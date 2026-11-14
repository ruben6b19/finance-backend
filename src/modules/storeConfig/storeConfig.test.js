import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { StoreConfig, STORE_CONFIG_KEY } from "./storeConfig.model.js";
import { getStoreConfig } from "./storeConfig.controller.js";
import esTranslations from "./es.json" with { type: "json" };

// asyncHandler does not return the handler promise, so tests must wait for the
// response (or reject) signal instead of awaiting the controller call itself.
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

describe("storeConfig module", () => {
    let mongoServer;

    beforeAll(async () => {
        mongoServer = await MongoMemoryServer.create();
        await mongoose.connect(mongoServer.getUri());
        await StoreConfig.init();
    }, 20000);

    afterAll(async () => {
        await mongoose.connection.dropDatabase();
        await mongoose.connection.close();
        await mongoServer.stop();
    }, 120000);

    beforeEach(async () => {
        await StoreConfig.deleteMany({});
    });

    it("applies the default currency and ticket footer", async () => {
        const config = await StoreConfig.create({ name: "Mi Tienda" });

        expect(config.currency).toBe("Bs.");
        expect(config.ticketFooter).toBe("¡Gracias por su preferencia!");
        expect(config.key).toBe(STORE_CONFIG_KEY);
    });

    it("returns the single row and rejects a second document with a duplicate key", async () => {
        await StoreConfig.create({ name: "Mi Tienda" });

        const singleton = await StoreConfig.getSingleton();
        expect(singleton).not.toBeNull();
        expect(singleton.name).toBe("Mi Tienda");

        let duplicateError;
        try {
            await StoreConfig.create({ name: "Otra Tienda" });
        } catch (error) {
            duplicateError = error;
        }

        expect(duplicateError).toBeDefined();
        expect(duplicateError.code).toBe(11000);
        expect(await StoreConfig.countDocuments({})).toBe(1);
    });

    it("returns 200 with the projected fields and without internal fields", async () => {
        await StoreConfig.create({
            name: "Mi Tienda",
            razonSocial: "Mi Tienda S.R.L.",
            nit: "123456789",
            phone: "70000000",
            whatsapp: "70000001",
            address: "Av. Principal 123",
            logoUrl: "https://example.com/logo.png"
        });

        const { statusCode, payload } = await call(getStoreConfig, { headers: {} });

        expect(statusCode).toBe(200);
        expect(payload.success).toBe(true);
        expect(payload.message).toBe(esTranslations.success_store_config_fetched);
        expect(payload.data.name).toBe("Mi Tienda");
        expect(payload.data.razonSocial).toBe("Mi Tienda S.R.L.");
        expect(payload.data.nit).toBe("123456789");
        expect(payload.data.phone).toBe("70000000");
        expect(payload.data.whatsapp).toBe("70000001");
        expect(payload.data.address).toBe("Av. Principal 123");
        expect(payload.data.currency).toBe("Bs.");
        expect(payload.data.ticketFooter).toBe("¡Gracias por su preferencia!");
        expect(payload.data.logoUrl).toBe("https://example.com/logo.png");
        expect(payload.data._id).toBeUndefined();
        expect(payload.data.key).toBeUndefined();
        expect(payload.data.createdAt).toBeUndefined();
        expect(payload.data.updatedAt).toBeUndefined();
        expect(Object.keys(payload.data).sort()).toEqual([
            "address",
            "currency",
            "logoUrl",
            "name",
            "nit",
            "phone",
            "razonSocial",
            "ticketFooter",
            "whatsapp"
        ]);
    });

    it("returns 404 with a translated error when the collection is empty", async () => {
        const { statusCode, payload } = await call(getStoreConfig, { headers: {} });

        expect(statusCode).toBe(404);
        expect(payload).toEqual({
            success: false,
            statusCode: 404,
            message: esTranslations.error_store_config_not_found
        });
    });
});
