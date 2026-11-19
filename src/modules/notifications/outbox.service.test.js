import { jest } from "@jest/globals";

import { STORE_CONFIG_KEY } from "../storeConfig/storeConfig.model.js";
import { buildOrderStatusMail } from "./orderMail.template.js";
import { enqueueOrderStatusMail } from "./outbox.service.js";

const configFixture = (overrides = {}) => ({
    name: "Mi Tienda",
    phone: "71234567",
    currency: "Bs.",
    smtpUser: "store@example.com",
    // Deliberately not a decryptable payload: enqueue must never decrypt.
    smtpPassEncrypted: "opaque-encrypted-value",
    adminBccEmail: "admin@example.com",
    ...overrides
});

const orderFixture = (overrides = {}) => ({
    _id: "order-1",
    code: "PED-OUTBOX1",
    customerName: "Cliente Prueba",
    customerEmail: "client@example.com",
    items: [{ name: "Soda", quantity: 2, unitPrice: 10, subtotal: 20 }],
    total: 20,
    deliveryType: 1,
    pickupAt: "2026-11-20T12:00:00.000Z",
    address: "Calle 1",
    ...overrides
});

// Every test uses chainable fakes: no Mongo connection and no SMTP server.
const setup = (config) => {
    const lean = jest.fn().mockResolvedValue(config);
    const session = jest.fn().mockReturnValue({ lean });
    const select = jest.fn().mockReturnValue({ lean, session });
    const findOne = jest.fn().mockReturnValue({ select });
    const create = jest.fn().mockResolvedValue([{ _id: "outbox-doc-1" }]);
    const getModel = jest.fn((name) => {
        if (name === "StoreConfig") return { findOne };
        if (name === "MailOutbox") return { create };
        throw new Error(`Unexpected model: ${name}`);
    });
    return { getModel, findOne, select, session, lean, create };
};

let warnSpy;
beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
    warnSpy.mockRestore();
});

describe("enqueueOrderStatusMail", () => {
    it("inserts one pending outbox doc with the rendered mail and the session", async () => {
        const config = configFixture();
        const order = orderFixture();
        const fakes = setup(config);
        const session = { id: "session-token" };

        const result = await enqueueOrderStatusMail({
            getModel: fakes.getModel,
            session,
            order,
            status: 1,
            lang: "es"
        });

        expect(result).toEqual({ enqueued: true, id: "outbox-doc-1" });
        expect(fakes.findOne).toHaveBeenCalledWith({ key: STORE_CONFIG_KEY });
        expect(fakes.select).toHaveBeenCalledWith(
            expect.stringContaining("+smtpPassEncrypted")
        );
        expect(fakes.session).toHaveBeenCalledWith(session);
        expect(fakes.create).toHaveBeenCalledTimes(1);

        const [entries, options] = fakes.create.mock.calls[0];
        expect(entries).toHaveLength(1);
        expect(options).toEqual({ session });

        const expected = buildOrderStatusMail({
            order, status: 1, storeConfig: config, lang: "es"
        });
        expect(entries[0]).toMatchObject({
            orderId: "order-1",
            orderCode: "PED-OUTBOX1",
            status: "pending",
            attempts: 0,
            maxAttempts: 5,
            to: "client@example.com",
            bcc: "admin@example.com",
            subject: expected.subject,
            html: expected.html,
            text: expected.text
        });
        expect(entries[0].nextAttemptAt).toBeInstanceOf(Date);
        expect(entries[0].subject).toContain("PED-OUTBOX1");
        expect(entries[0].html).toContain("PED-OUTBOX1");
    });

    it("renders combo voucher codes into the queued html", async () => {
        const fakes = setup(configFixture());

        await enqueueOrderStatusMail({
            getModel: fakes.getModel,
            order: orderFixture(),
            status: 1,
            comboVouchers: [{ code: "CB-77" }],
            lang: "es"
        });

        const [entries] = fakes.create.mock.calls[0];
        expect(entries[0].html).toContain("CB-77");
        expect(entries[0].text).toContain("CB-77");
    });

    it("skips enqueue when the tenant SMTP is not configured", async () => {
        const fakes = setup(configFixture({ smtpPassEncrypted: "" }));

        const result = await enqueueOrderStatusMail({
            getModel: fakes.getModel,
            order: orderFixture(),
            status: 1
        });

        expect(result).toEqual({ enqueued: false, reason: "not_configured" });
        expect(fakes.create).not.toHaveBeenCalled();
    });

    it("skips enqueue when the order has no customer email", async () => {
        const fakes = setup(configFixture());

        const result = await enqueueOrderStatusMail({
            getModel: fakes.getModel,
            order: orderFixture({ customerEmail: "" }),
            status: 1
        });

        expect(result).toEqual({ enqueued: false, reason: "no_recipient" });
        expect(fakes.create).not.toHaveBeenCalled();
    });
});
