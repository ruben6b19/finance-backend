import { STATUS } from "../../constants/roles.js";
import { Store } from "./store.model.js";

// A slug is the public, URL-safe identifier a client sends in X-Store.
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const MIN_SLUG_LENGTH = 2;
const MAX_SLUG_LENGTH = 48;

/**
 * true only for a lowercase slug that matches SLUG_PATTERN and is 2 to 48
 * characters long.
 * @param {unknown} value
 * @returns {boolean}
 */
export const isValidSlug = (value) => {
    if (typeof value !== "string") return false;
    if (value.length < MIN_SLUG_LENGTH || value.length > MAX_SLUG_LENGTH) return false;
    return SLUG_PATTERN.test(value);
};

/**
 * Builds a slug from a free-form value (usually the store name): strips
 * diacritics, lowercases, turns any run of characters outside [a-z0-9] into a
 * single "-" and trims the leading/trailing ones.
 *
 * Returns "" when nothing usable remains, so callers must validate the result
 * with isValidSlug before persisting it.
 * @param {unknown} value
 * @returns {string}
 */
export const slugify = (value) => {
    const raw = typeof value === "string" ? value : "";

    return raw
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
};

/**
 * Returns the ACTIVE store registered for the given slug as a lean object, or
 * null when the slug is empty or unknown. Database failures are not swallowed:
 * callers decide how to report them.
 * @param {unknown} slug
 * @returns {Promise<{ slug: string, dbName: string, name: string, status: number } | null>}
 */
export const findStoreBySlug = async (slug) => {
    const normalized = typeof slug === "string" ? slug.trim().toLowerCase() : "";
    if (!normalized) return null;

    const store = await Store.findOne({ slug: normalized, status: STATUS.ACTIVE })
        .select("slug dbName name status")
        .lean();

    if (!store) return null;

    return {
        slug: store.slug,
        dbName: store.dbName,
        name: store.name,
        status: store.status
    };
};
