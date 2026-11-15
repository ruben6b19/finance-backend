import { ROLES, STATUS } from "../../constants/roles.js";
import { validateName } from "../../utils/regex.js";
import { toClientRoleList } from "./user.policy.js";

const FALLBACK_NAME = "Cliente";

function sanitizeName(raw) {
  const value = typeof raw === "string" ? raw : "";
  const cleaned = value
    .replace(/[^-'a-zA-ZñÑáéíóúÁÉÍÓÚ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return validateName.test(cleaned) ? cleaned : "";
}

function nameFromEmail(email) {
  const local = String(email || "").split("@")[0] || "";
  const cleaned = local
    .replace(/[^a-zA-ZñÑáéíóúÁÉÍÓÚ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return validateName.test(cleaned) ? cleaned : FALLBACK_NAME;
}

/**
 * Finds the Mongo user bound to a Firebase account, creating it on first login.
 * New users are always CLIENT, never the schema default SELLER.
 *
 * The User model is tenant-scoped: the caller passes the resolver bound to the
 * request database so the profile lives in the same database as the rest of the
 * user's data.
 */
export async function resolveFirebaseUser({ firebaseUid, email, name, getModel }) {
  if (!firebaseUid) return { error: "missing_uid" };
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!normalizedEmail) return { error: "missing_email" };
  if (typeof getModel !== "function") {
    throw new Error("resolveFirebaseUser requires a tenant model resolver.");
  }

  const User = getModel("User");

  const existing = await User.findOne({ firebaseUid });
  if (existing) return { user: existing };

  const fullName = sanitizeName(name) || nameFromEmail(normalizedEmail);

  try {
    const user = await User.create({
      email: normalizedEmail,
      fullName,
      firebaseUid,
      role: [ROLES.CLIENT],
      status: STATUS.ACTIVE,
    });
    return { user };
  } catch (error) {
    if (error?.code === 11000) {
      const user = await User.findOne({ firebaseUid });
      if (user) return { user };
    }
    return { error: "create_failed" };
  }
}

export function toPublicUser(user) {
  return {
    id: String(user._id),
    email: user.email,
    fullName: user.fullName,
    phone: user.phone || '',
    // El rol interno nunca llega a la app: SUPERADMIN se presenta como ADMIN.
    role: toClientRoleList(user.role),
    status: user.status,
  };
}
