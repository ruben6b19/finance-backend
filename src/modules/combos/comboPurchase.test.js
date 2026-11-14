import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

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
    createRedemption
} from "./comboPurchase.controller.js";

let server;
let voucher;

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
    server = await MongoMemoryServer.create();
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
});

afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
    await server.stop();
});

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
