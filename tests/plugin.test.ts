import { afterEach, describe, expect, it } from "vitest";

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function connectedHost(timeZone = "Asia/Tokyo") {
	host = await createPluginRuntimeTestHost();
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
					hourly: [{ count: 120, sum: { visits: 40 }, dimensions: { datetimeHour: hourOf(0) } }],
					pages: [{ count: 80, dimensions: { requestPath: "/" } }],
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

function findBlock<T extends { type: string }>(blocks: T[], type: string): any {
	for (const block of blocks as any[]) {
		if (block.type === type) return block;
		for (const panel of block.panels ?? []) {
			const found = findBlock(panel.blocks, type);
			if (found) return found;
		}
	}
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
		const variables = sentVariables();
		expect(variables.account).toBe("account-1");
		expect(variables.current).toMatchObject({ siteTag: "site-1", bot: 0 });
		expect(variables.current.datetime_geq).toMatch(/T15:00:00\.000Z$/);
		const span = Date.parse(variables.current.datetime_lt) - Date.parse(variables.current.datetime_geq);
		expect(span).toBeGreaterThan(29 * 86_400_000);
		expect(span).toBeLessThanOrEqual(30 * 86_400_000);
		expect(variables.previous.datetime_lt).toBe(variables.current.datetime_geq);

		expect(findBlock(page.blocks, "stats").items).toMatchObject([
			{ label: "Page views", value: "120", trend: "up", description: "+20% vs the previous 30 days" },
			{ label: "Visits", value: "40", trend: "down", description: "-20% vs the previous 30 days" },
		]);
		const series = findBlock(page.blocks, "chart").config.series;
		expect(series[0].data).toHaveLength(30);
		expect(series[0].data.at(-1)[1]).toBe(120);
	});

	it("lists referrers without internal navigation", async () => {
		await connectedHost();
		await respond(report);
		const page = await host!.admin.loadPage("/report");
		const tab = findBlock(page.blocks, "tab");
		const referrers = tab.panels[1].blocks[0];
		expect(referrers.rows).toEqual([
			{ name: "Direct or unknown", value: 30 },
			{ name: "www.google.com", value: 10 },
		]);
	});

	it("switches the period", async () => {
		await connectedHost();
		await respond(report);
		const page = await host!.admin.act("/report", "range", { value: 7 });
		const span = Date.parse(sentVariables().current.datetime_lt) - Date.parse(sentVariables().current.datetime_geq);
		expect(span).toBeLessThanOrEqual(7 * 86_400_000);
		expect(findBlock(page.blocks, "actions").elements.map((button: any) => button.style)).toEqual([
			"primary",
			"secondary",
			"secondary",
		]);
	});

	it("reuses a recent result instead of asking Cloudflare again", async () => {
		await connectedHost();
		await respond(report);
		await host!.admin.loadPage("/report");
		const again = await host!.admin.loadPage("/report");
		expect(host!.http.requests()).toHaveLength(1);
		expect(findBlock(again.blocks, "stats").items[0].value).toBe("120");
	});

	it("speaks Japanese to a Japanese admin", async () => {
		await connectedHost();
		await respond(report);
		const page = await host!.admin.loadPage("/report", { locale: "ja" });
		expect(findBlock(page.blocks, "header").text).toBe("アクセス解析");
		const tab = findBlock(page.blocks, "tab");
		expect(tab.panels[2].blocks[0].rows).toEqual([{ name: "スマートフォン", value: 90 }]);
		expect(tab.panels[3].blocks[0].rows).toEqual([{ name: "日本", value: 110 }]);
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
