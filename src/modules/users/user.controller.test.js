import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { User } from "./user.model.js";
import { TenantMapping } from "../tenants/tenantMapping.model.js";
import { getTenantModel, resetTenantConnections } from "../tenants/tenantConnection.js";
import { DB_NAME } from "../../constants.js";
import { ROLES } from "../../constants/roles.js";

// user.controller.js initializes Firebase at import time and calls getAuth().
// The SDK is mocked so the test never needs real credentials.
const mockCreateUser = jest.fn();
const mockDeleteUser = jest.fn();
const mockUpdateUser = jest.fn();
const mockVerifyIdToken = jest.fn();
const mockCreateCustomToken = jest.fn();

jest.unstable_mockModule("firebase-admin/auth", () => ({
    getAuth: () => ({
        createUser: mockCreateUser,
        deleteUser: mockDeleteUser,
        updateUser: mockUpdateUser,
        verifyIdToken: mockVerifyIdToken,
        createCustomToken: mockCreateCustomToken
    })
}));

jest.unstable_mockModule("firebase-admin/app", () => ({
    initializeApp: () => {},
    getApps: () => [{}],
    cert: () => ({})
}));

let server;
let getAllUsers;
let registerUser;
let deleteUser;
let verifyIdToken;

const TENANT_DB = "tenant_users";

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

const buildTenant = (dbName = DB_NAME) => ({
    email: "test@example.com",
    dbName,
    getModel: (modelName) => getTenantModel(dbName, modelName)
});

const request = (overrides = {}) => ({
    params: {},
    query: {},
    body: {},
    headers: { "accept-language": "es" },
    user: { mongoDbId: new mongoose.Types.ObjectId(), role: [ROLES.ADMIN] },
    tenant: buildTenant(),
    ...overrides
});

beforeAll(async () => {
    // The controller refuses to load without this variable, even when Firebase
    // is mocked.
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 = Buffer
        .from(JSON.stringify({ project_id: "test-project" }))
        .toString("base64");

    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());

    await Promise.all(
        mongoose.modelNames().map((name) => mongoose.model(name).init())
    );
    await TenantMapping.init();

    ({ getAllUsers, registerUser, deleteUser, verifyIdToken } = await import("./user.controller.js"));
}, 120000);

afterAll(async () => {
    const client = mongoose.connection.getClient();
    resetTenantConnections();

    await mongoose.connection.dropDatabase();
    await client.db(TENANT_DB).dropDatabase();

    await mongoose.connection.close();
    await server.stop();
}, 60000);

describe("user tenant routing", () => {
    const tenantModel = (name) => getTenantModel(TENANT_DB, name);

    const tenantRequest = (overrides = {}) => request({
        ...overrides,
        tenant: buildTenant(TENANT_DB)
    });

    beforeAll(async () => {
        await tenantModel("User").init();
    }, 60000);

    beforeEach(async () => {
        await Promise.all([
            tenantModel("User").deleteMany({}),
            // The central database is shared by every test in this file, so
            // clear it too: the leak assertions are only meaningful if it starts
            // empty.
            User.deleteMany({}),
            TenantMapping.deleteMany({})
        ]);
        jest.clearAllMocks();
    });

    it("lists only the tenant users and hides internal accounts", async () => {
        await tenantModel("User").create([
            { email: "admin@tenant.test", fullName: "Admin Tienda", role: [ROLES.ADMIN] },
            { email: "seller@tenant.test", fullName: "Vendedor Tienda", role: [ROLES.SELLER] },
            { email: "root@tenant.test", fullName: "Cuenta Interna", role: [ROLES.SUPERADMIN] }
        ]);
        await User.create({ email: "admin@central.test", fullName: "Admin Central", role: [ROLES.ADMIN] });

        const tenantList = await call(getAllUsers, tenantRequest({ params: { page: "1" } }));
        expect(tenantList.statusCode).toBe(200);
        expect(tenantList.payload.data.docs).toHaveLength(2);
        expect(tenantList.payload.data.docs.map((user) => user.email).sort()).toEqual([
            "admin@tenant.test",
            "seller@tenant.test"
        ]);

        const centralList = await call(getAllUsers, request({ params: { page: "1" } }));
        expect(centralList.statusCode).toBe(200);
        expect(centralList.payload.data.docs).toHaveLength(1);
        expect(centralList.payload.data.docs[0].email).toBe("admin@central.test");
    });

    it("creates a new user in the tenant database only", async () => {
        mockCreateUser.mockResolvedValue({ uid: "uid-new" });

        const { statusCode } = await call(
            registerUser,
            tenantRequest({
                body: {
                    fullName: "Vendedor Nuevo",
                    email: "nuevo@tenant.test",
                    password: "secret123",
                    role: [ROLES.SELLER]
                }
            })
        );

        expect(statusCode).toBe(201);
        expect(await tenantModel("User").countDocuments()).toBe(1);
        expect(await User.countDocuments()).toBe(0);

        const created = await tenantModel("User").findOne({ email: "nuevo@tenant.test" });
        expect(created.firebaseUid).toBe("uid-new");
        expect(created.role).toEqual([ROLES.SELLER]);
    });

    it("deletes the tenant user and its Firebase account", async () => {
        const tenantUser = await tenantModel("User").create({
            email: "borrar@tenant.test",
            fullName: "Vendedor Borrar",
            firebaseUid: "uid-delete",
            role: [ROLES.SELLER]
        });
        const centralUser = await User.create({
            email: "central@tenant.test",
            fullName: "Central Intacto",
            role: [ROLES.SELLER]
        });
        mockDeleteUser.mockResolvedValue({});

        const { statusCode } = await call(
            deleteUser,
            tenantRequest({ params: { userId: String(tenantUser._id) } })
        );

        expect(statusCode).toBe(200);
        expect(mockDeleteUser).toHaveBeenCalledWith("uid-delete");
        expect(await tenantModel("User").countDocuments()).toBe(0);
        // The central document is untouched.
        expect(await User.findById(centralUser._id)).not.toBeNull();

        // A tenant user is invisible from another database.
        const crossRead = await call(
            deleteUser,
            request({ params: { userId: String(tenantUser._id) } })
        );
        expect(crossRead.statusCode).toBe(404);
    });

    it("resolves the tenant database from the verified email on login", async () => {
        await TenantMapping.create({ email: "login@tenant.test", dbName: TENANT_DB });
        const tenantUser = await tenantModel("User").create({
            email: "login@tenant.test",
            fullName: "Vendedor Login",
            firebaseUid: "uid-login",
            role: [ROLES.SELLER]
        });

        mockVerifyIdToken.mockResolvedValue({ uid: "uid-login", email: "login@tenant.test" });
        mockCreateCustomToken.mockResolvedValue("custom-token");

        const originalFetch = globalThis.fetch;
        globalThis.fetch = jest.fn().mockResolvedValue({
            json: async () => ({
                idToken: "firebase-id-token",
                refreshToken: "firebase-refresh-token",
                expiresIn: "3600"
            })
        });

        try {
            const { statusCode, payload } = await call(
                verifyIdToken,
                request({ body: { idToken: "incoming-token" } })
            );

            expect(statusCode).toBe(200);
            expect(payload.data.user._id).toBe(String(tenantUser._id));
            expect(payload.data.user.role).toEqual([ROLES.SELLER]);
            expect(mockCreateCustomToken).toHaveBeenCalledWith("uid-login", {
                mongoDbId: String(tenantUser._id),
                role: [ROLES.SELLER]
            });
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
