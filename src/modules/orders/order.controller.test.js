import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import { Order } from "./order.model.js";
import { Sale } from "../sales/sale.model.js";
import { Transaction } from "../transactions/transaction.model.js";
import { Product } from "../products/product.model.js";
import { TransactionCategory } from "../transactionCategories/transactionCategory.model.js";
import { User } from "../users/user.model.js";
import { getTenantModel, resetTenantConnections } from "../tenants/tenantConnection.js";
import { DB_NAME } from "../../constants.js";
import { createOrder, updateOrderStatus, getMyOrderById } from "./order.controller.js";

// Confirming an order opens a Mongo transaction: this needs a replica set.
let replSet;

const TEST_TIMEOUT = 20000;
const itDb = (name, fn) => it(name, fn, TEST_TIMEOUT);

const TENANT_DB = "tenant_orders";
const CLIENT = [3];
const SELLER = [2];

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
    headers: {},
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

describe("order tenant routing", () => {
    const tenantModel = (name) => getTenantModel(TENANT_DB, name);

    beforeAll(async () => {
        // Creating collections inside a transaction races for the catalog lock
        // in a single-node replica set, so create them up front.
        await Promise.all([
            tenantModel("Order").init(),
            tenantModel("Sale").init(),
            tenantModel("Transaction").init(),
            tenantModel("Product").init(),
            tenantModel("TransactionCategory").init(),
            tenantModel("ComboDefinition").init(),
            tenantModel("ComboComponent").init()
        ]);
    }, 60000);

    let tenantProduct;

    const clientRequest = (overrides = {}) => request({
        user: { firebaseUid: "uid-client", email: "client@example.com" },
        ...overrides,
        tenant: buildTenant(TENANT_DB)
    });

    const staffRequest = (overrides = {}) => request({
        user: { firebaseUid: "uid-staff", email: "staff@example.com" },
        ...overrides,
        tenant: buildTenant(TENANT_DB)
    });

    const orderBody = () => ({
        items: [{ productId: String(tenantProduct._id), quantity: 2 }],
        deliveryType: 1,
        pickupAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        phone: "71234567",
        contactName: "Cliente Nuevo"
    });

    beforeEach(async () => {
        await Promise.all([
            tenantModel("Order").deleteMany({}),
            tenantModel("Sale").deleteMany({}),
            tenantModel("Transaction").deleteMany({}),
            tenantModel("Product").deleteMany({}),
            tenantModel("TransactionCategory").deleteMany({}),
            tenantModel("ComboDefinition").deleteMany({}),
            tenantModel("ComboComponent").deleteMany({}),
            // The central database is shared by every test in this file, so
            // clear it too: the leak assertions are only meaningful if it starts
            // empty.
            Order.deleteMany({}),
            Sale.deleteMany({}),
            Transaction.deleteMany({}),
            Product.deleteMany({}),
            TransactionCategory.deleteMany({}),
            User.deleteMany({})
        ]);

        tenantProduct = await tenantModel("Product").create({
            name: "Tenant Soda",
            productType: 2,
            isSellable: true,
            price: 10,
            unit: new mongoose.Types.ObjectId(),
            stock: 10
        });

        // createSaleRecord resolves this system category for the income.
        await tenantModel("TransactionCategory").create({
            name: "Ventas POS",
            type: 0,
            isSystem: true
        });

        // Identity stays central: both users live in the central database.
        await User.create({
            email: "client@example.com",
            fullName: "Cliente Prueba",
            firebaseUid: "uid-client",
            role: CLIENT,
            status: 1
        });
        await User.create({
            email: "staff@example.com",
            fullName: "Vendedor Prueba",
            firebaseUid: "uid-staff",
            role: SELLER,
            status: 1
        });
    });

    itDb("creates the order in the tenant database only", async () => {
        const { statusCode, payload } = await call(
            createOrder,
            clientRequest({ body: orderBody() })
        );

        expect(statusCode).toBe(201);
        expect(await tenantModel("Order").countDocuments()).toBe(1);
        expect(await Order.countDocuments()).toBe(0);

        // The profile sync must stay central: identity is shared across stores.
        const centralUser = await User.findOne({ firebaseUid: "uid-client" });
        expect(centralUser.fullName).toBe("Cliente Nuevo");
        expect(payload.data.total).toBe(20);
    });

    itDb("confirms the order into a tenant sale and transaction", async () => {
        const created = await call(createOrder, clientRequest({ body: orderBody() }));
        const orderId = created.payload.data.id;

        const { statusCode, payload } = await call(
            updateOrderStatus,
            staffRequest({ params: { orderId }, body: { status: 1 } })
        );

        expect(statusCode).toBe(200);
        expect(payload.data.status).toBe(1);

        const tenantOrder = await tenantModel("Order").findById(orderId);
        expect(tenantOrder.status).toBe(1);
        expect(tenantOrder.saleId).toBeTruthy();

        expect(await tenantModel("Sale").countDocuments()).toBe(1);
        expect(await tenantModel("Transaction").countDocuments()).toBe(1);
        expect((await tenantModel("Product").findById(tenantProduct._id)).stock).toBe(8);

        // The whole flow stays in one database: nothing may leak here.
        expect(await Sale.countDocuments()).toBe(0);
        expect(await Transaction.countDocuments()).toBe(0);
        expect(await Product.countDocuments()).toBe(0);
    });

    itDb("does not expose a tenant order to another database", async () => {
        const created = await call(createOrder, clientRequest({ body: orderBody() }));
        const orderId = created.payload.data.id;

        const tenantRead = await call(
            getMyOrderById,
            clientRequest({ params: { orderId } })
        );
        expect(tenantRead.statusCode).toBe(200);

        const centralRead = await call(
            getMyOrderById,
            request({
                user: { firebaseUid: "uid-client", email: "client@example.com" },
                params: { orderId }
            })
        );
        expect(centralRead.statusCode).toBe(404);
    });
});
