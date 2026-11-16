import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { resolveStore, requireStore } from "./resolveStore.middleware.js";
import { Store } from "../modules/tenants/store.model.js";
import { ApiError } from "../utils/ApiError.js";

let mongoServer;

/**
 * Minimal request stub: the middleware only reads the X-Store header and
 * writes req.store / req.tenant.
 */
const buildRequest = (headers = {}) => {
    const normalized = Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
    );

    return {
        headers: normalized,
        header(name) {
            return normalized[String(name).toLowerCase()];
        }
    };
};

/**
 * Runs the middleware and resolves once it calls next. asyncHandler is
 * fire-and-forget, so awaiting the middleware itself would return too early.
 */
const run = (middleware, req) => {
    const next = jest.fn();
    const called = new Promise((resolve) => {
        next.mockImplementation(() => resolve());
    });

    middleware(req, {}, next);

    return called.then(() => next);
};

const firstError = (next) => next.mock.calls[0]?.[0];

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Store.init();
}, 60000);

afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
    await mongoServer.stop();
}, 60000);

beforeEach(async () => {
    await Store.deleteMany({});
    jest.restoreAllMocks();
});

describe("resolveStore", () => {
    const createStore = (overrides = {}) =>
        Store.create({
            slug: "tienda-norte",
            dbName: "tenant_norte",
            name: "Tienda Norte",
            ...overrides
        });

    it("does nothing when the X-Store header is absent", async () => {
        const req = buildRequest();

        const next = await run(resolveStore, req);

        expect(next).toHaveBeenCalledWith();
        expect(req.store).toBeUndefined();
        expect(req.tenant).toBeUndefined();
    });

    it("attaches the store and a tenant bound to its database", async () => {
        await createStore();
        const req = buildRequest({ "X-Store": "Tienda-Norte" });

        const next = await run(resolveStore, req);

        expect(next).toHaveBeenCalledWith();
        expect(req.store).toEqual({
            slug: "tienda-norte",
            dbName: "tenant_norte",
            name: "Tienda Norte"
        });
        expect(req.tenant).toMatchObject({
            storeSlug: "tienda-norte",
            dbName: "tenant_norte"
        });
        expect(typeof req.tenant.getConnection).toBe("function");
        expect(typeof req.tenant.getModel).toBe("function");
        expect(req.tenant.getConnection().name).toBe("tenant_norte");
    });

    it("rejects an empty header", async () => {
        const req = buildRequest({ "X-Store": "   " });

        const next = await run(resolveStore, req);

        const error = firstError(next);
        expect(error).toBeInstanceOf(ApiError);
        expect(error.statusCode).toBe(400);
        expect(error.message).toMatch(/vacío/);
        expect(req.tenant).toBeUndefined();
    });

    it("rejects an invalid slug and names the received value", async () => {
        const req = buildRequest({ "X-Store": "  Tienda Norte!!  " });

        const next = await run(resolveStore, req);

        const error = firstError(next);
        expect(error).toBeInstanceOf(ApiError);
        expect(error.statusCode).toBe(400);
        expect(error.message).toContain("Tienda Norte!!");
        expect(req.tenant).toBeUndefined();
    });

    it("returns 404 for an unknown or inactive store", async () => {
        await createStore({ slug: "tienda-vieja", dbName: "tenant_vieja", status: 0 });

        const unknown = await run(resolveStore, buildRequest({ "X-Store": "no-existe" }));
        expect(firstError(unknown).statusCode).toBe(404);
        expect(firstError(unknown).message).toContain("no-existe");

        const inactive = await run(resolveStore, buildRequest({ "X-Store": "tienda-vieja" }));
        expect(firstError(inactive).statusCode).toBe(404);
        expect(firstError(inactive).message).toContain("tienda-vieja");
    });

    it("returns 503 when the registry lookup fails", async () => {
        jest.spyOn(Store, "findOne").mockImplementationOnce(() => {
            throw new Error("central db down");
        });
        jest.spyOn(console, "error").mockImplementation(() => {});

        const next = await run(resolveStore, buildRequest({ "X-Store": "tienda-norte" }));

        const error = firstError(next);
        expect(error).toBeInstanceOf(ApiError);
        expect(error.statusCode).toBe(503);
        expect(error.message).toBe("No se pudo resolver la tienda de la solicitud.");
    });
});

describe("requireStore", () => {
    it("rejects a request without a resolved tenant", () => {
        const next = jest.fn();

        requireStore(buildRequest(), {}, next);

        const error = firstError(next);
        expect(error).toBeInstanceOf(ApiError);
        expect(error.statusCode).toBe(400);
        expect(error.message).toContain("X-Store");
    });

    it("continues when a tenant was resolved", () => {
        const next = jest.fn();

        requireStore({ tenant: { dbName: "tenant_norte" } }, {}, next);

        expect(next).toHaveBeenCalledWith();
    });
});
