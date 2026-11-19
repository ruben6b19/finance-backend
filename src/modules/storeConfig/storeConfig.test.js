import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { DB_NAME } from "../../constants.js";
import { StoreConfig, STORE_CONFIG_KEY } from "./storeConfig.model.js";
import { getPublicStoreConfig, getStoreConfig, updateMailConfig } from "./storeConfig.controller.js";
import { getTenantModel, resetTenantConnections } from "../tenants/tenantConnection.js";
import { ROLES } from "../../constants/roles.js";
import { decrypt } from "../../utils/mailCrypto.js";
import esTranslations from "./es.json" with { type: "json" };

const TENANT_DB = "tenant_store_config";

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

// Mirrors the shape verifyFirebaseToken attaches to the request.
const requestFor = (dbName, role, body) => ({
    headers: {},
    ...(role === undefined ? {} : { user: { role: [role] } }),
    ...(body === undefined ? {} : { body }),
    tenant: {
        getModel: (modelName) => getTenantModel(dbName, modelName)
    }
});

const validMailBody = {
    smtpUser: "sender@tenant.test",
    smtpPassword: "s3cret-password",
    adminBccEmail: "admin@tenant.test"
};

describe("storeConfig module", () => {
    let mongoServer;
    const originalMailKey = process.env.MAIL_ENCRYPTION_KEY;

    beforeAll(() => {
        process.env.MAIL_ENCRYPTION_KEY = "test-store-config-mail-key";
    });

    afterAll(() => {
        if (originalMailKey === undefined) {
            delete process.env.MAIL_ENCRYPTION_KEY;
        } else {
            process.env.MAIL_ENCRYPTION_KEY = originalMailKey;
        }
    });

    beforeAll(async () => {
        mongoServer = await MongoMemoryServer.create();
        await mongoose.connect(mongoServer.getUri(), { dbName: DB_NAME });
        await StoreConfig.init();
        await getTenantModel(TENANT_DB, "StoreConfig").init();
    }, 20000);

    afterAll(async () => {
        resetTenantConnections();

        const client = mongoose.connection.getClient();
        await mongoose.connection.dropDatabase();
        await client.db(TENANT_DB).dropDatabase();

        await mongoose.connection.close();
        await mongoServer.stop();
    }, 120000);

    beforeEach(async () => {
        await StoreConfig.deleteMany({});
        await getTenantModel(TENANT_DB, "StoreConfig").deleteMany({});
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

        const { statusCode, payload } = await call(getStoreConfig, requestFor(DB_NAME));

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
        const { statusCode, payload } = await call(getStoreConfig, requestFor(DB_NAME));

        expect(statusCode).toBe(404);
        expect(payload).toEqual({
            success: false,
            statusCode: 404,
            message: esTranslations.error_store_config_not_found
        });
    });

    it("reads the store config of the request tenant, not the central one", async () => {
        await StoreConfig.create({ name: "Tienda Central" });
        await getTenantModel(TENANT_DB, "StoreConfig").create({ name: "Tienda del Tenant" });

        const { statusCode, payload } = await call(getStoreConfig, requestFor(TENANT_DB));

        expect(statusCode).toBe(200);
        expect(payload.data.name).toBe("Tienda del Tenant");

        const central = await StoreConfig.findOne({ key: STORE_CONFIG_KEY }).lean();
        expect(central.name).toBe("Tienda Central");
    });

    it("exposes only the name on the public route", async () => {
        await getTenantModel(TENANT_DB, "StoreConfig").create({
            name: "Pollería Digital Core",
            nit: "123456789",
            phone: "70000000",
            address: "Av. Principal 123"
        });

        const { statusCode, payload } = await call(getPublicStoreConfig, requestFor(TENANT_DB));

        expect(statusCode).toBe(200);
        expect(payload.data).toEqual({ name: "Pollería Digital Core" });
        expect(payload.message).toBe(esTranslations.success_store_name_fetched);
    });

    it("returns 404 on the public route when the store has no config", async () => {
        const { statusCode, payload } = await call(getPublicStoreConfig, requestFor(DB_NAME));

        expect(statusCode).toBe(404);
        expect(payload).toEqual({
            success: false,
            statusCode: 404,
            message: esTranslations.error_store_config_not_found
        });
    });

    it("fails loudly when the request has no tenant context", async () => {
        await expect(call(getStoreConfig, { headers: {} })).rejects.toMatchObject({
            statusCode: 500
        });
    });

    it("lets an ADMIN save mail credentials encrypted without exposing them", async () => {
        const tenantModel = getTenantModel(TENANT_DB, "StoreConfig");
        await tenantModel.create({ name: "Tienda del Tenant" });

        const { statusCode, payload } = await call(
            updateMailConfig,
            requestFor(TENANT_DB, ROLES.ADMIN, {
                smtpUser: "  sender@tenant.test  ",
                smtpPassword: "s3cret-password",
                adminBccEmail: "  admin@tenant.test  "
            })
        );

        expect(statusCode).toBe(200);
        expect(payload.success).toBe(true);
        expect(payload.message).toBe(esTranslations.success_store_mail_config_saved);
        expect(payload.data).toEqual({
            smtpUser: "sender@tenant.test",
            adminBccEmail: "admin@tenant.test"
        });
        expect(JSON.stringify(payload)).not.toContain("smtpPassEncrypted");
        expect(JSON.stringify(payload)).not.toContain("s3cret-password");

        const defaultDoc = await tenantModel.findOne({ key: STORE_CONFIG_KEY }).lean();
        expect(defaultDoc.smtpPassEncrypted).toBeUndefined();

        const stored = await tenantModel
            .findOne({ key: STORE_CONFIG_KEY })
            .select("+smtpPassEncrypted")
            .lean();
        expect(stored.smtpPassEncrypted).toBeTruthy();
        expect(stored.smtpPassEncrypted).not.toBe("s3cret-password");
        expect(decrypt(stored.smtpPassEncrypted)).toBe("s3cret-password");
    });

    it.each([
        ["CLIENT", ROLES.CLIENT],
        ["SELLER", ROLES.SELLER]
    ])("returns 403 when a %s tries to save mail credentials", async (_, role) => {
        const tenantModel = getTenantModel(TENANT_DB, "StoreConfig");
        await tenantModel.create({ name: "Tienda del Tenant" });

        const { statusCode, payload } = await call(
            updateMailConfig,
            requestFor(TENANT_DB, role, validMailBody)
        );

        expect(statusCode).toBe(403);
        expect(payload.message).toBe(esTranslations.error_store_config_admin_only);
        const stored = await tenantModel
            .findOne({ key: STORE_CONFIG_KEY })
            .select("+smtpPassEncrypted")
            .lean();
        expect(stored.smtpPassEncrypted).toBe("");
    });

    it.each([
        [
            "smtpUser is empty",
            { ...validMailBody, smtpUser: "" }
        ],
        [
            "smtpPassword is empty",
            { ...validMailBody, smtpPassword: "" }
        ],
        [
            "adminBccEmail is not an email",
            { ...validMailBody, adminBccEmail: "not-an-email" }
        ]
    ])("returns 400 when %s", async (_, body) => {
        await getTenantModel(TENANT_DB, "StoreConfig").create({ name: "Tienda del Tenant" });

        const { statusCode, payload } = await call(
            updateMailConfig,
            requestFor(TENANT_DB, ROLES.ADMIN, body)
        );

        expect(statusCode).toBe(400);
        expect(payload.message).toBe(esTranslations.error_store_config_invalid_mail);
    });

    it("returns 404 when the tenant has no store config", async () => {
        const { statusCode, payload } = await call(
            updateMailConfig,
            requestFor(TENANT_DB, ROLES.ADMIN, validMailBody)
        );

        expect(statusCode).toBe(404);
        expect(payload.message).toBe(esTranslations.error_store_config_not_found);
    });
});
