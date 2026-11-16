import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { DB_NAME } from "../../constants.js";
import { ROLES, STATUS } from "../../constants/roles.js";
import { TenantMapping } from "./tenantMapping.model.js";
import { Store } from "./store.model.js";
import { getTenantModel, resetTenantConnections } from "./tenantConnection.js";
import { createStoreSuperadmin } from "./storeAdmin.service.js";

const TENANT_DB = "tenant_store_admin";
const OTHER_DB = "tenant_store_admin_other";
const STORE_SLUG = "digital-core";
const ADMIN_EMAIL = "soporte@digitalcore.com";
const ADMIN_NAME = "Soporte Digital";

let mongoServer;

const centralGetModel = (modelName) => mongoose.model(modelName);
const getStoreModelFor = (dbName) => (modelName) => getTenantModel(dbName, modelName);

const storeUser = (query = {}) => getTenantModel(TENANT_DB, "User").findOne(query);

const registerStore = (overrides = {}) =>
    Store.create({
        slug: STORE_SLUG,
        dbName: TENANT_DB,
        name: "Digital Core",
        status: STATUS.ACTIVE,
        ...overrides
    });

const createAdmin = (overrides = {}) =>
    createStoreSuperadmin({
        storeSlug: STORE_SLUG,
        email: ADMIN_EMAIL,
        fullName: ADMIN_NAME,
        StoreModel: Store,
        TenantMapping,
        centralGetModel,
        getModel: getStoreModelFor(TENANT_DB),
        ...overrides
    });

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), { dbName: DB_NAME });
    await Promise.all([
        TenantMapping.init(),
        Store.init(),
        getTenantModel(TENANT_DB, "User").init(),
        getTenantModel(OTHER_DB, "User").init()
    ]);
}, 20000);

afterAll(async () => {
    const client = mongoose.connection.getClient();
    resetTenantConnections();

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
    await getTenantModel(TENANT_DB, "User").deleteMany({});
    await getTenantModel(OTHER_DB, "User").deleteMany({});
});

describe("createStoreSuperadmin", () => {
    it("creates a pre-provisioned superadmin with no firebaseUid and registers the mapping", async () => {
        await registerStore();

        const result = await createAdmin({ email: "  Soporte@DigitalCore.com  " });

        expect(result).toMatchObject({
            dbName: TENANT_DB,
            storeSlug: STORE_SLUG,
            dryRun: false
        });
        expect(result.user).toMatchObject({
            action: "create",
            email: ADMIN_EMAIL,
            fullName: ADMIN_NAME,
            link: "pending-first-login"
        });
        expect(result.user.id).toBeDefined();
        expect(result.user.firebaseUid).toBeUndefined();
        expect(result.mapping).toEqual({
            action: "created",
            email: ADMIN_EMAIL,
            dbName: TENANT_DB
        });

        const user = await storeUser({ email: ADMIN_EMAIL }).lean();
        expect(user.role).toEqual([ROLES.SUPERADMIN]);
        expect(user.status).toBe(STATUS.ACTIVE);
        expect(user.firebaseUid).toBeUndefined();

        // The account lives in the store, never in the central database.
        expect(await mongoose.model("User").countDocuments()).toBe(0);

        const mapping = await TenantMapping.findOne({ email: ADMIN_EMAIL }).lean();
        expect(mapping.dbName).toBe(TENANT_DB);
    });

    it("is idempotent: a second run updates the same user and keeps a single mapping", async () => {
        await registerStore();

        const first = await createAdmin();
        const second = await createAdmin({ fullName: "Soporte Digital Dos" });

        expect(second.user.action).toBe("update");
        expect(second.user.link).toBe("pending-first-login");
        expect(second.user.id).toBe(first.user.id);
        expect(second.mapping.action).toBe("unchanged");

        const user = await storeUser({ email: ADMIN_EMAIL }).lean();
        expect(user.fullName).toBe("Soporte Digital Dos");
        expect(user.role).toEqual([ROLES.SUPERADMIN]);
        expect(await getTenantModel(TENANT_DB, "User").countDocuments()).toBe(1);
        expect(await TenantMapping.countDocuments()).toBe(1);
    });

    it("promotes an existing store user but preserves its firebaseUid", async () => {
        await registerStore();
        const existing = await getTenantModel(TENANT_DB, "User").create({
            email: ADMIN_EMAIL,
            fullName: "Soporte Viejo",
            firebaseUid: "fb-existing",
            role: [ROLES.SELLER],
            status: STATUS.ACTIVE
        });

        const result = await createAdmin();

        expect(result.user).toMatchObject({
            action: "update",
            id: String(existing._id),
            firebaseUid: "fb-existing",
            link: "preserved"
        });

        const user = await storeUser({ _id: existing._id }).lean();
        expect(user.firebaseUid).toBe("fb-existing");
        expect(user.role).toEqual([ROLES.SUPERADMIN]);
        expect(user.fullName).toBe(ADMIN_NAME);
    });

    it("resolves the store by database name when no slug is given", async () => {
        await registerStore();

        const result = await createAdmin({ storeSlug: undefined, dbName: TENANT_DB });

        expect(result.storeSlug).toBe(STORE_SLUG);
        expect(result.dbName).toBe(TENANT_DB);
        expect(await getTenantModel(TENANT_DB, "User").countDocuments()).toBe(1);
    });

    it("refuses a store that is not in the central registry", async () => {
        await expect(createAdmin()).rejects.toThrow(/provision:store/);

        expect(await getTenantModel(TENANT_DB, "User").countDocuments()).toBe(0);
        expect(await TenantMapping.countDocuments()).toBe(0);
    });

    it("refuses an inactive store", async () => {
        await registerStore({ status: STATUS.INACTIVE });

        await expect(createAdmin()).rejects.toThrow(/no está activa/);

        expect(await getTenantModel(TENANT_DB, "User").countDocuments()).toBe(0);
    });

    it("refuses the central database", async () => {
        await expect(createAdmin({ storeSlug: undefined, dbName: DB_NAME })).rejects.toThrow(/base central/);
        await expect(createAdmin({ storeSlug: undefined, dbName: DB_NAME })).rejects.toThrow(/create:superadmin/);

        expect(await mongoose.model("User").countDocuments()).toBe(0);
        expect(await TenantMapping.countDocuments()).toBe(0);
    });

    it("refuses an email already mapped to another store", async () => {
        await registerStore();
        await TenantMapping.create({ email: ADMIN_EMAIL, dbName: OTHER_DB });

        await expect(createAdmin()).rejects.toThrow(/ya está asignado/);

        expect(await getTenantModel(TENANT_DB, "User").countDocuments()).toBe(0);
        const mapping = await TenantMapping.findOne({ email: ADMIN_EMAIL }).lean();
        expect(mapping.dbName).toBe(OTHER_DB);
    });

    it("refuses an email that belongs to the central superadmin", async () => {
        await registerStore();
        await mongoose.model("User").create({
            email: ADMIN_EMAIL,
            fullName: "Super Admin",
            role: [ROLES.SUPERADMIN],
            status: STATUS.ACTIVE
        });

        await expect(createAdmin()).rejects.toThrow(/superadmin global/);

        expect(await getTenantModel(TENANT_DB, "User").countDocuments()).toBe(0);
        expect(await TenantMapping.countDocuments()).toBe(0);
    });

    it("rejects an invalid email or name before touching the database", async () => {
        await registerStore();

        await expect(createAdmin({ email: "no-es-un-email" })).rejects.toThrow(/email/);
        await expect(createAdmin({ fullName: "A" })).rejects.toThrow(/nombre/);

        expect(await getTenantModel(TENANT_DB, "User").countDocuments()).toBe(0);
        expect(await TenantMapping.countDocuments()).toBe(0);
    });

    it("plans without writing when dryRun is set", async () => {
        await registerStore();

        const plan = await createAdmin({ dryRun: true });

        expect(plan.dryRun).toBe(true);
        expect(plan.user).toMatchObject({
            action: "create",
            email: ADMIN_EMAIL,
            fullName: ADMIN_NAME,
            link: "pending-first-login"
        });
        expect(plan.user.id).toBeUndefined();
        expect(plan.mapping.action).toBe("created");

        expect(await getTenantModel(TENANT_DB, "User").countDocuments()).toBe(0);
        expect(await TenantMapping.countDocuments()).toBe(0);
        expect(await Store.countDocuments()).toBe(1);
    });
});
