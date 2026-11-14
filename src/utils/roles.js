/**
 * Normaliza los roles del usuario autenticado.
 * Los custom claims de Firebase pueden traer un número o un arreglo de números.
 * @param {number|number[]|undefined|null} role
 * @returns {number[]}
 */
export const normalizeRoles = (role) => {
    if (role === undefined || role === null) return [];
    const list = Array.isArray(role) ? role : [role];
    return list
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value));
};

/**
 * true si el usuario autenticado tiene al menos uno de los roles permitidos.
 * @param {object} req
 * @param {number[]} allowedRoles
 * @returns {boolean}
 */
export const hasRole = (req, allowedRoles) => {
    const roles = normalizeRoles(req.user?.role);
    return roles.some((role) => allowedRoles.includes(role));
};

/**
 * Jerarquía de roles: cuanto más bajo el número, más privilegios.
 * SUPERADMIN (-1) > ADMIN (0) > SUPERVISOR (1) > SELLER (2) > CLIENT (3).
 *
 * Así una sola comparación cubre a todos los roles superiores sin tener que
 * agregar SUPERADMIN a mano en cada arreglo de roles permitidos.
 *
 * @param {number|number[]|undefined|null} role
 * @param {number} minimumRole rol menos privilegiado que todavía se acepta
 * @returns {boolean}
 */
export const roleAtLeast = (role, minimumRole) => {
    const minimum = Number(minimumRole);
    if (!Number.isInteger(minimum)) return false;
    return normalizeRoles(role).some((value) => value <= minimum);
};

/**
 * Igual que `roleAtLeast`, pero lee los roles del usuario autenticado.
 * @param {object} req
 * @param {number} minimumRole
 * @returns {boolean}
 */
export const hasRoleAtLeast = (req, minimumRole) =>
    roleAtLeast(req.user?.role, minimumRole);
