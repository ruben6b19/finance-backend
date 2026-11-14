import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import { Product } from "../products/product.model.js";
import { User } from "../users/user.model.js";
import { ComboDefinition } from "./comboDefinition.model.js";
import { ComboComponent } from "./comboComponent.model.js";
import { ComboPurchase } from "./comboPurchase.model.js";
import { ComboRedemption } from "./comboRedemption.model.js";
import {
    getComboPurchases,
    getComboPurchaseById,
    getComboPurchaseRedemptions,
    createRedemption,
    voidRedemption
} from "./comboPurchase.controller.js";

let server;
let voucher;
let waterProductId;
let comboProductId;
let comboDefinitionId;

const WATER_NAME = "Agua Mineral 500ml";

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
    headers: {},
    user: { mongoDbId: new mongoose.Types.ObjectId(), role: [0] },
    ...overrides
});

beforeAll(async () => {
    // Anular un canje abre una transacción de Mongo: hace falta un replica set.
    server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(server.getUri());

    const water = await Product.create({
        name: WATER_NAME,
        price: 5,
        unit: new mongoose.Types.ObjectId(),
        productType: 2,
        isSellable: true,
        stock: 25
    });
    const combo = await Product.create({
        name: "Combo de Agua",
        price: 20,
        costPrice: 0,
        unit: water.unit,
        productType: 3,
        isSellable: true,
        stock: 0
    });
    const definition = await ComboDefinition.create({
        product: combo._id,
        referencePrice: 25,
        validityDays: 0,
        status: 1
    });
    await ComboComponent.create({
        combo: definition._id,
        product: water._id,
        quantity: 5,
        label: WATER_NAME,
        stockProduct: water._id,
        conversionFactor: 1
    });

    voucher = await ComboPurchase.create({
        code: "AB12CD34",
        comboProduct: combo._id,
        comboDefinition: definition._id,
        sale: new mongoose.Types.ObjectId(),
        customerName: "Cliente",
        customerPhone: "12345678",
        purchasedAt: new Date("2026-11-13T21:44:34.803Z"),
        expiresAt: null,
        pricePaid: 20,
        balances: [
            {
                product: water._id,
                includedQty: 5,
                usedQty: 2,
                stockProduct: water._id,
                conversionFactor: 1
            }
        ],
        totalUnits: 5,
        usedUnits: 2,
        status: 0
    });

    await ComboRedemption.create({
        comboPurchase: voucher._id,
        items: [{ product: water._id, quantity: 2 }],
        operator: new mongoose.Types.ObjectId(),
        redeemedAt: new Date("2026-11-14T10:00:00.000Z"),
        idempotencyKey: "seed-key"
    });

    waterProductId = water._id;
    comboProductId = combo._id;
    comboDefinitionId = definition._id;
}, 120000);

afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
    await server.stop();
}, 60000);

describe("combo purchase reads", () => {
    it("populates balances.product with the component name in the list", async () => {
        const { statusCode, payload } = await call(getComboPurchases, request({ query: { page: "1" } }));

        expect(statusCode).toBe(200);
        const [doc] = payload.data.docs;
        expect(doc.code).toBe("AB12CD34");
        expect(doc.expiresAt).toBeNull();
        expect(doc.balances[0].product).toMatchObject({
            _id: expect.anything(),
            name: WATER_NAME
        });
        expect(String(doc.balances[0].product._id)).toBe(String(voucher.balances[0].product));
    });

    it("populates balances.product in the detail read, resolving by code", async () => {
        const { statusCode, payload } = await call(
            getComboPurchaseById,
            request({ params: { comboPurchaseId: "ab12cd34" } })
        );

        expect(statusCode).toBe(200);
        expect(payload.data.code).toBe("AB12CD34");
        expect(payload.data.balances[0].product.name).toBe(WATER_NAME);
        expect(payload.data.usedUnits).toBe(2);
    });

    it("populates items.product with the component name in the redemption history", async () => {
        const { statusCode, payload } = await call(
            getComboPurchaseRedemptions,
            request({ params: { comboPurchaseId: voucher.code } })
        );

        expect(statusCode).toBe(200);
        expect(payload.data).toHaveLength(1);
        expect(payload.data[0].items[0].product).toMatchObject({ name: WATER_NAME });
        expect(payload.data[0].items[0].quantity).toBe(2);
    });
});

describe("createRedemption role gate", () => {
    it("rejects a client with 403 and the translated message", async () => {
        const { statusCode, payload } = await call(
            createRedemption,
            request({
                params: { comboPurchaseId: voucher.code },
                user: { mongoDbId: new mongoose.Types.ObjectId(), role: [3] },
                body: {
                    idempotencyKey: "client-key",
                    items: [{ product: String(voucher.balances[0].product), quantity: 1 }]
                }
            })
        );

        expect(statusCode).toBe(403);
        expect(payload.success).toBe(false);
        expect(payload.message).toBe("Solo el personal autorizado puede registrar canjes.");
    });

    it("rejects a user without roles", async () => {
        const { statusCode } = await call(
            createRedemption,
            request({
                params: { comboPurchaseId: voucher.code },
                user: { mongoDbId: new mongoose.Types.ObjectId() }
            })
        );

        expect(statusCode).toBe(403);
    });

    it("lets a seller through the gate and reaches the payload validation", async () => {
        const { statusCode, payload } = await call(
            createRedemption,
            request({
                params: { comboPurchaseId: voucher.code },
                user: { mongoDbId: new mongoose.Types.ObjectId(), role: [2] },
                body: { items: [{ product: String(voucher.balances[0].product), quantity: 1 }] }
            })
        );

        expect(statusCode).toBe(400);
        expect(payload.message).toBe("La clave de idempotencia es obligatoria.");
    });

    it("lets an admin through the gate", async () => {
        const { statusCode, payload } = await call(
            createRedemption,
            request({
                params: { comboPurchaseId: new mongoose.Types.ObjectId().toString() },
                user: { mongoDbId: new mongoose.Types.ObjectId(), role: [0] },
                body: { idempotencyKey: "admin-key", items: [] }
            })
        );

        expect(statusCode).toBe(404);
        expect(payload.message).toBe("Comprobante de combo no encontrado.");
    });
});

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

let voucherSeq = 0;

// Voucher nuevo con un canje ya registrado, para aislar cada caso de anulación.
const seedVoucherWithRedemption = async (daysAgo, quantity = 2) => {
    voucherSeq += 1;
    const code = `AA00${String(voucherSeq).padStart(4, "0")}`;
    const redeemedAt = boliviaDateDaysAgo(daysAgo);

    const seededVoucher = await ComboPurchase.create({
        code,
        comboProduct: comboProductId,
        comboDefinition: comboDefinitionId,
        sale: new mongoose.Types.ObjectId(),
        customerName: "Cliente",
        customerPhone: "12345678",
        purchasedAt: redeemedAt,
        expiresAt: null,
        pricePaid: 20,
        balances: [
            {
                product: waterProductId,
                includedQty: 5,
                usedQty: quantity,
                stockProduct: waterProductId,
                conversionFactor: 1
            }
        ],
        totalUnits: 5,
        usedUnits: quantity,
        status: 0
    });

    const redemption = await ComboRedemption.create({
        comboPurchase: seededVoucher._id,
        items: [{ product: waterProductId, quantity }],
        operator: new mongoose.Types.ObjectId(),
        redeemedAt,
        idempotencyKey: `key-${code}`
    });

    return { voucher: seededVoucher, redemption, code };
};

describe("void redemption window", () => {
    const voidRequest = (code, redemptionId, role) =>
        request({
            params: { comboPurchaseId: code, redemptionId: String(redemptionId) },
            user: { mongoDbId: new mongoose.Types.ObjectId(), role },
            body: { voidReason: "Cliente devolvió el producto" }
        });

    it("lets a seller void a redemption made today and restores the stock", async () => {
        const { redemption, code } = await seedVoucherWithRedemption(0);
        const stockBefore = (await Product.findById(waterProductId)).stock;

        const { statusCode, payload } = await call(
            voidRedemption,
            voidRequest(code, redemption._id, [2])
        );

        expect(statusCode).toBe(200);
        expect(payload.data.comboPurchase.usedUnits).toBe(0);
        expect(payload.data.comboPurchase.balances[0].usedQty).toBe(0);

        const stockAfter = (await Product.findById(waterProductId)).stock;
        expect(stockAfter).toBe(stockBefore + 2);
    });

    it("blocks a seller from voiding yesterday's redemption", async () => {
        const { redemption, code } = await seedVoucherWithRedemption(1);

        const { statusCode, payload } = await call(
            voidRedemption,
            voidRequest(code, redemption._id, [2])
        );

        expect(statusCode).toBe(403);
        expect(payload.message).toBe("Solo se pueden anular canjes realizados el día de hoy.");
        expect((await ComboRedemption.findById(redemption._id)).voidedAt).toBeNull();
    });

    it("lets a supervisor void a redemption from three days ago", async () => {
        const { redemption, code } = await seedVoucherWithRedemption(3);

        const { statusCode } = await call(
            voidRedemption,
            voidRequest(code, redemption._id, [1])
        );

        expect(statusCode).toBe(200);
    });

    it("lets an admin void a redemption from seven days ago", async () => {
        const { redemption, code } = await seedVoucherWithRedemption(7);

        const { statusCode } = await call(
            voidRedemption,
            voidRequest(code, redemption._id, [0])
        );

        expect(statusCode).toBe(200);
    });

    it("blocks an admin from voiding an eight day old redemption", async () => {
        const { redemption, code } = await seedVoucherWithRedemption(8);
        const stockBefore = (await Product.findById(waterProductId)).stock;

        const { statusCode, payload } = await call(
            voidRedemption,
            voidRequest(code, redemption._id, [0])
        );

        expect(statusCode).toBe(403);
        expect(payload.message).toBe("Solo se pueden anular canjes de los últimos 7 días.");
        expect((await ComboRedemption.findById(redemption._id)).voidedAt).toBeNull();
        expect((await Product.findById(waterProductId)).stock).toBe(stockBefore);
    });

    it("rejects a client", async () => {
        const { redemption, code } = await seedVoucherWithRedemption(0);

        const { statusCode, payload } = await call(
            voidRedemption,
            voidRequest(code, redemption._id, [3])
        );

        expect(statusCode).toBe(403);
        expect(payload.message).toBe("Solo el personal autorizado puede anular un canje.");
    });
});
