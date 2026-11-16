#!/usr/bin/env node
/**
 * Pre-provisions an internal SUPERADMIN inside an EXISTING store database.
 *
 * The account needs an email and a full name. Without a password it is written
 * in Mongo only: no Firebase user is created here, and the account is claimed on
 * the first Google login, when Firebase proves that the person signing in owns
 * that email address.
 *
 * With --password the account signs in with email/password instead: the password
 * lives in Firebase Auth and its firebaseUid is bound to the Mongo account right
 * away. That is what a support account needs to sign in to the Android app.
 *
 * The store must already exist: it is resolved from the central registry, which
 * is populated by provision:store. The global superadmin lives in the central
 * database and is never duplicated inside a store.
 *
 * Idempotent: re-running updates the same store user and keeps a single
 * TenantMapping. An existing firebaseUid is preserved unless --password is given
 * and Firebase returns the same uid; a different uid is refused instead of
 * re-linking the account.
 *
 * Usage:
 *   node scripts/create-store-superadmin.js --store digital-core --email soporte@digitalcore.com --name "Soporte Digital"
 *   node scripts/create-store-superadmin.js --store digital-core --email soporte@digitalcore.com --name "Soporte Digital" --password secret123
 *   node scripts/create-store-superadmin.js --db-name digital_core --email soporte@digitalcore.com --name "Soporte Digital" --dry-run
 *   STORE_SLUG=digital-core STORE_SUPERADMIN_EMAIL=soporte@digitalcore.com STORE_SUPERADMIN_NAME="Soporte Digital" npm run create:store-superadmin
 *
 * Options:
 *   --email <s>       Superadmin email (or STORE_SUPERADMIN_EMAIL, required)
 *   --name <s>        Display name (or STORE_SUPERADMIN_NAME, required)
 *   --store <slug>    Registry slug, e.g. digital-core (or STORE_SLUG)
 *   --db-name <s>     Store database, alternative to --store (or TENANT_DB_NAME)
 *   --password <s>    Firebase password, min 6 chars (or STORE_SUPERADMIN_PASSWORD)
 *   --reset-password  Update the Firebase password if the user already exists
 *   --dry-run         Print the plan without writing anything
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import dotenv from "dotenv";

import { DB_NAME } from "../src/constants.js";
import { ROLES } from "../src/constants/roles.js";
import { validateEmail, validateName } from "../src/utils/regex.js";
import { TenantMapping } from "../src/modules/tenants/tenantMapping.model.js";
import { Store } from "../src/modules/tenants/store.model.js";
// Importing the tenant connection registry also registers every model on the
// default (central) connection, which is what centralGetModel resolves.
import { getTenantModel } from "../src/modules/tenants/tenantConnection.js";
import { createStoreSuperadmin } from "../src/modules/tenants/storeAdmin.service.js";
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

const USER_ACTION = { create: "creado", update: "actualizado" };
const LINK_STATE = {
    linked: "vinculado por firebaseUid",
    preserved: "firebaseUid existente preservado",
    "pending-first-login": "pendiente del primer login"
};
const MAPPING_ACTION = { created: "creado", unchanged: "sin cambios" };

function printSummary(result) {
    console.log(result.dryRun ? "\n[dry-run] plan:" : "\nResumen:");
    console.log(`  tienda:        ${result.storeSlug}`);
    console.log(`  base de datos: ${result.dbName}`);
    console.log(`  email:         ${result.user.email}`);
    console.log(`  nombre:        ${result.user.fullName}`);
    console.log(
        `  usuario:       ${USER_ACTION[result.user.action] || result.user.action}` +
        (result.user.id ? ` (${result.user.id})` : "")
    );
    console.log(`  vínculo:       ${LINK_STATE[result.user.link] || result.user.link}`);
    console.log(
        `  mapeo:         ${MAPPING_ACTION[result.mapping.action] || result.mapping.action} ` +
        `(${result.mapping.email} -> ${result.mapping.dbName})`
    );
    if (result.user.firebaseUid) {
        console.log(`  firebase uid:  ${result.user.firebaseUid}`);
    }

    if (result.user.link === "pending-first-login") {
        console.log("\nFalta un paso:");
        console.log("  El operador debe iniciar sesión una vez con Google usando ese email");
        console.log("  para que la cuenta quede vinculada. El rol -1 solo llega al token");
        console.log("  después de ese login nuevo (si la sesión ya estaba abierta, cerrala).");
    } else if (result.user.link === "linked" && !result.dryRun) {
        console.log("\nLa cuenta ya está lista:");
        console.log(`  ${result.user.email} puede iniciar sesión con la contraseña indicada.`);
    }

    if (!result.dryRun) console.log("\nListo.");
}

async function main() {
    const args = parseArgs(process.argv);
    const dryRun = args.has("dry-run");
    const resetPassword = args.has("reset-password");

    const email = String(readOption(args, "email", "STORE_SUPERADMIN_EMAIL", "")).toLowerCase();
    const fullName = String(readOption(args, "name", "STORE_SUPERADMIN_NAME", ""));
    const storeSlug = String(readOption(args, "store", "STORE_SLUG", "")).toLowerCase();
    const requestedDbName = String(readOption(args, "db-name", "TENANT_DB_NAME", ""));
    const password = String(readOption(args, "password", "STORE_SUPERADMIN_PASSWORD", ""));

    if (!validateEmail.test(email)) {
        throw new Error("Falta un email válido. Pasá --email o definí STORE_SUPERADMIN_EMAIL.");
    }
    if (!validateName.test(fullName)) {
        throw new Error(
            `El nombre "${fullName}" no es válido. Pasá --name o definí STORE_SUPERADMIN_NAME ` +
            "(solo letras y espacios, 2 a 50 caracteres)."
        );
    }
    if (password && password.length < 6) {
        throw new Error(
            "La contraseña debe tener al menos 6 caracteres. Pasá --password o definí STORE_SUPERADMIN_PASSWORD."
        );
    }
    if (!storeSlug && !requestedDbName) {
        throw new Error(
            "Falta la tienda. Pasá --store <slug> (por ejemplo digital-core) o --db-name <base de datos>."
        );
    }
    if (storeSlug && requestedDbName) {
        throw new Error(
            "Indicá exactamente una tienda: --store <slug> o --db-name <base de datos>, no las dos."
        );
    }
    if (!process.env.MONGODB_URI) {
        throw new Error("MONGODB_URI no está definida en el archivo .env");
    }
    if (requestedDbName) assertDbName(requestedDbName);

    console.log("Superadmin de tienda:");
    console.log(`  email:  ${email}`);
    console.log(`  nombre: ${fullName}`);
    console.log(`  rol:    ${ROLES.SUPERADMIN} (interno, oculto en la app)`);
    if (storeSlug) console.log(`  tienda: ${storeSlug}`);
    else console.log(`  base de datos: ${requestedDbName}`);
    if (password) console.log("  acceso: email/contraseña (Firebase)");
    if (dryRun) console.log("  modo:   dry-run, no se escribe nada");

    // Always connect to the central database: the Store registry and
    // TenantMapping live there, and the store models are reached through the
    // tenant connection registry. Trailing slashes are trimmed so a URI ending
    // in "/" does not produce a doubled separator.
    const mongoUri = process.env.MONGODB_URI.replace(/\/+$/, "");
    await mongoose.connect(`${mongoUri}/${DB_NAME}`, {
        retryWrites: true,
        w: "majority"
    });
    console.log(`\nMongoDB conectado: ${mongoose.connection.host}`);

    // Firebase is only initialized when a password is actually provided, so a
    // run without one (the default, Google-login flow) never needs service
    // credentials.
    let firebaseAuth = null;
    const firebaseAdapter = async (payload) => {
        if (!firebaseAuth) firebaseAuth = initFirebase();
        return ensureFirebaseUser(firebaseAuth, payload);
    };

    try {
        // getTenantModel needs a concrete database name, so a slug-only run
        // resolves it from the central registry before calling the service.
        let dbName = requestedDbName;
        if (!dbName) {
            const store = await Store.findOne({ slug: storeSlug }).lean();
            if (!store) {
                throw new Error(
                    `La tienda "${storeSlug}" no está registrada en el registro central. ` +
                    "Ejecutá provision:store primero."
                );
            }
            dbName = store.dbName;
        }

        const result = await createStoreSuperadmin({
            storeSlug: storeSlug || undefined,
            dbName,
            email,
            fullName,
            StoreModel: Store,
            TenantMapping,
            centralGetModel: (modelName) => mongoose.model(modelName),
            getModel: (modelName) => getTenantModel(dbName, modelName),
            password,
            resetPassword,
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
