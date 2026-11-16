import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import { Purchase } from "./purchase.model.js";
import { Sale } from "../sales/sale.model.js";
import { Transaction } from "../transactions/transaction.model.js";
import { Product } from "../products/product.model.js";
import { TransactionCategory } from "../transactionCategories/transactionCategory.model.js";
import { getTenantModel, resetTenantConnections } from "../tenants/tenantConnection.js";
import { DB_NAME } from "../../constants.js";
import {
    createPurchase,
    getPurchases,
    deletePurchase,
    getPurchaseSummary
} from "./purchase.controller.js";

// Creating or deleting a purchase opens a Mongo transaction: needs a replica set.
let replSet;

const TEST_TIMEOUT = 20000;
const itDb = (name, fn) => it(name, fn, TEST_TIMEOUT);

const TENANT_DB = "tenant_purchases";
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

describe("purchase tenant routing", () => {
    const tenantModel = (name) => getTenantModel(TENANT_DB, name);

    beforeAll(async () => {
        // Creating collections inside a transaction races for the catalog lock
        // in a single-node replica set, so create them up front.
        await Promise.all([
            tenantModel("Purchase").init(),
            tenantModel("Product").init(),
            tenantModel("Transaction").init(),
            tenantModel("TransactionCategory").init()
        ]);
    }, 60000);

    let tenantProduct;

    const tenantRequest = (overrides = {}) => request({
        ...overrides,
        tenant: buildTenant(TENANT_DB)
    });

    const purchaseBody = () => ({
        totalAmount: 10,
        items: [{
            product: String(tenantProduct._id),
            quantity: 2,
            unitPrice: 5,
            unit: String(new mongoose.Types.ObjectId()),
            conversionFactor: 1,
            subtotal: 10
        }]
    });

    beforeEach(async () => {
        await Promise.all([
            tenantModel("Purchase").deleteMany({}),
            tenantModel("Product").deleteMany({}),
            tenantModel("Transaction").deleteMany({}),
            tenantModel("TransactionCategory").deleteMany({}),
            // The central database is shared by every test in this file, so
            // clear it too: the leak assertions are only meaningful if it starts
            // empty.
            Purchase.deleteMany({}),
            Sale.deleteMany({}),
            Transaction.deleteMany({}),
            Product.deleteMany({}),
            TransactionCategory.deleteMany({})
        ]);

        tenantProduct = await tenantModel("Product").create({
            name: "Tenant Insumo",
            productType: 2,
            isPurchasable: true,
            price: 5,
            unit: new mongoose.Types.ObjectId(),
            stock: 10
        });

        // createPurchase resolves this system category for the expense.
        await tenantModel("TransactionCategory").create({
            name: "Compra de Insumos",
            type: 1,
            isSystem: true
        });
    });

    itDb("creates the purchase, its transaction and the stock increase in the tenant database", async () => {
        const { statusCode } = await call(
            createPurchase,
            tenantRequest({ body: purchaseBody() })
        );

        expect(statusCode).toBe(201);
        expect(await tenantModel("Purchase").countDocuments()).toBe(1);
        expect(await tenantModel("Transaction").countDocuments()).toBe(1);
        expect((await tenantModel("Product").findById(tenantProduct._id)).stock).toBe(12);

        // The whole flow stays in one database: nothing may leak here.
        expect(await Purchase.countDocuments()).toBe(0);
        expect(await Transaction.countDocuments()).toBe(0);
        expect(await Product.countDocuments()).toBe(0);
    });

    itDb("reverts the tenant stock and cancels the transaction when the purchase is deleted", async () => {
        const created = await call(
            createPurchase,
            tenantRequest({ body: purchaseBody() })
        );
        const purchaseId = String(created.payload.data._id);

        const { statusCode } = await call(
            deletePurchase,
            tenantRequest({ params: { purchaseId } })
        );

        expect(statusCode).toBe(200);
        expect((await tenantModel("Product").findById(tenantProduct._id)).stock).toBe(10);
        expect(await tenantModel("Purchase").countDocuments()).toBe(0);

        const tenantTransaction = await tenantModel("Transaction").findOne({});
        expect(tenantTransaction.status).toBe(0);

        // The reversal must stay in the tenant database too.
        expect(await Purchase.countDocuments()).toBe(0);
        expect(await Transaction.countDocuments()).toBe(0);
        expect(await Product.countDocuments()).toBe(0);
    });

    itDb("computes the summary and the listing from the tenant database", async () => {
        await tenantModel("Purchase").create([
            { subtotal: 100, totalAmount: 100, paymentStatus: 1 },
            { subtotal: 40, totalAmount: 40, paymentStatus: 0 }
        ]);
        // A central purchase must not skew the tenant figures.
        await Purchase.create({ subtotal: 9999, totalAmount: 9999, paymentStatus: 1 });

        const summary = await call(getPurchaseSummary, tenantRequest());
        expect(summary.statusCode).toBe(200);
        expect(summary.payload.data.totalPaid).toBe(100);
        expect(summary.payload.data.totalPending).toBe(40);
        expect(summary.payload.data.totalPurchases).toBe(2);

        const listing = await call(getPurchases, tenantRequest());
        expect(listing.statusCode).toBe(200);
        expect(listing.payload.data.docs).toHaveLength(2);
    });
});

describe("purchase conversion factor inheritance", () => {
    const tenantModel = (name) => getTenantModel(TENANT_DB, name);

    const tenantRequest = (overrides = {}) => request({
        ...overrides,
        tenant: buildTenant(TENANT_DB)
    });

    const createProduct = (overrides = {}) => tenantModel("Product").create({
        name: "Gaseosa",
        productType: 2,
        isPurchasable: true,
        price: 5,
        unit: new mongoose.Types.ObjectId(),
        stock: 0,
        ...overrides
    });

    // The item deliberately omits conversionFactor unless a test sends it.
    const bodyFor = (product, itemOverrides = {}) => ({
        totalAmount: 5,
        items: [{
            product: String(product._id),
            quantity: 1,
            unitPrice: 5,
            unit: String(new mongoose.Types.ObjectId()),
            subtotal: 5,
            ...itemOverrides
        }]
    });

    beforeAll(async () => {
        // Idempotent: the collections are also created by the routing suite, but
        // this suite must not depend on running second.
        await Promise.all([
            tenantModel("Purchase").init(),
            tenantModel("Product").init(),
            tenantModel("Transaction").init(),
            tenantModel("TransactionCategory").init()
        ]);
    }, 60000);

    beforeEach(async () => {
        await Promise.all([
            tenantModel("Purchase").deleteMany({}),
            tenantModel("Product").deleteMany({}),
            tenantModel("Transaction").deleteMany({}),
            tenantModel("TransactionCategory").deleteMany({}),
            Purchase.deleteMany({}),
            Sale.deleteMany({}),
            Transaction.deleteMany({}),
            Product.deleteMany({}),
            TransactionCategory.deleteMany({})
        ]);

        // createPurchase resolves this system category for the expense.
        await tenantModel("TransactionCategory").create({
            name: "Compra de Insumos",
            type: 1,
            isSystem: true
        });
    });

    itDb("inherits the product factor when the item omits it", async () => {
        const product = await createProduct({
            purchaseUnit: new mongoose.Types.ObjectId(),
            conversionFactor: 12
        });

        const { statusCode, payload } = await call(
            createPurchase,
            tenantRequest({ body: bodyFor(product) })
        );

        expect(statusCode).toBe(201);
        expect((await tenantModel("Product").findById(product._id)).stock).toBe(12);
        expect(Number(payload.data.items[0].conversionFactor)).toBe(12);
    });

    itDb("keeps an explicit factor of 1 sent by the client", async () => {
        const product = await createProduct({
            purchaseUnit: new mongoose.Types.ObjectId(),
            conversionFactor: 12
        });

        const { statusCode } = await call(
            createPurchase,
            tenantRequest({ body: bodyFor(product, { conversionFactor: 1 }) })
        );

        expect(statusCode).toBe(201);
        expect((await tenantModel("Product").findById(product._id)).stock).toBe(1);
    });

    itDb("falls back to the quantity when the product has no purchase unit", async () => {
        const product = await createProduct({
            purchaseUnit: null,
            conversionFactor: 12
        });

        const { statusCode, payload } = await call(
            createPurchase,
            tenantRequest({ body: bodyFor(product, { quantity: 2, subtotal: 10 }) })
        );

        expect(statusCode).toBe(201);
        expect((await tenantModel("Product").findById(product._id)).stock).toBe(2);
        expect(Number(payload.data.items[0].conversionFactor)).toBe(1);
    });

    itDb("restores exactly the stock that the inherited factor added", async () => {
        const product = await createProduct({
            purchaseUnit: new mongoose.Types.ObjectId(),
            conversionFactor: 12,
            stock: 5
        });

        const created = await call(
            createPurchase,
            tenantRequest({ body: bodyFor(product, { quantity: 2, subtotal: 10 }) })
        );
        expect((await tenantModel("Product").findById(product._id)).stock).toBe(29);

        const { statusCode } = await call(
            deletePurchase,
            tenantRequest({ params: { purchaseId: String(created.payload.data._id) } })
        );

        expect(statusCode).toBe(200);
        expect((await tenantModel("Product").findById(product._id)).stock).toBe(5);
        expect(await tenantModel("Purchase").countDocuments()).toBe(0);
    });
});
