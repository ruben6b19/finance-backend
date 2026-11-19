import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const VERSION = "v1";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

// A fresh random IV makes each encryption unique, so a fixed application-level
// salt is enough to derive the same key from the passphrase every time.
const SALT = "finance-backend:store-config-mail:v1";

const getKey = () => {
    const passphrase = process.env.MAIL_ENCRYPTION_KEY;
    if (!passphrase) {
        throw new Error("MAIL_ENCRYPTION_KEY is not configured");
    }
    // scryptSync accepts passphrases of any length and always yields 32 bytes.
    return scryptSync(passphrase, SALT, KEY_LENGTH);
};

const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;

export const encrypt = (plainText) => {
    if (!isNonEmptyString(plainText)) return "";

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
    const ciphertext = Buffer.concat([
        cipher.update(plainText, "utf8"),
        cipher.final()
    ]);

    return [
        VERSION,
        iv.toString("base64"),
        cipher.getAuthTag().toString("base64"),
        ciphertext.toString("base64")
    ].join(":");
};

export const decrypt = (payload) => {
    if (!isNonEmptyString(payload)) return "";

    const parts = payload.split(":");
    if (parts.length !== 4 || parts.some((part) => part.length === 0)) {
        throw new Error("Malformed encrypted mail payload");
    }

    const [version, ivBase64, authTagBase64, ciphertextBase64] = parts;
    if (version !== VERSION) {
        throw new Error(`Unsupported encrypted mail payload version: ${version}`);
    }

    const iv = Buffer.from(ivBase64, "base64");
    const authTag = Buffer.from(authTagBase64, "base64");
    const ciphertext = Buffer.from(ciphertextBase64, "base64");
    if (
        iv.length !== IV_LENGTH ||
        authTag.length !== AUTH_TAG_LENGTH ||
        ciphertext.length === 0
    ) {
        throw new Error("Malformed encrypted mail payload");
    }

    // Read the key outside the try block so a missing key keeps its explicit error.
    const key = getKey();
    try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(authTag);
        return Buffer.concat([
            decipher.update(ciphertext),
            decipher.final()
        ]).toString("utf8");
    } catch (error) {
        throw new Error("Failed to decrypt mail payload: authentication failed or data was tampered with", {
            cause: error
        });
    }
};
