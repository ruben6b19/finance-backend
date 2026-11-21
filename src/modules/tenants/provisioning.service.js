import { DB_NAME } from "../../constants.js";
import { ROLES, STATUS } from "../../constants/roles.js";
import { normalizeRoles } from "../../utils/roles.js";
import { validateEmail, validateName } from "../../utils/regex.js";
import { STORE_CONFIG_KEY } from "../storeConfig/storeConfig.model.js";
import { STORE_SCHEDULE_KEY } from "../storeConfig/storeSchedule.model.js";
import { DEFAULT_TIME_ZONE } from "../../utils/boliviaTime.js";
import { isValidSlug, slugify } from "./store.service.js";

/**
 * Provisions a store: the singleton StoreConfig, its StoreSchedule and its
 * first admin in the store database, plus the central email -> database mapping
 * and the central slug -> database registry.
 *
 * Models and the Firebase adapter are injected so the flow is testable and so
 * the caller decides which database each model belongs to.
 *
 * Returns a summary describing what was created, updated or skipped. Throws on
 * any inconsistency (a superadmin being moved into a store, an email already
 * assigned to another store, a missing admin password, a slug conflict, ...).
 */
export async function provisionStore({
    dbName,
    slug,
    store,
    admin = {},
    getStoreModel,
    centralGetModel,
    TenantMapping,
    StoreModel,
    ensureFirebaseUser,
    scheduleTimezone = "",
    dryRun = false
}) {
    if (!dbName) {
        throw new Error("Falta el nombre de la base de la tienda.");
    }
    if (typeof getStoreModel !== "function") {
        throw new Error("provisionStore requires a store model resolver.");
    }
    if (typeof centralGetModel !== "function") {
        throw new Error("provisionStore requires a central model resolver.");
    }
    if (!TenantMapping) {
        throw new Error("provisionStore requires the TenantMapping model.");
    }
    if (!StoreModel) {
        throw new Error("provisionStore requires the Store model.");
    }
    if (!dryRun && typeof ensureFirebaseUser !== "function") {
        throw new Error("provisionStore requires a Firebase adapter.");
    }

    const StoreConfig = getStoreModel("StoreConfig");
    const StoreSchedule = getStoreModel("StoreSchedule");
    const User = getStoreModel("User");

    // Create the store collections before reading so the first run is
    // deterministic: a read never creates a database.
    if (!dryRun) {
        await Promise.all([StoreConfig.init(), StoreSchedule.init(), User.init()]);
    }

    const existingStore = await StoreConfig.findOne({ key: STORE_CONFIG_KEY }).lean();
    const existingAdmin = await User.findOne({ role: ROLES.ADMIN });
    const existingEmail = !existingAdmin && admin.email
        ? await User.findOne({ email: admin.email })
        : null;

    // The superadmin is global: it must stay in the central database. Mapping
    // it into a store would make its central account unreachable. Only checked
    // when this run would create or promote the admin, so an idempotent re-run
    // that passes an unrelated --admin-email is not blocked.
    if (!existingAdmin && dbName !== DB_NAME && admin.email) {
        const CentralUser = centralGetModel("User");
        const centralSuperadmin = await CentralUser.findOne({
            email: admin.email,
            role: ROLES.SUPERADMIN
        }).lean();
        if (centralSuperadmin) {
            throw new Error(
                `El email ${admin.email} pertenece al superadmin global y no se puede aprovisionar dentro de una tienda.`
            );
        }
    }

    if (existingEmail && hasSuperadminRole(existingEmail)) {
        throw new Error(
            `El email ${existingEmail.email} es una cuenta interna y no se puede convertir en administrador de tienda.`
        );
    }

    // Never move an email between stores: that would silently orphan its data.
    const mappedEmail = existingAdmin ? existingAdmin.email : admin.email;
    let mappingAction = "skipped";
    if (dbName !== DB_NAME && mappedEmail) {
        const currentMapping = await TenantMapping.findOne({ email: mappedEmail }).lean();
        if (currentMapping && currentMapping.dbName !== dbName) {
            throw new Error(
                `El email ${mappedEmail} ya está asignado a la base "${currentMapping.dbName}". ` +
                "No se mueve automáticamente entre tiendas."
            );
        }
        mappingAction = currentMapping ? "unchanged" : "created";
    }

    // Admin credentials are only required when there is no admin yet, so
    // store-only re-runs stay simple. Dry-run never validates secrets.
    if (!existingAdmin && !dryRun) {
        validateAdminInput(admin);
        if (existingEmail && !admin.force) {
            throw new Error(
                `Ya existe un usuario con el email ${admin.email} y no es administrador. ` +
                "Volvé a ejecutar con --force para convertirlo, o usá otro email con --admin-email."
            );
        }
    }

    // The central store registry maps the public slug (X-Store header) to the
    // database. The central database is not a store, so it is skipped there.
    // A registered database is never renamed automatically: changing its slug
    // would silently break every client already pointing at the old one.
    const resolvedSlug = slug ? String(slug).trim().toLowerCase() : slugify(store?.name ?? "");
    let registryAction = "skipped";
    if (dbName !== DB_NAME) {
        if (!isValidSlug(resolvedSlug)) {
            throw new Error(
                `El slug "${resolvedSlug}" no es válido. Usá de 2 a 48 caracteres en minúsculas ` +
                "(a-z, 0-9 y guiones)."
            );
        }

        const byDbName = await StoreModel.findOne({ dbName }).lean();
        const bySlug = await StoreModel.findOne({ slug: resolvedSlug }).lean();

        if (byDbName && byDbName.slug !== resolvedSlug) {
            throw new Error(
                `La base "${dbName}" ya está registrada con el slug "${byDbName.slug}". ` +
                "Un slug no se renombra automáticamente."
            );
        }
        if (bySlug && bySlug.dbName !== dbName) {
            throw new Error(
                `El slug "${resolvedSlug}" ya pertenece a la base "${bySlug.dbName}".`
            );
        }

        registryAction = byDbName ? "unchanged" : "created";
    }

    const registryPlan = {
        action: registryAction,
        slug: resolvedSlug,
        dbName
    };
    if (dbName === DB_NAME) {
        registryPlan.reason = "central database";
    }

    const plan = {
        dbName,
        dryRun,
        store: { action: existingStore ? "update" : "create" },
        admin: existingAdmin
            ? { action: "skip", email: existingAdmin.email, id: String(existingAdmin._id) }
            : existingEmail
                ? { action: admin.force ? "promote" : "requires-force", email: existingEmail.email, id: String(existingEmail._id) }
                : { action: "create", email: admin.email },
        mapping: {
            action: mappingAction,
            email: dbName === DB_NAME ? null : (mappedEmail || null),
            dbName
        },
        registry: registryPlan
    };

    if (dryRun) return plan;

    // 1. Store settings in the store database.
    const storeDoc = await StoreConfig.findOneAndUpdate(
        { key: STORE_CONFIG_KEY },
        { $set: store },
        { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );

    // 1b. The schedule owns the timezone now. Stores provisioned before this
    // feature still have a legacy StoreConfig.timezone that Mongoose no longer
    // maps, so it is read through the native collection. An existing schedule
    // is never overwritten, and a failed read must not fail provisioning.
    let initialTimeZone = DEFAULT_TIME_ZONE;
    try {
        const rawStore = await StoreConfig.collection.findOne(
            { key: STORE_CONFIG_KEY },
            { projection: { timezone: 1 } }
        );
        for (const candidate of [rawStore?.timezone, scheduleTimezone]) {
            if (typeof candidate !== "string" || candidate.trim() === "") continue;
            try {
                new Intl.DateTimeFormat("en", { timeZone: candidate.trim() });
                initialTimeZone = candidate.trim();
                break;
            } catch (error) {
                // Ignore invalid legacy values and keep the next candidate.
            }
        }
    } catch (error) {
        console.warn("[schedule] could not read the legacy timezone:", error?.message);
    }

    await StoreSchedule.updateOne(
        { key: STORE_SCHEDULE_KEY },
        { $setOnInsert: { timezone: initialTimeZone } },
        { upsert: true }
    );

    // 2. First admin in the store database.
    let adminOutcome;
    if (existingAdmin) {
        adminOutcome = {
            action: "skip",
            email: existingAdmin.email,
            id: String(existingAdmin._id)
        };
    } else {
        const firebase = await ensureFirebaseUser({
            email: admin.email,
            password: admin.password,
            fullName: admin.fullName,
            resetPassword: Boolean(admin.resetPassword)
        });

        if (existingEmail) {
            await User.updateOne(
                { _id: existingEmail._id },
                { $set: { role: [ROLES.ADMIN], firebaseUid: firebase.uid, status: STATUS.ACTIVE } }
            );
            adminOutcome = {
                action: "promote",
                email: existingEmail.email,
                id: String(existingEmail._id),
                firebaseUid: firebase.uid,
                firebaseCreated: Boolean(firebase.created)
            };
        } else {
            const created = await User.create({
                email: admin.email,
                fullName: admin.fullName,
                firebaseUid: firebase.uid,
                role: [ROLES.ADMIN],
                status: STATUS.ACTIVE
            });
            adminOutcome = {
                action: "create",
                email: admin.email,
                id: String(created._id),
                firebaseUid: firebase.uid,
                firebaseCreated: Boolean(firebase.created)
            };
        }
    }

    // 3. Central mapping: it only becomes useful once the admin exists.
    let mappingOutcome = { action: "skipped", email: null, dbName, reason: "central database" };
    if (dbName !== DB_NAME) {
        const email = adminOutcome.email;
        const mapping = await TenantMapping.findOneAndUpdate(
            { email },
            { $set: { dbName } },
            { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
        );
        mappingOutcome = { action: mappingAction, email: mapping.email, dbName: mapping.dbName };
    }

    // 4. Central store registry last: a client can only reach the store once the
    // store itself and its mapping exist.
    let registryOutcome = {
        action: "skipped",
        slug: resolvedSlug,
        dbName,
        reason: "central database"
    };
    if (dbName !== DB_NAME) {
        const registry = await StoreModel.findOneAndUpdate(
            { dbName },
            { $set: { slug: resolvedSlug, name: store.name, status: STATUS.ACTIVE } },
            { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
        );
        registryOutcome = {
            action: registryAction,
            slug: registry.slug,
            dbName: registry.dbName,
            id: String(registry._id)
        };
    }

    return {
        dbName,
        dryRun: false,
        store: { action: existingStore ? "update" : "create", id: String(storeDoc._id) },
        admin: adminOutcome,
        mapping: mappingOutcome,
        registry: registryOutcome
    };
}

function hasSuperadminRole(user) {
    return normalizeRoles(user?.role).includes(ROLES.SUPERADMIN);
}

function validateAdminInput({ email, password, fullName }) {
    if (!validateEmail.test(String(email || ""))) {
        throw new Error("Falta un email válido para el administrador. Pasá --admin-email o definí STORE_ADMIN_EMAIL.");
    }
    if (String(password || "").length < 6) {
        throw new Error("La contraseña del administrador debe tener al menos 6 caracteres. Pasá --admin-password o definí STORE_ADMIN_PASSWORD.");
    }
    if (!validateName.test(String(fullName || ""))) {
        throw new Error(`El nombre del administrador "${fullName}" no es válido. Usá solo letras y espacios (2 a 50 caracteres).`);
    }
}
