#!/usr/bin/env node
/**
 * Seeds the chicken menu in one tenant database.
 *
 * The store buys whole chickens and portions them in-house. One whole chicken
 * yields 8 presas, and the real inventory lives in a single hidden accumulator
 * product (POLLO-PRESA) denominated in presas. The three sellable presentations
 * do not hold stock: each one declares the accumulator as `stockProduct` and
 * how many presas a sale consumes through `stockConversionFactor`. Sales that
 * only send product and quantity are resolved by the server.
 *
 * Units ("presa" and "pollo entero") are reference data and must already exist
 * in the target database. They are matched by exact name: Unit.name is unique,
 * so a case mismatch must fail instead of creating a duplicate unit.
 *
 * Idempotent: re-running updates the product definitions but NEVER resets
 * stock. Prices are only overwritten when their CLI flag is provided.
 *
 * Usage:
 *   node scripts/seed-chicken-products.js --store digital-core
 *   node scripts/seed-chicken-products.js --db-name tienda1DB --price-entero 85
 *   node scripts/seed-chicken-products.js --store digital-core --dry-run
 *   STORE_SLUG=digital-core npm run seed:pollo-menu
 *
 * Options:
 *   --store <slug>          Registry slug, e.g. digital-core (or STORE_SLUG)
 *   --db-name <name>        Store database, alternative to --store (or TENANT_DB_NAME)
 *   --price-entero <n>      Pollo Entero price (default 80)
 *   --price-cuarto <n>      Cuarto de Pollo price (default 25)
 *   --price-presa <n>       Plato Económico price (default 17)
 *   --dry-run               Print the plan without writing anything
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import dotenv from "dotenv";

import { DB_NAME } from "../src/constants.js";
import { Store } from "../src/modules/tenants/store.model.js";
// Importing the tenant connection registry also registers every model on the
// default (central) connection, which is what DB_NAME resolves to.
import { getTenantModel } from "../src/modules/tenants/tenantConnection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const PRESA_UNIT_NAME = "presa";
const WHOLE_CHICKEN_UNIT_NAME = "pollo entero";

const PRODUCT_TYPE_FINAL = 1;
const PRODUCT_TYPE_DIRECT = 2;

const ACCUMULATOR = {
    sku: "POLLO-PRESA",
    name: "Pollo (presa)",
    description: "Whole chicken inventory in presas. Hidden from the catalog."
};

const PRESENTATIONS = [
    {
        key: "entero",
        flag: "price-entero",
        defaultPrice: 80,
        sku: "POLLO-ENTERO",
        name: "Pollo Entero",
        stockConversionFactor: 8
    },
    {
        key: "cuarto",
        flag: "price-cuarto",
        defaultPrice: 25,
        sku: "POLLO-CUARTO",
        name: "Cuarto de Pollo",
        stockConversionFactor: 2
    },
    {
        key: "presa",
        flag: "price-presa",
        defaultPrice: 17,
        sku: "PLATO-ECONOMICO",
        name: "Plato Económico",
        stockConversionFactor: 1
    }
];

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

function toNumber(value) {
    if (value === undefined || value === null || value === true || value === "") return NaN;
    const number = Number(value);
    return Number.isFinite(number) ? number : NaN;
}

function assertDbName(dbName) {
    if (/[/\\. "$*<>:|?]/.test(dbName)) {
        throw new Error(`Invalid database name: "${dbName}".`);
    }
}

async function resolveStoreDbName(storeSlug) {
    const store = await Store.findOne({ slug: storeSlug }).lean();
    if (!store) {
        throw new Error(
            `Store "${storeSlug}" is not registered in the central registry. ` +
            "Run provision:store first."
        );
    }
    return store.dbName;
}

async function resolveUnit(Unit, name, dbName) {
    const unit = await Unit.findOne({ name }).lean();
    if (!unit) {
        throw new Error(
            `Unit "${name}" is missing from database "${dbName}". ` +
            `Run: npm run seed:reference -- --db-name ${dbName}`
        );
    }
    return unit;
}

const displayPrice = (value) => value?.toString?.() ?? String(value ?? 0);

async function upsertProduct({ Product, definition, fields, createFields = {}, price, priceProvided, dryRun }) {
    const existing = await Product.findOne({ sku: definition.sku });
    const stockBefore = existing?.stock ?? 0;

    if (existing) {
        const priceBefore = displayPrice(existing.price);
        if (!dryRun) {
            Object.assign(existing, fields);
            if (priceProvided) existing.price = price;
            await existing.save();
        }
        console.log(`  ${dryRun ? "would update" : "updated"} "${definition.name}" (${existing._id})`);
        console.log(`    stock untouched: ${stockBefore}`);
        console.log(`    price: ${priceBefore} -> ${displayPrice(priceProvided ? price : existing.price)}` +
            `${priceProvided ? "" : " (unchanged)"}`);
        return { id: existing._id, created: false };
    }

    const payload = {
        name: definition.name,
        description: definition.description,
        sku: definition.sku,
        stock: 0,
        ...createFields,
        ...fields,
        price
    };

    if (dryRun) {
        console.log(`  would create "${definition.name}":`);
        console.log(JSON.stringify(payload, null, 2));
        return { id: null, created: true };
    }

    const created = await Product.create(payload);
    console.log(`  created "${definition.name}" (${created._id})`);
    console.log(`    initial stock: 0`);
    console.log(`    price: ${displayPrice(price)}`);
    return { id: created._id, created: true };
}

async function main() {
    const args = parseArgs(process.argv);
    const dryRun = args.get("dry-run") === true;

    const storeSlug = String(readOption(args, "store", "STORE_SLUG", "")).toLowerCase();
    const requestedDbName = String(readOption(args, "db-name", "TENANT_DB_NAME", ""));

    if (storeSlug && requestedDbName) {
        throw new Error("Provide exactly one store: --store <slug> or --db-name <name>, not both.");
    }
    if (requestedDbName) assertDbName(requestedDbName);
    if (!process.env.MONGODB_URI) {
        throw new Error("MONGODB_URI is not defined in .env");
    }

    const prices = new Map();
    for (const presentation of PRESENTATIONS) {
        const raw = args.get(presentation.flag);
        const price = toNumber(raw === undefined ? presentation.defaultPrice : raw);
        if (!Number.isFinite(price) || price < 0) {
            throw new Error(`--${presentation.flag} must be a number >= 0, got "${raw}".`);
        }
        prices.set(presentation.key, { price, provided: raw !== undefined });
    }

    console.log("Chicken menu:");
    console.log(`  accumulator: ${ACCUMULATOR.sku} (1 whole chicken = 8 presas)`);
    for (const presentation of PRESENTATIONS) {
        const { price, provided } = prices.get(presentation.key);
        console.log(`  ${presentation.sku}: ${displayPrice(price)}` +
            `${provided ? "" : " (default)"}`);
    }
    if (storeSlug) console.log(`  store: ${storeSlug}`);
    else console.log(`  database: ${requestedDbName || DB_NAME}`);
    if (dryRun) console.log("  mode: dry-run, nothing will be written");

    const mongoUri = process.env.MONGODB_URI.replace(/\/+$/, "");
    await mongoose.connect(`${mongoUri}/${DB_NAME}`, {
        retryWrites: true,
        w: "majority"
    });
    console.log(`\nConnected to MongoDB: ${mongoose.connection.host}`);

    try {
        const dbName = storeSlug ? await resolveStoreDbName(storeSlug) : requestedDbName || DB_NAME;
        const Product = getTenantModel(dbName, "Product");
        const Unit = getTenantModel(dbName, "Unit");

        const presaUnit = await resolveUnit(Unit, PRESA_UNIT_NAME, dbName);
        const wholeChickenUnit = await resolveUnit(Unit, WHOLE_CHICKEN_UNIT_NAME, dbName);

        console.log("\nReference units:");
        console.log(`  sale unit:    ${presaUnit.name} (${presaUnit._id})`);
        console.log(`  purchase unit: ${wholeChickenUnit.name} (${wholeChickenUnit._id})`);

        // Building the unique SKU index before the first write avoids a
        // background catalog change during this batch of upserts.
        if (!dryRun) await Product.init();

        console.log("\nProducts:");
        const accumulator = await upsertProduct({
            Product,
            definition: ACCUMULATOR,
            fields: {
                productType: PRODUCT_TYPE_DIRECT,
                isSellable: false,
                isPurchasable: true,
                unit: presaUnit._id,
                purchaseUnit: wholeChickenUnit._id,
                conversionFactor: 8,
                status: 0
            },
            createFields: { costPrice: 0 },
            price: 0,
            priceProvided: false,
            dryRun
        });

        const accumulatorId = accumulator.id ?? new mongoose.Types.ObjectId();

        for (const presentation of PRESENTATIONS) {
            const { price, provided } = prices.get(presentation.key);
            await upsertProduct({
                Product,
                definition: presentation,
                fields: {
                    description: `Sold by presa; consumes ${presentation.stockConversionFactor} presa${presentation.stockConversionFactor === 1 ? "" : "s"} per unit.`,
                    productType: PRODUCT_TYPE_FINAL,
                    isSellable: true,
                    isPurchasable: false,
                    unit: presaUnit._id,
                    purchaseUnit: null,
                    conversionFactor: 1,
                    stockProduct: accumulatorId,
                    stockConversionFactor: presentation.stockConversionFactor,
                    status: 1
                },
                price,
                priceProvided: provided,
                dryRun
            });
        }

        console.log("\nSummary:");
        console.log(`  database:     ${dbName}`);
        console.log(`  accumulator:  ${String(accumulatorId)}`);
        console.log(`  1 whole chicken = 8 presas`);
        console.log("  Sales of the three presentations decrement the accumulator by 8, 2 and 1 presas.");
        console.log(dryRun ? "\n[dry-run] nothing was written." : "\nDone.");
    } finally {
        await mongoose.disconnect();
    }
}

main().catch(async (error) => {
    console.error(`\nFAILED: ${error.message}`);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
