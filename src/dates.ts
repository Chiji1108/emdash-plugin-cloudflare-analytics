/** A calendar day in the site's time zone, as `YYYY-MM-DD`. */
export type Day = string;

const dayFormats = new Map<string, Intl.DateTimeFormat>();

function dayFormat(timeZone: string): Intl.DateTimeFormat {
	let format = dayFormats.get(timeZone);
	if (!format) {
		// en-CA formats dates as YYYY-MM-DD.
		format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
		dayFormats.set(timeZone, format);
	}
	return format;
}

export function isTimeZone(timeZone: string): boolean {
	try {
		dayFormat(timeZone);
		return true;
	} catch {
		return false;
	}
}

export function dayOf(instant: Date, timeZone: string): Day {
	return dayFormat(timeZone).format(instant);
}

function offsetMs(instant: Date, timeZone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		second: "numeric",
	}).formatToParts(instant);
	const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
	const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
	return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant a day starts in the given time zone. */
export function startOf(day: Day, timeZone: string): Date {
	const midnightUtc = Date.parse(`${day}T00:00:00Z`);
	return new Date(midnightUtc - offsetMs(new Date(midnightUtc), timeZone));
}

export function addDays(day: Day, days: number): Day {
	return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The `count` days ending with `last`, oldest first. */
export function daysEnding(last: Day, count: number): Day[] {
	return Array.from({ length: count }, (_, index) => addDays(last, index - count + 1));
}
