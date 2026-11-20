import { jest } from "@jest/globals";

import { encrypt } from "../../utils/mailCrypto.js";
import { STORE_CONFIG_KEY } from "../storeConfig/storeConfig.model.js";
import { sendOrderStatusEmail, sendComboRedemptionEmail } from "./mail.service.js";
import esTranslations from "./es.json" with { type: 'json' };

const TEST_KEY = "test-mail-encryption-passphrase";
const ORIGINAL_KEY = process.env.MAIL_ENCRYPTION_KEY;

const orderFixture = (overrides = {}) => ({
    code: "PED-ABC123",
    customerName: "Cliente Prueba",
    customerEmail: "client@example.com",
    items: [{ name: "Soda", quantity: 2, unitPrice: 10, subtotal: 20 }],
    total: 20,
    deliveryType: 1,
    pickupAt: "2026-11-20T12:00:00.000Z",
    address: "Calle 1",
    notes: "Sin hielo",
    ...overrides
});

const redemptionFixture = () => ({
    voucher: {
        code: "VALE-ABC123",
        customerName: "Cliente Prueba",
        totalUnits: 5,
        usedUnits: 2
    },
    redemption: { redeemedAt: "2026-11-19T12:00:00.000Z" },
    items: [{ name: "Agua Mineral", quantity: 2, remaining: 3 }]
});

const storeConfigFixture = (overrides = {}) => ({
    name: "Mi Tienda",
    phone: "71234567",
    whatsapp: "77123456",
    currency: "Bs.",
    smtpUser: "store@example.com",
    smtpPassEncrypted: encrypt("smtp-password"),
    adminBccEmail: "admin@example.com",
    ...overrides
});

// Every test builds its own chainable fake; nothing here opens a DB connection
// or reaches a real SMTP server.
const setup = (config) => {
    const lean = jest.fn().mockResolvedValue(config);
    const select = jest.fn().mockReturnValue({ lean });
    const findOne = jest.fn().mockReturnValue({ select });
    const getModel = jest.fn().mockReturnValue({ findOne });
    const sendMail = jest.fn().mockResolvedValue({});
    const createTransport = jest.fn().mockReturnValue({ sendMail });
    return { getModel, findOne, select, lean, sendMail, createTransport };
};

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
beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
    warnSpy.mockRestore();
});

describe("sendOrderStatusEmail", () => {
    it("sends one confirmation email through the tenant SMTP settings", async () => {
        const fakes = setup(storeConfigFixture());

        const result = await sendOrderStatusEmail({
            getModel: fakes.getModel,
            order: orderFixture(),
            status: 1,
            comboVouchers: [{ code: "CB000001" }],
            lang: "es",
            createTransport: fakes.createTransport
        });

        expect(result).toEqual({ sent: true });
        expect(fakes.findOne).toHaveBeenCalledWith({ key: STORE_CONFIG_KEY });
        expect(fakes.select).toHaveBeenCalledWith(
            expect.stringContaining("+smtpPassEncrypted")
        );
        expect(fakes.createTransport).toHaveBeenCalledWith({
            host: "smtp.gmail.com",
            port: 465,
            secure: true,
            auth: { user: "store@example.com", pass: "smtp-password" }
        });
        expect(fakes.sendMail).toHaveBeenCalledTimes(1);

        const message = fakes.sendMail.mock.calls[0][0];
        expect(message.from).toEqual({ name: "Mi Tienda", address: "store@example.com" });
        expect(message.to).toBe("client@example.com");
        expect(message.bcc).toBe("admin@example.com");
        expect(message.subject).toContain("PED-ABC123");
        expect(message.html).toContain("PED-ABC123");
        expect(message.html).toContain("Soda");
        expect(message.html).toContain("Bs. 20.00");
        expect(message.html).toContain(esTranslations.vouchers_label);
        expect(message.html).toContain("CB000001");
        expect(message.text).toContain("CB000001");
    });

    it("sends one rejection email with store contacts and no voucher section", async () => {
        const fakes = setup(storeConfigFixture());

        const result = await sendOrderStatusEmail({
            getModel: fakes.getModel,
            order: orderFixture(),
            status: 2,
            // Even if a caller passes vouchers, a rejection must not show them.
            comboVouchers: [{ code: "CB000001" }],
            lang: "es",
            createTransport: fakes.createTransport
        });

        expect(result).toEqual({ sent: true });
        expect(fakes.sendMail).toHaveBeenCalledTimes(1);

        const message = fakes.sendMail.mock.calls[0][0];
        expect(message.to).toBe("client@example.com");
        expect(message.subject).toContain("PED-ABC123");
        expect(message.html).toContain("71234567");
        expect(message.html).toContain("77123456");
        expect(message.html).toContain("Mi Tienda");
        expect(message.html).not.toContain(esTranslations.vouchers_label);
        expect(message.html).not.toContain("CB000001");
    });

    it("renders customer timestamps in the tenant's configured time zone", async () => {
        const fakes = setup(storeConfigFixture({ timezone: "America/Mexico_City" }));

        await sendOrderStatusEmail({
            getModel: fakes.getModel,
            order: orderFixture(),
            status: 1,
            lang: "es",
            createTransport: fakes.createTransport
        });

        const expected = new Date("2026-11-20T12:00:00.000Z").toLocaleString("es-ES", {
            timeZone: "America/Mexico_City"
        });
        expect(fakes.sendMail.mock.calls[0][0].text).toContain(expected);
    });

    it.each([
        ["no config", null],
        ["no SMTP user", { smtpUser: "", smtpPassEncrypted: "placeholder" }],
        ["no encrypted password", { smtpUser: "store@example.com", smtpPassEncrypted: "" }]
    ])("skips when there is %s", async (_label, config) => {
        const fakes = setup(config);

        const result = await sendOrderStatusEmail({
            getModel: fakes.getModel,
            order: orderFixture(),
            status: 1,
            createTransport: fakes.createTransport
        });

        expect(result).toEqual({ sent: false, reason: "not_configured" });
        expect(fakes.createTransport).not.toHaveBeenCalled();
        expect(fakes.sendMail).not.toHaveBeenCalled();
    });

    it("skips when the order has no customer email", async () => {
        const fakes = setup(storeConfigFixture());

        const result = await sendOrderStatusEmail({
            getModel: fakes.getModel,
            order: orderFixture({ customerEmail: "" }),
            status: 1,
            createTransport: fakes.createTransport
        });

        expect(result).toEqual({ sent: false, reason: "no_recipient" });
        expect(fakes.createTransport).not.toHaveBeenCalled();
        expect(fakes.sendMail).not.toHaveBeenCalled();
    });

    it("skips without throwing when the password cannot be decrypted", async () => {
        const fakes = setup(storeConfigFixture({
            smtpPassEncrypted: "v1:malformed:payload"
        }));

        await expect(sendOrderStatusEmail({
            getModel: fakes.getModel,
            order: orderFixture(),
            status: 1,
            createTransport: fakes.createTransport
        })).resolves.toEqual({ sent: false, reason: "decrypt_failed" });

        expect(fakes.createTransport).not.toHaveBeenCalled();
        expect(fakes.sendMail).not.toHaveBeenCalled();
    });
});

describe("sendComboRedemptionEmail", () => {
    it("sends one redemption receipt through the tenant SMTP settings", async () => {
        const fakes = setup(storeConfigFixture());
        const fixture = redemptionFixture();

        const result = await sendComboRedemptionEmail({
            getModel: fakes.getModel,
            ...fixture,
            to: "client@example.com",
            lang: "es",
            createTransport: fakes.createTransport
        });

        expect(result).toEqual({ sent: true });
        expect(fakes.findOne).toHaveBeenCalledWith({ key: STORE_CONFIG_KEY });
        expect(fakes.select).toHaveBeenCalledWith(
            expect.stringContaining("+smtpPassEncrypted")
        );
        expect(fakes.createTransport).toHaveBeenCalledWith({
            host: "smtp.gmail.com",
            port: 465,
            secure: true,
            auth: { user: "store@example.com", pass: "smtp-password" }
        });
        expect(fakes.sendMail).toHaveBeenCalledTimes(1);

        const message = fakes.sendMail.mock.calls[0][0];
        expect(message.from).toEqual({ name: "Mi Tienda", address: "store@example.com" });
        expect(message.to).toBe("client@example.com");
        expect(message.bcc).toBe("admin@example.com");
        expect(message.subject).toContain("VALE-ABC123");
        expect(message.html).toContain("Agua Mineral");
        expect(message.text).toContain("Agua Mineral");
        expect(message.text).toContain("3 de 5 unidades");
    });

    it("skips when there is no recipient", async () => {
        const fakes = setup(storeConfigFixture());

        const result = await sendComboRedemptionEmail({
            getModel: fakes.getModel,
            ...redemptionFixture(),
            to: undefined,
            createTransport: fakes.createTransport
        });

        expect(result).toEqual({ sent: false, reason: "no_recipient" });
        expect(fakes.createTransport).not.toHaveBeenCalled();
        expect(fakes.sendMail).not.toHaveBeenCalled();
    });

    it("skips when the tenant SMTP settings are missing", async () => {
        const fakes = setup(null);

        const result = await sendComboRedemptionEmail({
            getModel: fakes.getModel,
            ...redemptionFixture(),
            to: "client@example.com",
            createTransport: fakes.createTransport
        });

        expect(result).toEqual({ sent: false, reason: "not_configured" });
        expect(fakes.createTransport).not.toHaveBeenCalled();
        expect(fakes.sendMail).not.toHaveBeenCalled();
    });

    it("propagates transport failures to the caller", async () => {
        const fakes = setup(storeConfigFixture());
        fakes.sendMail.mockRejectedValueOnce(new Error("SMTP unavailable"));
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

        try {
            await expect(sendComboRedemptionEmail({
                getModel: fakes.getModel,
                ...redemptionFixture(),
                to: "client@example.com",
                createTransport: fakes.createTransport
            })).rejects.toThrow("SMTP unavailable");
        } finally {
            errorSpy.mockRestore();
        }

        expect(fakes.sendMail).toHaveBeenCalledTimes(1);
    });

    it("uses the plain sender address when the store has no display name", async () => {
        const fakes = setup(storeConfigFixture({ name: undefined }));

        const result = await sendOrderStatusEmail({
            getModel: fakes.getModel,
            order: orderFixture(),
            status: 1,
            lang: "es",
            createTransport: fakes.createTransport
        });

        expect(result).toEqual({ sent: true });
        expect(fakes.sendMail.mock.calls[0][0].from).toBe("store@example.com");
    });
});
