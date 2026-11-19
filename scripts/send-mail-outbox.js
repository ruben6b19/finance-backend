#!/usr/bin/env node
/**
 * Delivers queued order-status emails from every tenant outbox.
 *
 * Cron-friendly: no prompts, no server boot. The worker claims entries with an
 * atomic pending -> processing update, so several runs can safely overlap and
 * no email is delivered twice. A failure in one database does not stop the
 * others; the script exits non-zero if any target failed.
 *
 * Usage:
 *   node scripts/send-mail-outbox.js
 *   node scripts/send-mail-outbox.js --dry-run
 *   node scripts/send-mail-outbox.js --db-name tienda_norte
 *
 * Options:
 *   --db-name <s>   Deliver only this tenant (default: central + every store)
 *   --dry-run       Report the targets and due entries without sending anything.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import dotenv from "dotenv";

import { DB_NAME } from "../src/constants.js";
import { STATUS } from "../src/constants/roles.js";
import { Store } from "../src/modules/tenants/store.model.js";
import { TenantMapping } from "../src/modules/tenants/tenantMapping.model.js";
import { getTenantModel } from "../src/modules/tenants/tenantConnection.js";
import { runMailOutboxSweep } from "../src/modules/notifications/mailOutbox.worker.js";

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
    const [activeStores, mapped] = await Promise.all([
        Store.find({ status: STATUS.ACTIVE }).select("dbName").lean(),
        TenantMapping.distinct("dbName")
    ]);
    return [...new Set([
        DB_NAME,
        ...mapped,
        ...activeStores.map((store) => store.dbName)
    ])];
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
        const getModelFor = (dbName, name) => getTenantModel(dbName, name);

        console.log(`Sweeping ${targets.length} database(s): ${targets.join(", ")}`);

        if (dryRun) {
            const now = new Date();
            for (const dbName of targets) {
                try {
                    const due = await getModelFor(dbName, "MailOutbox").countDocuments({
                        status: "pending",
                        nextAttemptAt: { $lte: now }
                    });
                    console.log(`  ${dbName}: ${due} due pending entr${due === 1 ? "y" : "ies"}`);
                } catch (error) {
                    console.error(`  ${dbName}: FAILED to inspect: ${error.message}`);
                }
            }
            console.log("\n[dry-run] nothing was sent.");
            return;
        }

        const summary = await runMailOutboxSweep({ targets, getModelFor });

        for (const entry of summary.perTarget) {
            console.log(
                `\n[${entry.dbName}] claimed ${entry.claimed}, sent ${entry.sent}, ` +
                `retried ${entry.retried}, failed ${entry.failed}` +
                (entry.error ? `, error: ${entry.error}` : "")
            );
        }
        console.log(
            `\nSweep complete: ${summary.sent} sent, ${summary.retried} retried, ` +
            `${summary.failed} failed across ${summary.scannedTargets} database(s).`
        );

        const failures = summary.perTarget.filter((entry) => entry.error);
        if (failures.length > 0) {
            throw new Error(
                `Outbox sweep failed for ${failures.length} database(s): ` +
                failures.map((entry) => entry.dbName).join(", ")
            );
        }
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
