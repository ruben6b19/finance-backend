import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { DB_NAME } from "../../constants.js";
import { ROLES, STATUS } from "../../constants/roles.js";
import { STORE_CONFIG_KEY } from "../storeConfig/storeConfig.model.js";
import { TenantMapping } from "./tenantMapping.model.js";
import { Store } from "./store.model.js";
import { getTenantModel, resetTenantConnections } from "./tenantConnection.js";
import { provisionStore } from "./provisioning.service.js";

const TENANT_DB = "tenant_store";
const OTHER_DB = "tenant_other";

let mongoServer;

const centralGetModel = (modelName) => mongoose.model(modelName);
const getStoreModelFor = (dbName) => (modelName) => getTenantModel(dbName, modelName);

const storePayload = { name: "Tienda Norte", currency: "Bs." };
const adminPayload = {
    email: "admin@tiendanorte.com",
    password: "secret123",
    fullName: "Admin Norte"
};

const buildFirebase = ({ uid = "fb-admin", created = true } = {}) => {
    const calls = [];
    const adapter = async (payload) => {
        calls.push(payload);
        return { uid, created, passwordUpdated: false };
    };
    adapter.calls = calls;
    return adapter;
};

const provision = ({
    dbName = TENANT_DB,
    slug,
    store = storePayload,
    admin = adminPayload,
    firebase,
    dryRun = false
} = {}) =>
    provisionStore({
        dbName,
        slug,
        store,
        admin,
        getStoreModel: getStoreModelFor(dbName),
        centralGetModel,
        TenantMapping,
        StoreModel: Store,
        ensureFirebaseUser: firebase,
        dryRun
    });

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), { dbName: DB_NAME });
    await TenantMapping.init();
    await Store.init();
}, 20000);

afterAll(async () => {
    resetTenantConnections();

    const client = mongoose.connection.getClient();
    await mongoose.connection.dropDatabase();
    await client.db(TENANT_DB).dropDatabase();
    await client.db(OTHER_DB).dropDatabase();

    await mongoose.connection.close();
    await mongoServer.stop();
}, 120000);

beforeEach(async () => {
    await TenantMapping.deleteMany({});
    await Store.deleteMany({});
    await mongoose.model("User").deleteMany({});
    await mongoose.model("StoreConfig").deleteMany({});

    for (const dbName of [TENANT_DB, OTHER_DB]) {
        await getTenantModel(dbName, "User").deleteMany({});
        await getTenantModel(dbName, "StoreConfig").deleteMany({});
    }
});

describe("provisionStore", () => {
    it("writes the store, the admin and the central mapping into the store database", async () => {
        const firebase = buildFirebase({ uid: "fb-admin-1" });

        const result = await provision({ firebase });

        expect(result.store.action).toBe("create");
        expect(result.admin).toMatchObject({
            action: "create",
            email: adminPayload.email,
            firebaseUid: "fb-admin-1"
        });
        expect(result.mapping).toMatchObject({
            action: "created",
            email: adminPayload.email,
            dbName: TENANT_DB
        });
        expect(result.registry).toMatchObject({
            action: "created",
            slug: "tienda-norte",
            dbName: TENANT_DB
        });
        expect(result.registry.id).toBeDefined();

        const StoreConfig = getTenantModel(TENANT_DB, "StoreConfig");
        const User = getTenantModel(TENANT_DB, "User");

        const config = await StoreConfig.findOne({ key: STORE_CONFIG_KEY }).lean();
        expect(config.name).toBe("Tienda Norte");

        const admin = await User.findOne({ email: adminPayload.email }).lean();
        expect(admin.role).toEqual([ROLES.ADMIN]);
        expect(admin.firebaseUid).toBe("fb-admin-1");
        expect(admin.status).toBe(STATUS.ACTIVE);

        // The admin and the settings belong to the store, never to the central db.
        expect(await mongoose.model("User").countDocuments()).toBe(0);
        expect(await mongoose.model("StoreConfig").countDocuments()).toBe(0);

        const mapping = await TenantMapping.findOne({ email: adminPayload.email }).lean();
        expect(mapping.dbName).toBe(TENANT_DB);

        const registry = await Store.findOne({ dbName: TENANT_DB }).lean();
        expect(registry).toMatchObject({
            slug: "tienda-norte",
            name: "Tienda Norte",
            status: STATUS.ACTIVE
        });
    });

    it("uses an explicit slug when one is provided", async () => {
        const result = await provision({ firebase: buildFirebase(), slug: "  Digital-Core  " });

        expect(result.registry).toMatchObject({
            action: "created",
            slug: "digital-core",
            dbName: TENANT_DB
        });
        expect(await Store.countDocuments()).toBe(1);
    });

    it("is idempotent: a second run skips the admin and keeps a single mapping", async () => {
        const firebase = buildFirebase();

        await provision({ firebase });
        const second = await provision({ firebase });

        expect(second.store.action).toBe("update");
        expect(second.admin.action).toBe("skip");
        expect(second.mapping.action).toBe("unchanged");
        expect(second.registry.action).toBe("unchanged");
        expect(firebase.calls).toHaveLength(1);

        expect(await getTenantModel(TENANT_DB, "StoreConfig").countDocuments()).toBe(1);
        expect(await getTenantModel(TENANT_DB, "User").countDocuments()).toBe(1);
        expect(await TenantMapping.countDocuments()).toBe(1);
        expect(await Store.countDocuments()).toBe(1);
    });

    it("refuses a slug that already belongs to another database", async () => {
        await Store.create({ slug: "tienda-norte", dbName: OTHER_DB, name: "Otra Tienda" });
        const firebase = buildFirebase();

        await expect(provision({ firebase })).rejects.toThrow(/ya pertenece a la base/);

        expect(firebase.calls).toHaveLength(0);
        expect(await Store.countDocuments()).toBe(1);
        expect(await getTenantModel(TENANT_DB, "StoreConfig").countDocuments()).toBe(0);
    });

    it("refuses to rename a database already registered under another slug", async () => {
        await Store.create({ slug: "otro-slug", dbName: TENANT_DB, name: "Tienda Norte" });
        const firebase = buildFirebase();

        await expect(provision({ firebase })).rejects.toThrow(/ya está registrada con el slug/);

        expect(firebase.calls).toHaveLength(0);
        const registry = await Store.findOne({ dbName: TENANT_DB }).lean();
        expect(registry.slug).toBe("otro-slug");
    });

    it("rejects an empty or invalid slug before writing", async () => {
        const firebase = buildFirebase();

        await expect(provision({ firebase, store: { name: "!!!" } })).rejects.toThrow(/slug/);

        expect(firebase.calls).toHaveLength(0);
        expect(await Store.countDocuments()).toBe(0);
    });

    it("refuses to move an email already assigned to another store", async () => {
        await TenantMapping.create({ email: adminPayload.email, dbName: OTHER_DB });
        const firebase = buildFirebase();

        await expect(provision({ firebase })).rejects.toThrow(/ya está asignado/);

        expect(firebase.calls).toHaveLength(0);
        expect(await getTenantModel(TENANT_DB, "User").countDocuments()).toBe(0);
    });

    it("refuses to provision the global superadmin into a store", async () => {
        await mongoose.model("User").create({
            email: adminPayload.email,
            fullName: "Super Admin",
            role: [ROLES.SUPERADMIN],
            status: STATUS.ACTIVE
        });
        const firebase = buildFirebase();

        await expect(provision({ firebase })).rejects.toThrow(/superadmin global/);

        expect(firebase.calls).toHaveLength(0);
        expect(await getTenantModel(TENANT_DB, "User").countDocuments()).toBe(0);
    });

    it("refuses to convert an internal superadmin account into a store admin", async () => {
        await getTenantModel(TENANT_DB, "User").create({
            email: adminPayload.email,
            fullName: "Interno Tienda",
            role: [ROLES.SUPERADMIN],
            status: STATUS.ACTIVE
        });
        const firebase = buildFirebase();

        await expect(provision({ firebase })).rejects.toThrow(/cuenta interna/);

        expect(firebase.calls).toHaveLength(0);
    });

    it("requires --force to promote an existing non-admin user", async () => {
        await getTenantModel(TENANT_DB, "User").create({
            email: adminPayload.email,
            fullName: "Vendedor Uno",
            role: [ROLES.SELLER],
            status: STATUS.ACTIVE
        });
        const firebase = buildFirebase({ uid: "fb-promoted" });

        await expect(provision({ firebase })).rejects.toThrow(/--force/);
        expect(firebase.calls).toHaveLength(0);

        const promoted = await provision({ firebase, admin: { ...adminPayload, force: true } });

        expect(promoted.admin).toMatchObject({
            action: "promote",
            email: adminPayload.email,
            firebaseUid: "fb-promoted"
        });

        const user = await getTenantModel(TENANT_DB, "User")
            .findOne({ email: adminPayload.email })
            .lean();
        expect(user.role).toEqual([ROLES.ADMIN]);
        expect(user.firebaseUid).toBe("fb-promoted");
        expect(await getTenantModel(TENANT_DB, "User").countDocuments()).toBe(1);
    });

    it("plans without writing when dryRun is set", async () => {
        const firebase = buildFirebase();

        const plan = await provision({ firebase, dryRun: true });

        expect(plan.dryRun).toBe(true);
        expect(plan.store.action).toBe("create");
        expect(plan.admin.action).toBe("create");
        expect(plan.mapping.action).toBe("created");
        expect(plan.registry).toEqual({
            action: "created",
            slug: "tienda-norte",
            dbName: TENANT_DB
        });

        expect(firebase.calls).toHaveLength(0);
        expect(await getTenantModel(TENANT_DB, "StoreConfig").countDocuments()).toBe(0);
        expect(await getTenantModel(TENANT_DB, "User").countDocuments()).toBe(0);
        expect(await TenantMapping.countDocuments()).toBe(0);
        expect(await Store.countDocuments()).toBe(0);
    });

    it("skips the mapping and the registry when provisioning the central database", async () => {
        const firebase = buildFirebase({ uid: "fb-central" });

        const result = await provision({ dbName: DB_NAME, firebase });

        expect(result.mapping.action).toBe("skipped");
        expect(result.mapping.email).toBeNull();
        expect(result.registry).toMatchObject({
            action: "skipped",
            dbName: DB_NAME,
            reason: "central database"
        });
        expect(await TenantMapping.countDocuments()).toBe(0);
        expect(await Store.countDocuments()).toBe(0);
        expect(await mongoose.model("User").countDocuments({ email: adminPayload.email })).toBe(1);
        expect(await mongoose.model("StoreConfig").countDocuments()).toBe(1);
    });

    it("rejects a short admin password before touching the store", async () => {
        const firebase = buildFirebase();

        await expect(
            provision({ firebase, admin: { ...adminPayload, password: "123" } })
        ).rejects.toThrow(/al menos 6/);

        expect(firebase.calls).toHaveLength(0);
        expect(await getTenantModel(TENANT_DB, "StoreConfig").countDocuments()).toBe(0);
    });
});
