import type { BlockResponse } from "@emdash-cms/blocks/server";
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";
import { z } from "zod";

import { CloudflareError, loadReport, loadSummary, type Connection } from "./cloudflare.js";
import { isTimeZone } from "./dates.js";
import { messagesFor } from "./messages.js";
import { pagesFor, recordPage } from "./pages.js";
import { failure, pagesPage, parseShowValue, reportPage, reportWidget, setupNeeded, SHOW_ACTION, type Range, type Section } from "./view.js";

const WIDGET_PAGE = "widget:overview";

// Every dashboard visit renders the widget, and Cloudflare's query budget is shared
// by everyone using the same token, so a result is reused for a few minutes.
const CACHE_MS = 5 * 60_000;
// Bump when the cached report's shape changes, so an upgrade never reads an old one.
const CACHE_VERSION = 3;

async function cached<T>(ctx: PluginContext, key: string, load: () => Promise<T>): Promise<T> {
	const hit = await ctx.kv.get<{ fetchedAt: number; value: T }>(key);
	if (hit && Date.now() - hit.fetchedAt < CACHE_MS) return hit.value;
	const value = await load();
	await ctx.kv.set(key, { fetchedAt: Date.now(), value });
	return value;
}

const interactionSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("page_load"), page: z.string() }),
	z.object({ type: z.literal("block_action"), page: z.string(), action_id: z.string(), value: z.unknown().optional() }),
]);

type Setup = { connection: Connection } | { problem: "missing" } | { problem: "timeZone"; timeZone: string };

async function readSetup(ctx: PluginContext): Promise<Setup> {
	const [accountId, siteTag, apiToken, timeZone] = await Promise.all([
		ctx.settings.get<string>("accountId"),
		ctx.settings.get<string>("siteTag"),
		ctx.settings.get<string>("apiToken"),
		ctx.settings.get<string>("timeZone"),
	]);
	if (!accountId?.trim() || !siteTag?.trim() || !apiToken?.trim()) return { problem: "missing" };
	const zone = timeZone?.trim() || "UTC";
	if (!isTimeZone(zone)) return { problem: "timeZone", timeZone: zone };
	return { connection: { accountId: accountId.trim(), siteTag: siteTag.trim(), apiToken: apiToken.trim(), timeZone: zone } };
}

const plugin: SandboxedPlugin = {
	hooks: {
		"page:metadata": {
			handler: async (event, ctx) => {
				const { path, pageTitle, title, content } = event.page;
				await recordPage(ctx, path, {
					title: (pageTitle ?? title ?? "").trim(),
					...(content && { content: { collection: content.collection, id: content.id } }),
				});
				return null;
			},
		},
	},
	routes: {
		admin: {
			// Private routes default to admins only; editors look after the content, so
			// they should see how it is read.
			permission: "plugins:read",
			handler: async (routeCtx, ctx): Promise<BlockResponse> => {
				const parsed = interactionSchema.safeParse(routeCtx.input);
				if (!parsed.success) return { blocks: [] };
				const interaction = parsed.data;

				const locale = routeCtx.ui?.locale ?? ctx.site.locale;
				const view = { locale, messages: messagesFor(locale) };
				const isWidget = interaction.page === WIDGET_PAGE;

				let days: Range = isWidget ? 7 : 30;
				let section: Section = "overview";
				if (interaction.type === "block_action") {
					const shown = interaction.action_id === SHOW_ACTION ? parseShowValue(interaction.value) : null;
					if (!shown) return { blocks: [] };
					({ days, section } = shown);
				}

				const setup = await readSetup(ctx);
				if ("problem" in setup) {
					return {
						blocks: setup.problem === "missing" ? setupNeeded(view) : failure(view.messages.invalidTimeZone(setup.timeZone), view),
					};
				}

				try {
					const fetch = (url: string, init: RequestInit) => ctx.http!.fetch(url, init);
					const { connection } = setup;
					const key = (kind: string) =>
						`cache:v${CACHE_VERSION}:${kind}:${days}:${connection.accountId}:${connection.siteTag}:${connection.timeZone}`;
					if (isWidget) {
						return { blocks: reportWidget(await cached(ctx, key("summary"), () => loadSummary(fetch, connection, days)), view) };
					}
					// The overview and the page list read the same report, so one fetch serves both.
					const report = await cached(ctx, key("report"), () => loadReport(fetch, connection, days));
					const pages = await pagesFor(ctx, report.pages.map((page) => page.path));
					return {
						blocks: section === "pages" ? pagesPage(report, pages, ctx.site.url, days, view) : reportPage(report, pages, days, view),
					};
				} catch (error) {
					if (!(error instanceof CloudflareError)) throw error;
					ctx.log.warn("Cloudflare Web Analytics request failed", { error: error.message });
					return { blocks: failure(error.message, view) };
				}
			},
		},
	},
};

export default plugin;
