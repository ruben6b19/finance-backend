import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

/**
 * Initializes Firebase Admin from the base64 service account in the
 * environment and returns its Auth client.
 *
 * The app is initialized only once: re-running in the same process reuses the
 * existing app instead of throwing an "already exists" error.
 *
 * @returns {import("firebase-admin/auth").Auth}
 */
export function initFirebase() {
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

/**
 * Finds the Firebase user for an email, optionally resets its password, or
 * creates it when Firebase has no account with that email yet.
 *
 * The password lives only in Firebase Auth: nothing here touches MongoDB.
 *
 * @param {import("firebase-admin/auth").Auth} auth
 * @param {object} options
 * @param {string} options.email
 * @param {string} options.password
 * @param {string} options.fullName
 * @param {boolean} [options.resetPassword=false]
 * @returns {Promise<{ uid: string, created: boolean, passwordUpdated: boolean }>}
 */
export async function ensureFirebaseUser(auth, { email, password, fullName, resetPassword }) {
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
