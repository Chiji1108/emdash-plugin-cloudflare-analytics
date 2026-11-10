import type { BlockResponse } from "@emdash-cms/blocks/server";
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";
import { z } from "zod";

import { CloudflareError, loadReport, loadSummary, type Connection } from "./cloudflare.js";
import { isTimeZone } from "./dates.js";
import { messagesFor } from "./messages.js";
import { failure, RANGE_ACTION, RANGES, reportPage, reportWidget, setupNeeded, type Range } from "./view.js";

const WIDGET_PAGE = "widget:overview";

// Every dashboard visit renders the widget, and Cloudflare's query budget is shared
// by everyone using the same token, so a result is reused for a few minutes.
const CACHE_MS = 5 * 60_000;

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

function isRange(value: unknown): value is Range {
	return RANGES.some((days) => days === value);
}

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
	routes: {
		admin: {
			handler: async (routeCtx, ctx): Promise<BlockResponse> => {
				const parsed = interactionSchema.safeParse(routeCtx.input);
				if (!parsed.success) return { blocks: [] };
				const interaction = parsed.data;

				const locale = routeCtx.ui?.locale ?? ctx.site.locale;
				const view = { locale, messages: messagesFor(locale) };
				const isWidget = interaction.page === WIDGET_PAGE;

				let days: Range = isWidget ? 7 : 30;
				if (interaction.type === "block_action") {
					if (interaction.action_id !== RANGE_ACTION) return { blocks: [] };
					if (!isRange(interaction.value)) return { blocks: [] };
					days = interaction.value;
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
					const key = `cache:${isWidget ? "summary" : "report"}:${days}:${connection.accountId}:${connection.siteTag}:${connection.timeZone}`;
					const blocks = isWidget
						? reportWidget(await cached(ctx, key, () => loadSummary(fetch, connection, days)), view)
						: reportPage(await cached(ctx, key, () => loadReport(fetch, connection, days)), view);
					return { blocks };
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
