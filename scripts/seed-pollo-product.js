#!/usr/bin/env node
/**
 * Creates the chicken stock accumulator product.
 *
 * Model: ONE product holds the real chicken inventory, denominated in "presa".
 * Purchases of whole chickens convert to presas via conversionFactor.
 * Sales decrement presas directly (quantity = number of presas sold).
 *
 *   1 whole chicken      = --presas presas (default 8)
 *   1/4 pollo            = presas / 4   (2 with the default)
 *
 * Idempotent: re-running updates the product definition but NEVER resets stock.
 *
 * Usage:
 *   node scripts/seed-pollo-product.js --price 12
 *   node scripts/seed-pollo-product.js --price 12 --opening-stock 40
 *   node scripts/seed-pollo-product.js --price 12 --dry-run
 *
 * Options:
 *   --price <n>          Price per presa (required on first run, defaults to 0)
 *   --opening-stock <n>  ONE-TIME physical count in presas for migration only.
 *                        This is NOT a purchase. Recording both this and a
 *                        purchase of the same chickens double-counts the stock.
 *   --presas <n>         Presas per whole chicken (default 8)
 *   --category <id>      ProductCategory ObjectId
 *   --sku <s>            SKU override (default POLLO-PRESA)
 *   --name <s>           Product name override (default "Pollo (presa)")
 *   --dry-run            Print the plan without writing anything
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import dotenv from "dotenv";

import { DB_NAME } from "../src/constants.js";
import { Product } from "../src/modules/products/product.model.js";
import { Unit } from "../src/modules/units/unit.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const PRODUCT_TYPE_DIRECT = 2; // sellable + purchasable, and the only type whose stock is restored on void
const UNIT_TYPE_COUNT = 2;
const UNIT_TYPE_PACKAGE = 3;

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

function toNumber(value, fallback) {
    if (value === undefined || value === true) return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

async function ensureUnit({ name, symbol, unitType, allowDecimals }, dryRun) {
    const existing = await Unit.findOne({ name });
    if (existing) {
        console.log(`  = unit "${name}" already exists (${existing._id})`);
        return existing;
    }
    if (dryRun) {
        console.log(`  + unit "${name}" would be created`);
        return { _id: new mongoose.Types.ObjectId(), name };
    }
    const created = await Unit.create({
        name,
        symbol,
        unitType,
        allowDecimals,
        status: 1
    });
    console.log(`  + unit "${name}" created (${created._id})`);
    return created;
}

async function main() {
    const args = parseArgs(process.argv);

    const presasPerChicken = toNumber(args.get("presas"), 8);
    const openingStock = toNumber(args.get("opening-stock"), 0);
    const price = toNumber(args.get("price"), 0);
    const sku = typeof args.get("sku") === "string" ? args.get("sku") : "POLLO-PRESA";
    const name = typeof args.get("name") === "string" ? args.get("name") : "Pollo (presa)";
    const category = typeof args.get("category") === "string" ? args.get("category") : null;
    const dryRun = args.get("dry-run") === true;

    if (!Number.isInteger(presasPerChicken) || presasPerChicken < 1) {
        throw new Error(`--presas must be a positive integer, got "${args.get("presas")}"`);
    }
    if (openingStock < 0) {
        throw new Error("--opening-stock cannot be negative");
    }
    if (category && !mongoose.Types.ObjectId.isValid(category)) {
        throw new Error(`--category is not a valid ObjectId: "${category}"`);
    }
    if (args.get("price") === undefined) {
        console.warn("! --price not provided, falling back to 0. Set the real per-presa price.");
    }
    if (openingStock > 0) {
        console.warn("");
        console.warn("! --opening-stock is a ONE-TIME migration count, not a purchase.");
        console.warn("! Do NOT also register a purchase for those same chickens: stock would double.");
        console.warn("! After today, stock must only move through POST /api/v1/purchases and sales.");
        console.warn("");
    }

    const uri = `${process.env.MONGODB_URI}/${DB_NAME}`;
    if (!process.env.MONGODB_URI) {
        throw new Error("MONGODB_URI is not defined in .env");
    }

    console.log(`\nConnecting to ${DB_NAME}...`);
    await mongoose.connect(uri, { retryWrites: true, w: "majority" });
    console.log("Connected.\n");

    console.log("Units:");
    const presaUnit = await ensureUnit({
        name: "presa",
        symbol: "pza",
        unitType: UNIT_TYPE_COUNT,
        allowDecimals: false
    }, dryRun);
    const wholeChickenUnit = await ensureUnit({
        name: "pollo entero",
        symbol: "pollo",
        unitType: UNIT_TYPE_PACKAGE,
        allowDecimals: false
    }, dryRun);

    console.log("\nProduct:");
    const existing = await Product.findOne({ sku });

    if (existing) {
        const before = {
            stock: existing.stock,
            price: existing.price?.toString?.() ?? existing.price
        };

        if (!dryRun) {
            existing.name = name;
            existing.productType = PRODUCT_TYPE_DIRECT;
            existing.isSellable = true;
            existing.isPurchasable = true;
            existing.unit = presaUnit._id;
            existing.purchaseUnit = wholeChickenUnit._id;
            existing.conversionFactor = presasPerChicken;
            existing.status = 1;
            if (category) existing.category = category;
            if (args.get("price") !== undefined) existing.price = price;
            await existing.save();
        }

        console.log(`  ~ updated existing product "${name}" (${existing._id})`);
        console.log(`    stock untouched: ${before.stock}`);
        console.log(`    price: ${before.price} -> ${existing.price?.toString?.() ?? price}`);
    } else {
        const payload = {
            name,
            description: "Whole chicken portioned in-house. Stock is kept in presas.",
            productType: PRODUCT_TYPE_DIRECT,
            isSellable: true,
            isPurchasable: true,
            unit: presaUnit._id,
            purchaseUnit: wholeChickenUnit._id,
            conversionFactor: presasPerChicken,
            price,
            costPrice: 0,
            stock: openingStock,
            category,
            sku,
            status: 1
        };

        if (dryRun) {
            console.log("  + would create:");
            console.log(JSON.stringify(payload, null, 2));
        } else {
            const created = await Product.create(payload);
            console.log(`  + created product "${name}" (${created._id})`);
            console.log(`    opening stock: ${openingStock} presas`);
        }
    }

    console.log("\nResulting model:");
    console.log(`  1 pollo entero  = ${presasPerChicken} presas`);
    console.log(`  1/4 pollo       = ${presasPerChicken / 4} presas per unit sold`);
    console.log(`  conversionFactor to use when purchasing = ${presasPerChicken}`);
    console.log("\nSales must send quantity = number of presas sold.");
    console.log("e.g. 1/4 pollo -> quantity: " + presasPerChicken / 4 + ", pollo entero -> quantity: " + presasPerChicken);

    if (dryRun) {
        console.log("\n[dry-run] nothing was written.");
    }
}

main()
    .then(async () => {
        await mongoose.disconnect();
        process.exit(0);
    })
    .catch(async (error) => {
        console.error(`\nFAILED: ${error.message}`);
        await mongoose.disconnect().catch(() => {});
        process.exit(1);
    });
