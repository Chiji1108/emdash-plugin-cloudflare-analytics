import type { Block, StatItem } from "@emdash-cms/blocks/server";

import type { Report, Summary } from "./cloudflare.js";
import type { Messages } from "./messages.js";
import type { PageInfo } from "./pages.js";

export const RANGES = [7, 30, 90] as const;
export type Range = (typeof RANGES)[number];

export type Section = "overview" | "pages";

/** Every control on the page sends this action with a `section:days` value. */
export const SHOW_ACTION = "show";

export function showValue(section: Section, days: Range): string {
	return `${section}:${days}`;
}

export function parseShowValue(value: unknown): { section: Section; days: Range } | null {
	const [section, days] = String(value).split(":");
	const range = RANGES.find((range) => String(range) === days);
	if ((section !== "overview" && section !== "pages") || !range) return null;
	return { section, days: range };
}

export const REPORT_PAGE = "/report";

const TOP_PAGES = 5;

interface View {
	messages: Messages;
	locale: string;
}

/** The relative change from `before` to `now`, or null when there is nothing to compare with. */
function changeOf(now: number, before: number): number | null {
	return before === 0 ? null : (now - before) / before;
}

/** Shows `/news/%E3%81%82` as `/news/あ`. */
function readablePath(path: string): string {
	try {
		return decodeURI(path);
	} catch {
		return path;
	}
}

type Pages = Map<string, PageInfo>;

/** Studio's "Name /path" label; the home page's title is usually just the site name. */
function pageLabel(path: string, pages: Pages, { messages }: View): string {
	const name = path === "/" ? messages.home : pages.get(path)?.title;
	return name ? `${name}  ${readablePath(path)}` : readablePath(path);
}

function openLink(path: string, siteUrl: string, { messages }: View) {
	return { type: "link" as const, label: messages.open, target: { kind: "external" as const, url: new URL(path, siteUrl).href } };
}

/** Says how the numbers were estimated, or nothing when they are exact. */
function sampledNote({ days, sampleInterval }: Summary, { messages }: View): Block[] {
	if (sampleInterval <= 1) return [];
	return [{ type: "context", text: days > 7 ? messages.sampledOlder(sampleInterval) : messages.sampled(sampleInterval) }];
}

function trendOf(change: number): StatItem["trend"] {
	return change > 0 ? "up" : change < 0 ? "down" : "neutral";
}

function percent(change: number, locale: string, signDisplay: "exceptZero" | "never") {
	return new Intl.NumberFormat(locale, {
		style: "percent",
		minimumFractionDigits: 1,
		maximumFractionDigits: 1,
		signDisplay,
	}).format(change);
}

function stat(label: string, value: string, change: number | null, days: number, { messages, locale }: View): StatItem {
	if (change === null) return { label, value, description: messages.noComparison(days) };
	return {
		label,
		value,
		description: messages.comparedWith(percent(change, locale, "exceptZero"), days),
		trend: trendOf(change),
	};
}

/** Studio's section links and period picker, in one row. */
function toolbar(section: Section, days: Range, { messages }: View): Block {
	const sectionButton = (target: Section, label: string) => ({
		type: "button" as const,
		action_id: SHOW_ACTION,
		label,
		value: showValue(target, days),
		style: target === section ? ("primary" as const) : ("secondary" as const),
	});
	return {
		type: "actions",
		elements: [
			sectionButton("overview", messages.overview),
			sectionButton("pages", messages.pagesTitle),
			{
				type: "menu",
				action_id: SHOW_ACTION,
				label: messages.lastDays(days),
				items: RANGES.map((range) => ({ label: messages.lastDays(range), value: showValue(section, range) })),
				style: "secondary",
			},
		],
	};
}

function visitsChart(report: Summary, { messages }: View, height: number): Block {
	// Noon UTC keeps each point on its own date in every browser time zone the chart may render in.
	const at = (day: string) => Date.parse(`${day}T12:00:00Z`);
	return {
		type: "chart",
		config: {
			chart_type: "timeseries",
			style: "line",
			gradient: true,
			height,
			series: [{ name: messages.visits, data: report.daily.map((row) => [at(row.day), row.visits]) }],
		},
	};
}

function visitsStat(report: Summary, view: View): Block {
	const { totals, previous, days } = report;
	return {
		type: "stats",
		items: [stat(view.messages.siteVisits, totals.visits.toLocaleString(view.locale), changeOf(totals.visits, previous.visits), days, view)],
	};
}

function insights(report: Report, pages: Pages, view: View): Block {
	const { messages, locale } = view;
	const { totals, previous, days } = report;
	const pageViewsChange = changeOf(totals.pageViews, previous.pageViews);
	const pageViewsLabel =
		pageViewsChange === null
			? messages.sitePageViews
			: pageViewsChange > 0
				? messages.pageViewsRose
				: pageViewsChange < 0
					? messages.pageViewsFell
					: messages.pageViewsSteady;
	const perDay = (total: number) => Math.round(total / days);
	const items = [
		stat(pageViewsLabel, totals.pageViews.toLocaleString(locale), pageViewsChange, days, view),
		stat(
			messages.dailyPageViews,
			messages.perDay(perDay(totals.pageViews).toLocaleString(locale)),
			changeOf(perDay(totals.pageViews), perDay(previous.pageViews)),
			days,
			view,
		),
	];

	// Studio's "getting attention" card: the page whose views grew the most.
	const rising = report.pages
		.map((page) => ({ page, change: changeOf(page.pageViews, page.previousPageViews) }))
		.filter((row): row is { page: Report["pages"][number]; change: number } => row.change !== null && row.change > 0)
		.sort((a, b) => b.change - a.change)[0];
	if (rising) {
		items.push(stat(messages.trending(pageLabel(rising.page.path, pages, view)), rising.page.pageViews.toLocaleString(locale), rising.change, days, view));
	}
	return { type: "stats", items };
}

function breakdownTable(key: string, label: string, valueLabel: string, rows: Array<{ name: string; value: number }>, view: View): Block {
	return {
		type: "table",
		block_id: key,
		page_action_id: `${key}_page`,
		columns: [
			{ key: "name", label },
			{ key: "value", label: valueLabel, format: "number" },
		],
		rows,
		empty_text: view.messages.empty,
	};
}

function breakdowns(report: Report, view: View): Block {
	const { messages, locale } = view;
	const regions = new Intl.DisplayNames(locale, { type: "region" });
	const regionName = (code: string) => {
		try {
			return regions.of(code) ?? code;
		} catch {
			return code;
		}
	};
	return {
		type: "accordion",
		label: messages.more,
		blocks: [
			{
				type: "tab",
				panels: [
					{
						label: messages.referrers,
						blocks: [
							breakdownTable(
								"referrers",
								messages.source,
								messages.visits,
								report.referrers.map((row) => ({ name: row.host || messages.direct, value: row.visits })),
								view,
							),
						],
					},
					{
						label: messages.devices,
						blocks: [
							breakdownTable(
								"devices",
								messages.device,
								messages.pageViews,
								report.devices.map((row) => ({ name: messages.deviceTypes[row.type] ?? row.type, value: row.pageViews })),
								view,
							),
						],
					},
					{
						label: messages.countries,
						blocks: [
							breakdownTable(
								"countries",
								messages.country,
								messages.pageViews,
								report.countries.map((row) => ({ name: regionName(row.code), value: row.pageViews })),
								view,
							),
						],
					},
				],
			},
		],
	};
}

export function reportPage(report: Report, pages: Pages, days: Range, view: View): Block[] {
	const { messages, locale } = view;
	const top = report.pages.slice(0, TOP_PAGES);
	const max = top[0]?.pageViews ?? 0;
	return [
		{ type: "header", text: messages.title },
		toolbar("overview", days, view),
		{
			type: "columns",
			columns: [
				[visitsStat(report, view), visitsChart(report, view, 280)],
				[
					{ type: "section", text: messages.pageViewsByPage },
					...(top.length
						? top.map(
								(page): Block => ({
									type: "meter",
									label: pageLabel(page.path, pages, view),
									value: page.pageViews,
									max,
									custom_value: page.pageViews.toLocaleString(locale),
								}),
							)
						: [{ type: "context", text: messages.empty } satisfies Block]),
					{
						type: "actions",
						elements: [{ type: "button", action_id: SHOW_ACTION, label: messages.allPages, value: showValue("pages", days) }],
					},
				],
			],
		},
		{ type: "header", text: messages.insights(report.days) },
		insights(report, pages, view),
		breakdowns(report, view),
		...sampledNote(report, view),
	];
}

export function pagesPage(report: Report, pages: Pages, siteUrl: string, days: Range, view: View): Block[] {
	const { messages, locale } = view;
	return [
		{ type: "header", text: messages.title },
		toolbar("pages", days, view),
		{
			type: "table",
			block_id: "pages",
			page_action_id: "pages_page",
			// The host right-aligns element columns as row actions, so the links sit at the end.
			// A badge column would draw an empty pill on every non-CMS row; the edit link
			// appears only on CMS pages and tells the reader the same thing.
			columns: [
				{ key: "page", label: messages.page },
				{ key: "pageViews", label: messages.pageViews, format: "number" },
				{ key: "change", label: messages.change },
				{ key: "cms", label: messages.cms, format: "element" },
				{ key: "open", label: "", format: "element" },
			],
			rows: report.pages.map((page) => {
				const change = changeOf(page.pageViews, page.previousPageViews);
				const arrow = change === null ? "" : change > 0 ? "↑ " : change < 0 ? "↓ " : "";
				const content = pages.get(page.path)?.content;
				return {
					page: pageLabel(page.path, pages, view),
					pageViews: page.pageViews,
					change: change === null ? messages.newPage : arrow + percent(change, locale, "never"),
					...(content && {
						cms: { type: "link", label: messages.editInCms, target: { kind: "content", ...content } },
					}),
					open: openLink(page.path, siteUrl, view),
				};
			}),
			empty_text: messages.empty,
		},
		...sampledNote(report, view),
	];
}

export function reportWidget(report: Summary, view: View): Block[] {
	return [
		{ type: "context", text: view.messages.lastDays(report.days) },
		visitsStat(report, view),
		visitsChart(report, view, 180),
		{
			type: "actions",
			elements: [{ type: "link", label: view.messages.openReport, target: { kind: "plugin-page", path: REPORT_PAGE } }],
		},
	];
}

export function setupNeeded({ messages }: View): Block[] {
	return [
		{
			type: "empty",
			title: messages.setupTitle,
			description: messages.setupDescription,
			actions: [{ type: "link", label: messages.openSettings, target: { kind: "plugin-settings" } }],
		},
	];
}

export function failure(detail: string, { messages }: View): Block[] {
	return [
		{ type: "banner", variant: "error", title: messages.loadFailed, description: detail },
		{
			type: "actions",
			elements: [{ type: "link", label: messages.openSettings, target: { kind: "plugin-settings" } }],
		},
	];
}
