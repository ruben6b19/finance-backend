// Kept for backwards compatibility. Stores now configure an IANA time zone;
// Intl is used below because IANA zones can observe DST, so a fixed offset like
// this one cannot describe a whole calendar year in every country.
export const BOLIVIA_OFFSET_MS = 4 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_TIME_ZONE = "America/La_Paz";

const formatters = new Map();

const getDayFormatter = (timeZone) => {
    if (!formatters.has(timeZone)) {
        formatters.set(timeZone, new Intl.DateTimeFormat("en-US", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }));
    }
    return formatters.get(timeZone);
};

/**
 * UTC day number of the calendar date a timestamp has in `timeZone`.
 * @returns {number|null} null for an invalid date or an invalid IANA time zone.
 */
export const dayNumberInZone = (value, timeZone = DEFAULT_TIME_ZONE) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;

    try {
        const parts = getDayFormatter(timeZone).formatToParts(date);
        const part = (type) => parts.find((item) => item.type === type)?.value;
        const year = Number(part("year"));
        const month = Number(part("month"));
        const day = Number(part("day"));
        if (!year || !month || !day) return null;
        return Date.UTC(year, month - 1, day);
    } catch (error) {
        // Intl throws RangeError for an unknown time zone.
        if (error instanceof RangeError) return null;
        throw error;
    }
};

/**
 * Calendar days elapsed in `timeZone` between `date` and `now`.
 * Negative when the date is in the future.
 * @returns {number|null} null if either date or the time zone is invalid.
 */
export const daysElapsedInZone = (date, now = new Date(), timeZone = DEFAULT_TIME_ZONE) => {
    const target = dayNumberInZone(date, timeZone);
    const today = dayNumberInZone(now, timeZone);
    if (target === null || today === null) return null;
    return Math.round((today - target) / DAY_MS);
};

/** @deprecated Use dayNumberInZone with the default zone instead. */
export const boliviaDayNumber = (value) => dayNumberInZone(value, DEFAULT_TIME_ZONE);

/** @deprecated Use daysElapsedInZone with the default zone instead. */
export const daysElapsedInBolivia = (date, now = new Date()) =>
    daysElapsedInZone(date, now, DEFAULT_TIME_ZONE);
