import {
    BOLIVIA_OFFSET_MS,
    DAY_MS,
    DEFAULT_TIME_ZONE,
    boliviaDayNumber,
    dayNumberInZone,
    daysElapsedInBolivia,
    daysElapsedInZone
} from "./boliviaTime.js";

describe("dayNumberInZone", () => {
    it("uses America/La_Paz by default, matching the legacy UTC-4 behaviour", () => {
        expect(DEFAULT_TIME_ZONE).toBe("America/La_Paz");
        expect(BOLIVIA_OFFSET_MS).toBe(4 * 60 * 60 * 1000);
        expect(DAY_MS).toBe(24 * 60 * 60 * 1000);

        // 02:00Z is still the previous calendar day in Bolivia.
        expect(dayNumberInZone("2026-11-14T02:00:00.000Z")).toBe(Date.UTC(2026, 10, 13));
        expect(dayNumberInZone("2026-11-14T05:00:00.000Z")).toBe(Date.UTC(2026, 10, 14));
    });

    it("uses the calendar date of the supplied IANA zone", () => {
        // Mexico City is UTC-6 in November, so 05:00Z is still 13 November.
        expect(dayNumberInZone("2026-11-14T05:00:00.000Z", "America/Mexico_City"))
            .toBe(Date.UTC(2026, 10, 13));
        expect(dayNumberInZone("2026-11-14T06:00:00.000Z", "America/Mexico_City"))
            .toBe(Date.UTC(2026, 10, 14));
    });

    it("returns null for an invalid date or an invalid time zone", () => {
        expect(dayNumberInZone("not-a-date")).toBeNull();
        expect(dayNumberInZone("2026-11-14T00:00:00.000Z", "Mars/Olympus")).toBeNull();
    });

    it("keeps the legacy wrappers working", () => {
        expect(boliviaDayNumber("2026-11-14T02:00:00.000Z")).toBe(Date.UTC(2026, 10, 13));
        expect(daysElapsedInBolivia("2026-11-14T02:00:00.000Z", new Date("2026-11-15T02:00:00.000Z")))
            .toBe(1);
    });
});

describe("daysElapsedInZone", () => {
    const now = new Date("2026-11-15T05:30:00.000Z");
    const saleDate = "2026-11-14T06:00:00.000Z";

    it("measures elapsed calendar days in the requested zone", () => {
        expect(daysElapsedInZone(saleDate, now, DEFAULT_TIME_ZONE)).toBe(1);
        // The same instant is still today in Mexico City.
        expect(daysElapsedInZone(saleDate, now, "America/Mexico_City")).toBe(0);
    });

    it("returns null when a date or the zone is invalid", () => {
        expect(daysElapsedInZone("bad", now)).toBeNull();
        expect(daysElapsedInZone(saleDate, "bad")).toBeNull();
        expect(daysElapsedInZone(saleDate, now, "Mars/Olympus")).toBeNull();
    });
});
