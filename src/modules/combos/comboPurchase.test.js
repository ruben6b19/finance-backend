import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import nodemailer from "nodemailer";

import { encrypt } from "../../utils/mailCrypto.js";
import { StoreConfig, STORE_CONFIG_KEY } from "../storeConfig/storeConfig.model.js";
import { Product } from "../products/product.model.js";
import { User } from "../users/user.model.js";
import { ComboDefinition } from "./comboDefinition.model.js";
import { ComboComponent } from "./comboComponent.model.js";
import { ComboPurchase } from "./comboPurchase.model.js";
import { ComboRedemption } from "./comboRedemption.model.js";
import { getTenantModel, resetTenantConnections } from "../tenants/tenantConnection.js";
import { DB_NAME } from "../../constants.js";
import {
    getComboPurchases,
    getComboPurchaseById,
    getComboPurchaseRedemptions,
    createRedemption,
    voidRedemption,
    getVoucherReconciliation
} from "./comboPurchase.controller.js";
import { checkRedemptionVoidWindow } from "./redemption.policy.js";

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
    user: { mongoDbId: new mongoose.Types.ObjectId(), role: [0] },
    tenant: buildTenant(),
    ...overrides
});

beforeAll(async () => {
    // Anular un canje abre una transacción de Mongo: hace falta un replica set.
    // El nodo único pierde el lock a los 5 ms por defecto bajo carga
    // secuencial; es una limitación del harness, no del código.
    server = await MongoMemoryReplSet.create({
        replSet: {
            count: 1,
            args: ["--setParameter", "maxTransactionLockRequestTimeoutMillis=10000"]
        }
    });
    await mongoose.connect(server.getUri());

    // Construir todos los índices antes de la primera transacción: un build en
    // background cambia el catálogo y hace fallar la transacción en vuelo.
    await Promise.all(
        mongoose.modelNames().map((name) => mongoose.model(name).init())
    );

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
    const client = mongoose.connection.getClient();
    resetTenantConnections();

    await mongoose.connection.dropDatabase();
    await client.db("tenant_combos").dropDatabase();

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

describe("combo purchase read ownership", () => {
    const CLIENT_UID = "uid-combos-client";
    const OTHER_UID = "uid-combos-other";
    const MONGO_STAFF_UID = "uid-combos-mongo-staff";
    const CLIENT_PHONE = "44440001";
    const OTHER_PHONE = "44440002";
    const OWNED_CODE = "CC000001";
    const OTHER_CODE = "DD000002";
    const LEGACY_CODE = "EE000003";

    let clientUser;
    let otherUser;
    let ownedVoucher;
    let otherVoucher;
    let ownedRedemption;

    const clientRequest = (overrides = {}) => request({
        ...overrides,
        user: { firebaseUid: CLIENT_UID, email: "combos-client@example.com", role: [3] }
    });

    const mongoStaffRequest = (overrides = {}) => request({
        ...overrides,
        user: { firebaseUid: MONGO_STAFF_UID, email: "combos-staff@example.com" }
    });

    const claimStaffRequest = (overrides = {}) => request({
        ...overrides,
        user: { mongoDbId: new mongoose.Types.ObjectId(), role: [2] }
    });

    const seedVoucher = (code, customerPhone, customerId) => ComboPurchase.create({
        code,
        comboProduct: comboProductId,
        comboDefinition: comboDefinitionId,
        sale: new mongoose.Types.ObjectId(),
        customerName: "Read Owner",
        customerPhone,
        customerId,
        purchasedAt: new Date("2026-11-15T10:00:00.000Z"),
        expiresAt: null,
        pricePaid: 20,
        balances: [
            {
                product: waterProductId,
                includedQty: 5,
                usedQty: 0,
                stockProduct: waterProductId,
                conversionFactor: 1
            }
        ],
        totalUnits: 5,
        usedUnits: 0,
        status: 0
    });

    beforeAll(async () => {
        clientUser = await User.create({
            email: "combos-client@example.com",
            fullName: "Combo Client",
            firebaseUid: CLIENT_UID,
            role: [3],
            status: 1
        });
        otherUser = await User.create({
            email: "combos-other@example.com",
            fullName: "Other Client",
            firebaseUid: OTHER_UID,
            role: [3],
            status: 1
        });
        await User.create({
            email: "combos-staff@example.com",
            fullName: "Mongo Staff",
            firebaseUid: MONGO_STAFF_UID,
            role: [2],
            status: 1
        });

        ownedVoucher = await seedVoucher(OWNED_CODE, CLIENT_PHONE, clientUser._id);
        otherVoucher = await seedVoucher(OTHER_CODE, OTHER_PHONE, otherUser._id);
        await seedVoucher(LEGACY_CODE, "44440003", null);

        ownedRedemption = await ComboRedemption.create({
            comboPurchase: ownedVoucher._id,
            items: [{ product: waterProductId, quantity: 1 }],
            operator: new mongoose.Types.ObjectId(),
            redeemedAt: new Date("2026-11-15T11:00:00.000Z"),
            idempotencyKey: "client-owner-read-key"
        });
    }, 60000);

    it("limits a client list to their own vouchers", async () => {
        const { statusCode, payload } = await call(
            getComboPurchases,
            clientRequest({ query: { page: "1", limit: "50" } })
        );

        expect(statusCode).toBe(200);
        const codes = payload.data.docs.map((doc) => doc.code);
        expect(codes).toContain(OWNED_CODE);
        expect(codes).not.toContain(OTHER_CODE);
        expect(codes).not.toContain(LEGACY_CODE);
        expect(payload.data.docs.every(
            (doc) => String(doc.customerId) === String(clientUser._id)
        )).toBe(true);
    });

    it("does not let a client widen the list with another customer's phone or code", async () => {
        const byPhone = await call(
            getComboPurchases,
            clientRequest({ query: { customerPhone: OTHER_PHONE } })
        );
        expect(byPhone.statusCode).toBe(200);
        expect(byPhone.payload.data.docs).toHaveLength(0);

        const byCode = await call(
            getComboPurchases,
            clientRequest({ query: { code: OTHER_CODE } })
        );
        expect(byCode.statusCode).toBe(200);
        expect(byCode.payload.data.docs).toHaveLength(0);
    });

    it("still lets a client narrow the list by their own phone", async () => {
        const { statusCode, payload } = await call(
            getComboPurchases,
            clientRequest({ query: { customerPhone: CLIENT_PHONE } })
        );

        expect(statusCode).toBe(200);
        expect(payload.data.docs.map((doc) => doc.code)).toEqual([OWNED_CODE]);
    });

    it("returns the same 404 for another customer's voucher by id and by code", async () => {
        for (const comboPurchaseId of [String(otherVoucher._id), OTHER_CODE]) {
            const { statusCode, payload } = await call(
                getComboPurchaseById,
                clientRequest({ params: { comboPurchaseId } })
            );

            expect(statusCode).toBe(404);
            expect(payload.message).toBe("Comprobante de combo no encontrado.");
        }
    });

    it("hides a legacy voucher without an owner from clients", async () => {
        const { statusCode, payload } = await call(
            getComboPurchaseById,
            clientRequest({ params: { comboPurchaseId: LEGACY_CODE } })
        );

        expect(statusCode).toBe(404);
        expect(payload.message).toBe("Comprobante de combo no encontrado.");
    });

    it("lets a client read their own voucher by id and by code", async () => {
        for (const comboPurchaseId of [String(ownedVoucher._id), OWNED_CODE]) {
            const { statusCode, payload } = await call(
                getComboPurchaseById,
                clientRequest({ params: { comboPurchaseId } })
            );

            expect(statusCode).toBe(200);
            expect(payload.data.code).toBe(OWNED_CODE);
        }
    });

    it("hides another customer's redemptions by id and by code", async () => {
        for (const comboPurchaseId of [String(otherVoucher._id), OTHER_CODE]) {
            const { statusCode, payload } = await call(
                getComboPurchaseRedemptions,
                clientRequest({ params: { comboPurchaseId } })
            );

            expect(statusCode).toBe(404);
            expect(payload.message).toBe("Comprobante de combo no encontrado.");
        }
    });

    it("lets a client read their own redemptions", async () => {
        const { statusCode, payload } = await call(
            getComboPurchaseRedemptions,
            clientRequest({ params: { comboPurchaseId: OWNED_CODE } })
        );

        expect(statusCode).toBe(200);
        expect(payload.data).toHaveLength(1);
        expect(String(payload.data[0]._id)).toBe(String(ownedRedemption._id));
    });

    it("rejects a client without Firebase identity instead of granting staff access", async () => {
        const { statusCode } = await call(
            getComboPurchases,
            request({ user: { mongoDbId: new mongoose.Types.ObjectId(), role: [3] } })
        );

        expect(statusCode).toBe(401);
    });

    it("refuses the reconciliation report for a client", async () => {
        const { statusCode, payload } = await call(getVoucherReconciliation, clientRequest());

        expect(statusCode).toBe(403);
        expect(payload.success).toBe(false);
    });

    it("uses the Mongo role for a seller without staff claims", async () => {
        const list = await call(
            getComboPurchases,
            mongoStaffRequest({ query: { customerPhone: OTHER_PHONE } })
        );
        expect(list.statusCode).toBe(200);
        expect(list.payload.data.docs.map((doc) => doc.code)).toContain(OTHER_CODE);

        const report = await call(getVoucherReconciliation, mongoStaffRequest());
        expect(report.statusCode).toBe(200);
    });

    it("lets claim-based staff read any voucher and the reconciliation report", async () => {
        const detail = await call(
            getComboPurchaseById,
            claimStaffRequest({ params: { comboPurchaseId: OTHER_CODE } })
        );
        expect(detail.statusCode).toBe(200);
        expect(detail.payload.data.code).toBe(OTHER_CODE);

        const report = await call(getVoucherReconciliation, claimStaffRequest());
        expect(report.statusCode).toBe(200);
        expect(report.payload.data.checked).toBeGreaterThan(0);
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

    it("lets a superadmin through the gate", async () => {
        const { statusCode, payload } = await call(
            createRedemption,
            request({
                params: { comboPurchaseId: new mongoose.Types.ObjectId().toString() },
                user: { mongoDbId: new mongoose.Types.ObjectId(), role: [-1] },
                body: { idempotencyKey: "superadmin-key", items: [] }
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

let plainVoucherSeq = 0;

// Seeds a voucher whose balance has no derived stockProduct, so the component
// product's own type decides whether redemption moves inventory.
const seedVoucherWithPlainComponent = async ({
    product,
    conversionFactor = 1,
    quantity = 2,
    withRedemption = false
}) => {
    plainVoucherSeq += 1;
    const code = `BB00${String(plainVoucherSeq).padStart(4, "0")}`;
    const redeemedAt = boliviaDateDaysAgo(0);

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
                product: product._id,
                includedQty: 5,
                usedQty: withRedemption ? quantity : 0,
                stockProduct: null,
                conversionFactor
            }
        ],
        totalUnits: 5,
        usedUnits: withRedemption ? quantity : 0,
        status: 0
    });

    let redemption = null;
    if (withRedemption) {
        redemption = await ComboRedemption.create({
            comboPurchase: seededVoucher._id,
            items: [{ product: product._id, quantity }],
            operator: new mongoose.Types.ObjectId(),
            redeemedAt,
            idempotencyKey: `plain-key-${code}`
        });
    }

    return { voucher: seededVoucher, redemption, code };
};

describe("void redemption window", () => {
    it("shifts the void window when the store uses a non-default time zone", () => {
        const now = new Date("2026-11-15T05:30:00.000Z");
        const redeemedAt = "2026-11-14T06:00:00.000Z";

        expect(checkRedemptionVoidWindow({ redeemedAt, roles: [2], now })).toMatchObject({
            allowed: false,
            daysElapsed: 1
        });
        expect(checkRedemptionVoidWindow({
            redeemedAt,
            roles: [2],
            now,
            timeZone: "America/Mexico_City"
        })).toMatchObject({ allowed: true, daysElapsed: 0 });
    });

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

    it("lets a superadmin void a redemption from seven days ago", async () => {
        const { redemption, code } = await seedVoucherWithRedemption(7);

        const { statusCode } = await call(
            voidRedemption,
            voidRequest(code, redemption._id, [-1])
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

describe("redemption stock for plain components", () => {
    const plainProduct = (name, productType, stock) => Product.create({
        name,
        price: 8,
        unit: new mongoose.Types.ObjectId(),
        productType,
        isSellable: true,
        stock
    });

    it("decrements a tracked plain product's stock by quantity times conversionFactor", async () => {
        const soda = await plainProduct("Plain Soda", 2, 40);
        const { code } = await seedVoucherWithPlainComponent({
            product: soda,
            conversionFactor: 3,
            quantity: 2
        });

        const { statusCode, payload } = await call(
            createRedemption,
            request({
                params: { comboPurchaseId: code },
                body: {
                    idempotencyKey: `plain-create-${code}`,
                    items: [{ product: String(soda._id), quantity: 2 }]
                }
            })
        );

        expect(statusCode).toBe(201);
        expect((await Product.findById(soda._id)).stock).toBe(34);
        expect(payload.data.comboPurchase.balances[0].usedQty).toBe(2);
        expect(payload.data.comboPurchase.usedUnits).toBe(2);
    });

    it("restores a tracked plain product's stock when the redemption is voided", async () => {
        const soda = await plainProduct("Plain Soda To Restore", 2, 34);
        const { redemption, code } = await seedVoucherWithPlainComponent({
            product: soda,
            conversionFactor: 3,
            quantity: 2,
            withRedemption: true
        });

        const { statusCode, payload } = await call(
            voidRedemption,
            request({
                params: { comboPurchaseId: code, redemptionId: String(redemption._id) },
                user: { mongoDbId: new mongoose.Types.ObjectId(), role: [2] },
                body: { voidReason: "Customer returned the product" }
            })
        );

        expect(statusCode).toBe(200);
        expect((await Product.findById(soda._id)).stock).toBe(40);
        expect(payload.data.comboPurchase.balances[0].usedQty).toBe(0);
        expect(payload.data.comboPurchase.usedUnits).toBe(0);
    });

    it.each([
        [1, "menu"],
        [3, "combo"]
    ])("does not move stock for a type-%i %s component without stockProduct", async (productType, label) => {
        const product = await plainProduct(`Non tracked ${label}`, productType, 10);
        const { code } = await seedVoucherWithPlainComponent({ product, quantity: 2 });

        const { statusCode } = await call(
            createRedemption,
            request({
                params: { comboPurchaseId: code },
                body: {
                    idempotencyKey: `skip-create-${code}`,
                    items: [{ product: String(product._id), quantity: 2 }]
                }
            })
        );

        expect(statusCode).toBe(201);
        expect((await Product.findById(product._id)).stock).toBe(10);
    });
});

describe("combo redemption mail", () => {
    const TEST_KEY = "test-mail-encryption-passphrase";
    const ORIGINAL_KEY = process.env.MAIL_ENCRYPTION_KEY;

    beforeAll(() => {
        process.env.MAIL_ENCRYPTION_KEY = TEST_KEY;
    });

    afterAll(() => {
        if (ORIGINAL_KEY === undefined) {
            delete process.env.MAIL_ENCRYPTION_KEY;
        } else {
            process.env.MAIL_ENCRYPTION_KEY = ORIGINAL_KEY;
        }
    });

    it("sends a redemption receipt to the voucher owner after a successful redemption", async () => {
        const customer = await User.create({
            email: "redemption-owner@example.com",
            fullName: "Redemption Owner",
            firebaseUid: "uid-redemption-owner",
            role: [3],
            status: 1
        });
        const product = await Product.create({
            name: "Mail Redemption Water",
            price: 5,
            unit: new mongoose.Types.ObjectId(),
            productType: 2,
            isSellable: true,
            stock: 20
        });
        const code = "FA000001";
        const ownerVoucher = await ComboPurchase.create({
            code,
            comboProduct: comboProductId,
            comboDefinition: comboDefinitionId,
            sale: new mongoose.Types.ObjectId(),
            customerName: "Redemption Owner",
            customerPhone: "12345678",
            customerId: customer._id,
            purchasedAt: new Date("2026-11-19T10:00:00.000Z"),
            expiresAt: null,
            pricePaid: 20,
            balances: [
                {
                    product: product._id,
                    includedQty: 5,
                    usedQty: 0,
                    stockProduct: product._id,
                    conversionFactor: 1
                }
            ],
            totalUnits: 5,
            usedUnits: 0,
            status: 0
        });
        await StoreConfig.create({
            key: STORE_CONFIG_KEY,
            name: "Mi Tienda",
            smtpUser: "store@example.com",
            smtpPassEncrypted: encrypt("smtp-password"),
            adminBccEmail: "admin@example.com"
        });

        const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
        const transportSpy = jest.spyOn(nodemailer, "createTransport").mockReturnValue({
            sendMail: jest.fn().mockResolvedValue({})
        });

        try {
            const { statusCode, payload } = await call(createRedemption, request({
                params: { comboPurchaseId: code },
                user: { mongoDbId: new mongoose.Types.ObjectId(), role: [2] },
                body: {
                    idempotencyKey: `mail-redemption-${code}`,
                    items: [{ product: String(product._id), quantity: 2 }]
                }
            }));

            expect(statusCode).toBe(201);
            expect(payload.data.comboPurchase.code).toBe(code);
            expect(String(payload.data.comboPurchase._id)).toBe(String(ownerVoucher._id));

            const mailLogs = infoSpy.mock.calls.filter(
                ([message]) => message === "[mail] redemption send result"
            );
            expect(mailLogs).toHaveLength(1);
            expect(mailLogs[0][1]).toMatchObject({ voucherCode: code, sent: true });
        } finally {
            infoSpy.mockRestore();
            transportSpy.mockRestore();
        }
    });
});

describe("redemption stock for derived components", () => {
    const trackedProduct = (name, stock) => Product.create({
        name,
        price: 5,
        unit: new mongoose.Types.ObjectId(),
        productType: 2,
        isSellable: true,
        stock
    });

    // A presentation product does not hold stock itself: it declares the
    // accumulator (stockProduct) and the units consumed per sold unit.
    const derivedPresentation = (name, presas) => Product.create({
        name,
        price: 12,
        unit: presas.unit,
        productType: 1,
        isSellable: true,
        stock: 0,
        stockProduct: presas._id,
        stockConversionFactor: 8
    });

    it("decrements the derived stock product by quantity times the product factor", async () => {
        const presas = await trackedProduct("Pollo (presa)", 40);
        const presentation = await derivedPresentation("Pollo Entero", presas);
        const { code } = await seedVoucherWithPlainComponent({
            product: presentation,
            quantity: 1
        });

        const { statusCode, payload } = await call(
            createRedemption,
            request({
                params: { comboPurchaseId: code },
                body: {
                    idempotencyKey: `derived-create-${code}`,
                    items: [{ product: String(presentation._id), quantity: 1 }]
                }
            })
        );

        expect(statusCode).toBe(201);
        expect((await Product.findById(presas._id)).stock).toBe(32);
        expect(payload.data.comboPurchase.balances[0].usedQty).toBe(1);
        expect(payload.data.comboPurchase.usedUnits).toBe(1);
    });

    it("restores the derived stock product when the redemption is voided", async () => {
        const presas = await trackedProduct("Pollo (presa) to restore", 40);
        const presentation = await derivedPresentation("Pollo Entero to restore", presas);
        const { redemption, code } = await seedVoucherWithPlainComponent({
            product: presentation,
            quantity: 1,
            withRedemption: true
        });

        const { statusCode, payload } = await call(
            voidRedemption,
            request({
                params: { comboPurchaseId: code, redemptionId: String(redemption._id) },
                user: { mongoDbId: new mongoose.Types.ObjectId(), role: [2] },
                body: { voidReason: "Customer returned the product" }
            })
        );

        expect(statusCode).toBe(200);
        expect((await Product.findById(presas._id)).stock).toBe(48);
        expect(payload.data.comboPurchase.balances[0].usedQty).toBe(0);
        expect(payload.data.comboPurchase.usedUnits).toBe(0);
    });
});

describe("combo tenant routing", () => {
    const TENANT_DB = "tenant_combos";
    const tenantModel = (name) => getTenantModel(TENANT_DB, name);

    const tenantRequest = (overrides = {}) => request({
        ...overrides,
        tenant: buildTenant(TENANT_DB)
    });

    let tenantWaterId;

    beforeAll(async () => {
        // Crear las colecciones fuera de la transacción evita la carrera por el
        // lock del catálogo en un replica set de un solo nodo.
        await Promise.all([
            tenantModel("Product").init(),
            tenantModel("ComboDefinition").init(),
            tenantModel("ComboComponent").init(),
            tenantModel("ComboPurchase").init(),
            tenantModel("ComboRedemption").init()
        ]);
    }, 60000);

    beforeEach(async () => {
        await tenantModel("ComboPurchase").deleteMany({});
        await tenantModel("ComboRedemption").deleteMany({});
        await tenantModel("Product").deleteMany({});
        await tenantModel("ComboDefinition").deleteMany({});
        await tenantModel("ComboComponent").deleteMany({});

        const water = await tenantModel("Product").create({
            name: "Tenant Water",
            price: 5,
            unit: new mongoose.Types.ObjectId(),
            productType: 2,
            isSellable: true,
            stock: 25
        });
        tenantWaterId = water._id;
    });

    const seedTenantVoucher = async () => {
        const combo = await tenantModel("Product").create({
            name: "Tenant Combo",
            price: 20,
            unit: new mongoose.Types.ObjectId(),
            productType: 3,
            isSellable: true,
            stock: 0
        });

        const definition = await tenantModel("ComboDefinition").create({
            product: combo._id,
            referencePrice: 25,
            validityDays: 0,
            status: 1
        });

        await tenantModel("ComboComponent").create({
            combo: definition._id,
            product: tenantWaterId,
            quantity: 5,
            label: "Tenant Water",
            stockProduct: tenantWaterId,
            conversionFactor: 1
        });

        return tenantModel("ComboPurchase").create({
            code: "AB12CD34",
            comboProduct: combo._id,
            comboDefinition: definition._id,
            sale: new mongoose.Types.ObjectId(),
            customerName: "Cliente",
            customerPhone: "12345678",
            purchasedAt: new Date(),
            expiresAt: null,
            pricePaid: 20,
            balances: [
                {
                    product: tenantWaterId,
                    includedQty: 5,
                    usedQty: 0,
                    stockProduct: tenantWaterId,
                    conversionFactor: 1
                }
            ],
            totalUnits: 5,
            usedUnits: 0,
            status: 0
        });
    };

    it("redeems a tenant voucher against the tenant stock", async () => {
        const voucher = await seedTenantVoucher();

        const centralRedemptionsBefore = await ComboRedemption.countDocuments();
        const centralStockBefore = (await Product.findById(waterProductId)).stock;

        const { statusCode } = await call(
            createRedemption,
            tenantRequest({
                params: { comboPurchaseId: String(voucher._id) },
                body: {
                    idempotencyKey: "tenant-key",
                    items: [{ product: String(tenantWaterId), quantity: 2 }]
                }
            })
        );

        expect(statusCode).toBe(201);
        expect((await tenantModel("Product").findById(tenantWaterId)).stock).toBe(23);
        expect(await tenantModel("ComboRedemption").countDocuments()).toBe(1);

        // The whole flow stays in one database: nothing may leak here.
        expect(await ComboRedemption.countDocuments()).toBe(centralRedemptionsBefore);
        expect((await Product.findById(waterProductId)).stock).toBe(centralStockBefore);
    });

    it("does not expose a tenant voucher to another database", async () => {
        const voucher = await seedTenantVoucher();

        const tenantRead = await call(
            getComboPurchaseById,
            tenantRequest({ params: { comboPurchaseId: String(voucher._id) } })
        );
        expect(tenantRead.statusCode).toBe(200);

        const centralRead = await call(
            getComboPurchaseById,
            request({ params: { comboPurchaseId: String(voucher._id) } })
        );
        expect(centralRead.statusCode).toBe(404);
    });
});
