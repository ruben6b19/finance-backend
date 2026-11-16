#!/usr/bin/env node
/**
 * Moves the reference data between the central database, a store database and a
 * portable JSON file.
 *
 * A new store starts empty, and without units, transaction categories and
 * product categories it cannot sell anything: a sale without a transaction
 * category falls back to "Ventas POS", and Product.unit is required. Copying
 * them keeps every store consistent and saves the operator from typing the same
 * catalogue again.
 *
 * Handles: Unit, TransactionCategory, ProductCategory.
 * Never handles: business data (products, sales, users, settings) nor the
 * central TenantMapping.
 *
 * Idempotent: documents are matched by name, so a re-run only fills the gaps
 * and never overwrites what the store already edited.
 *
 * Usage:
 *   node scripts/copy-reference-data.js --db-name tienda_norte
 *   node scripts/copy-reference-data.js --db-name tienda_norte --dry-run
 *   node scripts/copy-reference-data.js --db-name tienda_norte --from financeDB
 *   node scripts/copy-reference-data.js --export data/reference-data.json
 *   node scripts/copy-reference-data.js --db-name tienda_norte --from-file data/reference-data.json
 *
 * Options:
 *   --db-name <s>     Target store database (or TENANT_DB_NAME, required to import)
 *   --from <s>        Source database (or REFERENCE_SOURCE_DB, default financeDB)
 *   --from-file <s>   Import from a JSON pack instead of a database
 *   --export <s>      Export the reference data to a JSON pack and exit
 *   --dry-run         Print the plan without writing anything
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import dotenv from "dotenv";

import { DB_NAME } from "../src/constants.js";
// Importing the tenant connection registry registers every model on the default
// (central) connection, which is what the resolver reaches for DB_NAME.
import { getTenantModel } from "../src/modules/tenants/tenantConnection.js";
import {
    copyReferenceData,
    exportReferencePack,
    importReferencePack
} from "../src/modules/tenants/referenceData.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(REPO_ROOT, ".env") });

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

function assertDbName(dbName) {
    if (/[/\\. "$*<>:|?]/.test(dbName)) {
        throw new Error(`Nombre de base inválido: "${dbName}".`);
    }
}

const label = (text) => `${text}:`.padEnd(22, " ");

function printImportSummary(result) {
    const line = (entry) =>
        `  ${label(entry.model)} ${String(entry.read).padStart(2)} leídas, ` +
        `${String(entry.created).padStart(2)} ${result.dryRun ? "a crear" : "creadas"}, ` +
        `${String(entry.existing).padStart(2)} ya existentes`;

    console.log(result.dryRun ? "\n[dry-run] plan:" : "\nResumen:");
    for (const entry of result.collections) {
        console.log(line(entry));
    }
    console.log(
        `  ${label("total")} ${String(result.total.read).padStart(2)} leídas, ` +
        `${String(result.total.created).padStart(2)} ${result.dryRun ? "a crear" : "creadas"}, ` +
        `${String(result.total.existing).padStart(2)} ya existentes`
    );
    if (!result.dryRun) console.log("\nListo.");
}

function printExportSummary(pack, filePath) {
    console.log("\nResumen:");
    for (const modelName of Object.keys(pack.collections)) {
        const count = pack.collections[modelName].length;
        console.log(`  ${label(modelName)} ${String(count).padStart(2)} exportadas`);
    }
    console.log(`  ${label("archivo")} ${filePath}`);
    console.log("\nListo.");
}

async function connect() {
    if (!process.env.MONGODB_URI) {
        throw new Error("MONGODB_URI no está definida en el archivo .env");
    }

    // The central database is always the entry point: the source models live on
    // the default connection and every other database is reached through the
    // tenant registry. Trailing slashes are trimmed so a URI ending in "/" does
    // not produce a doubled separator.
    const mongoUri = process.env.MONGODB_URI.replace(/\/+$/, "");
    await mongoose.connect(`${mongoUri}/${DB_NAME}`, {
        retryWrites: true,
        w: "majority"
    });
    console.log(`\nMongoDB conectado: ${mongoose.connection.host}`);
}

const getModel = (dbName, modelName) => getTenantModel(dbName, modelName);

async function runExport({ filePath, sourceDbName, dryRun }) {
    const absolutePath = path.resolve(REPO_ROOT, filePath);

    console.log("Exportación de datos de referencia:");
    console.log(`  desde:   ${sourceDbName}`);
    console.log(`  archivo: ${path.relative(REPO_ROOT, absolutePath)}`);
    if (dryRun) console.log("  modo:    dry-run, no se escribe nada");

    await connect();

    const pack = await exportReferencePack({ sourceDbName, getModel });

    if (dryRun) {
        console.log("\n[dry-run] plan:");
        for (const modelName of Object.keys(pack.collections)) {
            console.log(`  ${label(modelName)} ${String(pack.collections[modelName].length).padStart(2)} se exportarían`);
        }
        console.log(`  ${label("archivo")} ${path.relative(REPO_ROOT, absolutePath)}`);
        return;
    }

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");

    printExportSummary(pack, path.relative(REPO_ROOT, absolutePath));
}

async function runImport({ targetDbName, sourceDbName, fromFile, dryRun }) {
    // There is nothing to copy into the source itself, and a silent no-op here
    // would look like a successful copy.
    if (!targetDbName) {
        throw new Error(
            "Falta la base de destino. Pasá --db-name <tienda>; la copia nunca apunta a la central por defecto."
        );
    }
    assertDbName(targetDbName);

    if (!fromFile && targetDbName === sourceDbName) {
        throw new Error("La base de destino es la misma que la de origen: no hay nada que copiar.");
    }

    console.log("Copia de datos de referencia:");
    console.log(`  desde:   ${fromFile ? path.relative(REPO_ROOT, path.resolve(REPO_ROOT, fromFile)) : sourceDbName}`);
    console.log(`  hacia:   ${targetDbName}`);
    if (dryRun) console.log("  modo:    dry-run, no se escribe nada");

    // The pack is read before connecting: a malformed file must fail without
    // touching any database.
    let pack = null;
    if (fromFile) {
        const absolutePath = path.resolve(REPO_ROOT, fromFile);
        const raw = await fs.readFile(absolutePath, "utf8");
        try {
            pack = JSON.parse(raw);
        } catch (error) {
            throw new Error(`El archivo ${fromFile} no es un JSON válido: ${error.message}`);
        }
    }

    await connect();

    const result = pack
        ? await importReferencePack({ pack, targetDbName, dryRun, getModel })
        : await copyReferenceData({ sourceDbName, targetDbName, dryRun, getModel });

    printImportSummary(result);
}

async function main() {
    const args = parseArgs(process.argv);
    const dryRun = args.has("dry-run");

    const exportPath = String(readOption(args, "export", "REFERENCE_EXPORT", ""));
    const fromFile = String(readOption(args, "from-file", "REFERENCE_FROM_FILE", ""));
    const targetDbName = String(readOption(args, "db-name", "TENANT_DB_NAME", ""));
    const sourceDbName = String(readOption(args, "from", "REFERENCE_SOURCE_DB", DB_NAME));

    if (exportPath && fromFile) {
        throw new Error("--export y --from-file no se pueden usar juntos.");
    }
    if (exportPath && targetDbName) {
        throw new Error("--export no escribe en ninguna base: quitá --db-name.");
    }
    if (sourceDbName) assertDbName(sourceDbName);

    try {
        if (exportPath) {
            await runExport({ filePath: exportPath, sourceDbName, dryRun });
        } else {
            await runImport({ targetDbName, sourceDbName, fromFile, dryRun });
        }
    } finally {
        await mongoose.disconnect();
    }
}

main().catch(async (error) => {
    console.error(`\nFAILED: ${error.message}`);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
