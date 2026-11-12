import { afterEach, describe, expect, it } from "vitest";

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function connectedHost(timeZone = "Asia/Tokyo") {
	host = await createPluginRuntimeTestHost({ site: { url: "https://example.com" } });
	await host.actions.plugin.updateSettings({
		accountId: "account-1",
		siteTag: "site-1",
		apiToken: "token-1",
		timeZone,
	});
	return host;
}

function hourOf(daysAgo: number) {
	return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 13) + ":00:00Z";
}

const report = {
	data: {
		viewer: {
			accounts: [
				{
					previous: [{ count: 100, sum: { visits: 50 } }],
					hourly: [
						{ count: 0, sum: { visits: 0 }, avg: { sampleInterval: 10 }, dimensions: { datetimeHour: hourOf(20) } },
						{ count: 120, sum: { visits: 40 }, avg: { sampleInterval: 1 }, dimensions: { datetimeHour: hourOf(0) } },
					],
					pages: [
						{ count: 80, dimensions: { requestPath: "/" } },
						{ count: 20, dimensions: { requestPath: "/about" } },
						{ count: 5, dimensions: { requestPath: "/news/%E3%81%8A%E7%9F%A5%E3%82%89%E3%81%9B" } },
					],
					previousPages: [
						{ count: 100, dimensions: { requestPath: "/" } },
						{ count: 8, dimensions: { requestPath: "/about" } },
					],
					referrers: [
						{ sum: { visits: 30 }, dimensions: { refererHost: "" } },
						{ sum: { visits: 10 }, dimensions: { refererHost: "www.google.com" } },
						{ sum: { visits: 0 }, dimensions: { refererHost: "example.com" } },
					],
					devices: [{ count: 90, dimensions: { deviceType: "mobile" } }],
					countries: [{ count: 110, dimensions: { countryName: "JP" } }],
				},
			],
		},
	},
	errors: null,
};

function respond(body: unknown) {
	return host!.http.respond(GRAPHQL, Response.json(body));
}

function sentBody() {
	const request = host!.http.requests().at(-1)!;
	return JSON.parse(new TextDecoder().decode(request.body));
}

function sentVariables() {
	return sentBody().variables;
}

function allBlocks(blocks: any[]): any[] {
	return blocks.flatMap((block) => [
		block,
		...allBlocks(block.blocks ?? []),
		...allBlocks((block.columns ?? []).flat()),
		...allBlocks((block.panels ?? []).flatMap((panel: any) => panel.blocks)),
	]);
}

function findBlocks(blocks: any[], type: string): any[] {
	return allBlocks(blocks).filter((block) => block.type === type);
}

function findBlock(blocks: any[], type: string): any {
	return findBlocks(blocks, type)[0];
}

describe("report page", () => {
	it("asks for settings before it is connected", async () => {
		host = await createPluginRuntimeTestHost();
		const page = await host.admin.loadPage("/report");
		expect(page.blocks).toMatchObject([{ type: "empty", actions: [{ target: { kind: "plugin-settings" } }] }]);
		expect(host.http.requests()).toHaveLength(0);
	});

	it("reports the last 30 days from local midnight", async () => {
		await connectedHost();
		await respond(report);
		const page = await host!.admin.loadPage("/report");

		const request = host!.http.requests()[0]!;
		expect(request.headers.authorization).toBe("Bearer token-1");
		expect(request.headers["x-rate-limit-type"]).toBe("account-based");
		const variables = sentVariables();
		expect(variables.account).toBe("account-1");
		expect(variables.current).toMatchObject({ siteTag: "site-1", bot: 0 });
		expect(variables.current.datetime_geq).toMatch(/T15:00:00\.000Z$/);
		const span = Date.parse(variables.current.datetime_lt) - Date.parse(variables.current.datetime_geq);
		expect(span).toBeGreaterThan(29 * 86_400_000);
		expect(span).toBeLessThanOrEqual(30 * 86_400_000);
		const previousSpan = Date.parse(variables.previous.datetime_lt) - Date.parse(variables.previous.datetime_geq);
		expect(previousSpan).toBe(span);
		expect(Date.parse(variables.current.datetime_geq) - Date.parse(variables.previous.datetime_geq)).toBe(30 * 86_400_000);

		const [visits, insights] = findBlocks(page.blocks, "stats");
		expect(visits.items).toMatchObject([
			{ label: "Site visits", value: "40", trend: "down", description: "-20.0% vs the previous 30 days" },
		]);
		expect(insights.items).toMatchObject([
			{ label: "Site page views went up", value: "120", trend: "up", description: "+20.0% vs the previous 30 days" },
			{ label: "Average page views per day", value: "4 / day", trend: "up" },
			{ label: "/about is getting attention", value: "20", trend: "up", description: "+150.0% vs the previous 30 days" },
		]);
		const series = findBlock(page.blocks, "chart").config.series;
		expect(series).toHaveLength(1);
		expect(series[0].data).toHaveLength(30);
		expect(series[0].data.at(-1)[1]).toBe(40);
	});

	it("draws a bar for each of the top pages", async () => {
		await connectedHost();
		await respond(report);
		const page = await host!.admin.loadPage("/report");
		expect(findBlocks(page.blocks, "meter")).toMatchObject([
			{ label: "Home  /", value: 80, max: 80, custom_value: "80" },
			{ label: "/about", value: 20, max: 80 },
			{ label: "/news/お知らせ", value: 5, max: 80 },
		]);
	});

	it("names pages the site has rendered since the report asked for them", async () => {
		await connectedHost();
		await respond(report);
		await host!.admin.loadPage("/report");
		const render = (path: string, pageTitle: string, content?: { collection: string; id: string; slug: string }) =>
			host!.transport.invokeHook("page:metadata", {
				page: {
					url: `https://example.com${path}`,
					path,
					locale: null,
					kind: content ? "content" : "custom",
					pageType: "website",
					title: `${pageTitle} | Site`,
					pageTitle,
					description: null,
					canonical: null,
					image: null,
					content,
				},
			});
		await render("/about", "About us");
		await render("/news/%E3%81%8A%E7%9F%A5%E3%82%89%E3%81%9B", "Notice", { collection: "news", id: "01NEWS", slug: "notice" });
		await render("/wp-login.php", "Not found");

		const page = await host!.admin.loadPage("/report");
		expect(findBlocks(page.blocks, "meter").map((meter: any) => meter.label)).toEqual([
			"Home  /",
			"About us  /about",
			"Notice  /news/お知らせ",
		]);
		const pages: Record<string, unknown> = (await host!.inspect.kv.get("state:pages"))!;
		expect(Object.keys(pages)).not.toContain("/wp-login.php");

		const list = await host!.admin.act("/report", "show", { value: "pages:30" });
		const rows = findBlock(list.blocks, "table").rows;
		expect(rows.map((row: any) => row.cms ?? null)).toEqual([
			null,
			null,
			{ type: "link", label: "Edit in CMS", target: { kind: "content", collection: "news", id: "01NEWS" } },
		]);
		expect(rows[1].page).toBe("About us  /about");
		expect(rows[1].open).toEqual({ type: "link", label: "Open", target: { kind: "external", url: "https://example.com/about" } });
	});

	it("lists every page with its change", async () => {
		await connectedHost();
		await respond(report);
		const page = await host!.admin.act("/report", "show", { value: "pages:30" });
		expect(
			findBlock(page.blocks, "table").rows.map((row: any) => ({ page: row.page, pageViews: row.pageViews, change: row.change })),
		).toEqual([
			{ page: "Home  /", pageViews: 80, change: "↓ 20.0%" },
			{ page: "/about", pageViews: 20, change: "↑ 150.0%" },
			{ page: "/news/お知らせ", pageViews: 5, change: "New" },
		]);
		expect(findBlock(page.blocks, "actions").elements.map((element: any) => element.style)).toEqual([
			"secondary",
			"primary",
			"secondary",
		]);
	});

	it("lists referrers without internal navigation", async () => {
		await connectedHost();
		await respond(report);
		const page = await host!.admin.loadPage("/report");
		const tab = findBlock(page.blocks, "tab");
		const referrers = tab.panels[0].blocks[0];
		expect(referrers.rows).toEqual([
			{ name: "Direct or unknown", value: 30 },
			{ name: "www.google.com", value: 10 },
		]);
	});

	it("switches the period and keeps the section", async () => {
		await connectedHost();
		await respond(report);
		const page = await host!.admin.act("/report", "show", { value: "pages:7" });
		const span = Date.parse(sentVariables().current.datetime_lt) - Date.parse(sentVariables().current.datetime_geq);
		expect(span).toBeLessThanOrEqual(7 * 86_400_000);
		const menu = findBlock(page.blocks, "actions").elements[2];
		expect(menu).toMatchObject({ type: "menu", label: "Last 7 days" });
		expect(menu.items.map((item: any) => item.value)).toEqual(["pages:7", "pages:30", "pages:90"]);
	});

	it("says nothing about estimates when Cloudflare counted exactly", async () => {
		await connectedHost();
		const exact = structuredClone(report);
		exact.data.viewer.accounts[0]!.hourly = [{ count: 120, sum: { visits: 40 }, avg: { sampleInterval: 1 }, dimensions: { datetimeHour: hourOf(0) } }];
		await respond(exact);
		const page = await host!.admin.act("/report", "show", { value: "overview:7" });
		expect(findBlocks(page.blocks, "context")).toEqual([]);
	});

	it("ignores a value it did not send", async () => {
		await connectedHost();
		const page = await host!.admin.act("/report", "show", { value: "pages:365" });
		expect(page.blocks).toEqual([]);
		expect(host!.http.requests()).toHaveLength(0);
	});

	it("reuses a recent result instead of asking Cloudflare again", async () => {
		await connectedHost();
		await respond(report);
		await host!.admin.loadPage("/report");
		const again = await host!.admin.loadPage("/report");
		expect(host!.http.requests()).toHaveLength(1);
		expect(findBlock(again.blocks, "stats").items[0].value).toBe("40");
	});

	it("speaks Japanese to a Japanese admin", async () => {
		await connectedHost();
		await respond(report);
		const page = await host!.admin.loadPage("/report", { locale: "ja" });
		expect(findBlock(page.blocks, "header").text).toBe("アナリティクス");
		expect(findBlock(page.blocks, "stats").items[0]).toMatchObject({
			label: "サイト全体の訪問数",
			description: "その前の30日間と比べて -20.0%",
		});
		const tab = findBlock(page.blocks, "tab");
		expect(tab.panels[1].blocks[0].rows).toEqual([{ name: "スマートフォン", value: 90 }]);
		expect(tab.panels[2].blocks[0].rows).toEqual([{ name: "日本", value: 110 }]);
		expect(page.blocks.at(-1)).toEqual({
			type: "context",
			text: "Cloudflare が1/10に間引いたデータから集計したため、数値は推定値です。",
		});
	});

	it("shows the API's reason when Cloudflare rejects the request", async () => {
		await connectedHost();
		await respond({ data: null, errors: [{ message: "not authorized for that account" }] });
		const page = await host!.admin.loadPage("/report");
		expect(page.blocks[0]).toMatchObject({ type: "banner", variant: "error", description: "not authorized for that account" });
	});

	it("explains a rejected API token", async () => {
		await connectedHost();
		await host!.http.respond(
			GRAPHQL,
			Response.json({ success: false, errors: [{ code: 9106, message: "Authentication failed (status: 400)" }] }, { status: 400 }),
		);
		const page = await host!.admin.loadPage("/report");
		expect(page.blocks[0]).toMatchObject({ type: "banner", description: "Authentication failed (status: 400)" });
	});

	it("rejects a time zone that does not exist", async () => {
		await connectedHost("Mars/Olympus");
		const page = await host!.admin.loadPage("/report");
		expect(page.blocks[0]).toMatchObject({ type: "banner", variant: "error" });
		expect(host!.http.requests()).toHaveLength(0);
	});
});

describe("permissions", () => {
	it("lets editors read the report", async () => {
		await connectedHost();
		await respond(report);
		const editor = await host!.fixtures.user({ email: "editor@example.com", role: "editor" });
		const page = await host!.admin.loadPage("/report", { user: editor });
		expect(findBlock(page.blocks, "stats").items[0].value).toBe("40");
	});
});

describe("dashboard widget", () => {
	it("summarises the last 7 days and links to the report", async () => {
		await connectedHost();
		await respond(report);
		const widget = await host!.admin.loadWidget("overview");
		expect(findBlock(widget.blocks, "chart").config.series[0].data).toHaveLength(7);
		expect(sentBody().query).not.toContain("pages:");
		expect(findBlock(widget.blocks, "actions").elements[0].target).toEqual({ kind: "plugin-page", path: "/report" });
	});
});

describe("settings", () => {
	it("stores the API token encrypted", async () => {
		await connectedHost();
		expect(JSON.stringify(await host!.inspect.settings.raw("apiToken"))).not.toContain("token-1");
	});
});
