#!/usr/bin/env node
/**
 * Creates and initializes the application database on MongoDB Atlas.
 *
 * MongoDB has no CREATE DATABASE statement: a database exists as soon as it
 * holds at least one collection. This script connects to an existing Atlas
 * cluster, creates every collection declared by the application models, and
 * builds their indexes. The Atlas cluster itself must already exist (created
 * in the Atlas UI or through the Atlas Admin API, which requires API keys).
 *
 * Idempotent: existing collections are reused, missing ones are created, and
 * indexes are created only when absent. No document is inserted, no collection
 * is dropped and no index is removed.
 *
 * Usage:
 *   npm run db:create
 *   npm run db:create -- --dry-run
 *   npm run db:create -- --uri "mongodb+srv://user:pass@cluster.mongodb.net" --db financeDB
 *
 * Options:
 *   --uri <s>    Mongo connection string (or MONGODB_URI from .env)
 *   --db <s>     Database name (or MONGODB_DB, default financeDB)
 *   --dry-run    Print the plan without writing anything
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import dotenv from "dotenv";

import { DB_NAME } from "../src/constants.js";
import { Sale } from "../src/modules/sales/sale.model.js";
import { Transaction } from "../src/modules/transactions/transaction.model.js";
import { TransactionCategory } from "../src/modules/transactionCategories/transactionCategory.model.js";
import { Purchase } from "../src/modules/purchases/purchase.model.js";
import { User } from "../src/modules/users/user.model.js";
import { StockAdjustment } from "../src/modules/stockAdjustments/stockAdjustment.model.js";
import { Order } from "../src/modules/orders/order.model.js";
import { ProductCategory } from "../src/modules/productCategories/productCategory.model.js";
import { Reservation } from "../src/modules/reservations/reservation.model.js";
import { Unit } from "../src/modules/units/unit.model.js";
import { StoreConfig } from "../src/modules/storeConfig/storeConfig.model.js";
import { Product } from "../src/modules/products/product.model.js";
import { ComboRedemption } from "../src/modules/combos/comboRedemption.model.js";
import { ComboPurchase } from "../src/modules/combos/comboPurchase.model.js";
import { ComboComponent } from "../src/modules/combos/comboComponent.model.js";
import { ComboDefinition } from "../src/modules/combos/comboDefinition.model.js";
import { TenantMapping } from "../src/modules/tenants/tenantMapping.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const MODELS = [
    Sale,
    Transaction,
    TransactionCategory,
    Purchase,
    User,
    StockAdjustment,
    Order,
    ProductCategory,
    Reservation,
    Unit,
    StoreConfig,
    Product,
    ComboRedemption,
    ComboPurchase,
    ComboComponent,
    ComboDefinition,
    TenantMapping
];

// MongoDB error code returned when a collection already exists.
const NAMESPACE_EXISTS = 48;

function parseArgs(argv) {
    const parsed = new Map();
    for (let i = 2; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith("--")) continue;
        const [rawKey, ...inlineValue] = token.slice(2).split("=");
        if (inlineValue.length > 0) {
            parsed.set(rawKey, inlineValue.join("="));
        } else {
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith("--")) {
                parsed.set(rawKey, next);
                i += 1;
            } else {
                parsed.set(rawKey, true);
            }
        }
    }
    return parsed;
}

function readOption(args, key, envKey, fallback) {
    const value = args.get(key);
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    const fromEnv = process.env[envKey];
    if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
    return fallback;
}

function validateDatabaseName(name) {
    if (!name) {
        throw new Error("Falta el nombre de la base de datos. Pasá --db o definí MONGODB_DB.");
    }
    if (/[/\\. "$*<>:|?]/.test(name)) {
        throw new Error(`El nombre de la base de datos "${name}" contiene caracteres no permitidos.`);
    }
}

async function listExistingCollections() {
    const collections = await mongoose.connection.db.listCollections().toArray();
    return new Set(collections.map((collection) => collection.name));
}

async function ensureCollection(Model, existingNames, dryRun) {
    const name = Model.collection.collectionName;
    const plannedIndexes = Model.schema.indexes().length;

    if (existingNames.has(name)) {
        if (!dryRun) await Model.createIndexes();
        return { name, action: "existente", plannedIndexes, indexes: null };
    }

    if (dryRun) {
        return { name, action: "crear", plannedIndexes, indexes: null };
    }

    try {
        await Model.createCollection();
    } catch (error) {
        if (error.code !== NAMESPACE_EXISTS) throw error;
    }

    await Model.createIndexes();
    const actualIndexes = await Model.collection.indexes();
    return { name, action: "creada", plannedIndexes, indexes: actualIndexes.length };
}

async function main() {
    const args = parseArgs(process.argv);
    const dryRun = args.has("dry-run");

    const uri = readOption(args, "uri", "MONGODB_URI", "");
    const dbName = readOption(args, "db", "MONGODB_DB", DB_NAME);

    if (!uri) {
        throw new Error("Falta la cadena de conexión. Pasá --uri o definí MONGODB_URI en el archivo .env.");
    }
    if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
        throw new Error("La cadena de conexión debe empezar con mongodb:// o mongodb+srv://.");
    }
    validateDatabaseName(dbName);

    console.log("Inicialización de la base de datos en MongoDB Atlas:");
    console.log(`  base:     ${dbName}`);
    console.log(`  modelos:  ${MODELS.length}`);
    if (dryRun) console.log("  modo:     dry-run, no se escribe nada");

    // Mongoose creates collections and indexes automatically on connect when
    // autoCreate/autoIndex are true (their default). That would defeat
    // --dry-run, so this script owns every write explicitly.
    await mongoose.connect(uri, {
        dbName,
        autoCreate: false,
        autoIndex: false,
        retryWrites: true,
        w: "majority",
        serverSelectionTimeoutMS: 15000
    });
    console.log(`\nMongoDB conectado: ${mongoose.connection.host}`);

    try {
        try {
            const info = await mongoose.connection.db.admin().serverInfo();
            console.log(`Servidor: MongoDB ${info.version}`);
        } catch {
            console.log("Servidor: versión no disponible (permisos del usuario de Atlas)");
        }

        const existingNames = await listExistingCollections();
        console.log(`Colecciones actuales: ${existingNames.size}`);

        const results = [];
        for (const Model of MODELS) {
            results.push(await ensureCollection(Model, existingNames, dryRun));
        }

        console.log(dryRun ? "\n[dry-run] plan:" : "\nResultado:");
        for (const result of results) {
            const detail = result.action === "existente"
                ? `${result.plannedIndexes} índices declarados`
                : dryRun
                    ? `${result.plannedIndexes} índices a crear`
                    : `${result.indexes ?? result.plannedIndexes} índices creados`;
            console.log(`  ${result.name}: ${result.action}, ${detail}`);
        }

        if (dryRun) {
            console.log("\nDry-run completado, no se escribió nada.");
            return;
        }

        const finalNames = await listExistingCollections();
        console.log(`\nBase de datos lista: ${dbName} (${finalNames.size} colecciones).`);
        console.log("Listo.");
    } finally {
        await mongoose.disconnect();
    }
}

main().catch(async (error) => {
    console.error(`\nFAILED: ${error.message}`);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
