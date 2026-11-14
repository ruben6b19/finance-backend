import { ROLES } from "../../constants/roles.js";

// Bolivia es UTC-4 durante todo el año (no aplica horario de verano).
const BOLIVIA_OFFSET_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Roles que pueden crear, editar, anular o eliminar una venta.
export const SALE_STAFF_ROLES = [ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.SELLER];

// Días calendario hacia atrás en los que se permite modificar una venta.
// 0 => solo el mismo día.
export const SALE_EDIT_WINDOW_DAYS = {
    [ROLES.SELLER]: 0,
    [ROLES.SUPERVISOR]: 7,
    [ROLES.ADMIN]: 7
};

// Número de día (UTC) que representa la fecha calendario en Bolivia.
const boliviaDayNumber = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const shifted = new Date(date.getTime() - BOLIVIA_OFFSET_MS);
    return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
};

/**
 * Días calendario transcurridos en Bolivia entre `saleDate` y `now`.
 * Negativo cuando la venta tiene fecha futura.
 * @returns {number|null} null si la fecha no es válida.
 */
export const saleDaysElapsed = (saleDate, now = new Date()) => {
    const saleDay = boliviaDayNumber(saleDate);
    const today = boliviaDayNumber(now);
    if (saleDay === null || today === null) return null;
    return Math.round((today - saleDay) / DAY_MS);
};

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
export const checkSaleModificationWindow = ({ saleDate, roles = [], now = new Date() }) => {
    const maxDays = resolveSaleEditWindow(roles);

    if (maxDays === null) {
        return { allowed: false, maxDays: null, daysElapsed: null, errorCode: "error_sale_forbidden_role" };
    }

    const daysElapsed = saleDaysElapsed(saleDate, now);

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
 * Cambiar la fecha de una venta afecta reportes y caja: solo supervisor o admin.
 */
export const canChangeSaleDate = (roles = []) =>
    roles.includes(ROLES.ADMIN) || roles.includes(ROLES.SUPERVISOR);
