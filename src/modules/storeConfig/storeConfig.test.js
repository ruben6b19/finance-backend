import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { DB_NAME } from "../../constants.js";
import { StoreConfig, STORE_CONFIG_KEY } from "./storeConfig.model.js";
import { getPublicStoreConfig, getStoreConfig, updateDeliveryOptions, updateCoordinates, updateTimezone, updateMailConfig } from "./storeConfig.controller.js";
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
        expect(config.timezone).toBe("America/La_Paz");
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
            logoUrl: "https://example.com/logo.png",
            dineInEnabled: true,
            pickupEnabled: false,
            deliveryEnabled: true
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
        expect(payload.data.dineInEnabled).toBe(true);
        expect(payload.data.pickupEnabled).toBe(false);
        expect(payload.data.deliveryEnabled).toBe(true);
        expect(payload.data.timezone).toBe("America/La_Paz");
        expect(payload.data._id).toBeUndefined();
        expect(payload.data.key).toBeUndefined();
        expect(payload.data.createdAt).toBeUndefined();
        expect(payload.data.updatedAt).toBeUndefined();
        expect(Object.keys(payload.data).sort()).toEqual([
            "address",
            "currency",
            "deliveryEnabled",
            "dineInEnabled",
            "latitude",
            "logoUrl",
            "longitude",
            "name",
            "nit",
            "phone",
            "pickupEnabled",
            "razonSocial",
            "ticketFooter",
            "timezone",
            "whatsapp"
        ]);
    });

    it("includes the store coordinates on the authenticated route", async () => {
        await StoreConfig.create({
            name: "Mi Tienda",
            latitude: -17.7833,
            longitude: -63.1821
        });

        const { statusCode, payload } = await call(getStoreConfig, requestFor(DB_NAME));

        expect(statusCode).toBe(200);
        expect(payload.data.latitude).toBe(-17.7833);
        expect(payload.data.longitude).toBe(-63.1821);
    });

    it("includes the configured timezone on the authenticated route", async () => {
        await StoreConfig.create({
            name: "Mi Tienda",
            timezone: "America/Mexico_City"
        });

        const { statusCode, payload } = await call(getStoreConfig, requestFor(DB_NAME));

        expect(statusCode).toBe(200);
        expect(payload.data.timezone).toBe("America/Mexico_City");
    });

    it("returns the default timezone for legacy authenticated configs", async () => {
        await StoreConfig.collection.insertOne({ key: STORE_CONFIG_KEY, name: "Legacy Store" });

        const { statusCode, payload } = await call(getStoreConfig, requestFor(DB_NAME));

        expect(statusCode).toBe(200);
        expect(payload.data.timezone).toBe("America/La_Paz");
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

    it("exposes the name and delivery option flags on the public route", async () => {
        await getTenantModel(TENANT_DB, "StoreConfig").create({
            name: "Pollería Digital Core",
            nit: "123456789",
            phone: "70000000",
            address: "Av. Principal 123",
            dineInEnabled: true,
            pickupEnabled: false,
            deliveryEnabled: true
        });

        const { statusCode, payload } = await call(getPublicStoreConfig, requestFor(TENANT_DB));

        expect(statusCode).toBe(200);
        expect(payload.data).toEqual({
            name: "Pollería Digital Core",
            latitude: null,
            longitude: null,
            timezone: "America/La_Paz",
            dineInEnabled: true,
            pickupEnabled: false,
            deliveryEnabled: true
        });
        expect(payload.message).toBe(esTranslations.success_store_name_fetched);
    });

    it("exposes configured store coordinates on the public route", async () => {
        await getTenantModel(TENANT_DB, "StoreConfig").create({
            name: "Pollería Digital Core",
            latitude: -17.7833,
            longitude: -63.1821,
            timezone: "America/Mexico_City",
            dineInEnabled: true,
            pickupEnabled: false,
            deliveryEnabled: true
        });

        const { statusCode, payload } = await call(getPublicStoreConfig, requestFor(TENANT_DB));

        expect(statusCode).toBe(200);
        expect(payload.data).toEqual({
            name: "Pollería Digital Core",
            latitude: -17.7833,
            longitude: -63.1821,
            timezone: "America/Mexico_City",
            dineInEnabled: true,
            pickupEnabled: false,
            deliveryEnabled: true
        });
    });

    it("defaults every delivery option flag to true for legacy public configs", async () => {
        const tenantModel = getTenantModel(TENANT_DB, "StoreConfig");
        // Raw insert bypasses schema defaults, like a document created before
        // the delivery-option fields existed.
        await tenantModel.collection.insertOne({ key: STORE_CONFIG_KEY, name: "Legacy Store" });

        const { statusCode, payload } = await call(getPublicStoreConfig, requestFor(TENANT_DB));

        expect(statusCode).toBe(200);
        expect(payload.data).toEqual({
            name: "Legacy Store",
            latitude: null,
            longitude: null,
            timezone: "America/La_Paz",
            dineInEnabled: true,
            pickupEnabled: true,
            deliveryEnabled: true
        });
    });

    it("returns null coordinates for legacy public configs", async () => {
        const tenantModel = getTenantModel(TENANT_DB, "StoreConfig");
        // Raw insert bypasses schema defaults, like a document created before
        // the coordinate fields existed.
        await tenantModel.collection.insertOne({ key: STORE_CONFIG_KEY, name: "Legacy Store" });

        const { statusCode, payload } = await call(getPublicStoreConfig, requestFor(TENANT_DB));

        expect(statusCode).toBe(200);
        expect(payload.data.latitude).toBe(null);
        expect(payload.data.longitude).toBe(null);
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

    it("lets an ADMIN save all three delivery options", async () => {
        const tenantModel = getTenantModel(TENANT_DB, "StoreConfig");
        await tenantModel.create({
            name: "Tienda del Tenant",
            dineInEnabled: false,
            pickupEnabled: true,
            deliveryEnabled: false
        });

        const { statusCode, payload } = await call(
            updateDeliveryOptions,
            requestFor(TENANT_DB, ROLES.ADMIN, {
                dineInEnabled: true,
                pickupEnabled: false,
                deliveryEnabled: true
            })
        );

        expect(statusCode).toBe(200);
        expect(payload.success).toBe(true);
        expect(payload.message).toBe(esTranslations.success_store_delivery_options_saved);
        expect(payload.data).toEqual({
            dineInEnabled: true,
            pickupEnabled: false,
            deliveryEnabled: true
        });

        const stored = await tenantModel.findOne({ key: STORE_CONFIG_KEY }).lean();
        expect(stored.dineInEnabled).toBe(true);
        expect(stored.pickupEnabled).toBe(false);
        expect(stored.deliveryEnabled).toBe(true);
    });

    it.each([
        ["CLIENT", ROLES.CLIENT],
        ["SELLER", ROLES.SELLER]
    ])("returns 403 when a %s tries to save delivery options", async (_, role) => {
        const tenantModel = getTenantModel(TENANT_DB, "StoreConfig");
        await tenantModel.create({
            name: "Tienda del Tenant",
            dineInEnabled: false,
            pickupEnabled: true,
            deliveryEnabled: false
        });

        const { statusCode, payload } = await call(
            updateDeliveryOptions,
            requestFor(TENANT_DB, role, {
                dineInEnabled: true,
                pickupEnabled: false,
                deliveryEnabled: true
            })
        );

        expect(statusCode).toBe(403);
        expect(payload.message).toBe(esTranslations.error_store_config_admin_only);

        const stored = await tenantModel.findOne({ key: STORE_CONFIG_KEY }).lean();
        expect(stored.dineInEnabled).toBe(false);
        expect(stored.pickupEnabled).toBe(true);
        expect(stored.deliveryEnabled).toBe(false);
    });

    it.each([
        [
            "a flag is missing",
            { dineInEnabled: true, deliveryEnabled: true }
        ],
        [
            "a flag is not a boolean",
            { dineInEnabled: "true", pickupEnabled: false, deliveryEnabled: true }
        ]
    ])("returns 400 when %s", async (_, body) => {
        const tenantModel = getTenantModel(TENANT_DB, "StoreConfig");
        await tenantModel.create({
            name: "Tienda del Tenant",
            dineInEnabled: false,
            pickupEnabled: true,
            deliveryEnabled: false
        });

        const { statusCode, payload } = await call(
            updateDeliveryOptions,
            requestFor(TENANT_DB, ROLES.ADMIN, body)
        );

        expect(statusCode).toBe(400);
        expect(payload.message).toBe(esTranslations.error_store_config_invalid_delivery_options);

        const stored = await tenantModel.findOne({ key: STORE_CONFIG_KEY }).lean();
        expect(stored.dineInEnabled).toBe(false);
        expect(stored.pickupEnabled).toBe(true);
        expect(stored.deliveryEnabled).toBe(false);
    });

    it("returns 404 when saving delivery options without a store config", async () => {
        const { statusCode, payload } = await call(
            updateDeliveryOptions,
            requestFor(TENANT_DB, ROLES.ADMIN, {
                dineInEnabled: true,
                pickupEnabled: false,
                deliveryEnabled: true
            })
        );

        expect(statusCode).toBe(404);
        expect(payload.message).toBe(esTranslations.error_store_config_not_found);
    });

    it("lets an ADMIN save the store coordinates", async () => {
        const tenantModel = getTenantModel(TENANT_DB, "StoreConfig");
        await tenantModel.create({ name: "Tienda del Tenant" });

        const { statusCode, payload } = await call(
            updateCoordinates,
            requestFor(TENANT_DB, ROLES.ADMIN, {
                latitude: -17.7833,
                longitude: -63.1821
            })
        );

        expect(statusCode).toBe(200);
        expect(payload.success).toBe(true);
        expect(payload.message).toBe(esTranslations.success_store_coordinates_saved);
        expect(payload.data).toEqual({
            latitude: -17.7833,
            longitude: -63.1821
        });

        const stored = await tenantModel.findOne({ key: STORE_CONFIG_KEY }).lean();
        expect(stored.latitude).toBe(-17.7833);
        expect(stored.longitude).toBe(-63.1821);
    });

    it("lets an ADMIN clear the store coordinates with null", async () => {
        const tenantModel = getTenantModel(TENANT_DB, "StoreConfig");
        await tenantModel.create({
            name: "Tienda del Tenant",
            latitude: -17.7833,
            longitude: -63.1821
        });

        const { statusCode, payload } = await call(
            updateCoordinates,
            requestFor(TENANT_DB, ROLES.ADMIN, { latitude: null, longitude: null })
        );

        expect(statusCode).toBe(200);
        expect(payload.data).toEqual({ latitude: null, longitude: null });

        const stored = await tenantModel.findOne({ key: STORE_CONFIG_KEY }).lean();
        expect(stored.latitude).toBe(null);
        expect(stored.longitude).toBe(null);
    });

    it.each([
        ["CLIENT", ROLES.CLIENT],
        ["SELLER", ROLES.SELLER]
    ])("returns 403 when a %s tries to save store coordinates", async (_, role) => {
        const tenantModel = getTenantModel(TENANT_DB, "StoreConfig");
        await tenantModel.create({
            name: "Tienda del Tenant",
            latitude: -17.7833,
            longitude: -63.1821
        });

        const { statusCode, payload } = await call(
            updateCoordinates,
            requestFor(TENANT_DB, role, { latitude: 4.711, longitude: -74.0721 })
        );

        expect(statusCode).toBe(403);
        expect(payload.message).toBe(esTranslations.error_store_config_admin_only);

        const stored = await tenantModel.findOne({ key: STORE_CONFIG_KEY }).lean();
        expect(stored.latitude).toBe(-17.7833);
        expect(stored.longitude).toBe(-63.1821);
    });

    it.each([
        ["latitude is above the maximum", { latitude: 91, longitude: -63.1821 }],
        ["longitude is below the minimum", { latitude: -17.7833, longitude: -181 }],
        ["latitude is a numeric string", { latitude: " -17.5", longitude: -63.1821 }],
        ["longitude is missing", { latitude: -17.7833 }]
    ])("returns 400 for invalid coordinates when %s", async (_, body) => {
        const tenantModel = getTenantModel(TENANT_DB, "StoreConfig");
        await tenantModel.create({
            name: "Tienda del Tenant",
            latitude: -17.7833,
            longitude: -63.1821
        });

        const { statusCode, payload } = await call(
            updateCoordinates,
            requestFor(TENANT_DB, ROLES.ADMIN, body)
        );

        expect(statusCode).toBe(400);
        expect(payload.message).toBe(esTranslations.error_store_config_invalid_coordinates);

        const stored = await tenantModel.findOne({ key: STORE_CONFIG_KEY }).lean();
        expect(stored.latitude).toBe(-17.7833);
        expect(stored.longitude).toBe(-63.1821);
    });

    it("returns 404 when saving coordinates without a store config", async () => {
        const { statusCode, payload } = await call(
            updateCoordinates,
            requestFor(TENANT_DB, ROLES.ADMIN, { latitude: -17.7833, longitude: -63.1821 })
        );

        expect(statusCode).toBe(404);
        expect(payload.message).toBe(esTranslations.error_store_config_not_found);
    });

    it("rejects an invalid IANA timezone at write time", async () => {
        await expect(StoreConfig.create({ name: "Mi Tienda", timezone: "UTC-4" }))
            .rejects.toThrow();

        expect(await StoreConfig.countDocuments({})).toBe(0);
    });

    it("lets an ADMIN save the store timezone", async () => {
        const tenantModel = getTenantModel(TENANT_DB, "StoreConfig");
        await tenantModel.create({ name: "Tienda del Tenant" });

        const { statusCode, payload } = await call(
            updateTimezone,
            requestFor(TENANT_DB, ROLES.ADMIN, { timezone: "America/Mexico_City" })
        );

        expect(statusCode).toBe(200);
        expect(payload.success).toBe(true);
        expect(payload.message).toBe(esTranslations.success_store_timezone_saved);
        expect(payload.data).toEqual({ timezone: "America/Mexico_City" });

        const stored = await tenantModel.findOne({ key: STORE_CONFIG_KEY }).lean();
        expect(stored.timezone).toBe("America/Mexico_City");
    });

    it.each([
        ["CLIENT", ROLES.CLIENT],
        ["SELLER", ROLES.SELLER]
    ])("returns 403 when a %s tries to save the store timezone", async (_, role) => {
        const tenantModel = getTenantModel(TENANT_DB, "StoreConfig");
        await tenantModel.create({ name: "Tienda del Tenant" });

        const { statusCode, payload } = await call(
            updateTimezone,
            requestFor(TENANT_DB, role, { timezone: "America/Mexico_City" })
        );

        expect(statusCode).toBe(403);
        expect(payload.message).toBe(esTranslations.error_store_config_admin_only);

        const stored = await tenantModel.findOne({ key: STORE_CONFIG_KEY }).lean();
        expect(stored.timezone).toBe("America/La_Paz");
    });

    it.each([
        ["a numeric offset", { timezone: "-04:00" }],
        ["an unknown IANA name", { timezone: "Mars/Olympus" }],
        ["an empty string", { timezone: "   " }],
        ["a missing value", {}],
        ["a non-string value", { timezone: 123 }]
    ])("returns 400 for an invalid timezone when given %s", async (_, body) => {
        const tenantModel = getTenantModel(TENANT_DB, "StoreConfig");
        await tenantModel.create({ name: "Tienda del Tenant" });

        const { statusCode, payload } = await call(
            updateTimezone,
            requestFor(TENANT_DB, ROLES.ADMIN, body)
        );

        expect(statusCode).toBe(400);
        expect(payload.message).toBe(esTranslations.error_store_config_invalid_timezone);

        const stored = await tenantModel.findOne({ key: STORE_CONFIG_KEY }).lean();
        expect(stored.timezone).toBe("America/La_Paz");
    });

    it("returns 404 when saving the timezone without a store config", async () => {
        const { statusCode, payload } = await call(
            updateTimezone,
            requestFor(TENANT_DB, ROLES.ADMIN, { timezone: "America/Mexico_City" })
        );

        expect(statusCode).toBe(404);
        expect(payload.message).toBe(esTranslations.error_store_config_not_found);
    });
});
