#!/usr/bin/env node
/**
 * Creates or repairs the internal SUPERADMIN account.
 *
 * The account has every admin privilege but is never listed by the API and
 * cannot be assigned from the Android app. It is meant for system support and
 * repairs, not for daily store operation.
 *
 * The same email must exist in Firebase Auth and MongoDB, linked by firebaseUid.
 *
 * Idempotent: re-running reuses the Firebase user and re-asserts the Mongo role.
 * An existing non-superadmin user is NOT converted unless --force is passed.
 *
 * Usage:
 *   node scripts/create-superadmin.js --email you@example.com --password secret123
 *   node scripts/create-superadmin.js --email you@example.com --password secret123 --name "Super Admin"
 *   node scripts/create-superadmin.js --email you@example.com --dry-run
 *
 * Options:
 *   --email <s>            Superadmin email (or SUPERADMIN_EMAIL)
 *   --password <s>         Firebase password, min 6 chars (or SUPERADMIN_PASSWORD)
 *   --name <s>             Display name (or SUPERADMIN_NAME, default "Super Admin")
 *   --reset-password       Update the Firebase password if the user already exists
 *   --force                Convert an existing non-superadmin user into superadmin
 *   --dry-run              Print the plan without writing anything
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import dotenv from "dotenv";

import { DB_NAME } from "../src/constants.js";
import { ROLES, STATUS } from "../src/constants/roles.js";
import { User } from "../src/modules/users/user.model.js";
import { validateEmail, validateName } from "../src/utils/regex.js";
import { initFirebase, ensureFirebaseUser } from "./lib/firebase.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SUPERADMIN_ROLE = [ROLES.SUPERADMIN];

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

function hasRole(user, role) {
    const roles = Array.isArray(user?.role) ? user.role : [user?.role];
    return roles.map(Number).includes(role);
}

async function main() {
    const args = parseArgs(process.argv);
    const dryRun = args.has("dry-run");
    const force = args.has("force");
    const resetPassword = args.has("reset-password");

    const email = String(readOption(args, "email", "SUPERADMIN_EMAIL", "")).toLowerCase();
    const password = String(readOption(args, "password", "SUPERADMIN_PASSWORD", ""));
    const fullName = String(readOption(args, "name", "SUPERADMIN_NAME", "Super Admin"));

    if (!validateEmail.test(email)) {
        throw new Error("Falta un email válido. Pasá --email o definí SUPERADMIN_EMAIL.");
    }
    if (password.length < 6) {
        throw new Error("La contraseña debe tener al menos 6 caracteres. Pasá --password o definí SUPERADMIN_PASSWORD.");
    }
    if (!validateName.test(fullName)) {
        throw new Error(`El nombre "${fullName}" no es válido. Usá solo letras y espacios (2 a 50 caracteres).`);
    }

    console.log("Superadmin:");
    console.log(`  email:  ${email}`);
    console.log(`  nombre: ${fullName}`);
    console.log(`  rol:    ${ROLES.SUPERADMIN} (interno, oculto en la app)`);
    if (dryRun) console.log("  modo:   dry-run, no se escribe nada");

    await mongoose.connect(`${process.env.MONGODB_URI}/${DB_NAME}`, {
        retryWrites: true,
        w: "majority"
    });
    console.log(`\nMongoDB conectado: ${mongoose.connection.host}`);

    try {
        const existingMongoUser = await User.findOne({ email });

        if (existingMongoUser && !hasRole(existingMongoUser, ROLES.SUPERADMIN) && !force) {
            throw new Error(
                `Ya existe un usuario con ${email} y no es superadmin. ` +
                "Si querés convertirlo, volvé a ejecutar con --force."
            );
        }

        if (dryRun) {
            console.log("\n[dry-run] plan:");
            console.log(`  Firebase: ${existingMongoUser?.firebaseUid ? "reusar" : "crear/buscar por email"}`);
            console.log(`  MongoDB:  ${existingMongoUser ? "actualizar rol a [-1]" : "crear usuario"}`);
            return;
        }

        const auth = initFirebase();
        const firebase = await ensureFirebaseUser(auth, {
            email,
            password,
            fullName,
            resetPassword
        });

        console.log(`\nFirebase: ${firebase.created ? "usuario creado" : "usuario existente reutilizado"} (${firebase.uid})`);
        if (firebase.passwordUpdated) console.log("Firebase: contraseña actualizada");

        if (existingMongoUser) {
            await User.updateOne(
                { _id: existingMongoUser._id },
                { $set: { role: SUPERADMIN_ROLE, firebaseUid: firebase.uid, status: STATUS.ACTIVE } }
            );
            console.log(`MongoDB: rol de ${email} actualizado a superadmin (${existingMongoUser._id})`);
        } else {
            const created = await User.create({
                email,
                fullName,
                firebaseUid: firebase.uid,
                role: SUPERADMIN_ROLE,
                status: STATUS.ACTIVE
            });
            console.log(`MongoDB: superadmin creado (${created._id})`);
        }

        console.log("\nListo.");
        console.log("El superadmin tiene los mismos permisos que un admin, pero no aparece");
        console.log("en los listados ni se puede asignar desde la app Android.");
        console.log("Si la cuenta ya estaba logueada, cerrá sesión y volvé a entrar para");
        console.log("que el token incluya el rol -1.");
    } finally {
        await mongoose.disconnect();
    }
}

main().catch(async (error) => {
    console.error(`\nFAILED: ${error.message}`);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
