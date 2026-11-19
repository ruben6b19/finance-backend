import { encrypt, decrypt } from "./mailCrypto.js";

const TEST_KEY = "test-mail-encryption-passphrase";
const ORIGINAL_KEY = process.env.MAIL_ENCRYPTION_KEY;

beforeAll(() => {
    process.env.MAIL_ENCRYPTION_KEY = TEST_KEY;
});

afterAll(() => {
    if (ORIGINAL_KEY === undefined) {
        delete process.env.MAIL_ENCRYPTION_KEY;
    } else {
        process.env.MAIL_ENCRYPTION_KEY = ORIGINAL_KEY;
    }
});

describe("mailCrypto", () => {
    it("round-trips a plaintext value", () => {
        const payload = encrypt("s3cret-password");

        expect(payload).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
        expect(decrypt(payload)).toBe("s3cret-password");
    });

    it("produces different payloads for the same plaintext", () => {
        expect(encrypt("same-password")).not.toBe(encrypt("same-password"));
    });

    it("throws when the ciphertext was tampered with", () => {
        const [version, iv, authTag, ciphertextBase64] = encrypt("s3cret-password").split(":");
        const ciphertext = Buffer.from(ciphertextBase64, "base64");
        ciphertext[0] ^= 1;
        const tampered = [version, iv, authTag, ciphertext.toString("base64")].join(":");

        expect(() => decrypt(tampered)).toThrow(/authentication failed|tampered/);
    });

    it("throws on a malformed payload", () => {
        expect(() => decrypt("not-a-valid-payload")).toThrow("Malformed encrypted mail payload");
        expect(() => decrypt("v1:only:two")).toThrow("Malformed encrypted mail payload");
    });

    it("throws on an unknown payload version", () => {
        const payload = encrypt("s3cret-password").replace(/^v1:/, "v2:");

        expect(() => decrypt(payload)).toThrow("Unsupported encrypted mail payload version: v2");
    });

    it("returns an empty string for empty or null input", () => {
        expect(encrypt("")).toBe("");
        expect(encrypt(null)).toBe("");
        expect(decrypt("")).toBe("");
        expect(decrypt(null)).toBe("");
    });

    it("requires the encryption key at call time", () => {
        const payload = encrypt("s3cret-password");
        const originalKey = process.env.MAIL_ENCRYPTION_KEY;
        delete process.env.MAIL_ENCRYPTION_KEY;

        try {
            expect(() => encrypt("s3cret-password")).toThrow("MAIL_ENCRYPTION_KEY is not configured");
            expect(() => decrypt(payload)).toThrow("MAIL_ENCRYPTION_KEY is not configured");
        } finally {
            process.env.MAIL_ENCRYPTION_KEY = originalKey;
        }
    });
});
