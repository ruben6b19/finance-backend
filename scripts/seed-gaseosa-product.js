#!/usr/bin/env node
/**
 * Creates or updates the soda product of a store: sold by UNIT, purchased by BOX.
 *
 * Model: ONE product holds the real soda inventory, denominated in units.
 * A purchase of one box converts to units via conversionFactor, and a sale
 * decrements units directly (quantity = number of units sold).
 *
 *   1 box = --units-per-box units (default 12)
 *
 * The units ("Unidad" and "Caja") and the product category are reference data:
 * they must already exist in the store database (see seed:reference). This
 * script never creates them, so a missing unit is an operator error, not
 * something to paper over with a silently different unit.
 *
 * Idempotent: re-running updates the product definition but NEVER resets stock.
 *
 * Usage:
 *   node scripts/seed-gaseosa-product.js --store digital-core
 *   node scripts/seed-gaseosa-product.js --store digital-core --price 5 --cost-price 3.5
 *   node scripts/seed-gaseosa-product.js --db-name tienda1DB --units-per-box 12 --dry-run
 *   STORE_SLUG=digital-core GASEOSA_PRICE=5 npm run seed:gaseosa
 *
 * Options:
 *   --store <slug>         Registry slug, e.g. digital-core (or STORE_SLUG)
 *   --db-name <s>          Store database, alternative to --store (or TENANT_DB_NAME)
 *   --name <s>             Product name (or GASEOSA_NAME, default "Gaseosa")
 *   --sku <s>              Product SKU (or GASEOSA_SKU, default "GASEOSA")
 *   --units-per-box <n>    Units per box, positive integer (or GASEOSA_UNITS_PER_BOX, default 12)
 *   --price <n>            Sale price per unit (or GASEOSA_PRICE, default 0)
 *   --cost-price <n>       Purchase cost per box (or GASEOSA_COST_PRICE, default 0)
 *   --opening-stock <n>    ONE-TIME unit count on create only (or GASEOSA_OPENING_STOCK, default 0)
 *   --category-name <s>    Existing category name (or GASEOSA_CATEGORY_NAME, default "Bebidas y Gaseosas")
 *   --dry-run              Print the plan without writing anything
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

const PRODUCT_TYPE_DIRECT = 2; // sellable + purchasable, and the only type whose stock is restored on void
const SELL_UNIT_NAME = "Unidad";
const PURCHASE_UNIT_NAME = "Caja";

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

function toNumber(value, fallback) {
    if (value === undefined || value === null || value === true || value === "") return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function assertDbName(dbName) {
    if (/[/\\. "$*<>:|?]/.test(dbName)) {
        throw new Error(`Nombre de base inválido: "${dbName}".`);
    }
}

const label = (text) => `${text}:`.padEnd(20, " ");

async function resolveStoreDbName(storeSlug) {
    const store = await Store.findOne({ slug: storeSlug }).lean();
    if (!store) {
        throw new Error(
            `La tienda "${storeSlug}" no está registrada en el registro central. ` +
            "Ejecutá provision:store primero."
        );
    }
    return store.dbName;
}

async function resolveUnit(Unit, name, dbName) {
    const unit = await Unit.findOne({ name }).lean();
    if (!unit) {
        throw new Error(
            `La unidad "${name}" no existe en la base "${dbName}". ` +
            `Ejecutá primero: npm run seed:reference -- --db-name ${dbName}`
        );
    }
    return unit;
}

async function resolveCategory(ProductCategory, name, dbName) {
    const category = await ProductCategory.findOne({ name }).lean();
    if (category) return category;

    const available = (await ProductCategory.find({}).sort({ name: 1 }).select("name").lean())
        .map((entry) => entry.name);
    throw new Error(
        `La categoría "${name}" no existe en la base "${dbName}". ` +
        `Disponibles: ${available.length > 0 ? available.join(", ") : "(ninguna)"}.`
    );
}

function printPayloads({ productId, sellUnit, purchaseUnit, unitsPerBox, price, costPrice }) {
    const id = productId ? String(productId) : "<id del producto>";
    const cost = String(costPrice);

    console.log("\nCompra (una caja -> unidades):");
    console.log(
        `  items: [{ product: "${id}", unit: "${purchaseUnit._id}", quantity: 1, ` +
        `conversionFactor: ${unitsPerBox}, unitPrice: ${cost}, subtotal: ${cost} }]`
    );
    console.log("  El servidor hereda conversionFactor del producto si el item no lo envía.");

    console.log("\nVenta (en unidades):");
    console.log(
        `  items: [{ product: "${id}", unit: "${sellUnit._id}", quantity: 1, ` +
        `unitPrice: ${String(price)}, subtotal: ${String(price)} }]`
    );
    console.log("  quantity = unidades vendidas; no hace falta conversionFactor.");
}

async function main() {
    const args = parseArgs(process.argv);
    const dryRun = args.get("dry-run") === true;

    const storeSlug = String(readOption(args, "store", "STORE_SLUG", "")).toLowerCase();
    const requestedDbName = String(readOption(args, "db-name", "TENANT_DB_NAME", ""));
    const name = String(readOption(args, "name", "GASEOSA_NAME", "Gaseosa"));
    const sku = String(readOption(args, "sku", "GASEOSA_SKU", "GASEOSA"));
    const categoryName = String(
        readOption(args, "category-name", "GASEOSA_CATEGORY_NAME", "Bebidas y Gaseosas")
    );

    const unitsPerBoxRaw = readOption(args, "units-per-box", "GASEOSA_UNITS_PER_BOX", 12);
    const unitsPerBox = toNumber(unitsPerBoxRaw, NaN);

    const priceRaw = readOption(args, "price", "GASEOSA_PRICE", 0);
    const price = toNumber(priceRaw, NaN);
    const costPriceRaw = readOption(args, "cost-price", "GASEOSA_COST_PRICE", 0);
    const costPrice = toNumber(costPriceRaw, NaN);
    const openingStockRaw = readOption(args, "opening-stock", "GASEOSA_OPENING_STOCK", 0);
    const openingStock = toNumber(openingStockRaw, NaN);

    if (storeSlug && requestedDbName) {
        throw new Error(
            "Indicá exactamente una tienda: --store <slug> o --db-name <base de datos>, no las dos."
        );
    }
    if (requestedDbName) assertDbName(requestedDbName);
    if (!Number.isInteger(unitsPerBox) || unitsPerBox < 1) {
        throw new Error(`--units-per-box debe ser un entero positivo, recibido "${unitsPerBoxRaw}".`);
    }
    if (!Number.isFinite(price) || price < 0) {
        throw new Error(`--price debe ser un número mayor o igual a 0, recibido "${priceRaw}".`);
    }
    if (!Number.isFinite(costPrice) || costPrice < 0) {
        throw new Error(`--cost-price debe ser un número mayor o igual a 0, recibido "${costPriceRaw}".`);
    }
    if (!Number.isFinite(openingStock) || openingStock < 0) {
        throw new Error(`--opening-stock debe ser un número mayor o igual a 0, recibido "${openingStockRaw}".`);
    }
    if (!process.env.MONGODB_URI) {
        throw new Error("MONGODB_URI no está definida en el archivo .env");
    }

    // Price and cost are only overwritten on an existing product when the
    // operator actually provided them: a bare re-run must not zero the prices.
    const priceProvided = args.get("price") !== undefined || Boolean(process.env.GASEOSA_PRICE);
    const costPriceProvided =
        args.get("cost-price") !== undefined || Boolean(process.env.GASEOSA_COST_PRICE);

    if (openingStock > 0) {
        console.warn("");
        console.warn("! --opening-stock es un conteo inicial de migración, no una compra.");
        console.warn("! No registres además una compra por esa misma mercadería: el stock se duplicaría.");
        console.warn("! Solo se aplica al crear el producto; un re-run nunca lo resetea.");
        console.warn("");
    }

    console.log("Producto gaseosa:");
    console.log(`  nombre:    ${name}`);
    console.log(`  sku:       ${sku}`);
    console.log(`  unidad:    ${SELL_UNIT_NAME} (venta)`);
    console.log(`  compra:    ${PURCHASE_UNIT_NAME} de ${unitsPerBox}`);
    if (storeSlug) console.log(`  tienda:    ${storeSlug}`);
    else console.log(`  base:      ${requestedDbName || DB_NAME}`);
    if (dryRun) console.log("  modo:      dry-run, no se escribe nada");

    // The central database is always the entry point: the Store registry lives
    // there and every store model is reached through the tenant registry.
    // Trailing slashes are trimmed so a URI ending in "/" does not produce a
    // doubled separator.
    const mongoUri = process.env.MONGODB_URI.replace(/\/+$/, "");
    await mongoose.connect(`${mongoUri}/${DB_NAME}`, {
        retryWrites: true,
        w: "majority"
    });
    console.log(`\nMongoDB conectado: ${mongoose.connection.host}`);

    try {
        const dbName = storeSlug ? await resolveStoreDbName(storeSlug) : requestedDbName || DB_NAME;

        const Product = getTenantModel(dbName, "Product");
        const Unit = getTenantModel(dbName, "Unit");
        const ProductCategory = getTenantModel(dbName, "ProductCategory");

        const sellUnit = await resolveUnit(Unit, SELL_UNIT_NAME, dbName);
        const purchaseUnit = await resolveUnit(Unit, PURCHASE_UNIT_NAME, dbName);
        const category = await resolveCategory(ProductCategory, categoryName, dbName);

        console.log("\nDatos de referencia:");
        console.log(`  unidad de venta:   ${sellUnit.name} (${sellUnit._id})`);
        console.log(`  unidad de compra:  ${purchaseUnit.name} (${purchaseUnit._id})`);
        console.log(`  categoría:         ${category.name} (${category._id})`);

        // A background index build changes the catalog and can fail an in-flight
        // transaction, so the unique SKU index is built before the first write.
        if (!dryRun) await Product.init();

        const existing = await Product.findOne({ sku });
        const description = `Sold by unit, purchased by box of ${unitsPerBox}.`;

        let productId = existing?._id;
        let stock;
        let finalPrice;
        let finalCostPrice;

        if (existing) {
            const stockBefore = existing.stock;
            const priceBefore = existing.price?.toString?.() ?? String(existing.price ?? 0);
            const costBefore = existing.costPrice?.toString?.() ?? String(existing.costPrice ?? 0);

            if (!dryRun) {
                existing.name = name;
                existing.description = description;
                existing.productType = PRODUCT_TYPE_DIRECT;
                existing.isSellable = true;
                existing.isPurchasable = true;
                existing.unit = sellUnit._id;
                existing.purchaseUnit = purchaseUnit._id;
                existing.conversionFactor = unitsPerBox;
                existing.category = category._id;
                existing.status = 1;
                if (priceProvided) existing.price = price;
                if (costPriceProvided) existing.costPrice = costPrice;
                await existing.save();
            }

            stock = stockBefore;
            finalPrice = priceProvided ? price : priceBefore;
            finalCostPrice = costPriceProvided ? costPrice : costBefore;

            console.log(`\nProducto: ${dryRun ? "se actualizaría" : "actualizado"} "${name}" (${existing._id})`);
            console.log(`  stock intacto: ${stockBefore}`);
            console.log(`  precio:        ${priceBefore} -> ${finalPrice}${priceProvided ? "" : " (sin cambios)"}`);
            console.log(`  costo:         ${costBefore} -> ${finalCostPrice}${costPriceProvided ? "" : " (sin cambios)"}`);
        } else {
            const payload = {
                name,
                description,
                productType: PRODUCT_TYPE_DIRECT,
                isSellable: true,
                isPurchasable: true,
                unit: sellUnit._id,
                purchaseUnit: purchaseUnit._id,
                conversionFactor: unitsPerBox,
                price,
                costPrice,
                stock: openingStock,
                category: category._id,
                sku,
                status: 1
            };

            stock = openingStock;
            finalPrice = price;
            finalCostPrice = costPrice;

            if (dryRun) {
                console.log(`\nProducto: se crearía "${name}"`);
                console.log(JSON.stringify(payload, null, 2));
            } else {
                const created = await Product.create(payload);
                productId = created._id;
                console.log(`\nProducto: creado "${name}" (${created._id})`);
                console.log(`  stock inicial: ${openingStock} unidades`);
            }
        }

        console.log(dryRun ? "\n[dry-run] resumen:" : "\nResumen:");
        console.log(`  ${label("tienda")} ${storeSlug || "(sin slug)"}`);
        console.log(`  ${label("base de datos")} ${dbName}`);
        console.log(`  ${label("producto")} ${productId ? String(productId) : "(nuevo)"}`);
        console.log(`  ${label("unidad de venta")} ${sellUnit.name} (${sellUnit._id})`);
        console.log(`  ${label("unidad de compra")} ${purchaseUnit.name} (${purchaseUnit._id})`);
        console.log(`  ${label("factor")} 1 ${purchaseUnit.name} = ${unitsPerBox} ${sellUnit.name}`);
        console.log(`  ${label("stock")} ${stock} ${sellUnit.name}`);
        console.log(`  ${label("precio")} ${finalPrice} por ${sellUnit.name}`);
        console.log(`  ${label("costo")} ${finalCostPrice} por ${purchaseUnit.name}`);

        printPayloads({
            productId,
            sellUnit,
            purchaseUnit,
            unitsPerBox,
            price: finalPrice,
            costPrice: finalCostPrice
        });

        if (dryRun) {
            console.log("\n[dry-run] nothing was written.");
        } else {
            console.log("\nListo.");
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
