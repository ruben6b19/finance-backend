#!/usr/bin/env node
/**
 * Creates the "Combo de Agua" product and its combo definition.
 *
 * Model: a combo product (productType 3) holds no stock of its own. Its
 * ComboDefinition lists the components, and every unit sold issues one
 * voucher with the component balances frozen at purchase time.
 *
 *   1 combo = 5 x "Agua Mineral 500ml" for 20 Bs, no expiry.
 *
 * Idempotent: re-running reuses the combo product, updates the definition and
 * replaces the component list. Stock is never touched (combos hold none).
 *
 * Usage:
 *   node scripts/create-agua-combo.js --dry-run
 *   node scripts/create-agua-combo.js
 *
 * Options:
 *   --source-product <id>  Bottled water product to bundle (required)
 *   --price <n>            Combo price (default 20)
 *   --cost-price <n>       Combo cost (default 0: combos do not carry cost;
 *                          the real cost lives in the component stock movement)
 *   --quantity <n>         Bottles included per combo (default 5)
 *   --name <s>             Combo product name (default "Combo de Agua")
 *   --dry-run              Print the plan without writing anything
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import dotenv from "dotenv";

import { DB_NAME } from "../src/constants.js";
import { Product } from "../src/modules/products/product.model.js";
import { ComboDefinition } from "../src/modules/combos/comboDefinition.model.js";
import { ComboComponent } from "../src/modules/combos/comboComponent.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const PRODUCT_TYPE_COMBO = 3;
const DEFAULT_SOURCE_PRODUCT = "6a754056dc4b7fdd5ef978a7"; // Agua Mineral 500ml
const DEFAULT_PRICE = 20;
const DEFAULT_COST_PRICE = 0;
const DEFAULT_QUANTITY = 5;
const DEFAULT_NAME = "Combo de Agua";

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

const round2 = (value) => Math.round(value * 100) / 100;
const toNumberFromDecimal = (value) => (value && typeof value.toString === "function" ? Number(value.toString()) : Number(value));

async function main() {
    const args = parseArgs(process.argv);

    const sourceProductId = typeof args.get("source-product") === "string"
        ? args.get("source-product")
        : DEFAULT_SOURCE_PRODUCT;
    const price = toNumber(args.get("price"), DEFAULT_PRICE);
    const costPrice = toNumber(args.get("cost-price"), DEFAULT_COST_PRICE);
    const quantity = toNumber(args.get("quantity"), DEFAULT_QUANTITY);
    const name = typeof args.get("name") === "string" ? args.get("name") : DEFAULT_NAME;
    const dryRun = args.get("dry-run") === true;

    if (!mongoose.Types.ObjectId.isValid(sourceProductId)) {
        throw new Error(`--source-product is not a valid ObjectId: "${sourceProductId}"`);
    }
    if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`--price must be greater than zero, got "${args.get("price")}"`);
    }
    if (!Number.isFinite(costPrice) || costPrice < 0) {
        throw new Error(`--cost-price must be zero or greater, got "${args.get("cost-price")}"`);
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error(`--quantity must be greater than zero, got "${args.get("quantity")}"`);
    }

    if (!process.env.MONGODB_URI) {
        throw new Error("MONGODB_URI is not defined in .env");
    }

    console.log(`\nConnecting to ${DB_NAME}...`);
    await mongoose.connect(`${process.env.MONGODB_URI}/${DB_NAME}`, { retryWrites: true, w: "majority" });
    console.log("Connected.\n");

    const sourceProduct = await Product.findById(sourceProductId);
    if (!sourceProduct) {
        throw new Error(`source product ${sourceProductId} not found`);
    }
    if (sourceProduct.productType === PRODUCT_TYPE_COMBO) {
        throw new Error(`source product ${sourceProductId} is itself a combo; nesting is not allowed`);
    }

    const sourcePrice = toNumberFromDecimal(sourceProduct.price);
    const referencePrice = round2(sourcePrice * quantity);

    console.log("Source component:");
    console.log(`  ${sourceProduct.name} (${sourceProduct._id}) x ${quantity} @ ${sourcePrice} = ${referencePrice}`);

    console.log("\nCombo product:");
    const existingCombo = await Product.findOne({ name });
    let comboProduct = existingCombo;

    const comboPayload = {
        name,
        description: `${quantity} aguas minerales de 500 ml por ${price} Bs. Puedes recogerlo cuando quieras.`,
        productType: PRODUCT_TYPE_COMBO,
        isSellable: true,
        isPurchasable: false,
        price,
        costPrice,
        stock: 0,
        unit: sourceProduct.unit,
        purchaseUnit: null,
        conversionFactor: 1,
        category: sourceProduct.category || null,
        status: 1
    };

    if (existingCombo) {
        if (!dryRun) {
            Object.assign(existingCombo, comboPayload);
            await existingCombo.save();
        }
        console.log(`  ~ updated existing product "${name}" (${existingCombo._id})`);
    } else if (dryRun) {
        console.log("  + would create:");
        console.log(JSON.stringify(comboPayload, null, 2));
    } else {
        comboProduct = await Product.create(comboPayload);
        console.log(`  + created product "${name}" (${comboProduct._id})`);
    }

    console.log("\nCombo definition:");
    const definitionPayload = {
        referencePrice,
        validityDays: 0, // 0 => the voucher never expires
        graceDays: 0,
        allowSubstitution: false,
        terms: `Incluye ${quantity} aguas. Puedes recogerlo cuando quieras.`,
        status: 1
    };

    let definition = comboProduct && comboProduct._id
        ? await ComboDefinition.findOne({ product: comboProduct._id })
        : null;

    if (dryRun) {
        console.log("  + would upsert definition:");
        console.log(JSON.stringify(definitionPayload, null, 2));
    } else if (definition) {
        Object.assign(definition, definitionPayload);
        await definition.save();
        console.log(`  ~ updated definition ${definition._id}`);
    } else {
        definition = await ComboDefinition.create({ ...definitionPayload, product: comboProduct._id });
        console.log(`  + created definition ${definition._id}`);
    }

    console.log("\nComponents:");
    const components = [{
        product: sourceProduct._id,
        quantity,
        label: sourceProduct.name,
        // Bottled product: redeeming the voucher decrements its real stock.
        stockProduct: sourceProduct._id,
        conversionFactor: 1
    }];

    if (dryRun) {
        console.log("  + would replace components with:");
        console.log(JSON.stringify(components, null, 2));
        console.log("\n[dry-run] nothing was written.");
        return;
    }

    await ComboComponent.deleteMany({ combo: definition._id });
    const created = await ComboComponent.insertMany(components.map((component) => ({ ...component, combo: definition._id })));
    for (const component of created) {
        console.log(`  + ${component.quantity} x ${component.label} (stock from ${component.stockProduct})`);
    }

    console.log("\nResulting model:");
    console.log(`  1 combo = ${quantity} x ${sourceProduct.name}`);
    console.log(`  price ${price} Bs (catalog reference ${referencePrice} Bs)`);
    console.log("  vouchers never expire; redeeming decrements the bottle stock.");
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
