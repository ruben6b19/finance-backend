#!/usr/bin/env node
/**
 * Provisions the store settings and the first admin account.
 *
 * It writes the single StoreConfig document (the row the mobile app reads from
 * GET /api/v1/store-config) and creates the first ADMIN user if none exists.
 *
 * Authentication is owned by Firebase. The admin is created in Firebase Auth
 * and linked in MongoDB by firebaseUid; no password is stored in MongoDB.
 *
 * Idempotent: re-running updates the same StoreConfig document and skips the
 * admin creation as soon as any ADMIN user already exists. An existing Firebase
 * user with the requested email is reused instead of duplicated, and an
 * existing non-admin Mongo user is only promoted with --force.
 *
 * Usage:
 *   node scripts/provision-store.js --name "Mi Tienda" --admin-email admin@example.com --admin-password secret123
 *   node scripts/provision-store.js --name "Mi Tienda" --admin-email admin@example.com --admin-password secret123 --dry-run
 *   node scripts/provision-store.js --name "Mi Tienda" --admin-email existing@example.com --admin-password secret123 --force
 *   STORE_NAME="Mi Tienda" STORE_ADMIN_EMAIL=admin@example.com STORE_ADMIN_PASSWORD=secret123 npm run provision:store
 *
 * Options:
 *   --name <s>             Store display name (or STORE_NAME, required)
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
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

import { DB_NAME } from "../src/constants.js";
import { ROLES, STATUS } from "../src/constants/roles.js";
import { StoreConfig, STORE_CONFIG_KEY } from "../src/modules/storeConfig/storeConfig.model.js";
import { User } from "../src/modules/users/user.model.js";
import { validateEmail, validateName } from "../src/utils/regex.js";

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

function initFirebase() {
    const rawBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!rawBase64) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT_BASE64 no está definida en el archivo .env");
    }

    const serviceAccount = JSON.parse(Buffer.from(rawBase64, "base64").toString("utf-8"));
    if (getApps().length === 0) {
        initializeApp({ credential: cert(serviceAccount) });
    }
    return getAuth();
}

async function ensureFirebaseUser(auth, { email, password, fullName, resetPassword }) {
    try {
        const existing = await auth.getUserByEmail(email);
        let passwordUpdated = false;

        if (resetPassword) {
            await auth.updateUser(existing.uid, { password });
            passwordUpdated = true;
        }

        return { uid: existing.uid, created: false, passwordUpdated };
    } catch (error) {
        if (error.code !== "auth/user-not-found") throw error;
        const created = await auth.createUser({ email, password, displayName: fullName });
        return { uid: created.uid, created: true, passwordUpdated: false };
    }
}

function validateAdminInput({ adminEmail, adminPassword, adminName }) {
    if (!validateEmail.test(adminEmail)) {
        throw new Error("Falta un email válido para el administrador. Pasá --admin-email o definí STORE_ADMIN_EMAIL.");
    }
    if (adminPassword.length < 6) {
        throw new Error("La contraseña del administrador debe tener al menos 6 caracteres. Pasá --admin-password o definí STORE_ADMIN_PASSWORD.");
    }
    if (!validateName.test(adminName)) {
        throw new Error(`El nombre del administrador "${adminName}" no es válido. Usá solo letras y espacios (2 a 50 caracteres).`);
    }
}

async function main() {
    const args = parseArgs(process.argv);
    const dryRun = args.has("dry-run");
    const resetPassword = args.has("reset-password");
    const force = args.has("force");

    const name = String(readOption(args, "name", "STORE_NAME", ""));
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

    console.log("Aprovisionamiento de tienda:");
    console.log(`  nombre:      ${name}`);
    console.log(`  moneda:      ${currency}`);
    if (dryRun) console.log("  modo:        dry-run, no se escribe nada");

    await mongoose.connect(`${process.env.MONGODB_URI}/${DB_NAME}`, {
        retryWrites: true,
        w: "majority"
    });
    console.log(`\nMongoDB conectado: ${mongoose.connection.host}`);

    try {
        const existingStore = await StoreConfig.findOne({ key: STORE_CONFIG_KEY }).lean();
        const existingAdmin = await User.findOne({ role: ROLES.ADMIN });

        let existingEmail = null;
        if (!existingAdmin && adminEmail) {
            existingEmail = await User.findOne({ email: adminEmail });
        }

        if (dryRun) {
            console.log("\n[dry-run] plan:");
            console.log(`  tienda: ${name} (${existingStore ? "actualizar" : "crear"})`);
            if (existingAdmin) {
                console.log(`  admin:  ya existe (${existingAdmin._id}), se omite`);
            } else if (existingEmail) {
                console.log(`  admin:  convertir en administrador (${existingEmail._id})${force ? "" : ", requiere --force"}`);
            } else {
                console.log("  admin:  crear en Firebase y vincular en MongoDB");
            }
            return;
        }

        // The store is always safe to upsert. Admin credentials are only needed
        // when there is no admin yet, so store-only re-runs stay simple.
        if (!existingAdmin) {
            validateAdminInput({ adminEmail, adminPassword, adminName });

            if (existingEmail && !force) {
                throw new Error(
                    `Ya existe un usuario con el email ${adminEmail} y no es administrador. ` +
                    "Volvé a ejecutar con --force para convertirlo, o usá otro email con --admin-email."
                );
            }
        }

        const store = await StoreConfig.findOneAndUpdate(
            { key: STORE_CONFIG_KEY },
            { $set: { name, razonSocial, nit, phone, whatsapp, address, currency, ticketFooter, logoUrl } },
            { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
        );
        console.log(`\nTienda: ${existingStore ? "actualizada" : "creada"} (${store._id})`);

        let adminOutcome;
        if (existingAdmin) {
            adminOutcome = "omitido, ya existe un administrador";
            console.log(`Admin: omitido, ya existe un administrador (${existingAdmin._id}).`);
        } else {
            const auth = initFirebase();
            const firebase = await ensureFirebaseUser(auth, {
                email: adminEmail,
                password: adminPassword,
                fullName: adminName,
                resetPassword
            });

            console.log(`\nFirebase: ${firebase.created ? "usuario creado" : "usuario existente reutilizado"} (${firebase.uid})`);
            if (firebase.passwordUpdated) console.log("Firebase: contraseña actualizada");

            if (existingEmail) {
                await User.updateOne(
                    { _id: existingEmail._id },
                    { $set: { role: [ROLES.ADMIN], firebaseUid: firebase.uid, status: STATUS.ACTIVE } }
                );
                adminOutcome = "convertido en administrador";
                console.log(`Admin: usuario existente convertido y vinculado por firebaseUid (${existingEmail._id})`);
            } else {
                const admin = await User.create({
                    email: adminEmail,
                    fullName: adminName,
                    firebaseUid: firebase.uid,
                    role: [ROLES.ADMIN],
                    status: STATUS.ACTIVE
                });
                adminOutcome = "creado";
                console.log(`Admin: creado en MongoDB y vinculado por firebaseUid (${admin._id})`);
            }
        }

        console.log("\nResumen:");
        console.log(`  tienda: ${name}`);
        console.log(`  admin:  ${adminOutcome}`);
        console.log("\nListo.");
    } finally {
        await mongoose.disconnect();
    }
}

main().catch(async (error) => {
    console.error(`\nFAILED: ${error.message}`);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
