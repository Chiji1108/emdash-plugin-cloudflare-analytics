import type { PluginContext } from "emdash/plugin";

/** What a render tells the plugin about a page. */
export interface PageInfo {
	title: string;
	/** Set when the page shows a CMS entry, so the report can link to its editor. */
	content?: { collection: string; id: string };
}

/**
 * Page details, keyed by request path. Web Analytics records paths only, so the
 * plugin learns each page's name when the site renders it. A path the report has
 * asked about but no render has described yet maps to null.
 *
 * Only paths the report asks about are kept, so renders of 404s for paths bots
 * make up never add entries.
 */
type Pages = Record<string, PageInfo | null>;

const KEY = "state:pages";

/** Keeps the document small if a site's paths churn over the years. */
const MAX_PATHS = 1000;

async function read(ctx: PluginContext): Promise<Pages> {
	return (await ctx.kv.get<Pages>(KEY)) ?? {};
}

function same(a: PageInfo | null | undefined, b: PageInfo): boolean {
	return a?.title === b.title && a.content?.collection === b.content?.collection && a.content?.id === b.content?.id;
}

/** Called on every public render; writes only when a wanted path's details change. */
export async function recordPage(ctx: PluginContext, path: string, info: PageInfo): Promise<void> {
	if (!info.title.trim()) return;
	const pages = await read(ctx);
	if (!(path in pages) || same(pages[path], info)) return;
	pages[path] = info;
	await ctx.kv.set(KEY, pages);
}

/** Returns what is known about `paths` and asks future renders to describe the rest. */
export async function pagesFor(ctx: PluginContext, paths: string[]): Promise<Map<string, PageInfo>> {
	const pages = await read(ctx);
	const missing = paths.filter((path) => !(path in pages));
	if (missing.length) {
		const kept = Object.entries(pages).slice(-(MAX_PATHS - missing.length));
		await ctx.kv.set(KEY, Object.fromEntries([...kept, ...missing.map((path) => [path, null])]));
	}
	return new Map(paths.flatMap((path) => (pages[path] ? [[path, pages[path]] as const] : [])));
}
