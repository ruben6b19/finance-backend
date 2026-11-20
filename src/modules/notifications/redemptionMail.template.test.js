import { buildComboRedemptionMail } from "./redemptionMail.template.js";
import esTranslations from "./es.json" with { type: 'json' };
import enTranslations from "./en.json" with { type: 'json' };

const redemptionFixture = (overrides = {}) => ({
    voucher: {
        code: "VALE-7",
        customerName: "Ana",
        totalUnits: 5,
        usedUnits: 2
    },
    redemption: { redeemedAt: "2026-11-19T12:00:00.000Z" },
    items: [{ name: "Agua Mineral", quantity: 2, remaining: 3 }],
    storeConfig: { name: "Mi Tienda", phone: "71234567", whatsapp: "77123456" },
    lang: "es",
    ...overrides
});

describe("buildComboRedemptionMail", () => {
    it("renders the voucher code, redeemed items and remaining balance in Spanish", () => {
        const mail = buildComboRedemptionMail(redemptionFixture());

        expect(mail.subject).toBe("Vale VALE-7 retirado");
        expect(mail.html).toContain(esTranslations.redemption_title);
        expect(mail.html).toContain(esTranslations.redemption_voucher_code_label);
        expect(mail.html).toContain("VALE-7");
        expect(mail.html).toContain(esTranslations.redemption_items_label);
        expect(mail.html).toContain("Agua Mineral × 2 — Quedan 3");
        expect(mail.html).toContain(esTranslations.redemption_remaining_label);
        expect(mail.html).toContain("3 de 5 unidades");
        expect(mail.text).toContain("Agua Mineral × 2 — Quedan 3");
        expect(mail.text).toContain("3 de 5 unidades");
    });

    it("shows a zero balance without omitting the summary row", () => {
        const mail = buildComboRedemptionMail(redemptionFixture({
            voucher: { code: "VALE-8", totalUnits: 2, usedUnits: 2 },
            items: []
        }));

        expect(mail.html).toContain("0 de 2 unidades");
        expect(mail.html).not.toContain(esTranslations.redemption_items_label);
    });

    it("renders English copy when lang is en", () => {
        const mail = buildComboRedemptionMail(redemptionFixture({ lang: "en" }));

        expect(mail.subject).toBe("Voucher VALE-7 redeemed");
        expect(mail.html).toContain(enTranslations.redemption_title);
        expect(mail.html).toContain("3 of 5 units");
        expect(mail.html).toContain("Agua Mineral × 2 — 3 left");
    });

    it.each([
        ["missing", {}],
        ["invalid", { redeemedAt: "not-a-date" }]
    ])("renders without crashing when redeemedAt is %s", (_label, redemption) => {
        const mail = buildComboRedemptionMail(redemptionFixture({ redemption }));

        expect(mail.html).toContain(esTranslations.redemption_date_label);
        expect(mail.text).toContain(`${esTranslations.redemption_date_label}: `);
    });

    it("escapes HTML supplied by customers while keeping the text fallback readable", () => {
        const mail = buildComboRedemptionMail(redemptionFixture({
            voucher: {
                code: "VALE-9",
                customerName: "<script>alert(1)</script>",
                totalUnits: 5,
                usedUnits: 2
            },
            items: [{ name: "<img src=x>", quantity: 1, remaining: 3 }]
        }));

        expect(mail.html).not.toContain("<script>");
        expect(mail.html).not.toContain("<img");
        expect(mail.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
        expect(mail.html).toContain("&lt;img src=x&gt;");
        expect(mail.text).toContain("<script>alert(1)</script>");
        expect(mail.text).toContain("<img src=x>");
    });

    it("includes the store name and contact rows when provided", () => {
        const mail = buildComboRedemptionMail(redemptionFixture());

        expect(mail.html).toContain("71234567");
        expect(mail.html).toContain("77123456");
        expect(mail.html).toContain(esTranslations.store_label);
        expect(mail.html).toContain("Mi Tienda");
        expect(mail.text).toContain(`${esTranslations.phone_label}: 71234567`);
        expect(mail.text).toContain(`${esTranslations.whatsapp_label}: 77123456`);
        expect(mail.text).toContain(`${esTranslations.store_label}: Mi Tienda`);
    });
});
