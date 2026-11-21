export const SCHEDULE_MODE = Object.freeze({ AUTO: 0, FORCE_CLOSED: 1, FORCE_OPEN: 2 });

export const SCHEDULE_MODES = Object.freeze([
    SCHEDULE_MODE.AUTO,
    SCHEDULE_MODE.FORCE_CLOSED,
    SCHEDULE_MODE.FORCE_OPEN
]);

export const isScheduleMode = (value) => Number.isInteger(value) && SCHEDULE_MODES.includes(value);

// Read-side compatibility only. An earlier uncommitted version persisted string
// modes, so a store forced closed by such a document must not be read back as
// AUTO and accidentally reopen. This helper must NOT be used for write
// validation: writes accept only the numeric constants via isScheduleMode.
export const normalizeScheduleMode = (value) => {
    if (isScheduleMode(value)) return value;
    switch (value) {
        case "AUTO": return SCHEDULE_MODE.AUTO;
        case "FORCE_CLOSED": return SCHEDULE_MODE.FORCE_CLOSED;
        case "FORCE_OPEN": return SCHEDULE_MODE.FORCE_OPEN;
        default: return SCHEDULE_MODE.AUTO;
    }
};
