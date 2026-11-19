import { jest } from "@jest/globals";

import { encrypt } from "../../utils/mailCrypto.js";
import { STORE_CONFIG_KEY } from "../storeConfig/storeConfig.model.js";
import { runMailOutboxSweep } from "./mailOutbox.worker.js";

const TEST_KEY = "test-mail-encryption-passphrase";
const ORIGINAL_KEY = process.env.MAIL_ENCRYPTION_KEY;
const NOW = new Date("2026-11-19T12:00:00.000Z");
const STALE_MS = 10 * 60 * 1000;

let idCounter = 0;

const configFixture = (overrides = {}) => ({
    smtpUser: "store@example.com",
    smtpPassEncrypted: encrypt("smtp-password"),
    adminBccEmail: "admin@example.com",
    ...overrides
});

const entryFixture = (overrides = {}) => ({
    _id: `entry-${(idCounter += 1)}`,
    orderId: "order-1",
    orderCode: "PED-WORKER1",
    status: "pending",
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: new Date(NOW.getTime() - 1000),
    lockedAt: null,
    lastError: "",
    to: "client@example.com",
    bcc: "admin@example.com",
    subject: "Order PED-WORKER1",
    html: "<html><body>Order PED-WORKER1</body></html>",
    text: "Order PED-WORKER1",
    ...overrides
});

// Supports the plain equality and the $lt/$lte operators the worker uses.
const matches = (doc, filter) => Object.entries(filter).every(([key, expected]) => {
    if (
        expected && typeof expected === "object" &&
        !(expected instanceof Date) && !Array.isArray(expected)
    ) {
        return Object.entries(expected).every(([operator, value]) => {
            if (doc[key] == null) return false;
            if (operator === "$lt") return new Date(doc[key]) < new Date(value);
            if (operator === "$lte") return new Date(doc[key]) <= new Date(value);
            return false;
        });
    }
    return String(doc[key]) === String(expected);
});

/**
 * In-memory tenant fake. The claim is a synchronous check-and-set inside the
 * fake, so two concurrent sweeps cannot claim the same row — the same property
 * the real findOneAndUpdate provides in MongoDB.
 */
const tenantFake = ({ config = configFixture(), entries = [], broken = false } = {}) => {
    const docs = entries.map((entry) => ({ ...entry }));

    const applySet = (doc, update) => Object.assign(doc, update.$set);

    const MailOutbox = {
        findOneAndUpdate: jest.fn((filter, update) => {
            const candidates = docs
                .filter((doc) => matches(doc, filter))
                .sort((a, b) => new Date(a.nextAttemptAt) - new Date(b.nextAttemptAt));
            const doc = candidates[0];
            if (!doc) return Promise.resolve(null);
            applySet(doc, update);
            return Promise.resolve({ ...doc });
        }),
        updateOne: jest.fn(async (filter, update) => {
            const doc = docs.find((candidate) => matches(candidate, filter));
            if (doc) applySet(doc, update);
            return { matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0 };
        }),
        updateMany: jest.fn(async (filter, update) => {
            let modifiedCount = 0;
            for (const doc of docs) {
                if (matches(doc, filter)) {
                    applySet(doc, update);
                    modifiedCount += 1;
                }
            }
            return { matchedCount: modifiedCount, modifiedCount };
        })
    };

    const StoreConfig = {
        findOne: jest.fn(() => ({
            select: jest.fn(() => ({
                lean: jest.fn(async () => config)
            }))
        }))
    };

    const getModelFor = jest.fn((dbName, modelName) => {
        if (broken) throw new Error(`cannot open ${dbName}`);
        if (modelName === "MailOutbox") return MailOutbox;
        if (modelName === "StoreConfig") return StoreConfig;
        throw new Error(`Unexpected model: ${modelName}`);
    });

    return { docs, MailOutbox, StoreConfig, getModelFor };
};

const transportFake = ({ fail = false } = {}) => {
    const sendMail = fail
        ? jest.fn().mockRejectedValue(new Error("SMTP outage"))
        : jest.fn().mockResolvedValue({});
    const createTransport = jest.fn(() => ({ sendMail }));
    return { sendMail, createTransport };
};

const sweep = (tenant, transport, overrides = {}) => runMailOutboxSweep({
    targets: ["tenant_a"],
    getModelFor: tenant.getModelFor,
    createTransport: transport.createTransport,
    now: NOW,
    staleMs: STALE_MS,
    ...overrides
});

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

let warnSpy;
let errorSpy;
beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
});

describe("runMailOutboxSweep", () => {
    it("sends a pending entry and marks it sent", async () => {
        const tenant = tenantFake({ entries: [entryFixture()] });
        const transport = transportFake();

        const result = await sweep(tenant, transport);

        expect(result).toMatchObject({
            scannedTargets: 1, claimed: 1, sent: 1, retried: 0, failed: 0
        });
        expect(result.perTarget[0]).toMatchObject({
            dbName: "tenant_a", claimed: 1, sent: 1, retried: 0, failed: 0
        });
        expect(transport.sendMail).toHaveBeenCalledTimes(1);
        expect(transport.sendMail.mock.calls[0][0]).toMatchObject({
            from: "store@example.com",
            to: "client@example.com",
            bcc: "admin@example.com",
            subject: "Order PED-WORKER1"
        });
        expect(tenant.docs[0]).toMatchObject({
            status: "sent", lockedAt: null, lastError: ""
        });
        expect(tenant.docs[0].sentAt).toEqual(NOW);
        expect(tenant.MailOutbox.updateOne).toHaveBeenCalledWith(
            { _id: tenant.docs[0]._id, status: "processing" },
            { $set: { status: "sent", sentAt: NOW, lockedAt: null, lastError: "" } }
        );
    });

    it("requeues a transport failure with incremented attempts and future backoff", async () => {
        const tenant = tenantFake({ entries: [entryFixture()] });
        const transport = transportFake({ fail: true });

        const result = await sweep(tenant, transport);

        expect(result).toMatchObject({ claimed: 1, retried: 1, sent: 0, failed: 0 });
        expect(tenant.docs[0]).toMatchObject({
            status: "pending", attempts: 1, lockedAt: null, lastError: "SMTP outage"
        });
        expect(tenant.docs[0].nextAttemptAt.getTime()).toBe(NOW.getTime() + 60_000);
    });

    it("marks an exhausted entry as failed without further retries", async () => {
        const tenant = tenantFake({
            entries: [entryFixture({ attempts: 4, maxAttempts: 5 })]
        });
        const transport = transportFake({ fail: true });

        const result = await sweep(tenant, transport);

        expect(result).toMatchObject({ claimed: 1, retried: 0, failed: 1 });
        expect(tenant.docs[0]).toMatchObject({
            status: "failed", lockedAt: null, lastError: "SMTP outage"
        });
        expect(tenant.docs[0].nextAttemptAt).toEqual(new Date(NOW.getTime() - 1000));
    });

    it("treats not_configured as a terminal failure", async () => {
        const tenant = tenantFake({
            config: configFixture({ smtpUser: "", smtpPassEncrypted: "" }),
            entries: [entryFixture()]
        });
        const transport = transportFake();

        const result = await sweep(tenant, transport);

        expect(result).toMatchObject({ claimed: 1, failed: 1, sent: 0, retried: 0 });
        expect(tenant.docs[0]).toMatchObject({
            status: "failed", lockedAt: null, lastError: "not_configured"
        });
        expect(transport.sendMail).not.toHaveBeenCalled();
    });

    it("resets a stale processing claim and then sends the entry", async () => {
        const staleLock = new Date(NOW.getTime() - STALE_MS - 1000);
        const tenant = tenantFake({
            entries: [entryFixture({ status: "processing", lockedAt: staleLock })]
        });
        const transport = transportFake();

        const result = await sweep(tenant, transport);

        expect(tenant.MailOutbox.updateMany).toHaveBeenCalledWith(
            {
                status: "processing",
                lockedAt: { $lt: new Date(NOW.getTime() - STALE_MS) }
            },
            { $set: { status: "pending", lockedAt: null } }
        );
        expect(result.sent).toBe(1);
        expect(transport.sendMail).toHaveBeenCalledTimes(1);
        expect(tenant.docs[0].status).toBe("sent");
    });

    it("does not double-send when two sweeps run concurrently", async () => {
        const tenant = tenantFake({ entries: [entryFixture()] });
        const transport = transportFake();

        const [first, second] = await Promise.all([
            sweep(tenant, transport),
            sweep(tenant, transport)
        ]);

        expect(transport.sendMail).toHaveBeenCalledTimes(1);
        expect([first.claimed, second.claimed].sort()).toEqual([0, 1]);
        expect([first.sent, second.sent].sort()).toEqual([0, 1]);
        expect(tenant.docs[0].status).toBe("sent");
    });

    it("processes every target and keeps going when one target throws", async () => {
        const good = tenantFake({ entries: [entryFixture()] });
        const goodTransport = transportFake();
        const other = tenantFake({ entries: [entryFixture()] });
        const broken = tenantFake({ broken: true });

        const result = await runMailOutboxSweep({
            targets: ["tenant_a", "tenant_b", "tenant_c"],
            getModelFor: (dbName, modelName) => {
                if (dbName === "tenant_b") return broken.getModelFor(dbName, modelName);
                if (dbName === "tenant_a") return good.getModelFor(dbName, modelName);
                return other.getModelFor(dbName, modelName);
            },
            createTransport: (options) => (
                // Both healthy tenants share one fake transport factory.
                goodTransport.createTransport(options)
            ),
            now: NOW
        });

        expect(result.scannedTargets).toBe(3);
        expect(result.sent).toBe(2);
        expect(result.perTarget.map((entry) => entry.dbName)).toEqual(
            ["tenant_a", "tenant_b", "tenant_c"]
        );
        expect(result.perTarget[0].sent).toBe(1);
        expect(result.perTarget[1].error).toContain("cannot open tenant_b");
        expect(result.perTarget[2].sent).toBe(1);
        expect(goodTransport.sendMail).toHaveBeenCalledTimes(2);
        expect(other.docs[0].status).toBe("sent");
    });
});
