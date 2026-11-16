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

  // A pre-provisioned account (create:store-superadmin) already owns the email
  // but has no firebaseUid yet. Claiming it here is safe because Firebase has
  // already verified that the signing-in user owns that email address. The
  // claim only sets firebaseUid: it never touches status or role, so a banned
  // account stays banned and the pre-provisioned SUPERADMIN role survives.
  const unlinked = { $or: [{ firebaseUid: { $exists: false } }, { firebaseUid: null }] };
  const pending = await User.findOne({ email: normalizedEmail, ...unlinked });
  if (pending) {
    const claimed = await User.findOneAndUpdate(
      { _id: pending._id, ...unlinked },
      { $set: { firebaseUid } },
      { new: true }
    );
    // A lost race (null) falls through to the create path, whose 11000
    // recovery handles the account that won it.
    if (claimed) return { user: claimed };
  }

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
