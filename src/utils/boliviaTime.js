// Bolivia es UTC-4 durante todo el año (no aplica horario de verano).
export const BOLIVIA_OFFSET_MS = 4 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Número de día (UTC) que representa la fecha calendario en Bolivia.
 * @returns {number|null} null si la fecha no es válida.
 */
export const boliviaDayNumber = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const shifted = new Date(date.getTime() - BOLIVIA_OFFSET_MS);
    return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
};

/**
 * Días calendario transcurridos en Bolivia entre `date` y `now`.
 * Negativo cuando la fecha es futura.
 * @returns {number|null} null si alguna de las dos fechas no es válida.
 */
export const daysElapsedInBolivia = (date, now = new Date()) => {
    const target = boliviaDayNumber(date);
    const today = boliviaDayNumber(now);
    if (target === null || today === null) return null;
    return Math.round((today - target) / DAY_MS);
};
