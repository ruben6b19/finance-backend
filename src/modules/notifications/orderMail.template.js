import esTranslations from './es.json' with { type: 'json' };
import enTranslations from './en.json' with { type: 'json' };

// Local status constants keep the template pure: it must not load a Mongoose
// model just to render a string.
const STATUS = { CONFIRMED: 1, REJECTED: 2 };
const DEFAULT_CURRENCY = "Bs.";

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

const toAmount = (value) => {
    const amount = Number.parseFloat(String(value ?? ""));
    return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
};

const formatPickupAt = (value, lang) => {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString(lang === "en" ? "en-US" : "es-ES");
};

const deliveryLabel = (copy, deliveryType) => {
    const key = `delivery_${Number(deliveryType)}`;
    return copy[key] || "";
};

/**
 * Builds the subject, HTML body and plain-text fallback for an order status
 * email. It is intentionally free of side effects and I/O so it can be tested
 * without a database or an SMTP server.
 */
const buildOrderStatusMail = ({ order = {}, status, storeConfig = {}, comboVouchers, lang = "es" }) => {
    const copy = translations[lang] || translations.es;
    const orderCode = String(order.code ?? "");
    const isConfirmed = Number(status) === STATUS.CONFIRMED;
    const subject = interpolate(
        isConfirmed ? copy.confirmed_subject : copy.rejected_subject,
        { orderCode }
    );

    const greeting = order.customerName
        ? interpolate(copy.greeting, { customerName: escapeHtml(order.customerName) })
        : "";
    const greetingText = order.customerName
        ? interpolate(copy.greeting, { customerName: order.customerName })
        : "";
    const codeRowHtml = `${escapeHtml(copy.order_code_label)}: ${escapeHtml(orderCode)}`;
    const codeRowText = `${copy.order_code_label}: ${orderCode}`;

    const htmlRows = [];
    const textRows = [];

    if (greeting) {
        htmlRows.push(`<p>${greeting}</p>`);
        textRows.push(greetingText);
    }

    htmlRows.push(`<h1>${escapeHtml(isConfirmed ? copy.confirmed_title : copy.rejected_title)}</h1>`);
    textRows.push(isConfirmed ? copy.confirmed_title : copy.rejected_title);

    htmlRows.push(`<p><strong>${codeRowHtml}</strong></p>`);
    textRows.push(codeRowText);

    if (isConfirmed) {
        const items = Array.isArray(order.items) ? order.items : [];
        const currency = storeConfig.currency || DEFAULT_CURRENCY;
        const total = `${currency} ${toAmount(order.total)}`;

        const itemHtml = items.map((item) =>
            `<li>${escapeHtml(item.name)} × ${escapeHtml(item.quantity)}</li>`
        );
        const itemText = items.map((item) => `${item.name} × ${item.quantity}`);

        htmlRows.push(`<h2>${escapeHtml(copy.items_label)}</h2>`);
        htmlRows.push(`<ul>${itemHtml.join("")}</ul>`);
        textRows.push(copy.items_label);
        textRows.push(...itemText);

        htmlRows.push(`<p><strong>${escapeHtml(copy.total_label)}:</strong> ${escapeHtml(total)}</p>`);
        textRows.push(`${copy.total_label}: ${total}`);

        htmlRows.push(
            `<p><strong>${escapeHtml(copy.delivery_label)}:</strong> ${escapeHtml(deliveryLabel(copy, order.deliveryType))}</p>`
        );
        textRows.push(`${copy.delivery_label}: ${deliveryLabel(copy, order.deliveryType)}`);

        htmlRows.push(
            `<p><strong>${escapeHtml(copy.pickup_label)}:</strong> ${escapeHtml(formatPickupAt(order.pickupAt, lang))}</p>`
        );
        textRows.push(`${copy.pickup_label}: ${formatPickupAt(order.pickupAt, lang)}`);

        htmlRows.push(
            `<p><strong>${escapeHtml(copy.address_label)}:</strong> ${escapeHtml(order.address || "")}</p>`
        );
        textRows.push(`${copy.address_label}: ${order.address || ""}`);

        if (order.notes) {
            htmlRows.push(
                `<p><strong>${escapeHtml(copy.notes_label)}:</strong> ${escapeHtml(order.notes)}</p>`
            );
            textRows.push(`${copy.notes_label}: ${order.notes}`);
        }

        if (Array.isArray(comboVouchers) && comboVouchers.length > 0) {
            const voucherHtml = comboVouchers.map(
                (voucher) => `<li>${escapeHtml(voucher?.code)}</li>`
            );
            const voucherText = comboVouchers.map((voucher) => String(voucher?.code ?? ""));

            htmlRows.push(`<h2>${escapeHtml(copy.vouchers_label)}</h2>`);
            htmlRows.push(`<ul>${voucherHtml.join("")}</ul>`);
            textRows.push(copy.vouchers_label);
            textRows.push(...voucherText);
        }

        htmlRows.push(`<p>${escapeHtml(copy.thank_you)}</p>`);
        textRows.push(copy.thank_you);
    } else {
        const apology = interpolate(copy.rejected_apology, { orderCode: escapeHtml(orderCode) });
        htmlRows.push(`<p>${apology}</p>`);
        textRows.push(interpolate(copy.rejected_apology, { orderCode }));

        const contacts = [];
        if (storeConfig.phone) {
            contacts.push(`${copy.phone_label}: ${storeConfig.phone}`);
        }
        if (storeConfig.whatsapp) {
            contacts.push(`${copy.whatsapp_label}: ${storeConfig.whatsapp}`);
        }

        if (contacts.length > 0) {
            htmlRows.push(`<p>${escapeHtml(copy.rejected_contact)}</p>`);
            htmlRows.push(`<p>${escapeHtml(contacts.join(" · "))}</p>`);
            textRows.push(copy.rejected_contact);
            textRows.push(...contacts);
        }

        if (storeConfig.name) {
            htmlRows.push(`<p>${escapeHtml(copy.store_label)}: ${escapeHtml(storeConfig.name)}</p>`);
            textRows.push(`${copy.store_label}: ${storeConfig.name}`);
        }
    }

    return {
        subject,
        html: `<html><body>${htmlRows.join("\n")}</body></html>`,
        text: textRows.join("\n")
    };
};

export { buildOrderStatusMail };
