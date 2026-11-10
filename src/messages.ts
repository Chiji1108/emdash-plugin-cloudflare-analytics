const en = {
	title: "Analytics",
	pageViews: "Page views",
	visits: "Visits",
	lastDays: (days: number) => `Last ${days} days`,
	comparedWith: (change: string, days: number) => `${change} vs the previous ${days} days`,
	noComparison: (days: number) => `No data for the previous ${days} days`,
	pages: "Pages",
	path: "Path",
	referrers: "Referrers",
	source: "Source",
	direct: "Direct or unknown",
	devices: "Devices",
	device: "Device",
	countries: "Countries",
	country: "Country",
	empty: "No page views in this period",
	deviceTypes: { desktop: "Desktop", mobile: "Mobile", tablet: "Tablet" } as Record<string, string>,
	openReport: "Open report",
	setupTitle: "Connect Cloudflare Web Analytics",
	setupDescription:
		"Enter your Cloudflare account ID, the site tag of your Web Analytics site, and an API token with Account Analytics Read permission.",
	openSettings: "Open settings",
	invalidTimeZone: (timeZone: string) => `"${timeZone}" is not a time zone. Use a name such as Asia/Tokyo.`,
	loadFailed: "Could not load Cloudflare Web Analytics",
	sampled: "Cloudflare samples older data, so numbers are estimates.",
};

export type Messages = typeof en;

const ja: Messages = {
	title: "アクセス解析",
	pageViews: "ページビュー",
	visits: "訪問数",
	lastDays: (days) => `過去${days}日間`,
	comparedWith: (change, days) => `その前の${days}日間と比べて${change}`,
	noComparison: (days) => `その前の${days}日間のデータはありません`,
	pages: "ページ",
	path: "パス",
	referrers: "参照元",
	source: "参照元",
	direct: "直接、または不明",
	devices: "端末",
	device: "端末",
	countries: "国",
	country: "国",
	empty: "この期間のページビューはありません",
	deviceTypes: { desktop: "パソコン", mobile: "スマートフォン", tablet: "タブレット" },
	openReport: "詳しく見る",
	setupTitle: "Cloudflare Web Analytics と接続してください",
	setupDescription:
		"Cloudflare のアカウント ID、Web Analytics のサイトタグ、Account Analytics の読み取り権限がある API トークンを設定してください。",
	openSettings: "設定を開く",
	invalidTimeZone: (timeZone) => `「${timeZone}」はタイムゾーンではありません。Asia/Tokyo のような名前を入れてください。`,
	loadFailed: "Cloudflare Web Analytics のデータを読み込めませんでした",
	sampled: "Cloudflare は古いデータを間引いて保存するため、数値は推定値です。",
};

export function messagesFor(locale: string | undefined): Messages {
	return locale?.toLowerCase().startsWith("ja") ? ja : en;
}
