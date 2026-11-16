import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";

import { DB_NAME } from "../../constants.js";
import { STATUS } from "../../constants/roles.js";
import { Store } from "../tenants/store.model.js";
import { getTenantModel, resetTenantConnections } from "../tenants/tenantConnection.js";
import { Product } from "../products/product.model.js";

// app.js pulls in the user controller, which initializes Firebase at import
// time. Both SDK entry points are mocked so the test never needs credentials.
const mockVerifyIdToken = jest.fn();

jest.unstable_mockModule("firebase-admin/auth", () => ({
    getAuth: () => ({
        verifyIdToken: mockVerifyIdToken,
        createUser: jest.fn(),
        deleteUser: jest.fn(),
        updateUser: jest.fn(),
        createCustomToken: jest.fn()
    })
}));

jest.unstable_mockModule("firebase-admin/app", () => ({
    initializeApp: () => {},
    getApps: () => [{}],
    cert: () => ({})
}));

const STORE_DB = "tenant_catalog_public";

let mongoServer;
let app;

const productFixture = (overrides = {}) => ({
    name: "Producto",
    productType: 2,
    isSellable: true,
    price: 10,
    unit: new mongoose.Types.ObjectId(),
    stock: 5,
    status: 1,
    ...overrides
});

beforeAll(async () => {
    // The user controller refuses to load without this variable, even when
    // Firebase is mocked.
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 = Buffer
        .from(JSON.stringify({ project_id: "test-project" }))
        .toString("base64");

    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), { dbName: DB_NAME });

    await Promise.all([
        Store.init(),
        Product.init(),
        getTenantModel(STORE_DB, "Product").init()
    ]);

    ({ default: app } = await import("../../app.js"));
}, 120000);

afterAll(async () => {
    const client = mongoose.connection.getClient();
    resetTenantConnections();

    await mongoose.connection.dropDatabase();
    await client.db(STORE_DB).dropDatabase();

    await mongoose.connection.close();
    await mongoServer.stop();
}, 60000);

beforeEach(async () => {
    await Store.deleteMany({});
    await Product.deleteMany({});
    await getTenantModel(STORE_DB, "Product").deleteMany({});
});

describe("public catalog store routing", () => {
    beforeEach(async () => {
        await Store.create({
            slug: "tienda-uno",
            dbName: STORE_DB,
            name: "Tienda Uno",
            status: STATUS.ACTIVE
        });

        // One product per database: the public catalog must only expose the
        // products of the store named by the header.
        await getTenantModel(STORE_DB, "Product").create(
            productFixture({ name: "Solo Tienda Uno" })
        );
        await Product.create(productFixture({ name: "Solo Base Central" }));
    });

    it("rejects a public catalog request without the X-Store header", async () => {
        const response = await request(app).get("/api/v1/catalog/products");

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({ success: false, statusCode: 400 });
        expect(response.body.message).toContain("X-Store");
    });

    it("rejects an unknown store slug", async () => {
        const response = await request(app)
            .get("/api/v1/catalog/products")
            .set("X-Store", "no-existe");

        expect(response.status).toBe(404);
        expect(response.body).toMatchObject({ success: false, statusCode: 404 });
        expect(response.body.message).toContain("no-existe");
    });

    it("lists only the products of the store named by the header", async () => {
        const response = await request(app)
            .get("/api/v1/catalog/products")
            .set("X-Store", "tienda-uno");

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);

        const names = response.body.data.products.map((product) => product.name);
        expect(names).toEqual(["Solo Tienda Uno"]);
        expect(response.body.data.total).toBe(1);
    });
});
