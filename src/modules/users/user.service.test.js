import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { DB_NAME } from "../../constants.js";
import { ROLES, STATUS } from "../../constants/roles.js";
import { getTenantModel, resetTenantConnections } from "../tenants/tenantConnection.js";
import { resolveFirebaseUser } from "./user.service.js";

const TENANT_DB = "tenant_user_service";

let mongoServer;

const getModel = (modelName) => getTenantModel(TENANT_DB, modelName);
const tenantUser = (query = {}) => getTenantModel(TENANT_DB, "User").findOne(query);

const resolve = (overrides = {}) =>
    resolveFirebaseUser({
        firebaseUid: "uid-nuevo",
        email: "soporte@digitalcore.com",
        name: "Soporte Digital",
        getModel,
        ...overrides
    });

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), { dbName: DB_NAME });
    await getTenantModel(TENANT_DB, "User").init();
}, 20000);

afterAll(async () => {
    const client = mongoose.connection.getClient();
    resetTenantConnections();

    await mongoose.connection.dropDatabase();
    await client.db(TENANT_DB).dropDatabase();

    await mongoose.connection.close();
    await mongoServer.stop();
}, 60000);

beforeEach(async () => {
    await getTenantModel(TENANT_DB, "User").deleteMany({});
    await mongoose.model("User").deleteMany({});
});

describe("resolveFirebaseUser", () => {
    it("claims a pre-provisioned account on the first login and keeps SUPERADMIN", async () => {
        const preProvisioned = await getTenantModel(TENANT_DB, "User").create({
            email: "soporte@digitalcore.com",
            fullName: "Soporte Digital",
            role: [ROLES.SUPERADMIN],
            status: STATUS.ACTIVE
        });

        const { user, error } = await resolve();

        expect(error).toBeUndefined();
        expect(String(user._id)).toBe(String(preProvisioned._id));
        expect(user.firebaseUid).toBe("uid-nuevo");
        expect(user.role).toEqual([ROLES.SUPERADMIN]);
        expect(user.status).toBe(STATUS.ACTIVE);

        // Claimed, not duplicated.
        expect(await getTenantModel(TENANT_DB, "User").countDocuments()).toBe(1);
    });

    it("claims a banned pre-provisioned account without reactivating it", async () => {
        await getTenantModel(TENANT_DB, "User").create({
            email: "soporte@digitalcore.com",
            fullName: "Soporte Digital",
            role: [ROLES.SUPERADMIN],
            status: STATUS.BANNED
        });

        const { user } = await resolve();

        expect(user.firebaseUid).toBe("uid-nuevo");
        expect(user.role).toEqual([ROLES.SUPERADMIN]);
        expect(user.status).toBe(STATUS.BANNED);
    });

    it("never re-links an account that already has another firebaseUid", async () => {
        const taken = await getTenantModel(TENANT_DB, "User").create({
            email: "tomado@tienda.test",
            fullName: "Cuenta Tomada",
            firebaseUid: "uid-otro",
            role: [ROLES.SELLER],
            status: STATUS.ACTIVE
        });

        // Same email, different Firebase user: the account is not claimed.
        const collision = await resolve({ firebaseUid: "uid-nuevo", email: "tomado@tienda.test" });

        expect(collision.error).toBe("create_failed");
        expect(collision.user).toBeUndefined();

        const untouched = await tenantUser({ _id: taken._id }).lean();
        expect(untouched.firebaseUid).toBe("uid-otro");
        expect(untouched.role).toEqual([ROLES.SELLER]);
        expect(await getTenantModel(TENANT_DB, "User").countDocuments()).toBe(1);

        // A different email is a different person: it gets its own account.
        const { user } = await resolve({ firebaseUid: "uid-nuevo", email: "otro@tienda.test" });

        expect(String(user._id)).not.toBe(String(taken._id));
        expect(user.role).toEqual([ROLES.CLIENT]);
        expect(await getTenantModel(TENANT_DB, "User").countDocuments()).toBe(2);
    });

    it("creates a brand-new account as CLIENT for an email nobody pre-provisioned", async () => {
        const { user } = await resolve({
            firebaseUid: "uid-cliente",
            email: "cliente@nuevo.test",
            name: "Cliente Nuevo"
        });

        expect(user.role).toEqual([ROLES.CLIENT]);
        expect(user.status).toBe(STATUS.ACTIVE);
        expect(user.firebaseUid).toBe("uid-cliente");

        const stored = await tenantUser({ firebaseUid: "uid-cliente" }).lean();
        expect(stored.role).toEqual([ROLES.CLIENT]);
    });

    it("keeps resolving an account already bound to the signing-in firebaseUid", async () => {
        const existing = await getTenantModel(TENANT_DB, "User").create({
            email: "cliente@nuevo.test",
            fullName: "Cliente Existente",
            firebaseUid: "uid-nuevo",
            role: [ROLES.SELLER],
            status: STATUS.ACTIVE
        });

        const { user } = await resolve({ email: "otro-email@nuevo.test" });

        expect(String(user._id)).toBe(String(existing._id));
        expect(user.role).toEqual([ROLES.SELLER]);
        expect(await getTenantModel(TENANT_DB, "User").countDocuments()).toBe(1);
    });
});
