import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { STATUS } from "../../constants/roles.js";
import { Store } from "./store.model.js";
import { findStoreBySlug, isValidSlug, slugify } from "./store.service.js";

let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Store.init();
}, 60000);

afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
    await mongoServer.stop();
}, 60000);

beforeEach(async () => {
    await Store.deleteMany({});
});

describe("slugify", () => {
    it("lowercases and joins words with a single dash", () => {
        expect(slugify("Tienda Norte")).toBe("tienda-norte");
    });

    it("strips diacritics instead of dropping the letters", () => {
        expect(slugify("Tienda Núñez")).toBe("tienda-nunez");
        expect(slugify("Café Ñandú")).toBe("cafe-nandu");
    });

    it("collapses runs of unsupported characters and trims the edges", () => {
        expect(slugify("  --Tienda   Norte!!  ")).toBe("tienda-norte");
        expect(slugify("a___b---c")).toBe("a-b-c");
    });

    it("returns an empty string when nothing usable remains", () => {
        expect(slugify("")).toBe("");
        expect(slugify("!!!")).toBe("");
        expect(slugify(undefined)).toBe("");
        expect(slugify(42)).toBe("");
    });
});

describe("isValidSlug", () => {
    it("accepts lowercase alphanumeric slugs joined by single dashes", () => {
        expect(isValidSlug("tienda-norte")).toBe(true);
        expect(isValidSlug("ab")).toBe(true);
        expect(isValidSlug("a1-b2-c3")).toBe(true);
        expect(isValidSlug("a".repeat(48))).toBe(true);
    });

    it("rejects uppercase, unsupported characters and repeated dashes", () => {
        expect(isValidSlug("Tienda")).toBe(false);
        expect(isValidSlug("tienda_norte")).toBe(false);
        expect(isValidSlug("tienda--norte")).toBe(false);
        expect(isValidSlug("-tienda")).toBe(false);
        expect(isValidSlug("tienda-")).toBe(false);
        expect(isValidSlug("tienda norte")).toBe(false);
    });

    it("rejects values outside the 2..48 length window", () => {
        expect(isValidSlug("a")).toBe(false);
        expect(isValidSlug("")).toBe(false);
        expect(isValidSlug("a".repeat(49))).toBe(false);
    });

    it("rejects non-string values", () => {
        expect(isValidSlug(undefined)).toBe(false);
        expect(isValidSlug(null)).toBe(false);
        expect(isValidSlug(123)).toBe(false);
    });
});

describe("findStoreBySlug", () => {
    const createStore = (overrides = {}) =>
        Store.create({
            slug: "tienda-norte",
            dbName: "tenant_norte",
            name: "Tienda Norte",
            ...overrides
        });

    it("returns the active store as a lean object", async () => {
        await createStore();

        const store = await findStoreBySlug("tienda-norte");

        expect(store).toEqual({
            slug: "tienda-norte",
            dbName: "tenant_norte",
            name: "Tienda Norte",
            status: STATUS.ACTIVE
        });
    });

    it("normalizes the received slug", async () => {
        await createStore();

        await expect(findStoreBySlug("  TIENDA-NORTE  ")).resolves.toMatchObject({
            dbName: "tenant_norte"
        });
    });

    it("returns null for an unknown slug", async () => {
        await expect(findStoreBySlug("no-existe")).resolves.toBeNull();
    });

    it("returns null for an inactive store", async () => {
        await createStore({ status: STATUS.INACTIVE });

        await expect(findStoreBySlug("tienda-norte")).resolves.toBeNull();
    });

    it("returns null for an empty or missing slug", async () => {
        await expect(findStoreBySlug("")).resolves.toBeNull();
        await expect(findStoreBySlug("   ")).resolves.toBeNull();
        await expect(findStoreBySlug(undefined)).resolves.toBeNull();
    });
});
