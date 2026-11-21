import { StoreSchedule } from "../modules/storeConfig/storeSchedule.model.js";
import { evaluateStoreOpenState, getStoreLocalParts } from "./storeSchedule.js";
import { SCHEDULE_MODE } from "./storeScheduleModes.js";

// 2026-11-23T15:30:00Z is Monday 11:30 in America/La_Paz (UTC-4).
const MONDAY_MIDDAY = new Date("2026-11-23T15:30:00.000Z");
// Same UTC date is Sunday 22:00 in America/La_Paz.
const SUNDAY_LATE = new Date("2026-11-23T02:00:00.000Z");
// Tuesday UTC / Monday 22:00 in America/La_Paz.
const MONDAY_LATE = new Date("2026-11-24T02:00:00.000Z");
// Sunday 11:30 in America/La_Paz.
const SUNDAY_MIDDAY = new Date("2026-11-22T15:30:00.000Z");

const schedule = (overrides = {}) => ({
    timezone: "America/La_Paz",
    autoScheduleEnabled: true,
    openTime: "08:00",
    closeTime: "21:00",
    closedDays: [0],
    scheduleMode: SCHEDULE_MODE.AUTO,
    forceOpenUntil: "",
    ...overrides
});

describe("evaluateStoreOpenState", () => {
    it("fails open when there is no schedule", () => {
        expect(evaluateStoreOpenState(null, MONDAY_MIDDAY)).toEqual({
            isOpen: true,
            effectiveMode: SCHEDULE_MODE.AUTO,
            reason: "no_schedule"
        });
        expect(evaluateStoreOpenState(undefined, MONDAY_MIDDAY).isOpen).toBe(true);
    });

    it("lets SCHEDULE_MODE.FORCE_CLOSED win even inside the business window", () => {
        expect(evaluateStoreOpenState(schedule({ scheduleMode: SCHEDULE_MODE.FORCE_CLOSED }), MONDAY_MIDDAY)).toEqual({
            isOpen: false,
            effectiveMode: SCHEDULE_MODE.FORCE_CLOSED,
            reason: "force_closed"
        });
    });

    it("normalizes a legacy string FORCE_CLOSED to 1 and still blocks", () => {
        const state = evaluateStoreOpenState(schedule({ scheduleMode: "FORCE_CLOSED" }), MONDAY_MIDDAY);

        expect(state).toEqual({
            isOpen: false,
            effectiveMode: SCHEDULE_MODE.FORCE_CLOSED,
            reason: "force_closed"
        });
        expect(state.effectiveMode).toBe(1);
    });

    it("fails open as SCHEDULE_MODE.AUTO for an unknown mode value", () => {
        expect(evaluateStoreOpenState(schedule({ scheduleMode: "MAYBE" }), MONDAY_MIDDAY)).toEqual({
            isOpen: true,
            effectiveMode: SCHEDULE_MODE.AUTO,
            reason: "open"
        });
        expect(evaluateStoreOpenState(schedule({ scheduleMode: null }), MONDAY_MIDDAY).effectiveMode)
            .toBe(SCHEDULE_MODE.AUTO);
    });

    it("keeps SCHEDULE_MODE.FORCE_OPEN outside business hours when it has no expiry", () => {
        expect(evaluateStoreOpenState(schedule({ scheduleMode: SCHEDULE_MODE.FORCE_OPEN }), SUNDAY_LATE)).toEqual({
            isOpen: true,
            effectiveMode: SCHEDULE_MODE.FORCE_OPEN,
            reason: "force_open"
        });
    });

    it("keeps SCHEDULE_MODE.FORCE_OPEN open until the local expiry time", () => {
        expect(evaluateStoreOpenState(
            schedule({ scheduleMode: SCHEDULE_MODE.FORCE_OPEN, forceOpenUntil: "23:59" }),
            MONDAY_MIDDAY
        )).toEqual({
            isOpen: true,
            effectiveMode: SCHEDULE_MODE.FORCE_OPEN,
            reason: "force_open"
        });
    });

    it("falls back to SCHEDULE_MODE.AUTO after FORCE_OPEN expires without mutating the schedule", () => {
        const stored = schedule({ scheduleMode: SCHEDULE_MODE.FORCE_OPEN, forceOpenUntil: "09:00" });

        expect(evaluateStoreOpenState(stored, MONDAY_LATE)).toEqual({
            isOpen: false,
            effectiveMode: SCHEDULE_MODE.AUTO,
            reason: "outside_hours"
        });
        expect(evaluateStoreOpenState(stored, MONDAY_MIDDAY)).toEqual({
            isOpen: true,
            effectiveMode: SCHEDULE_MODE.AUTO,
            reason: "open"
        });
        expect(evaluateStoreOpenState(stored, SUNDAY_MIDDAY)).toEqual({
            isOpen: false,
            effectiveMode: SCHEDULE_MODE.AUTO,
            reason: "closed_day"
        });
        expect(stored.scheduleMode).toBe(SCHEDULE_MODE.FORCE_OPEN);
        expect(stored.forceOpenUntil).toBe("09:00");
    });

    it("treats a disabled AUTO schedule as open", () => {
        expect(evaluateStoreOpenState(schedule({ autoScheduleEnabled: false }), SUNDAY_LATE)).toEqual({
            isOpen: true,
            effectiveMode: SCHEDULE_MODE.AUTO,
            reason: "auto_disabled"
        });
    });

    it("closes on a configured weekday", () => {
        expect(evaluateStoreOpenState(schedule(), SUNDAY_MIDDAY)).toEqual({
            isOpen: false,
            effectiveMode: SCHEDULE_MODE.AUTO,
            reason: "closed_day"
        });
    });

    it("closes before the opening time and at or after the closing time", () => {
        const beforeOpen = new Date("2026-11-23T11:30:00.000Z"); // 07:30 local
        const atClose = new Date("2026-11-24T01:00:00.000Z"); // 21:00 local

        expect(evaluateStoreOpenState(schedule(), beforeOpen)).toMatchObject({
            isOpen: false,
            reason: "outside_hours"
        });
        expect(evaluateStoreOpenState(schedule(), atClose)).toMatchObject({
            isOpen: false,
            reason: "outside_hours"
        });
    });

    it("opens inside the configured window", () => {
        expect(evaluateStoreOpenState(schedule(), MONDAY_MIDDAY)).toEqual({
            isOpen: true,
            effectiveMode: SCHEDULE_MODE.AUTO,
            reason: "open"
        });
    });
});

describe("getStoreLocalParts", () => {
    it("maps Sunday to 0 and converts the UTC instant into the store timezone", () => {
        expect(getStoreLocalParts(SUNDAY_LATE, "America/La_Paz")).toEqual({
            weekday: 0,
            hhmm: "22:00"
        });
        expect(getStoreLocalParts(SUNDAY_LATE, "UTC")).toEqual({
            weekday: 1,
            hhmm: "02:00"
        });
    });

    it("falls back to UTC for an invalid timezone", () => {
        expect(getStoreLocalParts(SUNDAY_LATE, "Mars/Olympus")).toEqual({
            weekday: 1,
            hhmm: "02:00"
        });
    });

    it("formats midnight with hour 00", () => {
        expect(getStoreLocalParts(new Date("2026-11-23T04:00:00.000Z"), "America/La_Paz").hhmm).toBe("00:00");
    });
});

describe("StoreSchedule validation", () => {
    it("rejects a window that does not cross midnight but starts at or after closing", async () => {
        const doc = new StoreSchedule({ openTime: "21:00", closeTime: "08:00" });
        await expect(doc.validate()).rejects.toThrow();
    });

    it("rejects equal open and close times", async () => {
        const doc = new StoreSchedule({ openTime: "10:00", closeTime: "10:00" });
        await expect(doc.validate()).rejects.toThrow();
    });

    it("rejects an unknown timezone", async () => {
        const doc = new StoreSchedule({ timezone: "UTC-4" });
        await expect(doc.validate()).rejects.toThrow();
    });
});
