import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { DB_NAME } from "../../constants.js";
import { getTenantModel, resetTenantConnections } from "./tenantConnection.js";
import { copyReferenceData, REFERENCE_MODELS } from "./referenceData.service.js";

const TENANT_DB = "tenant_reference_data";

const getModel = (dbName, modelName) => getTenantModel(dbName, modelName);

const oid = () => new mongoose.Types.ObjectId();

const sourceUnits = () => [
    { name: "Unidad", symbol: "un", unitType: 2, allowDecimals: false, status: 1 },
    { name: "Kilogramo", symbol: "kg", unitType: 0, allowDecimals: true, status: 1 },
    { name: "Litro", symbol: "l", unitType: 1, allowDecimals: true, status: 1 }
];

const sourceTransactionCategories = () => [
    { name: "Ventas POS", type: 0, description: "Ingresos del POS", isSystem: true, status: 1 },
    { name: "Compra de Insumos", type: 1, description: "Gastos de compras", isSystem: true, status: 1 }
];

const sourceProductCategories = () => [
    { name: "Bebidas y Gaseosas", description: "Gaseosas y jugos", isSellable: true, isPurchasable: true, status: 1 },
    { name: "Insumos - Abarrotes", description: "Arroz, aceite, harina", isSellable: false, isPurchasable: true, status: 1 }
];

const seedSource = async () => {
    await getTenantModel(DB_NAME, "Unit").create(sourceUnits());
    await getTenantModel(DB_NAME, "TransactionCategory").create(sourceTransactionCategories());
    await getTenantModel(DB_NAME, "ProductCategory").create(
        sourceProductCategories().map((category) => ({ ...category, createdBy: oid() }))
    );
};

const countTarget = async (modelName) => getTenantModel(TENANT_DB, modelName).countDocuments({});

let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), { dbName: DB_NAME });
    for (const modelName of REFERENCE_MODELS) {
        await getTenantModel(DB_NAME, modelName).init();
        await getTenantModel(TENANT_DB, modelName).init();
    }
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
    for (const modelName of REFERENCE_MODELS) {
        await getTenantModel(DB_NAME, modelName).deleteMany({});
        await getTenantModel(TENANT_DB, modelName).deleteMany({});
    }
});

describe("copyReferenceData", () => {
    it("copies units, transaction categories and product categories into the store", async () => {
        await seedSource();

        const result = await copyReferenceData({ targetDbName: TENANT_DB, getModel });

        expect(result.collections).toEqual([
            { model: "Unit", read: 3, created: 3, existing: 0 },
            { model: "TransactionCategory", read: 2, created: 2, existing: 0 },
            { model: "ProductCategory", read: 2, created: 2, existing: 0 }
        ]);
        expect(result.total).toEqual({ read: 7, created: 7, existing: 0 });

        const units = await getTenantModel(TENANT_DB, "Unit").find().sort({ name: 1 }).lean();
        expect(units.map((unit) => unit.name)).toEqual(["Kilogramo", "Litro", "Unidad"]);
        expect(units.find((unit) => unit.name === "Kilogramo")).toMatchObject({
            symbol: "kg",
            unitType: 0,
            allowDecimals: true,
            status: 1
        });

        expect(await countTarget("TransactionCategory")).toBe(2);
        expect(await countTarget("ProductCategory")).toBe(2);

        // The source database is never touched.
        expect(await getTenantModel(DB_NAME, "Unit").countDocuments({})).toBe(3);
    });

    it("is idempotent and never duplicates documents", async () => {
        await seedSource();

        await copyReferenceData({ targetDbName: TENANT_DB, getModel });
        const second = await copyReferenceData({ targetDbName: TENANT_DB, getModel });

        expect(second.total).toEqual({ read: 7, created: 0, existing: 7 });
        expect(await countTarget("Unit")).toBe(3);
        expect(await countTarget("TransactionCategory")).toBe(2);
        expect(await countTarget("ProductCategory")).toBe(2);
    });

    it("never overwrites a document the store already edited", async () => {
        await seedSource();
        await copyReferenceData({ targetDbName: TENANT_DB, getModel });

        await getTenantModel(TENANT_DB, "ProductCategory").updateOne(
            { name: "Bebidas y Gaseosas" },
            { $set: { description: "Ajustado por la tienda", status: 0 } }
        );

        await copyReferenceData({ targetDbName: TENANT_DB, getModel });

        const category = await getTenantModel(TENANT_DB, "ProductCategory")
            .findOne({ name: "Bebidas y Gaseosas" })
            .lean();

        expect(category.description).toBe("Ajustado por la tienda");
        expect(category.status).toBe(0);
    });

    it("does not carry the source _id, timestamps or createdBy", async () => {
        await seedSource();

        const source = await getTenantModel(DB_NAME, "ProductCategory")
            .findOne({ name: "Bebidas y Gaseosas" })
            .lean();

        await copyReferenceData({ targetDbName: TENANT_DB, getModel });

        const copied = await getTenantModel(TENANT_DB, "ProductCategory")
            .findOne({ name: "Bebidas y Gaseosas" })
            .lean();

        expect(String(copied._id)).not.toBe(String(source._id));
        expect(copied.createdBy).toBeNull();
        expect(copied.createdAt).not.toEqual(source.createdAt);
    });

    it("reports the plan without writing on dry-run", async () => {
        await seedSource();

        const result = await copyReferenceData({ targetDbName: TENANT_DB, dryRun: true, getModel });

        expect(result.total).toEqual({ read: 7, created: 7, existing: 0 });
        expect(await countTarget("Unit")).toBe(0);
        expect(await countTarget("TransactionCategory")).toBe(0);
        expect(await countTarget("ProductCategory")).toBe(0);
    });

    it("counts already present documents as existing on dry-run", async () => {
        await seedSource();
        await copyReferenceData({ targetDbName: TENANT_DB, getModel });

        const result = await copyReferenceData({ targetDbName: TENANT_DB, dryRun: true, getModel });

        expect(result.total).toEqual({ read: 7, created: 0, existing: 7 });
    });

    it("refuses to copy a database into itself", async () => {
        await expect(
            copyReferenceData({ sourceDbName: DB_NAME, targetDbName: DB_NAME, getModel })
        ).rejects.toThrow(/same/);
    });

    it("requires a target database and a model resolver", async () => {
        await expect(copyReferenceData({ getModel })).rejects.toThrow(/target database/);
        await expect(copyReferenceData({ targetDbName: TENANT_DB })).rejects.toThrow(/model resolver/);
    });
});
