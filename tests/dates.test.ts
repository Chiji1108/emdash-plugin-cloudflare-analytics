import { describe, expect, it } from "vitest";

import { dayOf, startOf } from "../src/dates.js";

describe("startOf", () => {
	it("starts a Tokyo day at 15:00 UTC the day before", () => {
		expect(startOf("2026-11-10", "Asia/Tokyo").toISOString()).toBe("2026-11-09T15:00:00.000Z");
	});

	it("uses the offset in force at local midnight on a DST day", () => {
		// Sydney moves to +11 at 02:00 on 2026-10-04; midnight is still +10.
		expect(startOf("2026-10-04", "Australia/Sydney").toISOString()).toBe("2026-10-03T14:00:00.000Z");
		expect(startOf("2026-10-05", "Australia/Sydney").toISOString()).toBe("2026-10-04T13:00:00.000Z");
	});

	it("round-trips with dayOf", () => {
		for (const zone of ["UTC", "America/Los_Angeles", "Asia/Kolkata", "Pacific/Auckland"]) {
			expect(dayOf(startOf("2026-03-08", zone), zone)).toBe("2026-03-08");
		}
	});
});
