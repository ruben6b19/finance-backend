import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { registerOrGetGoogleUser } from "./google.controller.js";
import { TenantMapping } from "../tenants/tenantMapping.model.js";
import { getTenantModel, resetTenantConnections } from "../tenants/tenantConnection.js";
import { DB_NAME } from "../../constants.js";
import { ROLES, STATUS } from "../../constants/roles.js";

const TENANT_DB = "tenant_google_clients";

let mongoServer;

const call = (handler, req) =>
    new Promise((resolve, reject) => {
        const res = {
            statusCode: 200,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(payload) {
                resolve({ statusCode: this.statusCode, payload });
                return this;
            }
        };
        handler(req, res, reject);
    });

const buildRequest = (overrides = {}) => ({
    params: {},
    query: {},
    body: {},
    headers: { "accept-language": "es" },
    user: {
        firebaseUid: "uid-google-new",
        email: "cliente@nuevo.test",
        name: "Cliente Nuevo"
    },
    // resolveStore builds this context from the X-Store header.
    tenant: {
        storeSlug: "tienda-uno",
        dbName: TENANT_DB,
        getModel: (modelName) => getTenantModel(TENANT_DB, modelName)
    },
    ...overrides
});

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), { dbName: DB_NAME });

    await Promise.all([
        TenantMapping.init(),
        getTenantModel(TENANT_DB, "User").init()
    ]);
}, 120000);

afterAll(async () => {
    const client = mongoose.connection.getClient();
    resetTenantConnections();

    await mongoose.connection.dropDatabase();
    await client.db(TENANT_DB).dropDatabase();

    await mongoose.connection.close();
    await mongoServer.stop();
}, 60000);

beforeEach(async () => {
    await TenantMapping.deleteMany({});
    await mongoose.model("User").deleteMany({});
    await getTenantModel(TENANT_DB, "User").deleteMany({});
});

describe("registerOrGetGoogleUser", () => {
    const tenantUser = (query = {}) => getTenantModel(TENANT_DB, "User").findOne(query);

    it("creates a brand-new unmapped email as CLIENT in the tenant database", async () => {
        const { statusCode, payload } = await call(registerOrGetGoogleUser, buildRequest());

        // The old admin gate is gone: a new Firebase account is not forbidden.
        expect(statusCode).toBe(200);
        expect(payload.success).toBe(true);
        expect(payload.data).toMatchObject({
            email: "cliente@nuevo.test",
            fullName: "Cliente Nuevo",
            role: [ROLES.CLIENT]
        });

        const created = await tenantUser({ firebaseUid: "uid-google-new" }).lean();
        expect(created.role).toEqual([ROLES.CLIENT]);
        expect(created.status).toBe(STATUS.ACTIVE);

        // The profile lives in the store database, never in the central one.
        expect(await mongoose.model("User").countDocuments()).toBe(0);
        // The email has no central mapping: the header alone identified the store.
        expect(await TenantMapping.countDocuments()).toBe(0);
    });

    it("keeps resolving the session of an existing account", async () => {
        const existing = await getTenantModel(TENANT_DB, "User").create({
            email: "cliente@nuevo.test",
            fullName: "Cliente Existente",
            firebaseUid: "uid-google-new",
            role: [ROLES.SELLER],
            status: STATUS.ACTIVE
        });

        const { statusCode, payload } = await call(registerOrGetGoogleUser, buildRequest());

        expect(statusCode).toBe(200);
        expect(payload.data.id).toBe(String(existing._id));
        expect(payload.data.role).toEqual([ROLES.SELLER]);
        expect(await getTenantModel(TENANT_DB, "User").countDocuments()).toBe(1);
    });
});
