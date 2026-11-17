import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import { Sale } from "./sale.model.js";
import { Product } from "../products/product.model.js";
import { Transaction } from "../transactions/transaction.model.js";
import { getTenantModel, resetTenantConnections } from "../tenants/tenantConnection.js";
import { DB_NAME } from "../../constants.js";
import {
    createSale,
    getSaleById,
    updateSale,
    deleteSale,
    cancelSale
} from "./sale.controller.js";
import { checkSaleModificationWindow } from "./sale.policy.js";

// Las operaciones de anular y eliminar abren una transacción de Mongo,
// así que el test necesita un replica set, no un mongod suelto.
let replSet;

// En ESM `jest` no es global: el timeout se pasa por test.
const TEST_TIMEOUT = 20000;
const itDb = (name, fn) => it(name, fn, TEST_TIMEOUT);

const SUPERADMIN = [-1];
const ADMIN = [0];
const SUPERVISOR = [1];
const SELLER = [2];
const CLIENT = [3];

const BOLIVIA_OFFSET_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Mediodía (hora Bolivia) del día que está `daysAgo` días atrás.
const boliviaDateDaysAgo = (daysAgo) => {
    const now = new Date();
    const bolivia = new Date(now.getTime() - BOLIVIA_OFFSET_MS);
    const boliviaMidnightUtc =
        Date.UTC(bolivia.getUTCFullYear(), bolivia.getUTCMonth(), bolivia.getUTCDate()) + BOLIVIA_OFFSET_MS;
    return new Date(boliviaMidnightUtc - daysAgo * DAY_MS + 12 * 60 * 60 * 1000);
};

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

const TENANT_DB = "tenant_sales";

const request = (overrides = {}) => ({
    params: {},
    query: {},
    body: {},
    headers: { "accept-language": "es" },
    user: { mongoDbId: new mongoose.Types.ObjectId(), role: SELLER },
    tenant: buildTenant(),
    ...overrides
});

const withRole = (role) => ({ mongoDbId: new mongoose.Types.ObjectId(), role });

const createSaleDoc = (daysAgo) =>
    Sale.create({
        subtotal: 10,
        totalAmount: 10,
        saleDate: boliviaDateDaysAgo(daysAgo),
        items: [],
        notes: "original"
    });

beforeAll(async () => {
    // Un replica set de memoria de un solo nodo pierde el lock de una
    // transacción por defecto a los 5 ms bajo carga secuencial y la venta
    // falla con LockTimeout. Es una limitación del harness, no del código:
    // producción conserva el valor por defecto.
    replSet = await MongoMemoryReplSet.create({
        replSet: {
            count: 1,
            args: ["--setParameter", "maxTransactionLockRequestTimeoutMillis=10000"]
        }
    });
    await mongoose.connect(replSet.getUri());
    // Build every index before the first transaction. A background index build
    // changes the catalog and makes an in-flight transaction fail with
    // "catalog changes"; awaiting them up front removes that race.
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

beforeEach(async () => {
    await Sale.deleteMany({});
});

describe("sale modification policy", () => {
    const now = new Date("2026-11-14T15:00:00.000Z");

    const check = (saleDate, roles) =>
        checkSaleModificationWindow({ saleDate, roles, now });

    itDb("lets a seller modify a sale from today only", () => {
        expect(check("2026-11-14T10:00:00.000Z", SELLER).allowed).toBe(true);
        expect(check("2026-11-13T10:00:00.000Z", SELLER)).toMatchObject({
            allowed: false,
            errorCode: "error_sale_immutable_date"
        });
    });

    itDb("gives supervisor and admin a 7 day window", () => {
        for (const role of [SUPERVISOR, ADMIN]) {
            expect(check("2026-11-11T10:00:00.000Z", role).allowed).toBe(true);
            expect(check("2026-11-07T10:00:00.000Z", role).allowed).toBe(true);
            expect(check("2026-11-06T10:00:00.000Z", role)).toMatchObject({
                allowed: false,
                errorCode: "error_sale_edit_window_expired"
            });
        }
    });

    itDb("gives the superadmin the same 7 day window as an admin", () => {
        expect(check("2026-11-07T10:00:00.000Z", SUPERADMIN).allowed).toBe(true);
        expect(check("2026-11-06T10:00:00.000Z", SUPERADMIN)).toMatchObject({
            allowed: false,
            errorCode: "error_sale_edit_window_expired"
        });
    });

    itDb("measures calendar days in Bolivia time, not UTC", () => {
        // 2026-11-14T02:00Z es todavía 13/11 en Bolivia (UTC-4).
        expect(check("2026-11-14T02:00:00.000Z", SELLER)).toMatchObject({
            allowed: false,
            daysElapsed: 1
        });
    });

    itDb("allows future dated sales so the window cannot be bypassed by re-dating", () => {
        expect(check("2026-11-20T10:00:00.000Z", SELLER).allowed).toBe(true);
    });

    itDb("rejects roles outside the staff", () => {
        expect(check("2026-11-14T10:00:00.000Z", CLIENT)).toMatchObject({
            allowed: false,
            errorCode: "error_sale_forbidden_role"
        });
        expect(check("2026-11-14T10:00:00.000Z", []).allowed).toBe(false);
    });
});

describe("sale role gate", () => {
    itDb("rejects a client creating a sale", async () => {
        const { statusCode, payload } = await call(
            createSale,
            request({
                user: withRole(CLIENT),
                body: { totalAmount: 10, transactionCategory: new mongoose.Types.ObjectId().toString() }
            })
        );

        expect(statusCode).toBe(403);
        expect(payload.message).toBe("Solo un vendedor, supervisor o administrador puede realizar esta acción.");
        expect(await Sale.countDocuments()).toBe(0);
    });

    itDb("rejects a client updating a sale", async () => {
        const sale = await createSaleDoc(0);
        const { statusCode } = await call(
            updateSale,
            request({ params: { saleId: String(sale._id) }, user: withRole(CLIENT), body: { notes: "hack" } })
        );

        expect(statusCode).toBe(403);
        expect((await Sale.findById(sale._id)).notes).toBe("original");
    });

    itDb("rejects a client deleting a sale", async () => {
        const sale = await createSaleDoc(0);
        const { statusCode } = await call(
            deleteSale,
            request({ params: { saleId: String(sale._id) }, user: withRole(CLIENT) })
        );

        expect(statusCode).toBe(403);
        expect(await Sale.findById(sale._id)).not.toBeNull();
    });

    itDb("rejects a client cancelling a sale", async () => {
        const sale = await createSaleDoc(0);
        const { statusCode } = await call(
            cancelSale,
            request({ params: { saleId: String(sale._id) }, user: withRole(CLIENT) })
        );

        expect(statusCode).toBe(403);
        expect((await Sale.findById(sale._id)).saleStatus).toBe(0);
    });

    itDb("rejects a user without roles", async () => {
        const { statusCode } = await call(
            updateSale,
            request({
                params: { saleId: new mongoose.Types.ObjectId().toString() },
                user: { mongoDbId: new mongoose.Types.ObjectId() },
                body: { notes: "x" }
            })
        );

        expect(statusCode).toBe(403);
    });

    itDb("lets a seller create a sale", async () => {
        const { statusCode } = await call(
            createSale,
            request({
                body: {
                    totalAmount: 10,
                    transactionCategory: new mongoose.Types.ObjectId().toString()
                }
            })
        );

        expect(statusCode).toBe(201);
        expect(await Sale.countDocuments()).toBe(1);
    });

    itDb("lets a superadmin create a sale", async () => {
        const { statusCode } = await call(
            createSale,
            request({
                user: withRole(SUPERADMIN),
                body: {
                    totalAmount: 10,
                    transactionCategory: new mongoose.Types.ObjectId().toString()
                }
            })
        );

        expect(statusCode).toBe(201);
        expect(await Sale.countDocuments()).toBe(1);
    });
});

describe("sale modification window", () => {
    itDb("lets a seller update a sale from today", async () => {
        const sale = await createSaleDoc(0);
        const { statusCode, payload } = await call(
            updateSale,
            request({ params: { saleId: String(sale._id) }, body: { notes: "editada" } })
        );

        expect(statusCode).toBe(200);
        expect(payload.data.notes).toBe("editada");
    });

    itDb("blocks a seller from updating yesterday's sale and persists nothing", async () => {
        const sale = await createSaleDoc(1);
        const { statusCode, payload } = await call(
            updateSale,
            request({ params: { saleId: String(sale._id) }, body: { notes: "editada" } })
        );

        expect(statusCode).toBe(403);
        expect(payload.message).toBe("Solo se pueden modificar, anular o eliminar ventas realizadas el día de hoy.");
        expect((await Sale.findById(sale._id)).notes).toBe("original");
    });

    itDb("closes the saleDate bypass: a seller cannot re-date an old sale to today", async () => {
        const sale = await createSaleDoc(1);
        const originalDate = (await Sale.findById(sale._id)).saleDate;

        const { statusCode } = await call(
            updateSale,
            request({
                params: { saleId: String(sale._id) },
                body: { notes: "editada", saleDate: new Date().toISOString() }
            })
        );

        expect(statusCode).toBe(403);
        const after = await Sale.findById(sale._id);
        expect(after.notes).toBe("original");
        expect(after.saleDate.getTime()).toBe(originalDate.getTime());
    });

    itDb("forbids a seller from changing the sale date even on today's sale", async () => {
        const sale = await createSaleDoc(0);
        const { statusCode, payload } = await call(
            updateSale,
            request({
                params: { saleId: String(sale._id) },
                body: { saleDate: new Date().toISOString() }
            })
        );

        expect(statusCode).toBe(403);
        expect(payload.message).toBe("Solo un supervisor o administrador puede cambiar la fecha de una venta.");
    });

    itDb("lets a supervisor update a sale from three days ago", async () => {
        const sale = await createSaleDoc(3);
        const { statusCode } = await call(
            updateSale,
            request({ params: { saleId: String(sale._id) }, user: withRole(SUPERVISOR), body: { notes: "editada" } })
        );

        expect(statusCode).toBe(200);
    });

    itDb("lets a superadmin change the sale date", async () => {
        const sale = await createSaleDoc(3);
        const { statusCode } = await call(
            updateSale,
            request({
                params: { saleId: String(sale._id) },
                user: withRole(SUPERADMIN),
                body: { saleDate: new Date().toISOString() }
            })
        );

        expect(statusCode).toBe(200);
    });

    itDb("blocks a supervisor from updating an eight day old sale", async () => {
        const sale = await createSaleDoc(8);
        const { statusCode, payload } = await call(
            updateSale,
            request({ params: { saleId: String(sale._id) }, user: withRole(SUPERVISOR), body: { notes: "editada" } })
        );

        expect(statusCode).toBe(403);
        expect(payload.message).toBe("Solo se pueden modificar, anular o eliminar ventas de los últimos 7 días.");
    });

    itDb("lets an admin delete a seven day old sale", async () => {
        const sale = await createSaleDoc(7);
        const { statusCode } = await call(
            deleteSale,
            request({ params: { saleId: String(sale._id) }, user: withRole(ADMIN) })
        );

        expect(statusCode).toBe(200);
        expect(await Sale.findById(sale._id)).toBeNull();
    });

    itDb("blocks an admin from deleting an eight day old sale", async () => {
        const sale = await createSaleDoc(8);
        const { statusCode } = await call(
            deleteSale,
            request({ params: { saleId: String(sale._id) }, user: withRole(ADMIN) })
        );

        expect(statusCode).toBe(403);
        expect(await Sale.findById(sale._id)).not.toBeNull();
    });

    itDb("blocks a seller from deleting yesterday's sale", async () => {
        const sale = await createSaleDoc(1);
        const { statusCode } = await call(
            deleteSale,
            request({ params: { saleId: String(sale._id) } })
        );

        expect(statusCode).toBe(403);
        expect(await Sale.findById(sale._id)).not.toBeNull();
    });

    itDb("lets a supervisor cancel a three day old sale", async () => {
        const sale = await createSaleDoc(3);
        const { statusCode } = await call(
            cancelSale,
            request({ params: { saleId: String(sale._id) }, user: withRole(SUPERVISOR) })
        );

        expect(statusCode).toBe(200);
        expect((await Sale.findById(sale._id)).saleStatus).toBe(2);
    });

    itDb("blocks an admin from cancelling an eight day old sale", async () => {
        const sale = await createSaleDoc(8);
        const { statusCode } = await call(
            cancelSale,
            request({ params: { saleId: String(sale._id) }, user: withRole(ADMIN) })
        );

        expect(statusCode).toBe(403);
        expect((await Sale.findById(sale._id)).saleStatus).toBe(0);
    });
});

describe("sale tenant routing", () => {
    const tenantModel = (name) => getTenantModel(TENANT_DB, name);

    beforeAll(async () => {
        // Creating a collection implicitly inside a transaction races for the
        // lock in a single-node replica set. Create them up front.
        await Promise.all([
            tenantModel("Sale").init(),
            tenantModel("Transaction").init(),
            tenantModel("Product").init(),
            tenantModel("ComboPurchase").init()
        ]);
    }, 60000);

    const tenantRequest = (overrides = {}) => request({
        ...overrides,
        tenant: buildTenant(TENANT_DB)
    });

    const createTenantProduct = (overrides = {}) => tenantModel("Product").create({
        name: "Tenant Soda",
        productType: 2,
        isSellable: true,
        isPurchasable: true,
        price: 10,
        unit: new mongoose.Types.ObjectId(),
        stock: 10,
        ...overrides
    });

    const sellTwoUnits = (product) => tenantRequest({
        body: {
            totalAmount: 20,
            transactionCategory: new mongoose.Types.ObjectId().toString(),
            items: [{ product: product._id.toString(), quantity: 2, unitPrice: 10, subtotal: 20 }],
            paymentStatus: 1
        }
    });

    beforeEach(async () => {
        await tenantModel("Sale").deleteMany({});
        await tenantModel("Transaction").deleteMany({});
        await tenantModel("Product").deleteMany({});
        await tenantModel("ComboPurchase").deleteMany({});

        // The central database is shared with the tests above, which only
        // clean up sales. Clear the rest so the leak assertions are meaningful.
        await Transaction.deleteMany({});
        await Product.deleteMany({});
    });

    itDb("writes the sale, its transaction and the stock movement to the tenant database", async () => {
        const product = await createTenantProduct();

        const { statusCode, payload } = await call(createSale, sellTwoUnits(product));

        expect(statusCode).toBe(201);
        expect(payload.data.transactionId).toBeDefined();

        expect(await tenantModel("Sale").countDocuments()).toBe(1);
        expect(await tenantModel("Transaction").countDocuments()).toBe(1);
        expect((await tenantModel("Product").findById(product._id)).stock).toBe(8);

        // The whole flow must stay in one database: nothing may leak here.
        expect(await Sale.countDocuments()).toBe(0);
        expect(await Transaction.countDocuments()).toBe(0);
        expect(await Product.countDocuments()).toBe(0);
    });

    itDb("restores the tenant stock when the sale is cancelled", async () => {
        const product = await createTenantProduct();
        const created = await call(createSale, sellTwoUnits(product));
        const saleId = created.payload.data._id.toString();

        const cancelled = await call(cancelSale, tenantRequest({ params: { saleId } }));

        expect(cancelled.statusCode).toBe(200);
        expect((await tenantModel("Product").findById(product._id)).stock).toBe(10);
        expect((await tenantModel("Sale").findById(saleId)).saleStatus).toBe(2);
        expect(await Sale.countDocuments()).toBe(0);
    });

    itDb("does not expose a tenant sale to another database", async () => {
        const product = await createTenantProduct();
        const created = await call(createSale, sellTwoUnits(product));
        const saleId = created.payload.data._id.toString();

        const tenantRead = await call(getSaleById, tenantRequest({ params: { saleId } }));
        expect(tenantRead.statusCode).toBe(200);

        const centralRead = await call(getSaleById, request({ params: { saleId } }));
        expect(centralRead.statusCode).toBe(404);
    });

    describe("derived chicken stock", () => {
        const MENU_PRICES = [80, 25, 17];

        const createAccumulator = (stock = 100) => tenantModel("Product").create({
            name: "Pollo (presa)",
            productType: 2,
            isSellable: false,
            isPurchasable: true,
            unit: new mongoose.Types.ObjectId(),
            purchaseUnit: new mongoose.Types.ObjectId(),
            conversionFactor: 8,
            price: 0,
            stock
        });

        const createPresentation = (accumulator, name, price, stockConversionFactor) =>
            tenantModel("Product").create({
                name,
                productType: 1,
                isSellable: true,
                unit: new mongoose.Types.ObjectId(),
                price,
                stockProduct: accumulator._id,
                stockConversionFactor
            });

        const createMenu = async (stock = 100) => {
            const accumulator = await createAccumulator(stock);
            const presentations = [
                await createPresentation(accumulator, "Pollo Entero", MENU_PRICES[0], 8),
                await createPresentation(accumulator, "Cuarto de Pollo", MENU_PRICES[1], 2),
                await createPresentation(accumulator, "Plato Económico", MENU_PRICES[2], 1)
            ];
            return { accumulator, presentations };
        };

        const menuRequest = (presentations) => tenantRequest({
            body: {
                totalAmount: MENU_PRICES.reduce((total, price) => total + price, 0),
                transactionCategory: new mongoose.Types.ObjectId().toString(),
                items: presentations.map((presentation, index) => ({
                    product: String(presentation._id),
                    quantity: 1,
                    unitPrice: MENU_PRICES[index],
                    subtotal: MENU_PRICES[index]
                })),
                paymentStatus: 1
            }
        });

        const stockOf = async (product) =>
            (await tenantModel("Product").findById(product._id)).stock;

        itDb("decrements the accumulator by each presentation's derived factor", async () => {
            const { accumulator, presentations } = await createMenu();
            const req = menuRequest(presentations);

            const { statusCode } = await call(createSale, req);

            expect(statusCode).toBe(201);
            expect(await stockOf(accumulator)).toBe(100 - 8 - 2 - 1);
            for (const presentation of presentations) {
                expect(await stockOf(presentation)).toBe(0);
            }

            const sale = await tenantModel("Sale").findOne({});
            expect(sale.items).toHaveLength(3);
            expect(sale.items.map((item) => String(item.stockProduct)))
                .toEqual(presentations.map(() => String(accumulator._id)));
            expect(sale.items.map((item) => item.conversionFactor)).toEqual([8, 2, 1]);

            // The request body belongs to the client and must stay untouched.
            expect(req.body.items.every((item) =>
                item.stockProduct === undefined && item.conversionFactor === undefined
            )).toBe(true);
        });

        itDb("restores the derived amount when the sale is cancelled", async () => {
            const { accumulator, presentations } = await createMenu();
            const created = await call(createSale, menuRequest(presentations));
            expect(created.statusCode).toBe(201);
            expect(await stockOf(accumulator)).toBe(89);

            const cancelled = await call(cancelSale, tenantRequest({
                params: { saleId: String(created.payload.data._id) }
            }));

            expect(cancelled.statusCode).toBe(200);
            expect(await stockOf(accumulator)).toBe(100);
            expect((await tenantModel("Sale").findById(created.payload.data._id)).saleStatus).toBe(2);
        });

        itDb("restores the derived amount when the sale is deleted", async () => {
            const { accumulator, presentations } = await createMenu();
            const created = await call(createSale, menuRequest(presentations));
            expect(created.statusCode).toBe(201);
            expect(await stockOf(accumulator)).toBe(89);

            const deleted = await call(deleteSale, tenantRequest({
                params: { saleId: String(created.payload.data._id) }
            }));

            expect(deleted.statusCode).toBe(200);
            expect(await stockOf(accumulator)).toBe(100);
            expect(await tenantModel("Sale").countDocuments()).toBe(0);
        });

        itDb("does not overwrite explicit stockProduct or conversionFactor", async () => {
            const { accumulator, presentations } = await createMenu();
            const explicitTarget = await createAccumulator(50);
            const req = tenantRequest({
                body: {
                    totalAmount: 160,
                    transactionCategory: new mongoose.Types.ObjectId().toString(),
                    items: [{
                        product: String(presentations[0]._id),
                        quantity: 2,
                        unitPrice: 80,
                        subtotal: 160,
                        stockProduct: String(explicitTarget._id),
                        conversionFactor: 3
                    }],
                    paymentStatus: 1
                }
            });

            const { statusCode } = await call(createSale, req);

            expect(statusCode).toBe(201);
            expect(await stockOf(explicitTarget)).toBe(50 - 2 * 3);
            expect(await stockOf(accumulator)).toBe(100);

            const sale = await tenantModel("Sale").findOne({});
            expect(String(sale.items[0].stockProduct)).toBe(String(explicitTarget._id));
            expect(sale.items[0].conversionFactor).toBe(3);
            expect(req.body.items[0]).toMatchObject({
                stockProduct: String(explicitTarget._id),
                conversionFactor: 3
            });
        });

        itDb("keeps ordinary sales decrementing their own product", async () => {
            const product = await createTenantProduct();

            const { statusCode } = await call(createSale, sellTwoUnits(product));

            expect(statusCode).toBe(201);
            expect(await stockOf(product)).toBe(8);

            const sale = await tenantModel("Sale").findOne({});
            expect(sale.items[0].stockProduct).toBeNull();
            expect(sale.items[0].conversionFactor).toBe(1);
        });

        itDb("rejects a derived sale when the accumulator has too little stock", async () => {
            const { accumulator, presentations } = await createMenu(1);

            const { statusCode, payload } = await call(createSale, menuRequest(presentations));

            expect(statusCode).toBe(400);
            expect(payload.message).toBe("Stock insuficiente para uno o más productos de la venta.");
            expect(await stockOf(accumulator)).toBe(1);
            expect(await tenantModel("Sale").countDocuments()).toBe(0);
        });
    });
});
