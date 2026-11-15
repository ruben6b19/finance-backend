#!/usr/bin/env node
/**
 * Expires reservations and combo vouchers whose term has fully elapsed.
 *
 * Cron-friendly: no prompts, no server boot, and it never moves stock or money.
 * It only flips status 0 -> 2 on the expired promises, so it is idempotent and
 * safe to run on a schedule or several times in a row.
 *
 * Reservations expire when `expiresAt <= now`.
 * Vouchers expire only strictly past `expiresAt + graceDays`, matching the
 * redemption window.
 *
 * Every store keeps its promises in its own database, so by default the sweep
 * runs over the central database plus every database registered in the central
 * TenantMapping. A failure in one database does not stop the others; the script
 * exits non-zero if any database failed.
 *
 * Usage:
 *   node scripts/expire-stale.js
 *   node scripts/expire-stale.js --dry-run
 *   node scripts/expire-stale.js --db-name tienda_norte
 *
 * Options:
 *   --db-name <s>   Sweep only this database (default: central + every mapped store)
 *   --dry-run       Report what would expire without writing anything.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import dotenv from "dotenv";

import { DB_NAME } from "../src/constants.js";
import { TenantMapping } from "../src/modules/tenants/tenantMapping.model.js";
import { getTenantModel } from "../src/modules/tenants/tenantConnection.js";
import { runExpirySweep } from "../src/modules/maintenance/expiry.service.js";

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

async function resolveTargets(requestedDbName) {
    if (requestedDbName) return [requestedDbName];
    const mapped = await TenantMapping.distinct("dbName");
    return [...new Set([DB_NAME, ...mapped])];
}

async function main() {
    const args = parseArgs(process.argv);
    const dryRun = args.get("dry-run") === true || args.get("dry-run") === "true";
    const requestedDbName = typeof args.get("db-name") === "string"
        ? args.get("db-name").trim()
        : "";

    if (!process.env.MONGODB_URI) {
        throw new Error("MONGODB_URI is not defined in .env");
    }

    // Only the database name is printed, never the URI with credentials.
    console.log(`\nConnecting to ${DB_NAME}...`);

    try {
        // Trailing slashes are trimmed so a URI ending in "/" does not produce a
        // doubled separator that the driver would read as "/financeDB".
        const mongoUri = process.env.MONGODB_URI.replace(/\/+$/, "");
        await mongoose.connect(`${mongoUri}/${DB_NAME}`, {
            retryWrites: true,
            w: "majority"
        });

        const targets = await resolveTargets(requestedDbName);
        const now = new Date();
        const failures = [];

        console.log(`Sweeping ${targets.length} database(s): ${targets.join(", ")}`);

        for (const dbName of targets) {
            const getModel = (modelName) => getTenantModel(dbName, modelName);

            try {
                const { ranAt, reservations, vouchers } = await runExpirySweep({
                    now,
                    dryRun,
                    getModel
                });

                console.log(`\n[${dbName}] sweep at ${ranAt.toISOString()}${dryRun ? " (dry-run)" : ""}`);
                console.log(`  reservations: matched ${reservations.matched}, modified ${reservations.modified}`);
                console.log(`  vouchers:     matched ${vouchers.matched}, modified ${vouchers.modified}`);
            } catch (error) {
                failures.push({ dbName, message: error.message });
                console.error(`\n[${dbName}] FAILED: ${error.message}`);
            }
        }

        if (failures.length > 0) {
            throw new Error(
                `Sweep failed for ${failures.length} database(s): ${failures.map((failure) => failure.dbName).join(", ")}`
            );
        }

        console.log(dryRun ? "\n[dry-run] nothing was written." : "\nSweep complete.");
    } finally {
        await mongoose.disconnect().catch(() => {});
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(`\nFAILED: ${error.message}`);
        process.exit(1);
    });
