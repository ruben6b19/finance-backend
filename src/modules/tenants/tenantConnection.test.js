import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { DB_NAME } from "../../constants.js";
import {
    getCachedTenantDbNames,
    getTenantConnection,
    getTenantModel,
    resetTenantConnections
} from "./tenantConnection.js";

let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), { dbName: DB_NAME });
}, 20000);

afterAll(async () => {
    resetTenantConnections();

    const client = mongoose.connection.getClient();
    await mongoose.connection.dropDatabase();
    await client.db("tenant_a").dropDatabase();
    await client.db("tenant_b").dropDatabase();

    await mongoose.connection.close();
    await mongoServer.stop();
}, 120000);

beforeEach(async () => {
    await mongoose.model("ProductCategory").deleteMany({});
    await getTenantModel("tenant_a", "ProductCategory").deleteMany({});
    await getTenantModel("tenant_b", "ProductCategory").deleteMany({});
});

describe("tenantConnection", () => {
    it("reuses the default connection for the central database", () => {
        expect(getTenantConnection(DB_NAME)).toBe(mongoose.connection);
    });

    it("caches one connection per tenant and tracks the cached names", () => {
        const tenantA = getTenantConnection("tenant_a");
        const tenantB = getTenantConnection("tenant_b");

        expect(getTenantConnection("tenant_a")).toBe(tenantA);
        expect(tenantA).not.toBe(tenantB);

        const cached = getCachedTenantDbNames();
        expect(cached).toContain("tenant_a");
        expect(cached).toContain("tenant_b");
    });

    it("compiles a distinct model per tenant bound to its own database", () => {
        const productCategoryA = getTenantModel("tenant_a", "ProductCategory");
        const productCategoryB = getTenantModel("tenant_b", "ProductCategory");

        expect(productCategoryA).not.toBe(productCategoryB);
        expect(productCategoryA.collection.conn.name).toBe("tenant_a");
        expect(productCategoryB.collection.conn.name).toBe("tenant_b");
    });

    it("isolates data between tenants and the central database", async () => {
        await getTenantModel("tenant_a", "ProductCategory").create({ name: "tenant-a-category" });
        await getTenantModel("tenant_b", "ProductCategory").create({ name: "tenant-b-category" });

        const countA = await getTenantModel("tenant_a", "ProductCategory").countDocuments();
        const countB = await getTenantModel("tenant_b", "ProductCategory").countDocuments();
        const countCentral = await mongoose.model("ProductCategory").countDocuments();

        expect(countA).toBe(1);
        expect(countB).toBe(1);
        expect(countCentral).toBe(0);
    });

    it("enforces unique indexes per tenant", async () => {
        const productCategoryA = getTenantModel("tenant_a", "ProductCategory");
        const productCategoryB = getTenantModel("tenant_b", "ProductCategory");

        await productCategoryA.init();
        await productCategoryA.create({ name: "shared" });

        let error;
        try {
            await productCategoryA.create({ name: "shared" });
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeDefined();
        expect(error.code).toBe(11000);

        await expect(productCategoryB.create({ name: "shared" })).resolves.toBeDefined();
    });

    it("throws for a model outside the tenant registry", () => {
        expect(() => getTenantModel("tenant_a", "Nope")).toThrow(/Unknown tenant model/);
    });

    it("rejects invalid database names", () => {
        expect(() => getTenantConnection("bad/name")).toThrow(/Invalid tenant database name/);
        expect(() => getTenantConnection("")).toThrow(/required/);
    });

    it("clears the cache and keeps resolving models afterwards", async () => {
        getTenantConnection("tenant_a");
        getTenantConnection("tenant_b");

        resetTenantConnections();

        expect(getCachedTenantDbNames()).toEqual([]);

        const productCategory = getTenantModel("tenant_a", "ProductCategory");
        await expect(productCategory.create({ name: "after-reset" })).resolves.toBeDefined();
    });
});
