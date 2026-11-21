import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { DB_NAME } from "../../constants.js";
import { StoreConfig, STORE_CONFIG_KEY } from "./storeConfig.model.js";
import { STORE_SCHEDULE_KEY } from "./storeSchedule.model.js";
import {
    getPublicStoreConfig,
    getStoreConfig,
    updateDeliveryOptions,
    updateCoordinates,
    updateGeneralStoreConfig,
    updateMailConfig,
    getStoreSchedule,
    updateStoreSchedule,
    updateStoreScheduleMode
} from "./storeConfig.controller.js";
import { getTenantModel, resetTenantConnections } from "../tenants/tenantConnection.js";
import { ROLES } from "../../constants/roles.js";
import { decrypt } from "../../utils/mailCrypto.js";
import { SCHEDULE_MODE } from "../../utils/storeScheduleModes.js";
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

// Surrounding whitespace proves the controller trims before writing.
const validGeneralBody = {
    name: "  Pollería Digital Core  ",
    razonSocial: "  Pollería Digital S.R.L.  ",
    nit: "  123456789  ",
    phone: "  70000000  ",
    whatsapp: "  70000001  ",
    address: "  Av. Principal 123  ",
    currency: "  Bs.  ",
    ticketFooter: "  ¡Gracias por su preferencia!  ",
    logoUrl: "  https://example.com/logo.png  "
};

const trimmedGeneralBody = {
    name: "Pollería Digital Core",
    razonSocial: "Pollería Digital S.R.L.",
    nit: "123456789",
    phone: "70000000",
    whatsapp: "70000001",
    address: "Av. Principal 123",
    currency: "Bs.",
    ticketFooter: "¡Gracias por su preferencia!",
    logoUrl: "https://example.com/logo.png"
};

// Distinct values make an accidental write obvious in the "unchanged" cases.
const generalBaseline = {
    name: "Tienda del Tenant",
    razonSocial: "Razón Anterior",
    nit: "999",
    phone: "111",
    whatsapp: "222",
    address: "Calle Vieja 1",
    currency: "USD",
    ticketFooter: "Footer anterior",
    logoUrl: "https://example.com/old.png"
};

const withoutGeneralField = (field) => {
    const body = { ...validGeneralBody };
    delete body[field];
    return body;
};

const expectGeneralBaseline = async (tenantModel) => {
    const stored = await tenantModel.findOne({ key: STORE_CONFIG_KEY }).lean();
    expect(stored).toMatchObject(generalBaseline);
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
        await getTenantModel(TENANT_DB, "StoreSchedule").init();
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
        await getTenantModel(TENANT_DB, "StoreSchedule").deleteMany({});
    });

    it("applies the default currency and ticket footer", async () => {
        const config = await StoreConfig.create({ name: "Mi Tienda" });

        expect(config.currency).toBe("Bs.");
        expect(config.ticketFooter).toBe("¡Gracias por su preferencia!");
        expect(config.key).toBe(STORE_CONFIG_KEY);
        expect(config.timezone).toBeUndefined();
        expect(StoreConfig.schema.path("timezone")).toBeUndefined();
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
            isOpen: true,
            scheduleMode: SCHEDULE_MODE.AUTO,
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
            dineInEnabled: true,
            pickupEnabled: false,
            deliveryEnabled: true
        });
        await getTenantModel(TENANT_DB, "StoreSchedule").create({
            key: STORE_SCHEDULE_KEY,
            timezone: "America/Mexico_City",
            autoScheduleEnabled: false
        });

        const { statusCode, payload } = await call(getPublicStoreConfig, requestFor(TENANT_DB));

        expect(statusCode).toBe(200);
        expect(payload.data).toEqual({
            name: "Pollería Digital Core",
            latitude: -17.7833,
            longitude: -63.1821,
            timezone: "America/Mexico_City",
            isOpen: true,
            scheduleMode: SCHEDULE_MODE.AUTO,
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
            isOpen: true,
            scheduleMode: SCHEDULE_MODE.AUTO,
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

    it("lets an ADMIN save all nine general store fields trimmed", async () => {
        const tenantModel = getTenantModel(TENANT_DB, "StoreConfig");
        await tenantModel.create(generalBaseline);

        const { statusCode, payload } = await call(
            updateGeneralStoreConfig,
            requestFor(TENANT_DB, ROLES.ADMIN, validGeneralBody)
        );

        expect(statusCode).toBe(200);
        expect(payload.success).toBe(true);
        expect(payload.message).toBe(esTranslations.success_store_general_data_saved);
        expect(payload.data).toEqual(trimmedGeneralBody);

        const stored = await tenantModel.findOne({ key: STORE_CONFIG_KEY }).lean();
        expect(stored).toMatchObject(trimmedGeneralBody);
    });

    it("lets blank strings clear the optional general store fields", async () => {
        const tenantModel = getTenantModel(TENANT_DB, "StoreConfig");
        await tenantModel.create(generalBaseline);

        const body = {
            ...validGeneralBody,
            name: "Tienda del Tenant",
            razonSocial: "",
            nit: "",
            phone: "",
            whatsapp: "",
            address: "",
            currency: "",
            ticketFooter: "",
            logoUrl: ""
        };

        const { statusCode, payload } = await call(
            updateGeneralStoreConfig,
            requestFor(TENANT_DB, ROLES.ADMIN, body)
        );

        expect(statusCode).toBe(200);
        expect(payload.data.name).toBe("Tienda del Tenant");
        expect(payload.data.logoUrl).toBe("");

        const stored = await tenantModel.findOne({ key: STORE_CONFIG_KEY }).lean();
        expect(stored.razonSocial).toBe("");
        expect(stored.nit).toBe("");
        expect(stored.phone).toBe("");
        expect(stored.whatsapp).toBe("");
        expect(stored.address).toBe("");
        expect(stored.currency).toBe("");
        expect(stored.ticketFooter).toBe("");
        expect(stored.logoUrl).toBe("");
    });

    it.each([
        ["a whitespace-only name", { name: "   " }],
        ["an empty name", { name: "" }]
    ])("returns 400 for an invalid store name when given %s", async (_, override) => {
        const tenantModel = getTenantModel(TENANT_DB, "StoreConfig");
        await tenantModel.create(generalBaseline);

        const { statusCode, payload } = await call(
            updateGeneralStoreConfig,
            requestFor(TENANT_DB, ROLES.ADMIN, { ...validGeneralBody, ...override })
        );

        expect(statusCode).toBe(400);
        expect(payload.message).toBe(esTranslations.error_store_config_invalid_general_data);
        await expectGeneralBaseline(tenantModel);
    });

    it.each(["name", "phone", "ticketFooter"])(
        "returns 400 when a general data field is missing (%s)",
        async (field) => {
            const tenantModel = getTenantModel(TENANT_DB, "StoreConfig");
            await tenantModel.create(generalBaseline);

            const { statusCode, payload } = await call(
                updateGeneralStoreConfig,
                requestFor(TENANT_DB, ROLES.ADMIN, withoutGeneralField(field))
            );

            expect(statusCode).toBe(400);
            expect(payload.message).toBe(esTranslations.error_store_config_invalid_general_data);
            await expectGeneralBaseline(tenantModel);
        }
    );

    it.each([
        ["a number for phone", { phone: 70000000 }],
        ["null for logoUrl", { logoUrl: null }],
        ["a boolean for nit", { nit: true }]
    ])("returns 400 for non-string general data when given %s", async (_, override) => {
        const tenantModel = getTenantModel(TENANT_DB, "StoreConfig");
        await tenantModel.create(generalBaseline);

        const { statusCode, payload } = await call(
            updateGeneralStoreConfig,
            requestFor(TENANT_DB, ROLES.ADMIN, { ...validGeneralBody, ...override })
        );

        expect(statusCode).toBe(400);
        expect(payload.message).toBe(esTranslations.error_store_config_invalid_general_data);
        await expectGeneralBaseline(tenantModel);
    });

    it.each([
        ["CLIENT", ROLES.CLIENT],
        ["SELLER", ROLES.SELLER]
    ])("returns 403 when a %s tries to save general store data", async (_, role) => {
        const tenantModel = getTenantModel(TENANT_DB, "StoreConfig");
        await tenantModel.create(generalBaseline);

        const { statusCode, payload } = await call(
            updateGeneralStoreConfig,
            requestFor(TENANT_DB, role, validGeneralBody)
        );

        expect(statusCode).toBe(403);
        expect(payload.message).toBe(esTranslations.error_store_config_admin_only);
        await expectGeneralBaseline(tenantModel);
    });

    it("returns 404 when saving general store data without a store config", async () => {
        const { statusCode, payload } = await call(
            updateGeneralStoreConfig,
            requestFor(TENANT_DB, ROLES.ADMIN, validGeneralBody)
        );

        expect(statusCode).toBe(404);
        expect(payload.message).toBe(esTranslations.error_store_config_not_found);
    });

    describe("store schedule", () => {
        const scheduleModel = () => getTenantModel(TENANT_DB, "StoreSchedule");

        const seedSchedule = (overrides = {}) => scheduleModel().create({
            key: STORE_SCHEDULE_KEY,
            timezone: "America/La_Paz",
            autoScheduleEnabled: true,
            openTime: "08:00",
            closeTime: "21:00",
            closedDays: [0],
            scheduleMode: SCHEDULE_MODE.AUTO,
            forceOpenUntil: "",
            ...overrides
        });

        const validScheduleBody = {
            timezone: "America/Mexico_City",
            autoScheduleEnabled: false,
            openTime: "09:30",
            closeTime: "18:45",
            closedDays: [0, 6],
            scheduleMode: SCHEDULE_MODE.AUTO,
            forceOpenUntil: ""
        };

        const expectedProjection = (overrides = {}) => ({
            timezone: "America/La_Paz",
            autoScheduleEnabled: true,
            openTime: "08:00",
            closeTime: "21:00",
            closedDays: [0],
            scheduleMode: SCHEDULE_MODE.AUTO,
            forceOpenUntil: "",
            isOpen: true,
            effectiveMode: SCHEDULE_MODE.AUTO,
            ...overrides
        });

        it("lets an ADMIN read the full schedule with its effective state", async () => {
            await seedSchedule({ scheduleMode: SCHEDULE_MODE.FORCE_CLOSED });

            const { statusCode, payload } = await call(
                getStoreSchedule,
                requestFor(TENANT_DB, ROLES.ADMIN)
            );

            expect(statusCode).toBe(200);
            expect(payload.success).toBe(true);
            expect(payload.data).toEqual(expectedProjection({
                scheduleMode: SCHEDULE_MODE.FORCE_CLOSED,
                effectiveMode: SCHEDULE_MODE.FORCE_CLOSED,
                isOpen: false
            }));
        });

        it.each([
            ["CLIENT", ROLES.CLIENT],
            ["SELLER", ROLES.SELLER]
        ])("returns 403 when a %s reads the schedule", async (_, role) => {
            await seedSchedule();

            const { statusCode, payload } = await call(
                getStoreSchedule,
                requestFor(TENANT_DB, role)
            );

            expect(statusCode).toBe(403);
            expect(payload.message).toBe(esTranslations.error_store_config_admin_only);
        });

        it("returns 404 when reading a schedule that does not exist", async () => {
            const { statusCode, payload } = await call(
                getStoreSchedule,
                requestFor(TENANT_DB, ROLES.ADMIN)
            );

            expect(statusCode).toBe(404);
            expect(payload.message).toBe(esTranslations.error_store_config_not_found);
        });

        it("lets an ADMIN replace the whole schedule", async () => {
            await seedSchedule();

            const { statusCode, payload } = await call(
                updateStoreSchedule,
                requestFor(TENANT_DB, ROLES.ADMIN, validScheduleBody)
            );

            expect(statusCode).toBe(200);
            expect(payload.message).toBe(esTranslations.success_store_schedule_saved);
            expect(payload.data).toEqual(expectedProjection({
                ...validScheduleBody,
                isOpen: true,
                effectiveMode: SCHEDULE_MODE.AUTO
            }));

            const stored = await scheduleModel().findOne({ key: STORE_SCHEDULE_KEY }).lean();
            expect(stored).toMatchObject(validScheduleBody);
            expect(typeof stored.scheduleMode).toBe("number");
        });

        it.each([
            ["an invalid timezone", { timezone: "Mars/Olympus" }],
            ["a malformed open time", { openTime: "24:00" }],
            ["open at or after close", { openTime: "21:00", closeTime: "08:00" }],
            ["equal open and close times", { openTime: "09:30", closeTime: "09:30" }],
            ["an out-of-range closed day", { closedDays: [7] }],
            ["a non-integer closed day", { closedDays: ["1"] }],
            ["an unknown mode", { scheduleMode: "MAYBE" }],
            ["a legacy string mode", { scheduleMode: "FORCE_CLOSED" }],
            ["a fractional numeric mode", { scheduleMode: 1.5 }],
            ["a negative numeric mode", { scheduleMode: -1 }],
            ["an out-of-range numeric mode", { scheduleMode: 3 }],
            ["a null mode", { scheduleMode: null }],
            ["a malformed forced-open expiry", { forceOpenUntil: "9:00" }],
            ["a non-boolean autoScheduleEnabled", { autoScheduleEnabled: "true" }],
            ["a missing field", { closeTime: undefined }]
        ])("returns 400 when the schedule payload has %s", async (_, override) => {
            await seedSchedule();
            const body = { ...validScheduleBody, ...override };
            if (override.closeTime === undefined) delete body.closeTime;

            const { statusCode, payload } = await call(
                updateStoreSchedule,
                requestFor(TENANT_DB, ROLES.ADMIN, body)
            );

            expect(statusCode).toBe(400);
            expect(payload.message).toBe(esTranslations.error_store_schedule_invalid);

            const stored = await scheduleModel().findOne({ key: STORE_SCHEDULE_KEY }).lean();
            expect(stored.timezone).toBe("America/La_Paz");
            expect(stored.openTime).toBe("08:00");
        });

        it.each([
            ["CLIENT", ROLES.CLIENT],
            ["SELLER", ROLES.SELLER]
        ])("returns 403 when a %s replaces the schedule", async (_, role) => {
            await seedSchedule();

            const { statusCode, payload } = await call(
                updateStoreSchedule,
                requestFor(TENANT_DB, role, validScheduleBody)
            );

            expect(statusCode).toBe(403);
            expect(payload.message).toBe(esTranslations.error_store_config_admin_only);

            const stored = await scheduleModel().findOne({ key: STORE_SCHEDULE_KEY }).lean();
            expect(stored.timezone).toBe("America/La_Paz");
        });

        it("returns 404 when replacing a schedule that does not exist", async () => {
            const { statusCode, payload } = await call(
                updateStoreSchedule,
                requestFor(TENANT_DB, ROLES.ADMIN, validScheduleBody)
            );

            expect(statusCode).toBe(404);
            expect(payload.message).toBe(esTranslations.error_store_config_not_found);
        });

        it("pauses orders instantly with SCHEDULE_MODE.FORCE_CLOSED", async () => {
            await seedSchedule({ autoScheduleEnabled: false });

            const { statusCode, payload } = await call(
                updateStoreScheduleMode,
                requestFor(TENANT_DB, ROLES.ADMIN, { scheduleMode: SCHEDULE_MODE.FORCE_CLOSED })
            );

            expect(statusCode).toBe(200);
            expect(payload.message).toBe(esTranslations.success_store_schedule_saved);
            expect(payload.data.isOpen).toBe(false);
            expect(payload.data.scheduleMode).toBe(SCHEDULE_MODE.FORCE_CLOSED);
            expect(payload.data.effectiveMode).toBe(SCHEDULE_MODE.FORCE_CLOSED);

            const stored = await scheduleModel().findOne({ key: STORE_SCHEDULE_KEY }).lean();
            expect(stored.scheduleMode).toBe(SCHEDULE_MODE.FORCE_CLOSED);
            expect(typeof stored.scheduleMode).toBe("number");
        });

        it("resumes orders instantly with SCHEDULE_MODE.FORCE_OPEN and an optional local expiry", async () => {
            await seedSchedule({ scheduleMode: SCHEDULE_MODE.FORCE_CLOSED });

            const { statusCode, payload } = await call(
                updateStoreScheduleMode,
                requestFor(TENANT_DB, ROLES.ADMIN, {
                    scheduleMode: SCHEDULE_MODE.FORCE_OPEN,
                    forceOpenUntil: "23:59"
                })
            );

            expect(statusCode).toBe(200);
            expect(payload.data).toMatchObject({
                isOpen: true,
                scheduleMode: SCHEDULE_MODE.FORCE_OPEN,
                effectiveMode: SCHEDULE_MODE.FORCE_OPEN,
                forceOpenUntil: "23:59"
            });
        });

        it.each([
            ["an unknown mode", { scheduleMode: "MAYBE" }],
            ["a legacy string mode", { scheduleMode: "FORCE_CLOSED" }],
            ["a fractional numeric mode", { scheduleMode: 1.5 }],
            ["a negative numeric mode", { scheduleMode: -1 }],
            ["an out-of-range numeric mode", { scheduleMode: 3 }],
            ["a null mode", { scheduleMode: null }],
            ["a missing mode", {}],
            ["a malformed expiry", { scheduleMode: SCHEDULE_MODE.FORCE_OPEN, forceOpenUntil: "7:30" }],
            ["a non-string expiry", { scheduleMode: SCHEDULE_MODE.FORCE_OPEN, forceOpenUntil: 30 }]
        ])("returns 400 when the mode payload has %s", async (_, body) => {
            await seedSchedule();

            const { statusCode, payload } = await call(
                updateStoreScheduleMode,
                requestFor(TENANT_DB, ROLES.ADMIN, body)
            );

            expect(statusCode).toBe(400);
            expect(payload.message).toBe(esTranslations.error_store_schedule_invalid);
        });

        it.each([
            ["CLIENT", ROLES.CLIENT],
            ["SELLER", ROLES.SELLER]
        ])("returns 403 when a %s changes the mode", async (_, role) => {
            await seedSchedule();

            const { statusCode, payload } = await call(
                updateStoreScheduleMode,
                requestFor(TENANT_DB, role, { scheduleMode: SCHEDULE_MODE.FORCE_CLOSED })
            );

            expect(statusCode).toBe(403);
            expect(payload.message).toBe(esTranslations.error_store_config_admin_only);

            const stored = await scheduleModel().findOne({ key: STORE_SCHEDULE_KEY }).lean();
            expect(stored.scheduleMode).toBe(SCHEDULE_MODE.AUTO);
        });

        it("returns 404 when changing the mode of a schedule that does not exist", async () => {
            const { statusCode, payload } = await call(
                updateStoreScheduleMode,
                requestFor(TENANT_DB, ROLES.ADMIN, { scheduleMode: SCHEDULE_MODE.FORCE_CLOSED })
            );

            expect(statusCode).toBe(404);
            expect(payload.message).toBe(esTranslations.error_store_config_not_found);
        });

        it("publishes the effective state and the schedule timezone on the public route", async () => {
            await getTenantModel(TENANT_DB, "StoreConfig").create({ name: "Pollería Digital Core" });
            await seedSchedule({
                timezone: "America/Mexico_City",
                scheduleMode: SCHEDULE_MODE.FORCE_CLOSED
            });

            const { statusCode, payload } = await call(
                getPublicStoreConfig,
                requestFor(TENANT_DB)
            );

            expect(statusCode).toBe(200);
            expect(payload.data).toMatchObject({
                timezone: "America/Mexico_City",
                isOpen: false,
                scheduleMode: SCHEDULE_MODE.FORCE_CLOSED
            });
        });
    });
});
