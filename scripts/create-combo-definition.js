#!/usr/bin/env node
/**
 * Creates (or updates) the ComboDefinition and its ComboComponents for an
 * existing combo product (productType 3). Combo products created through the
 * products API have no definition, so ordering them fails with
 * "error_order_combo_unavailable" until this is run.
 *
 * Usage:
 *   node scripts/create-combo-definition.js \
 *     --db-name tienda1DB \
 *     --combo-product 6afb6f535523bef277c84485 \
 *     --component 6afa7eed9f89027fffbc3d21:5
 *
 * Repeat --component for every product in the combo. The value after ":" is
 * the quantity included per combo unit; when omitted it defaults to 1.
 * Idempotent: re-running updates the definition and replaces its components.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import dotenv from "dotenv";

import { Product } from "../src/modules/products/product.model.js";
import { ComboDefinition } from "../src/modules/combos/comboDefinition.model.js";
import { ComboComponent } from "../src/modules/combos/comboComponent.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const PRODUCT_TYPE_COMBO = 3;

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

function toNumber(value) {
    const n = Number(value && typeof value.toString === "function" ? value.toString() : value);
    return Number.isFinite(n) ? n : 0;
}

const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

async function main() {
    const args = parseArgs(process.argv);
    const dbName = typeof args.get("db-name") === "string" ? args.get("db-name") : "";
    const comboProductId = typeof args.get("combo-product") === "string" ? args.get("combo-product") : "";
    const dryRun = args.get("dry-run") === true;

    if (!dbName) throw new Error("Falta --db-name.");
    if (!mongoose.Types.ObjectId.isValid(comboProductId)) {
        throw new Error(`--combo-product no es un ObjectId válido: "${comboProductId}"`);
    }

    const rawComponents = [];
    for (let i = 2; i < process.argv.length; i += 1) {
        if (process.argv[i] === "--component") {
            const value = process.argv[i + 1];
            if (typeof value === "string") rawComponents.push(value);
            i += 1;
        } else if (process.argv[i].startsWith("--component=")) {
            rawComponents.push(process.argv[i].slice("--component=".length));
        }
    }

    if (rawComponents.length === 0) {
        throw new Error("Falta al menos un --component <productId>[:quantity].");
    }

    const components = rawComponents.map((raw) => {
        const [productId, rawQuantity] = raw.split(":");
        if (!mongoose.Types.ObjectId.isValid(productId)) {
            throw new Error(`Componente inválido: "${raw}"`);
        }
        const quantity = rawQuantity === undefined ? 1 : Number(rawQuantity);
        if (!Number.isFinite(quantity) || quantity <= 0) {
            throw new Error(`Cantidad inválida en "${raw}"`);
        }
        return { product: productId, quantity };
    });

    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI no está definida en .env.");

    const mongoUri = process.env.MONGODB_URI.replace(/\/+$/, "");
    await mongoose.connect(`${mongoUri}/${dbName}`, { retryWrites: true, w: "majority" });
    console.log(`Conectado a ${dbName}.`);

    const comboProduct = await Product.findById(comboProductId);
    if (!comboProduct) throw new Error(`Producto combo ${comboProductId} no existe.`);
    if (comboProduct.productType !== PRODUCT_TYPE_COMBO) {
        throw new Error("El producto indicado no es de tipo combo (productType 3).");
    }

    const productIds = components.map((c) => c.product);
    const products = await Product.find({ _id: { $in: productIds } });
    const productMap = new Map(products.map((p) => [String(p._id), p]));
    for (const component of components) {
        if (!productMap.has(component.product)) {
            throw new Error(`Componente ${component.product} no existe.`);
        }
    }

    const referencePrice = round2(
        components.reduce((sum, c) => sum + toNumber(productMap.get(c.product).price) * c.quantity, 0),
    );

    console.log(`\nCombo: ${comboProduct.name} (${comboProduct._id}) precio ${toNumber(comboProduct.price)}`);
    for (const c of components) {
        const p = productMap.get(c.product);
        console.log(`  ${c.quantity} x ${p.name} (${p._id}) @ ${toNumber(p.price)} = ${round2(toNumber(p.price) * c.quantity)}`);
    }
    console.log(`  precio de referencia: ${referencePrice}`);

    if (dryRun) {
        console.log("\n[dry-run] nada fue escrito.");
        return;
    }

    let definition = await ComboDefinition.findOne({ product: comboProductId });
    if (definition) {
        definition.referencePrice = referencePrice;
        definition.status = 1;
        await definition.save();
        console.log(`\n~ definición actualizada: ${definition._id}`);
    } else {
        definition = await ComboDefinition.create({
            product: comboProductId,
            referencePrice,
            validityDays: 0,
            graceDays: 0,
            allowSubstitution: false,
            terms: '',
            status: 1,
        });
        console.log(`\n+ definición creada: ${definition._id}`);
    }

    await ComboComponent.deleteMany({ combo: definition._id });
    const created = await ComboComponent.insertMany(
        components.map((c) => ({
            combo: definition._id,
            product: c.product,
            quantity: c.quantity,
            label: productMap.get(c.product).name,
            stockProduct: c.product,
            conversionFactor: 1,
        })),
    );
    console.log(`+ ${created.length} componente(s) creado(s).`);
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
