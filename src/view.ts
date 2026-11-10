import type { Block, StatItem } from "@emdash-cms/blocks/server";

import type { Report, Summary, Totals } from "./cloudflare.js";
import type { Messages } from "./messages.js";

export const RANGES = [7, 30, 90] as const;
export type Range = (typeof RANGES)[number];

export const RANGE_ACTION = "range";

interface View {
	messages: Messages;
	locale: string;
}

function stat(label: string, key: keyof Totals, report: Summary, { messages, locale }: View): StatItem {
	const value = report.totals[key];
	const before = report.previous[key];
	if (before === 0) {
		return { label, value: value.toLocaleString(locale), description: messages.noComparison(report.days) };
	}
	const change = (value - before) / before;
	const percent = new Intl.NumberFormat(locale, { style: "percent", signDisplay: "exceptZero" }).format(change);
	return {
		label,
		value: value.toLocaleString(locale),
		description: messages.comparedWith(percent, report.days),
		trend: change > 0 ? "up" : change < 0 ? "down" : "neutral",
	};
}

function stats(report: Summary, view: View): Block {
	return {
		type: "stats",
		items: [stat(view.messages.pageViews, "pageViews", report, view), stat(view.messages.visits, "visits", report, view)],
	};
}

function chart(report: Summary, { messages }: View, height: number): Block {
	// Noon UTC keeps each point on its own date in every browser time zone the chart may render in.
	const at = (day: string) => Date.parse(`${day}T12:00:00Z`);
	return {
		type: "chart",
		config: {
			chart_type: "timeseries",
			style: "bar",
			height,
			series: [
				{ name: messages.pageViews, data: report.daily.map((row) => [at(row.day), row.pageViews]) },
				{ name: messages.visits, data: report.daily.map((row) => [at(row.day), row.visits]) },
			],
		},
	};
}

function table(label: string, key: string, rows: Array<{ name: string; value: number }>, valueLabel: string, view: View): Block {
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

export function reportPage(report: Report, view: View): Block[] {
	const { messages, locale } = view;
	const regions = new Intl.DisplayNames(locale, { type: "region" });
	const regionName = (code: string) => {
		try {
			return regions.of(code) ?? code;
		} catch {
			return code;
		}
	};

	return [
		{ type: "header", text: messages.title },
		{
			type: "actions",
			elements: RANGES.map((days) => ({
				type: "button",
				action_id: RANGE_ACTION,
				label: messages.lastDays(days),
				value: days,
				style: days === report.days ? "primary" : "secondary",
			})),
		},
		stats(report, view),
		chart(report, view, 320),
		{
			type: "tab",
			panels: [
				{
					label: messages.pages,
					blocks: [table(messages.path, "pages", report.pages.map((row) => ({ name: row.path, value: row.pageViews })), messages.pageViews, view)],
				},
				{
					label: messages.referrers,
					blocks: [
						table(
							messages.source,
							"referrers",
							report.referrers.map((row) => ({ name: row.host || messages.direct, value: row.visits })),
							messages.visits,
							view,
						),
					],
				},
				{
					label: messages.devices,
					blocks: [
						table(
							messages.device,
							"devices",
							report.devices.map((row) => ({ name: messages.deviceTypes[row.type] ?? row.type, value: row.pageViews })),
							messages.pageViews,
							view,
						),
					],
				},
				{
					label: messages.countries,
					blocks: [
						table(
							messages.country,
							"countries",
							report.countries.map((row) => ({ name: regionName(row.code), value: row.pageViews })),
							messages.pageViews,
							view,
						),
					],
				},
			],
		},
		{ type: "context", text: messages.sampled },
	];
}

export function reportWidget(report: Summary, view: View): Block[] {
	return [
		{ type: "context", text: view.messages.lastDays(report.days) },
		stats(report, view),
		chart(report, view, 180),
		{
			type: "actions",
			elements: [{ type: "link", label: view.messages.openReport, target: { kind: "plugin-page", path: "/report" } }],
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
