#!/usr/bin/env node
/**
 * Copies the reference data of the central database into a store database.
 *
 * A new store starts empty, and without units, transaction categories and
 * product categories it cannot sell anything: a sale without a transaction
 * category falls back to "Ventas POS", and Product.unit is required. Copying
 * them from the central database keeps every store consistent and saves the
 * operator from typing the same catalogue again.
 *
 * Copies: Unit, TransactionCategory, ProductCategory.
 * Does not copy: business data (products, sales, users, settings) nor the
 * central TenantMapping.
 *
 * Idempotent: documents are matched by name, so a re-run only fills the gaps
 * and never overwrites what the store already edited.
 *
 * Usage:
 *   node scripts/copy-reference-data.js --db-name tienda_norte
 *   node scripts/copy-reference-data.js --db-name tienda_norte --dry-run
 *   node scripts/copy-reference-data.js --db-name tienda_norte --from financeDB
 *
 * Options:
 *   --db-name <s>   Target store database (or TENANT_DB_NAME, required)
 *   --from <s>      Source database (or REFERENCE_SOURCE_DB, default financeDB)
 *   --dry-run       Print the plan without writing anything
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import dotenv from "dotenv";

import { DB_NAME } from "../src/constants.js";
// Importing the tenant connection registry registers every model on the default
// (central) connection, which is what the resolver reaches for DB_NAME.
import { getTenantModel } from "../src/modules/tenants/tenantConnection.js";
import { copyReferenceData } from "../src/modules/tenants/referenceData.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

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

function printSummary(result) {
    const label = (text) => `${text}:`.padEnd(22, " ");
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

async function main() {
    const args = parseArgs(process.argv);
    const dryRun = args.has("dry-run");

    const targetDbName = String(readOption(args, "db-name", "TENANT_DB_NAME", ""));
    const sourceDbName = String(readOption(args, "from", "REFERENCE_SOURCE_DB", DB_NAME));

    // There is nothing to copy into the source itself, and a silent no-op here
    // would look like a successful copy.
    if (!targetDbName) {
        throw new Error(
            "Falta la base de destino. Pasá --db-name <tienda>; la copia nunca apunta a la central por defecto."
        );
    }
    if (!process.env.MONGODB_URI) {
        throw new Error("MONGODB_URI no está definida en el archivo .env");
    }
    assertDbName(targetDbName);
    assertDbName(sourceDbName);

    if (targetDbName === sourceDbName) {
        throw new Error("La base de destino es la misma que la de origen: no hay nada que copiar.");
    }

    console.log("Copia de datos de referencia:");
    console.log(`  desde:   ${sourceDbName}`);
    console.log(`  hacia:   ${targetDbName}`);
    if (dryRun) console.log("  modo:    dry-run, no se escribe nada");

    // The central database is always the entry point: the source models live on
    // the default connection and the target is reached through the tenant
    // registry. Trailing slashes are trimmed so a URI ending in "/" does not
    // produce a doubled separator.
    const mongoUri = process.env.MONGODB_URI.replace(/\/+$/, "");
    await mongoose.connect(`${mongoUri}/${DB_NAME}`, {
        retryWrites: true,
        w: "majority"
    });
    console.log(`\nMongoDB conectado: ${mongoose.connection.host}`);

    try {
        const result = await copyReferenceData({
            sourceDbName,
            targetDbName,
            dryRun,
            getModel: (dbName, modelName) => getTenantModel(dbName, modelName)
        });

        printSummary(result);
    } finally {
        await mongoose.disconnect();
    }
}

main().catch(async (error) => {
    console.error(`\nFAILED: ${error.message}`);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
