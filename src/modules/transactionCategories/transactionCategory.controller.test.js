import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { TransactionCategory } from "./transactionCategory.model.js";
import { getTenantModel, resetTenantConnections } from "../tenants/tenantConnection.js";
import { DB_NAME } from "../../constants.js";
import {
    createTransactionCategory,
    getTransactionCategories,
    getTransactionCategoryById
} from "./transactionCategory.controller.js";

let server;

const TENANT_DB = "tenant_transaction_categories";

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
    user: { mongoDbId: new mongoose.Types.ObjectId(), role: [1] },
    tenant: buildTenant(),
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

describe("transaction category tenant routing", () => {
    const tenantModel = (name) => getTenantModel(TENANT_DB, name);

    const tenantRequest = (overrides = {}) => request({
        ...overrides,
        tenant: buildTenant(TENANT_DB)
    });

    beforeAll(async () => {
        await tenantModel("TransactionCategory").init();
    }, 60000);

    beforeEach(async () => {
        await tenantModel("TransactionCategory").deleteMany({});
        await TransactionCategory.deleteMany({});
    });

    it("creates the category in the tenant database only", async () => {
        const { statusCode } = await call(
            createTransactionCategory,
            tenantRequest({ body: { name: "Ventas", type: 0 } })
        );

        expect(statusCode).toBe(201);
        expect(await tenantModel("TransactionCategory").countDocuments()).toBe(1);
        expect(await TransactionCategory.countDocuments()).toBe(0);
    });

    it("lists and reads only the tenant categories", async () => {
        const created = await call(
            createTransactionCategory,
            tenantRequest({ body: { name: "Ventas", type: 0 } })
        );
        const categoryId = String(created.payload.data._id);

        const tenantRead = await call(
            getTransactionCategoryById,
            tenantRequest({ params: { categoryId } })
        );
        expect(tenantRead.statusCode).toBe(200);

        const centralRead = await call(
            getTransactionCategoryById,
            request({ params: { categoryId } })
        );
        expect(centralRead.statusCode).toBe(404);

        const tenantList = await call(getTransactionCategories, tenantRequest());
        expect(tenantList.statusCode).toBe(200);
        expect(tenantList.payload.data.docs).toHaveLength(1);

        const centralList = await call(getTransactionCategories, request());
        expect(centralList.statusCode).toBe(200);
        expect(centralList.payload.data.docs).toHaveLength(0);
    });
});
