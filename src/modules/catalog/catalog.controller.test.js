import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { Product } from "../products/product.model.js";
import { getTenantModel, resetTenantConnections } from "../tenants/tenantConnection.js";
import { DB_NAME } from "../../constants.js";
import { getPublicProducts, getPublicProductById } from "./catalog.controller.js";

let server;

const TENANT_DB = "tenant_catalog";

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
    headers: {},
    tenant: buildTenant(),
    ...overrides
});

const productFixture = (overrides = {}) => ({
    name: "Soda",
    productType: 2,
    isSellable: true,
    price: 10,
    unit: new mongoose.Types.ObjectId(),
    stock: 5,
    status: 1,
    ...overrides
});

beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());

    await Promise.all(
        mongoose.modelNames().map((name) => mongoose.model(name).init())
    );
}, 120000);

afterAll(async () => {
    const client = mongoose.connection.getClient();
    resetTenantConnections();

    await mongoose.connection.dropDatabase();
    await client.db(TENANT_DB).dropDatabase();

    await mongoose.connection.close();
    await server.stop();
}, 60000);

describe("catalog tenant routing", () => {
    const tenantModel = (name) => getTenantModel(TENANT_DB, name);

    const tenantRequest = (overrides = {}) => request({
        ...overrides,
        tenant: buildTenant(TENANT_DB)
    });

    beforeAll(async () => {
        await Promise.all([
            tenantModel("Product").init(),
            tenantModel("ProductCategory").init()
        ]);
    }, 60000);

    beforeEach(async () => {
        await tenantModel("Product").deleteMany({});
        await Product.deleteMany({});
    });

    it("lists only the tenant products", async () => {
        await tenantModel("Product").create(productFixture({ name: "Tenant Soda" }));
        await Product.create(productFixture({ name: "Central Soda" }));

        const tenantList = await call(getPublicProducts, tenantRequest());
        expect(tenantList.statusCode).toBe(200);
        expect(tenantList.payload.data.products).toHaveLength(1);
        expect(tenantList.payload.data.products[0].name).toBe("Tenant Soda");

        const centralList = await call(getPublicProducts, request());
        expect(centralList.statusCode).toBe(200);
        expect(centralList.payload.data.products).toHaveLength(1);
        expect(centralList.payload.data.products[0].name).toBe("Central Soda");
    });

    it("does not expose a tenant product to another database", async () => {
        const product = await tenantModel("Product").create(
            productFixture({ name: "Tenant Soda" })
        );
        const productId = String(product._id);

        const tenantRead = await call(
            getPublicProductById,
            tenantRequest({ params: { productId } })
        );
        expect(tenantRead.statusCode).toBe(200);

        const centralRead = await call(
            getPublicProductById,
            request({ params: { productId } })
        );
        expect(centralRead.statusCode).toBe(404);
    });
});
