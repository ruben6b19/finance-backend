import { User } from "./user.model.js";
import { ROLES, STATUS } from "../../constants/roles.js";
import { validateName } from "../../utils/regex.js";

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
 */
export async function resolveFirebaseUser({ firebaseUid, email, name }) {
  if (!firebaseUid) return { error: "missing_uid" };
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!normalizedEmail) return { error: "missing_email" };

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
    role: Array.isArray(user.role) ? user.role : [user.role],
    status: user.status,
  };
}
