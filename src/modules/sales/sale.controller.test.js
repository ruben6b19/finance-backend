import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import { Sale } from "./sale.model.js";
import {
    createSale,
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

const request = (overrides = {}) => ({
    params: {},
    query: {},
    body: {},
    headers: { "accept-language": "es" },
    user: { mongoDbId: new mongoose.Types.ObjectId(), role: SELLER },
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
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri());
}, 120000);

afterAll(async () => {
    await mongoose.connection.dropDatabase();
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
