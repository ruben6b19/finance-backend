import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { DB_NAME } from "../../constants.js";
import { getTenantModel, resetTenantConnections } from "./tenantConnection.js";
import {
    copyReferenceData,
    exportReferencePack,
    importReferencePack,
    REFERENCE_MODELS,
    REFERENCE_PACK_VERSION
} from "./referenceData.service.js";

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

describe("reference data pack", () => {
    it("exports a portable pack without database-bound fields", async () => {
        await seedSource();

        const pack = await exportReferencePack({ getModel });

        expect(pack.version).toBe(REFERENCE_PACK_VERSION);
        expect(pack.sourceDatabase).toBe(DB_NAME);
        expect(typeof pack.exportedAt).toBe("string");

        const units = pack.collections.Unit;
        expect(units).toHaveLength(3);
        expect(units[0]).toMatchObject({ name: expect.any(String), symbol: expect.any(String) });
        for (const document of units) {
            expect(document._id).toBeUndefined();
            expect(document.createdAt).toBeUndefined();
            expect(document.updatedAt).toBeUndefined();
            expect(document.__v).toBeUndefined();
            expect(document.createdBy).toBeUndefined();
        }

        expect(pack.collections.TransactionCategory).toHaveLength(2);
        expect(pack.collections.ProductCategory).toHaveLength(2);
    });

    it("imports a pack into a store database and stays idempotent", async () => {
        await seedSource();
        const pack = await exportReferencePack({ getModel });

        const first = await importReferencePack({ pack, targetDbName: TENANT_DB, getModel });
        expect(first.total).toEqual({ read: 7, created: 7, existing: 0 });

        const second = await importReferencePack({ pack, targetDbName: TENANT_DB, getModel });
        expect(second.total).toEqual({ read: 7, created: 0, existing: 7 });

        expect(await countTarget("Unit")).toBe(3);
        expect(await countTarget("TransactionCategory")).toBe(2);
        expect(await countTarget("ProductCategory")).toBe(2);
    });

    it("round-trips the business fields", async () => {
        await seedSource();
        const pack = await exportReferencePack({ getModel });

        await importReferencePack({ pack, targetDbName: TENANT_DB, getModel });

        const source = await getTenantModel(DB_NAME, "Unit").findOne({ name: "Kilogramo" }).lean();
        const copied = await getTenantModel(TENANT_DB, "Unit").findOne({ name: "Kilogramo" }).lean();

        expect(copied).toMatchObject({
            name: source.name,
            symbol: source.symbol,
            unitType: source.unitType,
            allowDecimals: source.allowDecimals,
            status: source.status
        });
    });

    it("works without a source database, so it survives a wiped central", async () => {
        const pack = {
            version: 1,
            exportedAt: "2026-01-01T00:00:00.000Z",
            sourceDatabase: "financeDB",
            collections: {
                Unit: [{ name: "Unidad", symbol: "un", unitType: 2, allowDecimals: false, status: 1 }],
                TransactionCategory: [{ name: "Ventas POS", type: 0, description: "", isSystem: true, status: 1 }],
                ProductCategory: [{ name: "Bebidas", description: "", isSellable: true, isPurchasable: true, status: 1 }]
            }
        };

        const result = await importReferencePack({ pack, targetDbName: TENANT_DB, getModel });

        expect(result.total).toEqual({ read: 3, created: 3, existing: 0 });
        expect(await countTarget("Unit")).toBe(1);
    });

    it("reports the plan without writing on dry-run", async () => {
        await seedSource();
        const pack = await exportReferencePack({ getModel });

        const result = await importReferencePack({ pack, targetDbName: TENANT_DB, dryRun: true, getModel });

        expect(result.total).toEqual({ read: 7, created: 7, existing: 0 });
        expect(await countTarget("Unit")).toBe(0);
    });

    it("rejects a malformed pack instead of guessing", async () => {
        await expect(
            importReferencePack({ pack: null, targetDbName: TENANT_DB, getModel })
        ).rejects.toThrow(/not a valid pack/);

        await expect(
            importReferencePack({
                pack: { version: 1, collections: { Unit: [] } },
                targetDbName: TENANT_DB,
                getModel
            })
        ).rejects.toThrow(/missing the "TransactionCategory" collection/);

        await expect(
            importReferencePack({
                pack: { version: 99, collections: { Unit: [], TransactionCategory: [], ProductCategory: [] } },
                targetDbName: TENANT_DB,
                getModel
            })
        ).rejects.toThrow(/Unsupported reference data pack version/);
    });

    it("requires a target database and a model resolver", async () => {
        await expect(importReferencePack({ pack: {}, getModel })).rejects.toThrow(/target database/);
        await expect(
            importReferencePack({ pack: {}, targetDbName: TENANT_DB })
        ).rejects.toThrow(/model resolver/);
    });
});
