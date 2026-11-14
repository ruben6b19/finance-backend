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
