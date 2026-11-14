import { ROLES } from "../../constants/roles.js";
import { daysElapsedInBolivia } from "../../utils/boliviaTime.js";

// Roles que pueden anular un canje. El vendedor solo el mismo día.
export const REDEMPTION_VOID_ROLES = [ROLES.SUPERADMIN, ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.SELLER];

// Días calendario hacia atrás en los que se permite anular un canje.
// 0 => solo el mismo día.
export const REDEMPTION_VOID_WINDOW_DAYS = {
    [ROLES.SELLER]: 0,
    [ROLES.SUPERVISOR]: 7,
    [ROLES.ADMIN]: 7,
    [ROLES.SUPERADMIN]: 7
};

/**
 * Ventana más amplia que le corresponde al usuario según sus roles.
 * @param {number[]} roles
 * @returns {number|null} null si no tiene ningún rol habilitado.
 */
export const resolveRedemptionVoidWindow = (roles = []) => {
    const windows = roles
        .map((role) => REDEMPTION_VOID_WINDOW_DAYS[role])
        .filter((days) => days !== undefined);

    if (windows.length === 0) return null;
    return Math.max(...windows);
};

/**
 * Decide si el usuario puede anular un canje hecho en `redeemedAt`.
 * @returns {{allowed: boolean, maxDays: number|null, daysElapsed: number|null, errorCode: string|null}}
 */
export const checkRedemptionVoidWindow = ({ redeemedAt, roles = [], now = new Date() }) => {
    const maxDays = resolveRedemptionVoidWindow(roles);

    if (maxDays === null) {
        return { allowed: false, maxDays: null, daysElapsed: null, errorCode: "error_redemption_forbidden" };
    }

    const daysElapsed = daysElapsedInBolivia(redeemedAt, now);

    if (daysElapsed === null) {
        return { allowed: false, maxDays, daysElapsed: null, errorCode: "error_redemption_void_window_expired" };
    }

    if (daysElapsed > maxDays) {
        return {
            allowed: false,
            maxDays,
            daysElapsed,
            errorCode: maxDays === 0 ? "error_redemption_void_same_day" : "error_redemption_void_window_expired"
        };
    }

    return { allowed: true, maxDays, daysElapsed, errorCode: null };
};
