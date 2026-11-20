import esTranslations from './es.json' with { type: 'json' };
import enTranslations from './en.json' with { type: 'json' };
import { DEFAULT_TIME_ZONE } from "../../utils/boliviaTime.js";

const translations = {
    es: esTranslations,
    en: enTranslations
};

const escapeHtml = (value) =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

const interpolate = (copy, values = {}) =>
    String(copy ?? "").replace(/\{\{(\w+)\}\}/g, (_, key) => String(values[key] ?? ""));

const formatDateTime = (value, lang, timeZone = DEFAULT_TIME_ZONE) => {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const locale = lang === "en" ? "en-US" : "es-ES";
    try {
        return date.toLocaleString(locale, { timeZone });
    } catch (error) {
        return date.toLocaleString(locale);
    }
};

/**
 * Builds the subject, HTML body and plain-text fallback for a combo voucher
 * redemption receipt. It is intentionally free of side effects and I/O so it
 * can be tested without a database or an SMTP server.
 */
const buildComboRedemptionMail = ({
    voucher = {},
    redemption = {},
    items = [],
    storeConfig = {},
    lang = "es",
    timeZone = DEFAULT_TIME_ZONE
}) => {
    const copy = translations[lang] || translations.es;
    const voucherCode = String(voucher.code ?? "");
    const subject = interpolate(copy.redemption_subject, { voucherCode });

    const total = Number(voucher.totalUnits) || 0;
    const used = Number(voucher.usedUnits) || 0;
    const remaining = Math.max(0, total - used);
    const remainingUnits = interpolate(copy.redemption_remaining_units, { remaining, total });

    const htmlRows = [];
    const textRows = [];

    if (voucher.customerName) {
        htmlRows.push(`<p>${interpolate(copy.greeting, { customerName: escapeHtml(voucher.customerName) })}</p>`);
        textRows.push(interpolate(copy.greeting, { customerName: voucher.customerName }));
    }

    htmlRows.push(`<h1>${escapeHtml(copy.redemption_title)}</h1>`);
    textRows.push(copy.redemption_title);

    htmlRows.push(
        `<p><strong>${escapeHtml(copy.redemption_voucher_code_label)}:</strong> ${escapeHtml(voucherCode)}</p>`
    );
    textRows.push(`${copy.redemption_voucher_code_label}: ${voucherCode}`);

    const redeemedAt = formatDateTime(redemption.redeemedAt, lang, timeZone);
    htmlRows.push(
        `<p><strong>${escapeHtml(copy.redemption_date_label)}:</strong> ${escapeHtml(redeemedAt)}</p>`
    );
    textRows.push(`${copy.redemption_date_label}: ${redeemedAt}`);

    const redeemedItems = Array.isArray(items) ? items : [];
    if (redeemedItems.length > 0) {
        const itemHtml = redeemedItems.map((item) =>
            `<li>${escapeHtml(item.name)} × ${escapeHtml(item.quantity)} — ${
                interpolate(copy.redemption_item_remaining, { remaining: escapeHtml(item.remaining) })
            }</li>`
        );
        const itemText = redeemedItems.map((item) =>
            `${item.name} × ${item.quantity} — ${
                interpolate(copy.redemption_item_remaining, { remaining: item.remaining })
            }`
        );

        htmlRows.push(`<h2>${escapeHtml(copy.redemption_items_label)}</h2>`);
        htmlRows.push(`<ul>${itemHtml.join("")}</ul>`);
        textRows.push(copy.redemption_items_label);
        textRows.push(...itemText);
    }

    htmlRows.push(
        `<p><strong>${escapeHtml(copy.redemption_remaining_label)}:</strong> ${escapeHtml(remainingUnits)}</p>`
    );
    textRows.push(`${copy.redemption_remaining_label}: ${remainingUnits}`);

    const contacts = [];
    if (storeConfig.phone) {
        contacts.push(`${copy.phone_label}: ${storeConfig.phone}`);
    }
    if (storeConfig.whatsapp) {
        contacts.push(`${copy.whatsapp_label}: ${storeConfig.whatsapp}`);
    }
    if (contacts.length > 0) {
        htmlRows.push(`<p>${escapeHtml(contacts.join(" · "))}</p>`);
        textRows.push(...contacts);
    }

    if (storeConfig.name) {
        htmlRows.push(`<p>${escapeHtml(copy.store_label)}: ${escapeHtml(storeConfig.name)}</p>`);
        textRows.push(`${copy.store_label}: ${storeConfig.name}`);
    }

    htmlRows.push(`<p>${escapeHtml(copy.redemption_thank_you)}</p>`);
    textRows.push(copy.redemption_thank_you);

    return {
        subject,
        html: `<html><body>${htmlRows.join("\n")}</body></html>`,
        text: textRows.join("\n")
    };
};

export { buildComboRedemptionMail };
