import { addDays, dayOf, daysEnding, startOf, type Day } from "./dates.js";

export interface Connection {
	accountId: string;
	siteTag: string;
	apiToken: string;
	timeZone: string;
}

export interface Totals {
	pageViews: number;
	visits: number;
}

export interface Summary {
	days: number;
	totals: Totals;
	/** The same number of days just before the reported period. */
	previous: Totals;
	daily: Array<{ day: Day } & Totals>;
}

export interface Report extends Summary {
	pages: Array<{ path: string; pageViews: number }>;
	/** An empty host means the visit had no referrer. */
	referrers: Array<{ host: string; visits: number }>;
	devices: Array<{ type: string; pageViews: number }>;
	/** ISO 3166-1 alpha-2 codes. */
	countries: Array<{ code: string; pageViews: number }>;
}

export class CloudflareError extends Error {}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

// Cloudflare counts every dataset in a request against its 300-per-5-minutes budget,
// so the widget asks for two and only the report page asks for the breakdowns.
const SUMMARY_NODES = `
	previous: rumPageloadEventsAdaptiveGroups(limit: 1, filter: $previous) { count sum { visits } }
	hourly: rumPageloadEventsAdaptiveGroups(limit: 5000, filter: $current, orderBy: [datetimeHour_ASC]) { count sum { visits } dimensions { datetimeHour } }`;

const BREAKDOWN_NODES = `
	pages: rumPageloadEventsAdaptiveGroups(limit: 10, filter: $current, orderBy: [count_DESC]) { count dimensions { requestPath } }
	referrers: rumPageloadEventsAdaptiveGroups(limit: 20, filter: $current, orderBy: [sum_visits_DESC]) { sum { visits } dimensions { refererHost } }
	devices: rumPageloadEventsAdaptiveGroups(limit: 5, filter: $current, orderBy: [count_DESC]) { count dimensions { deviceType } }
	countries: rumPageloadEventsAdaptiveGroups(limit: 10, filter: $current, orderBy: [count_DESC]) { count dimensions { countryName } }`;

const query = (nodes: string) => `query Report($account: string!, $current: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject!, $previous: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject!) {
	viewer { accounts(filter: { accountTag: $account }) {${nodes}
	} }
}`;

interface Group {
	count?: number;
	sum?: { visits: number };
	dimensions?: Record<string, string>;
}

type Groups = Record<string, Group[]>;

interface GraphqlBody {
	data?: { viewer: { accounts: Groups[] } } | null;
	errors?: Array<{ message: string }> | null;
}

async function request(fetch: Fetch, connection: Connection, days: number, now: Date, nodes: string) {
	const { timeZone } = connection;
	const dayList = daysEnding(dayOf(now, timeZone), days);
	const start = startOf(dayList[0]!, timeZone);
	const previousStart = startOf(addDays(dayList[0]!, -days), timeZone);
	// Bots run the beacon too; Cloudflare's own dashboard leaves them out.
	const filter = (from: Date, to: Date) => ({
		siteTag: connection.siteTag,
		datetime_geq: from.toISOString(),
		datetime_lt: to.toISOString(),
		bot: 0,
	});

	const response = await fetch(ENDPOINT, {
		method: "POST",
		headers: { Authorization: `Bearer ${connection.apiToken}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			query: query(nodes),
			variables: { account: connection.accountId, current: filter(start, now), previous: filter(previousStart, start) },
		}),
	});
	// A rejected token comes back as HTTP 400 with the reason in `errors`.
	const body = (await response.json().catch(() => ({}))) as GraphqlBody;
	if (!body.errors?.length && !response.ok) throw new CloudflareError(`Cloudflare API returned HTTP ${response.status}`);
	if (body.errors?.length) throw new CloudflareError(body.errors.map((error) => error.message).join("; "));
	const account = body.data?.viewer.accounts[0];
	if (!account) throw new CloudflareError("The API token cannot read this account");
	return { account, dayList };
}

function summarize(account: Groups, dayList: Day[], timeZone: string): Summary {
	const byDay = new Map(dayList.map((day) => [day, { pageViews: 0, visits: 0 }]));
	for (const group of account.hourly ?? []) {
		const totals = byDay.get(dayOf(new Date(group.dimensions!.datetimeHour!), timeZone));
		if (!totals) continue;
		totals.pageViews += group.count ?? 0;
		totals.visits += group.sum?.visits ?? 0;
	}
	const daily = dayList.map((day) => ({ day, ...byDay.get(day)! }));
	const previous = account.previous?.[0];
	return {
		days: dayList.length,
		totals: {
			pageViews: daily.reduce((sum, row) => sum + row.pageViews, 0),
			visits: daily.reduce((sum, row) => sum + row.visits, 0),
		},
		previous: { pageViews: previous?.count ?? 0, visits: previous?.sum?.visits ?? 0 },
		daily,
	};
}

/** Totals and daily counts for the last `days` days, today included, in the connection's time zone. */
export async function loadSummary(fetch: Fetch, connection: Connection, days: number, now = new Date()): Promise<Summary> {
	const { account, dayList } = await request(fetch, connection, days, now, SUMMARY_NODES);
	return summarize(account, dayList, connection.timeZone);
}

/** The summary plus the top pages, referrers, devices and countries. */
export async function loadReport(fetch: Fetch, connection: Connection, days: number, now = new Date()): Promise<Report> {
	const { account, dayList } = await request(fetch, connection, days, now, SUMMARY_NODES + BREAKDOWN_NODES);
	return {
		...summarize(account, dayList, connection.timeZone),
		pages: (account.pages ?? []).map((group) => ({ path: group.dimensions!.requestPath!, pageViews: group.count ?? 0 })),
		// Navigation inside the site carries the site's own host but counts no visit.
		referrers: (account.referrers ?? [])
			.filter((group) => (group.sum?.visits ?? 0) > 0)
			.map((group) => ({ host: group.dimensions!.refererHost!, visits: group.sum!.visits })),
		devices: (account.devices ?? []).map((group) => ({ type: group.dimensions!.deviceType!, pageViews: group.count ?? 0 })),
		countries: (account.countries ?? []).map((group) => ({ code: group.dimensions!.countryName!, pageViews: group.count ?? 0 })),
	};
}
