import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import { StockAdjustment } from "./stockAdjustment.model.js";
import { Product } from "../products/product.model.js";
import { getTenantModel, resetTenantConnections } from "../tenants/tenantConnection.js";
import { DB_NAME } from "../../constants.js";
import {
    createStockAdjustment,
    getStockAdjustments
} from "./stockAdjustment.controller.js";

// Creating an adjustment opens a Mongo transaction: needs a replica set.
let replSet;

const TEST_TIMEOUT = 20000;
const itDb = (name, fn) => it(name, fn, TEST_TIMEOUT);

const TENANT_DB = "tenant_stock_adjustments";
const SUPERVISOR = [1];

// Invoca un handler de Express y resuelve con la respuesta emitida.
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
    user: { mongoDbId: new mongoose.Types.ObjectId(), role: SUPERVISOR },
    tenant: buildTenant(),
    ...overrides
});

beforeAll(async () => {
    // A single-node in-memory replica set loses the transaction lock at 5 ms
    // by default under sequential load. Harness limitation, not app behaviour.
    replSet = await MongoMemoryReplSet.create({
        replSet: {
            count: 1,
            args: ["--setParameter", "maxTransactionLockRequestTimeoutMillis=10000"]
        }
    });
    await mongoose.connect(replSet.getUri());

    // Build every index before the first transaction: a background index build
    // changes the catalog and fails an in-flight transaction.
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
    await replSet.stop();
}, 60000);

describe("stock adjustment tenant routing", () => {
    const tenantModel = (name) => getTenantModel(TENANT_DB, name);

    beforeAll(async () => {
        // Creating collections inside a transaction races for the catalog lock
        // in a single-node replica set, so create them up front.
        await Promise.all([
            tenantModel("StockAdjustment").init(),
            tenantModel("Product").init()
        ]);
    }, 60000);

    let tenantProduct;

    const tenantRequest = (overrides = {}) => request({
        ...overrides,
        tenant: buildTenant(TENANT_DB)
    });

    beforeEach(async () => {
        await Promise.all([
            tenantModel("StockAdjustment").deleteMany({}),
            tenantModel("Product").deleteMany({}),
            // The central database is shared by every test in this file, so
            // clear it too: the leak assertions are only meaningful if it starts
            // empty.
            StockAdjustment.deleteMany({}),
            Product.deleteMany({})
        ]);

        tenantProduct = await tenantModel("Product").create({
            name: "Tenant Insumo",
            productType: 2,
            price: 5,
            unit: new mongoose.Types.ObjectId(),
            stock: 10
        });
    });

    itDb("applies a delta to the tenant product only", async () => {
        const { statusCode, payload } = await call(
            createStockAdjustment,
            tenantRequest({
                body: {
                    product: String(tenantProduct._id),
                    delta: 5,
                    reason: 1,
                    note: "Recuento"
                }
            })
        );

        expect(statusCode).toBe(201);
        expect(payload.data.adjustment.previousStock).toBe(10);
        expect(payload.data.adjustment.newStock).toBe(15);

        expect((await tenantModel("Product").findById(tenantProduct._id)).stock).toBe(15);
        expect(await tenantModel("StockAdjustment").countDocuments()).toBe(1);

        // The whole flow stays in one database: nothing may leak here.
        expect(await StockAdjustment.countDocuments()).toBe(0);
        expect(await Product.countDocuments()).toBe(0);
    });

    itDb("applies an absolute newStock to the tenant product only", async () => {
        const { statusCode } = await call(
            createStockAdjustment,
            tenantRequest({
                body: {
                    product: String(tenantProduct._id),
                    newStock: 3,
                    reason: 2
                }
            })
        );

        expect(statusCode).toBe(201);
        expect((await tenantModel("Product").findById(tenantProduct._id)).stock).toBe(3);

        const adjustment = await tenantModel("StockAdjustment").findOne({});
        expect(adjustment.previousStock).toBe(10);
        expect(adjustment.newStock).toBe(3);
        expect(adjustment.delta).toBe(-7);

        expect(await StockAdjustment.countDocuments()).toBe(0);
        expect(await Product.countDocuments()).toBe(0);
    });

    itDb("lists only the tenant adjustments", async () => {
        await tenantModel("StockAdjustment").create({
            product: tenantProduct._id,
            previousStock: 10,
            newStock: 15,
            delta: 5,
            reason: 1,
            operator: new mongoose.Types.ObjectId()
        });
        await StockAdjustment.create({
            product: new mongoose.Types.ObjectId(),
            previousStock: 0,
            newStock: 1,
            delta: 1,
            reason: 0,
            operator: new mongoose.Types.ObjectId()
        });

        const { statusCode, payload } = await call(getStockAdjustments, tenantRequest());

        expect(statusCode).toBe(200);
        expect(payload.data.docs).toHaveLength(1);
        expect(payload.data.docs[0].previousStock).toBe(10);
    });
});
