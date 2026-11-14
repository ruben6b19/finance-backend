import { ROLES } from "../../constants/roles.js";

/**
 * Roles que existen solo para soporte interno y nunca deben llegar a la app.
 * Se mantiene como lista para poder ocultar más roles en el futuro.
 */
export const HIDDEN_ROLES = [ROLES.SUPERADMIN];

/**
 * Normaliza los roles de un documento de usuario.
 * @param {number|number[]|undefined|null} role
 * @returns {number[]}
 */
export const normalizeRoleList = (role) => {
    if (role === undefined || role === null) return [];
    return (Array.isArray(role) ? role : [role])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value));
};

/**
 * true si el usuario es una cuenta interna que no debe exponerse.
 * @param {object} user
 * @returns {boolean}
 */
export const isHiddenUser = (user) =>
    normalizeRoleList(user?.role).some((role) => HIDDEN_ROLES.includes(role));

/**
 * Filtro de Mongo que excluye cuentas internas de cualquier listado.
 * @returns {object}
 */
export const visibleUserFilter = () => ({ role: { $ne: ROLES.SUPERADMIN } });

/**
 * Solo los roles que la app puede asignar. El superadmin se crea por script,
 * nunca desde la API.
 * @param {number|string} role
 * @returns {boolean}
 */
export const isAssignableRole = (role) => !HIDDEN_ROLES.includes(Number(role));

/**
 * @param {Array<number|string>} roles
 * @returns {boolean}
 */
export const isAssignableRoleList = (roles) =>
    Array.isArray(roles) &&
    roles.length > 0 &&
    roles.every((role) => isAssignableRole(role));

/**
 * Traduce un rol interno al rol más cercano que entiende la app Android.
 * SUPERADMIN se presenta como ADMIN; el JWT conserva el rol real.
 * @param {number|string} role
 * @returns {number}
 */
export const toClientRole = (role) => {
    const value = Number(role);
    return value === ROLES.SUPERADMIN ? ROLES.ADMIN : value;
};

/**
 * @param {number|number[]|undefined|null} role
 * @returns {number[]}
 */
export const toClientRoleList = (role) => normalizeRoleList(role).map(toClientRole);
