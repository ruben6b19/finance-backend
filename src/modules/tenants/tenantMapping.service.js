import { TenantMapping } from "./tenantMapping.model.js";
import { DB_NAME } from "../../constants.js";

const normalizeEmail = (email) => {
    return typeof email === "string" ? email.trim().toLowerCase() : "";
};

/**
 * Returns the database name assigned to the given email, or null when the
 * email is missing or has no mapping.
 */
export const getTenantDbNameByEmail = async (email) => {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;

    const mapping = await TenantMapping.findOne({ email: normalized }).select("dbName").lean();
    return mapping?.dbName || null;
};

/**
 * Resolves the database name for an email, falling back to the central
 * database when the email has no mapping. This keeps existing users working
 * while tenants are provisioned gradually.
 */
export const resolveTenantDbName = async (email, fallback = DB_NAME) => {
    const dbName = await getTenantDbNameByEmail(email);
    return dbName || fallback;
};
