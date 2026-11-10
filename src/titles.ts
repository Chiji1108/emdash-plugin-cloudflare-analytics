import type { PluginContext } from "emdash/plugin";

/**
 * Page names, keyed by request path. Web Analytics records paths only, so the
 * plugin learns each name when the site renders the page. A path the report has
 * asked about but no render has named yet maps to null.
 *
 * Only paths the report asks about are kept, so renders of 404s for paths bots
 * make up never add entries.
 */
type Titles = Record<string, string | null>;

const KEY = "state:pageTitles";

/** Keeps the document small if a site's paths churn over the years. */
const MAX_PATHS = 1000;

async function read(ctx: PluginContext): Promise<Titles> {
	return (await ctx.kv.get<Titles>(KEY)) ?? {};
}

/** Called on every public render; writes only when a wanted path's name changes. */
export async function recordTitle(ctx: PluginContext, path: string, title: string | null | undefined): Promise<void> {
	const name = title?.trim();
	if (!name) return;
	const titles = await read(ctx);
	if (!(path in titles) || titles[path] === name) return;
	titles[path] = name;
	await ctx.kv.set(KEY, titles);
}

/** Returns the known names for `paths` and asks future renders to name the rest. */
export async function titlesFor(ctx: PluginContext, paths: string[]): Promise<Map<string, string>> {
	const titles = await read(ctx);
	const missing = paths.filter((path) => !(path in titles));
	if (missing.length) {
		const kept = Object.entries(titles).slice(-(MAX_PATHS - missing.length));
		await ctx.kv.set(KEY, Object.fromEntries([...kept, ...missing.map((path) => [path, null])]));
	}
	return new Map(paths.flatMap((path) => (titles[path] ? [[path, titles[path]] as const] : [])));
}
