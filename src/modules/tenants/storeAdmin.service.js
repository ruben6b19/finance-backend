import { DB_NAME } from "../../constants.js";
import { ROLES, STATUS } from "../../constants/roles.js";
import { validateEmail, validateName } from "../../utils/regex.js";

/**
 * Pre-provisions an internal SUPERADMIN inside an EXISTING store database.
 *
 * The account can be created in two ways:
 * - Email + name only: no Firebase user and no password. It is claimed on the
 *   first Google login by `resolveFirebaseUser`, which binds the verified
 *   `firebaseUid` to the account that already owns the email.
 * - Email + name + password: the password lives in Firebase Auth, and the
 *   resulting `firebaseUid` is bound to the Mongo account right away. This is
 *   what a support account needs to sign in with email/password.
 *
 * Invariants:
 * - The global SUPERADMIN belongs to the central database. It is never
 *   duplicated inside a store, and an email already mapped to a different store
 *   is never moved automatically.
 * - An existing non-empty `firebaseUid` is preserved: an account is never
 *   re-linked to another Firebase user. When a password is given and Firebase
 *   returns a different uid for the email, the run fails instead of hijacking
 *   the account.
 * - The `TenantMapping` is written last, so a failure while writing the user
 *   never routes the email to a store whose account does not exist yet.
 * - `dryRun` returns the plan without touching the database and without calling
 *   Firebase.
 *
 * Models are injected so the caller decides which database each one belongs
 * to: `StoreModel` and `TenantMapping` live in the central database, while
 * `getModel` resolves the store models bound to the target store database.
 *
 * @param {object} options
 * @param {string} [options.storeSlug] Public slug from the central registry (wins over dbName).
 * @param {string} [options.dbName] Store database name, used when no slug is given.
 * @param {string} options.email Email that will own the account; trimmed and lowercased.
 * @param {string} options.fullName Display name; letters and spaces, 2 to 50 chars.
 * @param {string} [options.password] Firebase password, min 6 chars. Binds a Firebase user to the account.
 * @param {boolean} [options.resetPassword=false] Update the Firebase password when the user already exists.
 * @param {object} options.StoreModel Central Store registry model.
 * @param {object} options.TenantMapping Central email -> database mapping model.
 * @param {(modelName: string) => object} options.centralGetModel Central model resolver.
 * @param {(modelName: string) => object} options.getModel Store model resolver bound to the target database.
 * @param {Function} [options.ensureFirebaseUser] Firebase adapter, required when a password is given.
 * @param {boolean} [options.dryRun=false] Build the plan without writing.
 * @returns {Promise<{
 *   dbName: string,
 *   storeSlug: string,
 *   dryRun: boolean,
 *   user: { action: "create" | "update", email: string, fullName: string, id?: string, firebaseUid?: string, link: "linked" | "preserved" | "pending-first-login" },
 *   mapping: { action: "created" | "unchanged", email: string, dbName: string }
 * }>}
 */
export async function createStoreSuperadmin({
    storeSlug,
    dbName,
    email,
    fullName,
    password,
    resetPassword = false,
    StoreModel,
    TenantMapping,
    centralGetModel,
    getModel,
    ensureFirebaseUser,
    dryRun = false
}) {
    if (!StoreModel) {
        throw new Error("createStoreSuperadmin requires the Store model.");
    }
    if (!TenantMapping) {
        throw new Error("createStoreSuperadmin requires the TenantMapping model.");
    }
    if (typeof centralGetModel !== "function") {
        throw new Error("createStoreSuperadmin requires a central model resolver.");
    }
    if (typeof getModel !== "function") {
        throw new Error("createStoreSuperadmin requires a store model resolver.");
    }

    // 1. Input validation. The email is normalized because every lookup
    // (central user, store user, TenantMapping) is keyed by the lowercase form.
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (!validateEmail.test(normalizedEmail)) {
        throw new Error(
            `El email "${String(email ?? "")}" no es válido. Usá un email real, por ejemplo soporte@tienda.com.`
        );
    }

    const normalizedName = typeof fullName === "string" ? fullName.trim() : "";
    if (!validateName.test(normalizedName)) {
        throw new Error(
            `El nombre "${String(fullName ?? "")}" no es válido. Usá solo letras y espacios (2 a 50 caracteres).`
        );
    }

    // A password means "this account signs in with email/password", so a
    // Firebase adapter is mandatory. It is checked even in dry-run: the plan
    // advertises a link, and that link must be achievable in a real run.
    const hasPassword = typeof password === "string" && password.length > 0;
    if (hasPassword) {
        if (typeof ensureFirebaseUser !== "function") {
            throw new Error(
                "createStoreSuperadmin requires a Firebase adapter when a password is provided."
            );
        }
        if (password.length < 6) {
            throw new Error(
                "La contraseña debe tener al menos 6 caracteres. Pasá --password o definí STORE_SUPERADMIN_PASSWORD."
            );
        }
    }

    // 2. Resolve the target store from the central registry.
    const slug = typeof storeSlug === "string" ? storeSlug.trim().toLowerCase() : "";
    const requestedDbName = typeof dbName === "string" ? dbName.trim() : "";

    if (!slug && !requestedDbName) {
        throw new Error("Indicá la tienda: usá --store <slug> o --db-name <base de datos>.");
    }
    if (requestedDbName === DB_NAME) {
        throw centralDatabaseError();
    }

    const store = slug
        ? await StoreModel.findOne({ slug }).lean()
        : await StoreModel.findOne({ dbName: requestedDbName }).lean();

    if (!store) {
        throw new Error(
            `La tienda "${slug || requestedDbName}" no está registrada en el registro central. ` +
            "Ejecutá provision:store primero."
        );
    }
    if (store.status !== STATUS.ACTIVE) {
        throw new Error(
            `La tienda "${store.slug}" no está activa (estado ${store.status}). ` +
            "Ejecutá provision:store para volver a activarla."
        );
    }
    if (slug && requestedDbName && requestedDbName !== store.dbName) {
        throw new Error(
            `La tienda "${store.slug}" usa la base "${store.dbName}", no "${requestedDbName}". ` +
            "Indicá una sola tienda."
        );
    }
    if (store.dbName === DB_NAME) {
        throw centralDatabaseError();
    }

    const targetDbName = store.dbName;

    // 3. The global superadmin is unique: it lives in the central database and
    // must never be duplicated inside a store.
    const CentralUser = centralGetModel("User");
    const centralSuperadmin = await CentralUser.findOne({
        email: normalizedEmail,
        role: ROLES.SUPERADMIN
    }).lean();
    if (centralSuperadmin) {
        throw new Error(
            `El email ${normalizedEmail} pertenece al superadmin global y no se puede duplicar dentro de una tienda.`
        );
    }

    // 4. An email is never moved between stores automatically: that would
    // silently orphan its data in the previous database.
    const existingMapping = await TenantMapping.findOne({ email: normalizedEmail }).lean();
    if (existingMapping && existingMapping.dbName !== targetDbName) {
        throw new Error(
            `El email ${normalizedEmail} ya está asignado a la base "${existingMapping.dbName}". ` +
            "No se mueve automáticamente entre tiendas."
        );
    }

    // 5. Read the store account. A missing user is created; an existing one is
    // updated. Its firebaseUid is preserved unless this run supplies a password
    // and Firebase returns the very same uid (or the account had none yet).
    const User = getModel("User");

    // Create the collection and its indexes before reading so the first run is
    // deterministic and the unique email index is in place.
    if (!dryRun) {
        await User.init();
    }

    const existingUser = await User.findOne({ email: normalizedEmail }).lean();
    const existingFirebaseUid = readFirebaseUid(existingUser);

    // A password means the account signs in with email/password: resolve the
    // Firebase user now so its uid can be bound. Dry-run never calls Firebase;
    // it just reports that the run would link the account.
    let resolvedFirebaseUid = existingFirebaseUid;
    let link;
    if (hasPassword) {
        if (dryRun) {
            link = "linked";
        } else {
            const firebase = await ensureFirebaseUser({
                email: normalizedEmail,
                password,
                fullName: normalizedName,
                resetPassword: Boolean(resetPassword)
            });
            resolvedFirebaseUid = firebase.uid;

            // Re-linking an account to a different Firebase user would hijack
            // it, so a mismatch is a hard error before anything is written.
            if (existingFirebaseUid && existingFirebaseUid !== resolvedFirebaseUid) {
                throw new Error(
                    `La cuenta ${normalizedEmail} ya está vinculada al firebaseUid "${existingFirebaseUid}" ` +
                    `y Firebase devolvió "${resolvedFirebaseUid}" para ese email. ` +
                    "No se re-vincula automáticamente."
                );
            }
            link = "linked";
        }
    } else {
        link = existingFirebaseUid ? "preserved" : "pending-first-login";
    }

    const userAction = existingUser ? "update" : "create";

    // 6. The mapping is only "created" when the email is unknown; a mapping that
    // already points at this database needs no write.
    const mappingAction = existingMapping ? "unchanged" : "created";

    const plan = {
        dbName: targetDbName,
        storeSlug: store.slug,
        dryRun: Boolean(dryRun),
        user: {
            action: userAction,
            email: normalizedEmail,
            fullName: normalizedName,
            ...(existingUser ? { id: String(existingUser._id) } : {}),
            ...(resolvedFirebaseUid ? { firebaseUid: resolvedFirebaseUid } : {}),
            link
        },
        mapping: {
            action: mappingAction,
            email: normalizedEmail,
            dbName: targetDbName
        }
    };

    // 7. Dry-run stops here: nothing below writes.
    if (dryRun) return plan;

    // 8. Write the store account first. With a password the resolved uid is
    // bound (created, or updated only when it differs); without one the
    // existing uid is left untouched, and a banned account is reactivated on
    // purpose because this is an explicit operator action.
    let userOutcome;
    if (existingUser) {
        const update = {
            fullName: normalizedName,
            role: [ROLES.SUPERADMIN],
            status: STATUS.ACTIVE
        };
        if (hasPassword && resolvedFirebaseUid && resolvedFirebaseUid !== existingFirebaseUid) {
            update.firebaseUid = resolvedFirebaseUid;
        }
        await User.updateOne({ _id: existingUser._id }, { $set: update });
        userOutcome = plan.user;
    } else {
        const created = await User.create({
            email: normalizedEmail,
            fullName: normalizedName,
            ...(hasPassword && resolvedFirebaseUid ? { firebaseUid: resolvedFirebaseUid } : {}),
            role: [ROLES.SUPERADMIN],
            status: STATUS.ACTIVE
        });
        userOutcome = { ...plan.user, id: String(created._id) };
    }

    // 9. The central mapping goes last: only once the account exists does it
    // make sense to route this email to the store database.
    const mapping = await TenantMapping.findOneAndUpdate(
        { email: normalizedEmail },
        { $set: { dbName: targetDbName } },
        { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );

    return {
        dbName: targetDbName,
        storeSlug: store.slug,
        dryRun: false,
        user: userOutcome,
        mapping: {
            action: mappingAction,
            email: mapping.email,
            dbName: mapping.dbName
        }
    };
}

const centralDatabaseError = () => new Error(
    `La base "${DB_NAME}" es la base central y no una tienda. ` +
    "Usá create:superadmin para el superadmin global."
);

/**
 * Returns the firebaseUid only when it is a non-empty string, so `null`, an
 * empty string and an absent field all count as "still pending the first login".
 * @param {object|null|undefined} user
 * @returns {string}
 */
const readFirebaseUid = (user) => {
    const value = user?.firebaseUid;
    return typeof value === "string" && value.trim() !== "" ? value : "";
};
