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
import { createOrder, updateOrderStatus, getMyOrderById, getMyOrders } from "./order.controller.js";

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
            tenantModel("ComboComponent").init(),
            tenantModel("ComboPurchase").init(),
            tenantModel("ComboRedemption").init(),
            tenantModel("User").init()
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
            tenantModel("ComboPurchase").deleteMany({}),
            tenantModel("ComboRedemption").deleteMany({}),
            tenantModel("User").deleteMany({}),
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

        // Identity is tenant-scoped: both users live with the order.
        await tenantModel("User").create({
            email: "client@example.com",
            fullName: "Cliente Prueba",
            firebaseUid: "uid-client",
            role: CLIENT,
            status: 1
        });
        await tenantModel("User").create({
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

        // The profile sync stays in the tenant: the customer and the order share
        // one database.
        const tenantUser = await tenantModel("User").findOne({ firebaseUid: "uid-client" });
        expect(tenantUser.fullName).toBe("Cliente Nuevo");
        expect(await User.countDocuments()).toBe(0);
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

    // A genuinely vouchered combo: an active definition with a component, so
    // createOrder passes its availability check and reaches the quantity guard.
    const seedOrderableCombo = async () => {
        const component = await tenantModel("Product").create({
            name: "Combo Component",
            productType: 2,
            isSellable: true,
            price: 5,
            unit: new mongoose.Types.ObjectId(),
            stock: 10
        });
        const combo = await tenantModel("Product").create({
            name: "Orderable Combo",
            productType: 3,
            isSellable: true,
            price: 20,
            unit: component.unit,
            stock: 0
        });
        const definition = await tenantModel("ComboDefinition").create({
            product: combo._id,
            referencePrice: 20,
            validityDays: 0,
            status: 1
        });
        await tenantModel("ComboComponent").create({
            combo: definition._id,
            product: component._id,
            quantity: 1,
            stockProduct: component._id,
            conversionFactor: 1
        });
        return combo;
    };

    const comboOrderBody = (combo, quantity) => ({
        ...orderBody(),
        items: [{ productId: String(combo._id), quantity }]
    });

    itDb("rejects more than one unit of a combo", async () => {
        const combo = await seedOrderableCombo();

        const { statusCode, payload } = await call(
            createOrder,
            clientRequest({ body: comboOrderBody(combo, 2) })
        );

        expect(statusCode).toBe(400);
        expect(payload.message).toBe("error_order_invalid_items");
        expect(await tenantModel("Order").countDocuments()).toBe(0);
    });

    itDb("accepts a single unit of a combo", async () => {
        const combo = await seedOrderableCombo();

        const { statusCode } = await call(
            createOrder,
            clientRequest({ body: comboOrderBody(combo, 1) })
        );

        expect(statusCode).toBe(201);
        expect(await tenantModel("Order").countDocuments()).toBe(1);
    });

    describe("getMyOrders combo summary", () => {
        const OTHER_UID = "uid-orders-other";
        const OTHER_EMAIL = "other-orders@example.com";
        const PURCHASED_AT = new Date("2026-11-16T09:00:00.000Z");
        const REDEEMED_AT = new Date("2026-11-16T10:00:00.000Z");
        const FORBIDDEN_KEYS = [
            "idempotencyKey", "operator", "voidedAt", "voidedBy", "voidReason",
            "_id", "customerId", "sale", "pricePaid", "createdBy"
        ];

        let clientUser;
        let otherUser;
        let componentProduct;
        let comboProduct;
        let comboDefinition;

        const collectKeys = (value, keys = new Set()) => {
            if (Array.isArray(value)) {
                value.forEach((entry) => collectKeys(entry, keys));
            } else if (value && typeof value === "object") {
                Object.entries(value).forEach(([key, nested]) => {
                    keys.add(key);
                    collectKeys(nested, keys);
                });
            }
            return keys;
        };

        const expectNoInternalFields = (summary) => {
            const leaked = [...collectKeys(summary)].filter((key) => FORBIDDEN_KEYS.includes(key));
            expect(leaked).toEqual([]);
        };

        const seedSale = () => tenantModel("Sale").create({
            customerName: "Cliente Prueba",
            subtotal: 20,
            totalAmount: 20,
            paymentMethod: 0,
            paymentStatus: 1,
            saleStatus: 0
        });

        const seedOrder = ({ code, customer, saleId = null }) => tenantModel("Order").create({
            code,
            customer,
            customerName: "Cliente Prueba",
            customerPhone: "71234567",
            customerEmail: "client@example.com",
            deliveryType: 1,
            pickupAt: new Date(Date.now() + 60 * 60 * 1000),
            items: [{
                product: tenantProduct._id,
                name: tenantProduct.name,
                unitPrice: mongoose.Types.Decimal128.fromString("20.00"),
                quantity: 1,
                subtotal: mongoose.Types.Decimal128.fromString("20.00")
            }],
            total: mongoose.Types.Decimal128.fromString("20.00"),
            status: 1,
            saleId
        });

        const seedVoucher = ({
            code,
            sale,
            customerId,
            totalUnits,
            usedUnits,
            status = 0,
            purchasedAt = PURCHASED_AT
        }) => tenantModel("ComboPurchase").create({
            code,
            comboProduct: comboProduct._id,
            comboDefinition: comboDefinition._id,
            sale,
            customerName: "Combo Client",
            customerPhone: "71234567",
            customerId,
            purchasedAt,
            expiresAt: null,
            pricePaid: 20,
            balances: [{
                product: componentProduct._id,
                includedQty: totalUnits,
                usedQty: usedUnits,
                stockProduct: componentProduct._id,
                conversionFactor: 1
            }],
            totalUnits,
            usedUnits,
            status
        });

        const seedRedemption = ({
            comboPurchase,
            notes,
            redeemedAt = REDEEMED_AT,
            voidedAt = null
        }) => tenantModel("ComboRedemption").create({
            comboPurchase,
            items: [{ product: componentProduct._id, quantity: 1 }],
            operator: new mongoose.Types.ObjectId(),
            redeemedAt,
            idempotencyKey: new mongoose.Types.ObjectId().toString(),
            notes,
            voidedAt,
            voidedBy: voidedAt ? new mongoose.Types.ObjectId() : null,
            voidReason: voidedAt ? "Customer returned the product" : ""
        });

        const readOrders = async () => {
            const { statusCode, payload } = await call(getMyOrders, clientRequest());
            expect(statusCode).toBe(200);
            return payload.data;
        };

        beforeEach(async () => {
            clientUser = await tenantModel("User").findOne({ firebaseUid: "uid-client" });
            otherUser = await tenantModel("User").create({
                email: OTHER_EMAIL,
                fullName: "Other Client",
                firebaseUid: OTHER_UID,
                role: CLIENT,
                status: 1
            });

            componentProduct = await tenantModel("Product").create({
                name: "Combo Bottled Water",
                productType: 2,
                isSellable: true,
                price: 5,
                unit: new mongoose.Types.ObjectId(),
                stock: 10
            });
            comboProduct = await tenantModel("Product").create({
                name: "Order Combo",
                productType: 3,
                isSellable: true,
                price: 20,
                unit: componentProduct.unit,
                stock: 0
            });
            comboDefinition = await tenantModel("ComboDefinition").create({
                product: comboProduct._id,
                referencePrice: 20,
                validityDays: 0,
                status: 1
            });
        });

        itDb("returns summed combo progress without internal fields", async () => {
            const sale = await seedSale();
            const order = await seedOrder({
                code: "PED-COMBO1",
                customer: clientUser._id,
                saleId: sale._id
            });
            const first = await seedVoucher({
                code: "CB000001",
                sale: sale._id,
                customerId: clientUser._id,
                totalUnits: 5,
                usedUnits: 2
            });
            await seedVoucher({
                code: "CB000002",
                sale: sale._id,
                customerId: clientUser._id,
                totalUnits: 3,
                usedUnits: 1,
                status: 1,
                purchasedAt: new Date("2026-11-16T09:01:00.000Z")
            });
            await seedRedemption({ comboPurchase: first._id, notes: "  Entrega parcial  " });

            const dtos = await readOrders();
            const summary = dtos.find((dto) => dto.id === String(order._id))?.comboSummary;

            expect(summary).toEqual({
                totalUnits: 8,
                usedUnits: 3,
                vouchers: [
                    {
                        code: "CB000001",
                        status: 0,
                        totalUnits: 5,
                        usedUnits: 2,
                        redemptions: [{
                            redeemedAt: REDEEMED_AT.toISOString(),
                            notes: "Entrega parcial",
                            items: [{ productName: "Combo Bottled Water", quantity: 1 }]
                        }]
                    },
                    {
                        code: "CB000002",
                        status: 1,
                        totalUnits: 3,
                        usedUnits: 1,
                        redemptions: []
                    }
                ]
            });
            expectNoInternalFields(summary);
        });

        itDb("ignores a voucher owned by another customer for the same sale", async () => {
            const sale = await seedSale();
            const order = await seedOrder({
                code: "PED-COMBO2",
                customer: clientUser._id,
                saleId: sale._id
            });
            await seedVoucher({
                code: "CB000010",
                sale: sale._id,
                customerId: clientUser._id,
                totalUnits: 4,
                usedUnits: 1
            });
            await seedVoucher({
                code: "CB000011",
                sale: sale._id,
                customerId: otherUser._id,
                totalUnits: 9,
                usedUnits: 7
            });

            const dtos = await readOrders();
            const summary = dtos.find((dto) => dto.id === String(order._id)).comboSummary;

            expect(summary.totalUnits).toBe(4);
            expect(summary.usedUnits).toBe(1);
            expect(summary.vouchers.map((voucher) => voucher.code)).toEqual(["CB000010"]);
            expect(JSON.stringify(summary)).not.toContain("CB000011");
        });

        itDb("omits comboSummary for orders without vouchers", async () => {
            const saleWithoutVouchers = await seedSale();
            const comboOrder = await seedOrder({
                code: "PED-COMBO3",
                customer: clientUser._id,
                saleId: saleWithoutVouchers._id
            });
            const plainOrder = await seedOrder({
                code: "PED-PLAIN3",
                customer: clientUser._id
            });

            const dtos = await readOrders();
            const byId = new Map(dtos.map((dto) => [dto.id, dto]));

            expect(byId.get(String(comboOrder._id))).not.toHaveProperty("comboSummary");
            expect(byId.get(String(plainOrder._id))).not.toHaveProperty("comboSummary");
        });

        itDb("excludes voided redemptions from the history", async () => {
            const sale = await seedSale();
            const order = await seedOrder({
                code: "PED-COMBO4",
                customer: clientUser._id,
                saleId: sale._id
            });
            const voucher = await seedVoucher({
                code: "CB000020",
                sale: sale._id,
                customerId: clientUser._id,
                totalUnits: 5,
                usedUnits: 1
            });
            await seedRedemption({ comboPurchase: voucher._id, notes: "Entrega vigente" });
            await seedRedemption({
                comboPurchase: voucher._id,
                notes: "Canje anulado",
                redeemedAt: new Date("2026-11-16T12:00:00.000Z"),
                voidedAt: new Date("2026-11-16T13:00:00.000Z")
            });

            const dtos = await readOrders();
            const summary = dtos.find((dto) => dto.id === String(order._id)).comboSummary;

            expect(summary.usedUnits).toBe(1);
            expect(summary.vouchers[0].redemptions).toEqual([{
                redeemedAt: REDEEMED_AT.toISOString(),
                notes: "Entrega vigente",
                items: [{ productName: "Combo Bottled Water", quantity: 1 }]
            }]);
            expect(JSON.stringify(summary)).not.toContain("Canje anulado");
            expectNoInternalFields(summary);
        });
    });
});
