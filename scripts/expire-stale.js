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
 * Usage:
 *   node scripts/expire-stale.js
 *   node scripts/expire-stale.js --dry-run
 *
 * Options:
 *   --dry-run   Report what would expire without writing anything.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import dotenv from "dotenv";

import { DB_NAME } from "../src/constants.js";
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

async function main() {
    const args = parseArgs(process.argv);
    const dryRun = args.get("dry-run") === true || args.get("dry-run") === "true";

    if (!process.env.MONGODB_URI) {
        throw new Error("MONGODB_URI is not defined in .env");
    }

    // Only the database name is printed, never the URI with credentials.
    console.log(`\nConnecting to ${DB_NAME}...`);

    try {
        await mongoose.connect(`${process.env.MONGODB_URI}/${DB_NAME}`, {
            retryWrites: true,
            w: "majority"
        });

        const { ranAt, reservations, vouchers } = await runExpirySweep({ dryRun });

        console.log(`\nExpiry sweep at ${ranAt.toISOString()}${dryRun ? " (dry-run)" : ""}`);
        console.log(`  reservations: matched ${reservations.matched}, modified ${reservations.modified}`);
        console.log(`  vouchers:     matched ${vouchers.matched}, modified ${vouchers.modified}`);
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
