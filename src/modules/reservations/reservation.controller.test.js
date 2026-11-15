import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import { Reservation } from "./reservation.model.js";
import { Sale } from "../sales/sale.model.js";
import { Transaction } from "../transactions/transaction.model.js";
import { Product } from "../products/product.model.js";
import { TransactionCategory } from "../transactionCategories/transactionCategory.model.js";
import { getTenantModel, resetTenantConnections } from "../tenants/tenantConnection.js";
import { DB_NAME } from "../../constants.js";
import {
    createReservation,
    getReservationById,
    voidReservation
} from "./reservation.controller.js";

// Creating or voiding a reservation opens a Mongo transaction: needs a replica set.
let replSet;

const TEST_TIMEOUT = 20000;
const itDb = (name, fn) => it(name, fn, TEST_TIMEOUT);

const TENANT_DB = "tenant_reservations";
const SELLER = [2];
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
    user: { mongoDbId: new mongoose.Types.ObjectId(), role: SELLER },
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

describe("reservation tenant routing", () => {
    const tenantModel = (name) => getTenantModel(TENANT_DB, name);

    beforeAll(async () => {
        // Creating collections inside a transaction races for the catalog lock
        // in a single-node replica set, so create them up front.
        await Promise.all([
            tenantModel("Reservation").init(),
            tenantModel("Sale").init(),
            tenantModel("Transaction").init(),
            tenantModel("Product").init(),
            tenantModel("TransactionCategory").init()
        ]);
    }, 60000);

    let tenantProduct;

    const tenantRequest = (overrides = {}) => request({
        ...overrides,
        tenant: buildTenant(TENANT_DB)
    });

    const supervisorRequest = (overrides = {}) => tenantRequest({
        ...overrides,
        user: { mongoDbId: new mongoose.Types.ObjectId(), role: SUPERVISOR }
    });

    const reservationBody = () => ({
        customerName: "Cliente Reserva",
        customerPhone: "71234567",
        items: [{ product: String(tenantProduct._id), quantity: 2 }],
        pickupAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    });

    beforeEach(async () => {
        await Promise.all([
            tenantModel("Reservation").deleteMany({}),
            tenantModel("Sale").deleteMany({}),
            tenantModel("Transaction").deleteMany({}),
            tenantModel("Product").deleteMany({}),
            tenantModel("TransactionCategory").deleteMany({}),
            // The central database is shared by every test in this file, so
            // clear it too: the leak assertions are only meaningful if it starts
            // empty.
            Reservation.deleteMany({}),
            Sale.deleteMany({}),
            Transaction.deleteMany({}),
            Product.deleteMany({}),
            TransactionCategory.deleteMany({})
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
    });

    itDb("creates the reservation, its sale and transaction in the tenant database only", async () => {
        const { statusCode } = await call(
            createReservation,
            tenantRequest({ body: reservationBody() })
        );

        expect(statusCode).toBe(201);
        expect(await tenantModel("Reservation").countDocuments()).toBe(1);
        expect(await tenantModel("Sale").countDocuments()).toBe(1);
        expect(await tenantModel("Transaction").countDocuments()).toBe(1);
        expect((await tenantModel("Product").findById(tenantProduct._id)).stock).toBe(8);

        // The whole flow stays in one database: nothing may leak here.
        expect(await Reservation.countDocuments()).toBe(0);
        expect(await Sale.countDocuments()).toBe(0);
        expect(await Transaction.countDocuments()).toBe(0);
        expect(await Product.countDocuments()).toBe(0);
    });

    itDb("restores the tenant stock when the reservation is voided", async () => {
        const created = await call(
            createReservation,
            tenantRequest({ body: reservationBody() })
        );
        const reservationId = String(created.payload.data._id);

        const { statusCode, payload } = await call(
            voidReservation,
            supervisorRequest({
                params: { reservationId },
                body: { voidReason: "Cliente desistió" }
            })
        );

        expect(statusCode).toBe(200);
        expect(payload.data.status).toBe(3);

        const tenantReservation = await tenantModel("Reservation").findById(reservationId);
        expect(tenantReservation.status).toBe(3);

        const tenantSale = await tenantModel("Sale").findById(tenantReservation.saleId);
        expect(tenantSale.saleStatus).toBe(2);

        const tenantTransaction = await tenantModel("Transaction").findById(tenantSale.transactionId);
        expect(tenantTransaction.status).toBe(0);

        expect((await tenantModel("Product").findById(tenantProduct._id)).stock).toBe(10);

        // The reversal must stay in the tenant database too.
        expect(await Sale.countDocuments()).toBe(0);
        expect(await Transaction.countDocuments()).toBe(0);
        expect(await Product.countDocuments()).toBe(0);
    });

    itDb("does not expose a tenant reservation to another database", async () => {
        const created = await call(
            createReservation,
            tenantRequest({ body: reservationBody() })
        );
        const reservationId = String(created.payload.data._id);

        const tenantRead = await call(
            getReservationById,
            tenantRequest({ params: { reservationId } })
        );
        expect(tenantRead.statusCode).toBe(200);

        const centralRead = await call(
            getReservationById,
            request({ params: { reservationId } })
        );
        expect(centralRead.statusCode).toBe(404);
    });
});
