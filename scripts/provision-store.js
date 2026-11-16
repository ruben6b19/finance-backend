#!/usr/bin/env node
/**
 * Provisions a store into its own database.
 *
 * Writes the single StoreConfig document (the row the mobile app reads from
 * GET /api/v1/store-config) and the first ADMIN user into the store database,
 * then registers the central email -> database mapping so every later request
 * from that admin is routed to the right store.
 *
 * It also registers the store in the central slug -> database registry, which
 * is what public clients use to identify the store through the X-Store header.
 *
 * Authentication is owned by Firebase. The admin is created in Firebase Auth
 * and linked in MongoDB by firebaseUid; no password is stored in MongoDB.
 *
 * Idempotent: re-running updates the same StoreConfig document and skips the
 * admin creation as soon as any ADMIN user already exists. An existing Firebase
 * user with the requested email is reused instead of duplicated, and an
 * existing non-admin Mongo user is only promoted with --force. A registered
 * database keeps its slug: it is never renamed automatically.
 *
 * Usage:
 *   node scripts/provision-store.js --db-name tienda_norte --name "Tienda Norte" --admin-email admin@example.com --admin-password secret123
 *   node scripts/provision-store.js --db-name tienda_norte --name "Tienda Norte" --slug tienda-norte --admin-email admin@example.com --admin-password secret123 --dry-run
 *   node scripts/provision-store.js --db-name tienda_norte --name "Tienda Norte" --admin-email existing@example.com --admin-password secret123 --force
 *   TENANT_DB_NAME=tienda_norte STORE_NAME="Tienda Norte" STORE_ADMIN_EMAIL=admin@example.com STORE_ADMIN_PASSWORD=secret123 npm run provision:store
 *
 * Options:
 *   --db-name <s>          Store database (or TENANT_DB_NAME, default financeDB)
 *   --name <s>             Store display name (or STORE_NAME, required)
 *   --slug <s>             Public store slug, a-z 0-9 and dashes (or STORE_SLUG, default slugify(name))
 *   --razon-social <s>     Legal name (or STORE_RAZON_SOCIAL, default "")
 *   --nit <s>              Tax id (or STORE_NIT, default "")
 *   --phone <s>            Phone (or STORE_PHONE, default "")
 *   --whatsapp <s>         WhatsApp number (or STORE_WHATSAPP, default "")
 *   --address <s>          Address (or STORE_ADDRESS, default "")
 *   --currency <s>         Currency label (or STORE_CURRENCY, default "Bs.")
 *   --ticket-footer <s>    Ticket footer text (or STORE_TICKET_FOOTER, default "¡Gracias por su preferencia!")
 *   --logo-url <s>         Logo URL (or STORE_LOGO_URL, default "")
 *   --admin-email <s>      First admin email (or STORE_ADMIN_EMAIL; required only when no admin exists)
 *   --admin-password <s>   Firebase password, min 6 chars (or STORE_ADMIN_PASSWORD; required only when no admin exists)
 *   --admin-name <s>       First admin display name (or STORE_ADMIN_NAME, default "Administrador")
 *   --reset-password       Update the Firebase password if the admin already exists in Firebase
 *   --force                Promote an existing non-admin user with that email into admin
 *   --dry-run              Print the plan without writing anything
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import dotenv from "dotenv";

import { DB_NAME } from "../src/constants.js";
import { TenantMapping } from "../src/modules/tenants/tenantMapping.model.js";
import { Store } from "../src/modules/tenants/store.model.js";
import { slugify } from "../src/modules/tenants/store.service.js";
// Importing the tenant connection registry also registers every model on the
// default (central) connection, which is what centralGetModel resolves.
import { getTenantModel } from "../src/modules/tenants/tenantConnection.js";
import { provisionStore } from "../src/modules/tenants/provisioning.service.js";
import { initFirebase, ensureFirebaseUser } from "./lib/firebase.js";

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

const STORE_ACTION = { create: "creada", update: "actualizada" };
const ADMIN_ACTION = {
    create: "creado en MongoDB y vinculado por firebaseUid",
    promote: "usuario existente convertido y vinculado por firebaseUid",
    skip: "omitido, ya existe un administrador",
    "requires-force": "requiere --force para convertir el usuario existente"
};
const MAPPING_ACTION = {
    created: "creado",
    unchanged: "sin cambios",
    skipped: "no aplica (base central)"
};
const REGISTRY_ACTION = {
    created: "creado",
    unchanged: "sin cambios",
    skipped: "no aplica (base central)"
};

function printSummary(result) {
    console.log(result.dryRun ? "\n[dry-run] plan:" : "\nResumen:");
    console.log(`  base de datos: ${result.dbName}`);
    console.log(
        `  tienda:        ${STORE_ACTION[result.store.action] || result.store.action}` +
        (result.store.id ? ` (${result.store.id})` : "")
    );
    console.log(
        `  admin:         ${ADMIN_ACTION[result.admin.action] || result.admin.action}` +
        (result.admin.email ? ` (${result.admin.email})` : "")
    );
    console.log(
        `  mapeo:         ${MAPPING_ACTION[result.mapping.action] || result.mapping.action}` +
        (result.mapping.action !== "skipped" && result.mapping.email
            ? ` (${result.mapping.email} -> ${result.mapping.dbName})`
            : "")
    );
    console.log(
        `  registro:      ${result.registry.slug} -> ${result.registry.dbName} ` +
        `(${REGISTRY_ACTION[result.registry.action] || result.registry.action})`
    );
    if (result.admin.firebaseUid) {
        console.log(`  firebase uid:  ${result.admin.firebaseUid}`);
    }
    if (!result.dryRun) console.log("\nListo.");
}

async function main() {
    const args = parseArgs(process.argv);
    const dryRun = args.has("dry-run");
    const resetPassword = args.has("reset-password");
    const force = args.has("force");

    const dbName = String(readOption(args, "db-name", "TENANT_DB_NAME", DB_NAME));
    const name = String(readOption(args, "name", "STORE_NAME", ""));
    const slug = String(readOption(args, "slug", "STORE_SLUG", slugify(name)));
    const razonSocial = String(readOption(args, "razon-social", "STORE_RAZON_SOCIAL", ""));
    const nit = String(readOption(args, "nit", "STORE_NIT", ""));
    const phone = String(readOption(args, "phone", "STORE_PHONE", ""));
    const whatsapp = String(readOption(args, "whatsapp", "STORE_WHATSAPP", ""));
    const address = String(readOption(args, "address", "STORE_ADDRESS", ""));
    const currency = String(readOption(args, "currency", "STORE_CURRENCY", "Bs."));
    const ticketFooter = String(readOption(args, "ticket-footer", "STORE_TICKET_FOOTER", "¡Gracias por su preferencia!"));
    const logoUrl = String(readOption(args, "logo-url", "STORE_LOGO_URL", ""));
    const adminEmail = String(readOption(args, "admin-email", "STORE_ADMIN_EMAIL", "")).toLowerCase();
    const adminPassword = String(readOption(args, "admin-password", "STORE_ADMIN_PASSWORD", ""));
    const adminName = String(readOption(args, "admin-name", "STORE_ADMIN_NAME", "Administrador"));

    if (!name) {
        throw new Error("Falta el nombre de la tienda. Pasá --name o definí STORE_NAME.");
    }
    if (!process.env.MONGODB_URI) {
        throw new Error("MONGODB_URI no está definida en el archivo .env");
    }
    assertDbName(dbName);

    console.log("Aprovisionamiento de tienda:");
    console.log(`  base de datos: ${dbName}`);
    console.log(`  nombre:        ${name}`);
    console.log(`  moneda:        ${currency}`);
    if (dryRun) console.log("  modo:          dry-run, no se escribe nada");

    // Always connect to the central database: TenantMapping lives there and the
    // store models are reached through the tenant connection registry. The
    // trailing slashes are trimmed so a URI ending in "/" does not produce a
    // doubled separator (the driver would read the database as "/financeDB").
    const mongoUri = process.env.MONGODB_URI.replace(/\/+$/, "");
    await mongoose.connect(`${mongoUri}/${DB_NAME}`, {
        retryWrites: true,
        w: "majority"
    });
    console.log(`\nMongoDB conectado: ${mongoose.connection.host}`);

    // Firebase is only initialized when a new admin actually has to be created,
    // so dry-runs and admin-skipping re-runs never need service credentials.
    let firebaseAuth = null;
    const firebaseAdapter = async (payload) => {
        if (!firebaseAuth) firebaseAuth = initFirebase();
        return ensureFirebaseUser(firebaseAuth, payload);
    };

    try {
        const result = await provisionStore({
            dbName,
            slug,
            store: {
                name,
                razonSocial,
                nit,
                phone,
                whatsapp,
                address,
                currency,
                ticketFooter,
                logoUrl
            },
            admin: {
                email: adminEmail,
                password: adminPassword,
                fullName: adminName,
                resetPassword,
                force
            },
            getStoreModel: (modelName) => getTenantModel(dbName, modelName),
            centralGetModel: (modelName) => mongoose.model(modelName),
            TenantMapping,
            StoreModel: Store,
            ensureFirebaseUser: firebaseAdapter,
            dryRun
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
