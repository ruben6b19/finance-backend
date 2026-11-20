import { ROLES } from "../../constants/roles.js";
import { DEFAULT_TIME_ZONE, daysElapsedInZone } from "../../utils/boliviaTime.js";
import { roleAtLeast } from "../../utils/roles.js";

// Roles que pueden crear, editar, anular o eliminar una venta.
export const SALE_STAFF_ROLES = [ROLES.SUPERADMIN, ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.SELLER];

// Días calendario hacia atrás en los que se permite modificar una venta.
// 0 => solo el mismo día.
export const SALE_EDIT_WINDOW_DAYS = {
    [ROLES.SELLER]: 0,
    [ROLES.SUPERVISOR]: 7,
    [ROLES.ADMIN]: 7,
    [ROLES.SUPERADMIN]: 7
};

/**
 * Calendar days elapsed in the store's time zone between `saleDate` and `now`.
 * Negative when the sale has a future date.
 * @returns {number|null} null if the date or time zone is invalid.
 */
export const saleDaysElapsed = (saleDate, now = new Date(), timeZone = DEFAULT_TIME_ZONE) =>
    daysElapsedInZone(saleDate, now, timeZone);

/**
 * Ventana más amplia que le corresponde al usuario según sus roles.
 * @param {number[]} roles
 * @returns {number|null} null si no tiene ningún rol habilitado.
 */
export const resolveSaleEditWindow = (roles = []) => {
    const windows = roles
        .map((role) => SALE_EDIT_WINDOW_DAYS[role])
        .filter((days) => days !== undefined);

    if (windows.length === 0) return null;
    return Math.max(...windows);
};

/**
 * Decide si el usuario puede modificar una venta con la fecha indicada.
 * La fecha debe ser la original de la venta, nunca la que envía el cliente.
 * @returns {{allowed: boolean, maxDays: number|null, daysElapsed: number|null, errorCode: string|null}}
 */
export const checkSaleModificationWindow = ({ saleDate, roles = [], now = new Date(), timeZone = DEFAULT_TIME_ZONE }) => {
    const maxDays = resolveSaleEditWindow(roles);

    if (maxDays === null) {
        return { allowed: false, maxDays: null, daysElapsed: null, errorCode: "error_sale_forbidden_role" };
    }

    const daysElapsed = saleDaysElapsed(saleDate, now, timeZone);

    if (daysElapsed === null) {
        return { allowed: false, maxDays, daysElapsed: null, errorCode: "error_sale_immutable_date" };
    }

    if (daysElapsed > maxDays) {
        return {
            allowed: false,
            maxDays,
            daysElapsed,
            errorCode: maxDays === 0 ? "error_sale_immutable_date" : "error_sale_edit_window_expired"
        };
    }

    return { allowed: true, maxDays, daysElapsed, errorCode: null };
};

/**
 * Cambiar la fecha de una venta afecta reportes y caja: solo supervisor, admin
 * o superadmin.
 */
export const canChangeSaleDate = (roles = []) =>
    roleAtLeast(roles, ROLES.SUPERVISOR);
