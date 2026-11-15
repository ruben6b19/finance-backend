import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { Transaction } from "./transaction.model.js";
import { getTenantModel, resetTenantConnections } from "../tenants/tenantConnection.js";
import { DB_NAME } from "../../constants.js";
import {
    createTransaction,
    getTransactionById,
    getTransactions,
    getTransactionSummary
} from "./transaction.controller.js";

let server;

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
    user: { mongoDbId: new mongoose.Types.ObjectId(), role: [0] },
    tenant: buildTenant(),
    ...overrides
});

const TENANT_DB = "tenant_transactions";

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

describe("transaction tenant routing", () => {
    const tenantModel = (name) => getTenantModel(TENANT_DB, name);

    const tenantRequest = (overrides = {}) => request({
        ...overrides,
        tenant: buildTenant(TENANT_DB)
    });

    const categoryId = new mongoose.Types.ObjectId();

    beforeAll(async () => {
        await tenantModel("Transaction").init();
    }, 60000);

    beforeEach(async () => {
        await tenantModel("Transaction").deleteMany({});
        await Transaction.deleteMany({});
    });

    it("writes a transaction to the tenant database only", async () => {
        const { statusCode, payload } = await call(
            createTransaction,
            tenantRequest({
                body: {
                    type: 0,
                    amount: 250,
                    concept: "Venta mostrador",
                    category: String(categoryId)
                }
            })
        );

        expect(statusCode).toBe(201);
        expect(await tenantModel("Transaction").countDocuments()).toBe(1);
        expect(await Transaction.countDocuments()).toBe(0);

        const tenantRead = await call(
            getTransactionById,
            tenantRequest({ params: { transactionId: String(payload.data._id) } })
        );
        expect(tenantRead.statusCode).toBe(200);

        // A transaction in one store must never be visible from another.
        const centralRead = await call(
            getTransactionById,
            request({ params: { transactionId: String(payload.data._id) } })
        );
        expect(centralRead.statusCode).toBe(404);
    });

    it("computes the summary from the tenant database", async () => {
        await tenantModel("Transaction").create([
            { type: 0, amount: 100, concept: "Ingreso", category: categoryId, status: 1 },
            { type: 1, amount: 40, concept: "Egreso", category: categoryId, status: 1 }
        ]);
        // A central transaction must not skew the tenant balance.
        await Transaction.create({
            type: 0,
            amount: 9999,
            concept: "Central",
            category: categoryId,
            status: 1
        });

        const { statusCode, payload } = await call(getTransactionSummary, tenantRequest());

        expect(statusCode).toBe(200);
        expect(payload.data.totalIncome).toBe(100);
        expect(payload.data.totalExpense).toBe(40);
        expect(payload.data.balance).toBe(60);
    });

    it("lists only the tenant transactions", async () => {
        await tenantModel("Transaction").create({
            type: 0,
            amount: 10,
            concept: "Tenant",
            category: categoryId,
            status: 1
        });
        await Transaction.create({
            type: 0,
            amount: 20,
            concept: "Central",
            category: categoryId,
            status: 1
        });

        const { statusCode, payload } = await call(getTransactions, tenantRequest());

        expect(statusCode).toBe(200);
        expect(payload.data.docs).toHaveLength(1);
        expect(payload.data.docs[0].concept).toBe("Tenant");
    });
});
