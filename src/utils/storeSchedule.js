import { DEFAULT_TIME_ZONE } from "./boliviaTime.js";
import { SCHEDULE_MODE, normalizeScheduleMode } from "./storeScheduleModes.js";

const WEEKDAY_TO_NUMBER = {
    Sunday: 0,
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5,
    Saturday: 6
};

const formatterCache = new Map();

/**
 * Returns the local weekday (0 = Sunday) and HH:mm for an instant in a zone.
 * Invalid zones fall back to UTC so a bad configuration can never break a
 * request. The function is pure: `now` is always supplied by the caller.
 */
export const getStoreLocalParts = (date, timezone) => {
    const value = date instanceof Date ? date : new Date(date);
    const instant = Number.isNaN(value.getTime()) ? new Date(0) : value;
    const safeZone = typeof timezone === "string" && timezone.trim() !== ""
        ? timezone.trim()
        : DEFAULT_TIME_ZONE;

    let formatter = formatterCache.get(safeZone);
    if (!formatter) {
        try {
            formatter = new Intl.DateTimeFormat("en-US", {
                timeZone: safeZone,
                hourCycle: "h23",
                weekday: "long",
                hour: "2-digit",
                minute: "2-digit"
            });
        } catch (error) {
            formatter = new Intl.DateTimeFormat("en-US", {
                timeZone: "UTC",
                hourCycle: "h23",
                weekday: "long",
                hour: "2-digit",
                minute: "2-digit"
            });
        }
        formatterCache.set(safeZone, formatter);
    }

    const parts = formatter.formatToParts(instant);
    const part = (type) => parts.find((item) => item.type === type)?.value;

    return {
        weekday: WEEKDAY_TO_NUMBER[part("weekday")] ?? 0,
        hhmm: `${part("hour")}:${part("minute")}`
    };
};

/**
 * Evaluates the effective open state of a store without mutating the schedule.
 * Precedence is SCHEDULE_MODE.FORCE_CLOSED > SCHEDULE_MODE.FORCE_OPEN >
 * SCHEDULE_MODE.AUTO. An expired SCHEDULE_MODE.FORCE_OPEN window falls through
 * to SCHEDULE_MODE.AUTO while stored `scheduleMode` stays untouched.
 * A missing schedule fails OPEN so existing stores keep taking orders.
 */
export const evaluateStoreOpenState = (schedule, now = new Date()) => {
    if (!schedule) {
        return { isOpen: true, effectiveMode: SCHEDULE_MODE.AUTO, reason: "no_schedule" };
    }

    const mode = normalizeScheduleMode(schedule.scheduleMode);
    if (mode === SCHEDULE_MODE.FORCE_CLOSED) {
        return { isOpen: false, effectiveMode: SCHEDULE_MODE.FORCE_CLOSED, reason: "force_closed" };
    }

    const timezone = schedule.timezone || DEFAULT_TIME_ZONE;
    const closedDays = Array.isArray(schedule.closedDays) ? schedule.closedDays : [];

    const evaluateAuto = () => {
        if (schedule.autoScheduleEnabled === false) {
            return { isOpen: true, effectiveMode: SCHEDULE_MODE.AUTO, reason: "auto_disabled" };
        }

        const { weekday, hhmm } = getStoreLocalParts(now, timezone);
        if (closedDays.includes(weekday)) {
            return { isOpen: false, effectiveMode: SCHEDULE_MODE.AUTO, reason: "closed_day" };
        }
        if (hhmm < (schedule.openTime || "08:00") || hhmm >= (schedule.closeTime || "21:00")) {
            return { isOpen: false, effectiveMode: SCHEDULE_MODE.AUTO, reason: "outside_hours" };
        }
        return { isOpen: true, effectiveMode: SCHEDULE_MODE.AUTO, reason: "open" };
    };

    if (mode === SCHEDULE_MODE.FORCE_OPEN) {
        const until = typeof schedule.forceOpenUntil === "string"
            ? schedule.forceOpenUntil.trim()
            : "";
        if (!until) {
            return { isOpen: true, effectiveMode: SCHEDULE_MODE.FORCE_OPEN, reason: "force_open" };
        }

        const { hhmm } = getStoreLocalParts(now, timezone);
        if (hhmm <= until) {
            return { isOpen: true, effectiveMode: SCHEDULE_MODE.FORCE_OPEN, reason: "force_open" };
        }
        return evaluateAuto();
    }

    return evaluateAuto();
};
