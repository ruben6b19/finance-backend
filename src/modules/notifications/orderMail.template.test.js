import { buildOrderStatusMail } from "./orderMail.template.js";
import esTranslations from "./es.json" with { type: 'json' };
import enTranslations from "./en.json" with { type: 'json' };

const orderFixture = (overrides = {}) => ({
    code: "PED-X",
    customerName: "Ana",
    items: [{ name: "<script>alert(1)</script>", quantity: 1 }],
    total: "10.00",
    deliveryType: 2,
    pickupAt: "2026-11-20T12:00:00.000Z",
    address: "<b>Calle 1</b>",
    notes: "<img src=x>",
    ...overrides
});

describe("buildOrderStatusMail", () => {
    it("escapes HTML supplied by customers while keeping the text fallback readable", () => {
        const mail = buildOrderStatusMail({
            order: orderFixture(),
            status: 1,
            storeConfig: { currency: "Bs." },
            comboVouchers: [{ code: "<script>voucher</script>" }],
            lang: "es"
        });

        expect(mail.html).not.toContain("<script>");
        expect(mail.html).not.toContain("<img");
        expect(mail.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
        expect(mail.html).toContain("&lt;script&gt;voucher&lt;/script&gt;");
        expect(mail.html).toContain("&lt;b&gt;Calle 1&lt;/b&gt;");
        expect(mail.html).toContain("&lt;img src=x&gt;");
        expect(mail.text).toContain("<script>alert(1)</script>");
    });

    it("renders Spanish copy with the store currency by default", () => {
        const mail = buildOrderStatusMail({
            order: orderFixture(),
            status: 1,
            storeConfig: { currency: "Bs." },
            comboVouchers: [{ code: "CB1" }]
        });

        expect(mail.subject).toBe("Pedido PED-X confirmado");
        expect(mail.html).toContain(esTranslations.delivery_2);
        expect(mail.html).toContain(esTranslations.vouchers_label);
        expect(mail.html).toContain("Bs. 10.00");
    });

    it("renders English copy for a rejection with store contacts", () => {
        const mail = buildOrderStatusMail({
            order: orderFixture(),
            status: 2,
            storeConfig: { name: "Mi Tienda", phone: "71234567", whatsapp: "77123456" },
            comboVouchers: [{ code: "CB1" }],
            lang: "en"
        });

        expect(mail.subject).toBe("Order PED-X cancelled");
        expect(mail.html).toContain(enTranslations.rejected_contact);
        expect(mail.html).toContain("71234567");
        expect(mail.html).toContain("77123456");
        expect(mail.html).not.toContain(enTranslations.vouchers_label);
        expect(mail.html).not.toContain("CB1");
    });

    it("renders the pickup time in the supplied store time zone", () => {
        const pickupAt = "2026-11-20T12:00:00.000Z";
        const mail = buildOrderStatusMail({
            order: orderFixture({ pickupAt }),
            status: 1,
            timeZone: "America/Mexico_City",
            lang: "en"
        });

        const expected = new Date(pickupAt).toLocaleString("en-US", {
            timeZone: "America/Mexico_City"
        });
        expect(mail.text).toContain(expected);
        expect(mail.html).toContain(expected);
    });

    it("labels voucher codes in English for a confirmed combo order", () => {
        const mail = buildOrderStatusMail({
            order: orderFixture(),
            status: 1,
            storeConfig: {},
            comboVouchers: [{ code: "CB1" }, { code: "CB2" }],
            lang: "en"
        });

        expect(mail.html).toContain(enTranslations.vouchers_label);
        expect(mail.html).toContain("CB1");
        expect(mail.html).toContain("CB2");
    });
});
