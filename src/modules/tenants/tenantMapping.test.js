import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { TenantMapping } from "./tenantMapping.model.js";
import { getTenantDbNameByEmail, resolveTenantDbName } from "./tenantMapping.service.js";
import { DB_NAME } from "../../constants.js";
import { ApiError } from "../../utils/ApiError.js";

const mockVerifyIdToken = jest.fn();

// The middleware is imported dynamically in beforeAll, after this mock is
// registered, so the real Firebase SDK is never loaded.
jest.unstable_mockModule("firebase-admin/auth", () => ({
    getAuth: () => ({ verifyIdToken: mockVerifyIdToken })
}));

let verifyFirebaseToken;
let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await TenantMapping.init();

    ({ verifyFirebaseToken } = await import("../../middlewares/auth.middleware.js"));
}, 20000);

afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
    await mongoServer.stop();
}, 120000);

beforeEach(async () => {
    await TenantMapping.deleteMany({});
    mockVerifyIdToken.mockReset();
});

describe("TenantMapping model", () => {
    it("stores the email lowercased and trimmed and sets timestamps", async () => {
        const mapping = await TenantMapping.create({
            email: "  Admin@Example.com  ",
            dbName: "tenant_admin"
        });

        expect(mapping.email).toBe("admin@example.com");
        expect(mapping.dbName).toBe("tenant_admin");
        expect(mapping.createdAt).toBeInstanceOf(Date);
        expect(mapping.updatedAt).toBeInstanceOf(Date);
    });

    it("rejects a duplicate email regardless of case", async () => {
        await TenantMapping.create({ email: "admin@example.com", dbName: "tenant_admin" });

        let error;
        try {
            await TenantMapping.create({ email: "ADMIN@Example.com", dbName: "tenant_other" });
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeDefined();
        expect(error.code).toBe(11000);
    });

    it("requires dbName", async () => {
        let error;
        try {
            await TenantMapping.create({ email: "admin@example.com" });
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeDefined();
        expect(error.name).toBe("ValidationError");
        expect(error.errors.dbName).toBeDefined();
    });
});

describe("tenant mapping service", () => {
    beforeEach(async () => {
        await TenantMapping.create({ email: "admin@example.com", dbName: "tenant_admin" });
    });

    it("returns the mapped database name, normalizing the email", async () => {
        await expect(getTenantDbNameByEmail("  ADMIN@Example.com  ")).resolves.toBe("tenant_admin");
    });

    it("returns null for an unknown email", async () => {
        await expect(getTenantDbNameByEmail("unknown@example.com")).resolves.toBeNull();
    });

    it("returns null for an empty or missing email", async () => {
        await expect(getTenantDbNameByEmail("")).resolves.toBeNull();
        await expect(getTenantDbNameByEmail(undefined)).resolves.toBeNull();
    });

    it("falls back to the central database for unknown emails", async () => {
        await expect(resolveTenantDbName("unknown@example.com")).resolves.toBe(DB_NAME);
    });

    it("resolves the mapped name for known emails", async () => {
        await expect(resolveTenantDbName("admin@example.com")).resolves.toBe("tenant_admin");
    });
});

describe("verifyFirebaseToken tenant resolution", () => {
    const buildRequest = () => ({
        headers: { authorization: "Bearer test-token" }
    });

    beforeEach(() => {
        jest.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("attaches the mapped tenant database", async () => {
        await TenantMapping.create({ email: "admin@example.com", dbName: "tenant_admin" });
        mockVerifyIdToken.mockResolvedValue({ uid: "uid-1", email: "admin@example.com" });

        const req = buildRequest();
        const next = jest.fn();

        await verifyFirebaseToken(req, {}, next);

        expect(next).toHaveBeenCalledWith();
        expect(req.user.dbName).toBe("tenant_admin");
        expect(req.tenant).toEqual({ email: "admin@example.com", dbName: "tenant_admin" });
    });

    it("falls back to the central database for unmapped emails", async () => {
        mockVerifyIdToken.mockResolvedValue({ uid: "uid-2", email: "nobody@example.com" });

        const req = buildRequest();
        const next = jest.fn();

        await verifyFirebaseToken(req, {}, next);

        expect(next).toHaveBeenCalledWith();
        expect(req.user.dbName).toBe(DB_NAME);
        expect(req.tenant.dbName).toBe(DB_NAME);
    });

    it("falls back to the central database when the token has no email", async () => {
        mockVerifyIdToken.mockResolvedValue({ uid: "uid-3" });

        const req = buildRequest();
        const next = jest.fn();

        await verifyFirebaseToken(req, {}, next);

        expect(next).toHaveBeenCalledWith();
        expect(req.user.dbName).toBe(DB_NAME);
    });

    it("returns 401 for an expired token", async () => {
        mockVerifyIdToken.mockRejectedValue({ code: "auth/id-token-expired" });

        const req = buildRequest();
        const next = jest.fn();

        await verifyFirebaseToken(req, {}, next);

        expect(next).toHaveBeenCalledTimes(1);
        const error = next.mock.calls[0][0];
        expect(error).toBeInstanceOf(ApiError);
        expect(error.statusCode).toBe(401);
    });

    it("returns 503 when the central tenant lookup fails", async () => {
        mockVerifyIdToken.mockResolvedValue({ uid: "uid-4", email: "admin@example.com" });
        jest.spyOn(TenantMapping, "findOne").mockImplementationOnce(() => {
            throw new Error("central db down");
        });

        const req = buildRequest();
        const next = jest.fn();

        await verifyFirebaseToken(req, {}, next);

        expect(next).toHaveBeenCalledTimes(1);
        const error = next.mock.calls[0][0];
        expect(error).toBeInstanceOf(ApiError);
        expect(error.statusCode).toBe(503);
    });
});
