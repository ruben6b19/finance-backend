import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import { Product } from "../products/product.model.js";
import { ComboDefinition } from "./comboDefinition.model.js";
import { ComboComponent } from "./comboComponent.model.js";
import { getTenantModel, resetTenantConnections } from "../tenants/tenantConnection.js";
import { DB_NAME } from "../../constants.js";
import { createCombo, getComboById, getCombos } from "./combo.controller.js";

let server;

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

const TENANT_DB = "tenant_combo_definitions";

beforeAll(async () => {
    // createCombo abre una transacción: hace falta un replica set.
    server = await MongoMemoryReplSet.create({
        replSet: {
            count: 1,
            args: ["--setParameter", "maxTransactionLockRequestTimeoutMillis=10000"]
        }
    });
    await mongoose.connect(server.getUri());

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
    await server.stop();
}, 60000);

describe("combo definition tenant routing", () => {
    const tenantModel = (name) => getTenantModel(TENANT_DB, name);

    const tenantRequest = (overrides = {}) => request({
        ...overrides,
        tenant: buildTenant(TENANT_DB)
    });

    let comboProductId;
    let componentProductId;

    beforeAll(async () => {
        await Promise.all([
            tenantModel("Product").init(),
            tenantModel("ComboDefinition").init(),
            tenantModel("ComboComponent").init()
        ]);
    }, 60000);

    beforeEach(async () => {
        await tenantModel("ComboDefinition").deleteMany({});
        await tenantModel("ComboComponent").deleteMany({});
        await tenantModel("Product").deleteMany({});

        const component = await tenantModel("Product").create({
            name: "Tenant Water",
            price: 5,
            unit: new mongoose.Types.ObjectId(),
            productType: 2,
            isSellable: true,
            stock: 10
        });

        const combo = await tenantModel("Product").create({
            name: "Tenant Combo",
            price: 20,
            unit: new mongoose.Types.ObjectId(),
            productType: 3,
            isSellable: true,
            stock: 0
        });

        componentProductId = component._id;
        comboProductId = combo._id;
    });

    it("creates the definition and its components in the tenant database", async () => {
        const centralDefinitionsBefore = await ComboDefinition.countDocuments();

        const { statusCode } = await call(
            createCombo,
            tenantRequest({
                body: {
                    product: String(comboProductId),
                    components: [{ product: String(componentProductId), quantity: 3 }]
                }
            })
        );

        expect(statusCode).toBe(201);
        expect(await tenantModel("ComboDefinition").countDocuments()).toBe(1);
        expect(await tenantModel("ComboComponent").countDocuments()).toBe(1);

        // The whole flow stays in one database: nothing may leak here.
        expect(await ComboDefinition.countDocuments()).toBe(centralDefinitionsBefore);
        expect(await ComboComponent.countDocuments()).toBe(0);
    });

    it("hydrates components from the tenant database on read", async () => {
        const definition = await tenantModel("ComboDefinition").create({
            product: comboProductId,
            referencePrice: 15,
            validityDays: 0,
            status: 1
        });
        await tenantModel("ComboComponent").create({
            combo: definition._id,
            product: componentProductId,
            quantity: 3,
            label: "Tenant Water",
            conversionFactor: 1
        });

        const { statusCode, payload } = await call(
            getComboById,
            tenantRequest({ params: { comboId: String(definition._id) } })
        );

        expect(statusCode).toBe(200);
        expect(payload.data.components).toHaveLength(1);
        expect(payload.data.components[0].quantity).toBe(3);
    });

    it("does not list another database's combos", async () => {
        await tenantModel("ComboDefinition").create({
            product: comboProductId,
            referencePrice: 15,
            validityDays: 0,
            status: 1
        });

        const tenantList = await call(getCombos, tenantRequest());
        expect(tenantList.statusCode).toBe(200);
        expect(tenantList.payload.data.docs).toHaveLength(1);

        const centralList = await call(getCombos, request());
        expect(centralList.statusCode).toBe(200);
        expect(centralList.payload.data.docs).toHaveLength(0);
    });
});
