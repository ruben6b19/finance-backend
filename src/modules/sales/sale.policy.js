import { ROLES } from "../../constants/roles.js";
import { daysElapsedInBolivia } from "../../utils/boliviaTime.js";
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
 * Días calendario transcurridos en Bolivia entre `saleDate` y `now`.
 * Negativo cuando la venta tiene fecha futura.
 * @returns {number|null} null si la fecha no es válida.
 */
export const saleDaysElapsed = (saleDate, now = new Date()) =>
    daysElapsedInBolivia(saleDate, now);

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
 * Cambiar la fecha de una venta afecta reportes y caja: solo supervisor, admin
 * o superadmin.
 */
export const canChangeSaleDate = (roles = []) =>
    roleAtLeast(roles, ROLES.SUPERVISOR);
