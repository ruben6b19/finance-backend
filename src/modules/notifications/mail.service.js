import nodemailer from "nodemailer";
import { STORE_CONFIG_KEY } from "../storeConfig/storeConfig.model.js";
import { decrypt } from "../../utils/mailCrypto.js";
import { buildOrderStatusMail } from "./orderMail.template.js";
import { buildComboRedemptionMail } from "./redemptionMail.template.js";

const defaultCreateTransport = (options) => nodemailer.createTransport(options);

/**
 * Sends an already-rendered email through the tenant's Gmail SMTP settings.
 * This is the single delivery primitive shared by the legacy direct sender and
 * the outbox worker. Expected configuration problems are returned as results;
 * unexpected transport failures propagate to the caller's logger.
 */
export const sendRawMail = async ({
    config,
    to,
    subject,
    html,
    text,
    createTransport = defaultCreateTransport
}) => {
    if (!config?.smtpUser || !config?.smtpPassEncrypted) {
        console.warn("[mail] tenant SMTP not configured; skipping mail");
        return { sent: false, reason: "not_configured" };
    }

    if (!to) {
        console.warn("[mail] message has no recipient; skipping mail");
        return { sent: false, reason: "no_recipient" };
    }

    let plainPassword;
    try {
        plainPassword = decrypt(config.smtpPassEncrypted);
    } catch (error) {
        console.warn("[mail] failed to decrypt tenant SMTP password; skipping mail");
        return { sent: false, reason: "decrypt_failed" };
    }

    const transport = createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user: config.smtpUser, pass: plainPassword }
    });

    // Never log the password — only the account, recipient and subject.
    console.info("[mail] sending via Gmail SMTP", {
        smtpUser: config.smtpUser,
        to,
        bcc: config.adminBccEmail || "(none)",
        subject
    });

    // Use Nodemailer's address object so the store name becomes the display
    // name ("Digital Core" <sender@gmail.com>) and any quotes are escaped.
    // Fall back to the plain address when the tenant has no name configured.
    const from = config.name
        ? { name: config.name, address: config.smtpUser }
        : config.smtpUser;

    await transport.sendMail({
        from,
        to,
        bcc: config.adminBccEmail || undefined,
        subject,
        html,
        text
    });

    console.info("[mail] sendMail succeeded", { smtpUser: config.smtpUser, to });
    return { sent: true };
};

/**
 * Sends the customer an email when an order is confirmed or rejected, using the
 * SMTP credentials of the tenant that owns the order.
 *
 * The order flow sends directly through this function and sendRawMail; the
 * dormant outbox worker uses the same delivery primitive as a manual fallback.
 */
const sendOrderStatusEmail = async ({
    getModel,
    order,
    status,
    comboVouchers,
    lang,
    createTransport = defaultCreateTransport
}) => {
    const StoreConfig = getModel("StoreConfig");

    // smtpPassEncrypted has select: false, so the explicit "+field" is required.
    const config = await StoreConfig.findOne({ key: STORE_CONFIG_KEY })
        .select("name phone whatsapp smtpUser smtpPassEncrypted adminBccEmail +smtpPassEncrypted")
        .lean();

    const template = buildOrderStatusMail({
        order,
        status,
        storeConfig: config || {},
        comboVouchers,
        lang
    });

    return sendRawMail({
        config,
        to: order?.customerEmail,
        subject: template.subject,
        html: template.html,
        text: template.text,
        createTransport
    });
};

/**
 * Sends the combo voucher holder a redemption receipt through the tenant's
 * Gmail SMTP settings. Recipient resolution belongs to the caller: the counter
 * staff member is not necessarily the voucher owner.
 */
const sendComboRedemptionEmail = async ({
    getModel,
    voucher,
    redemption,
    items,
    to,
    lang,
    createTransport = defaultCreateTransport
}) => {
    const StoreConfig = getModel("StoreConfig");

    // smtpPassEncrypted has select: false, so the explicit "+field" is required.
    const config = await StoreConfig.findOne({ key: STORE_CONFIG_KEY })
        .select("name phone whatsapp smtpUser smtpPassEncrypted adminBccEmail +smtpPassEncrypted")
        .lean();

    const template = buildComboRedemptionMail({
        voucher,
        redemption,
        items,
        storeConfig: config || {},
        lang
    });

    return sendRawMail({
        config,
        to,
        subject: template.subject,
        html: template.html,
        text: template.text,
        createTransport
    });
};

export { sendOrderStatusEmail, sendComboRedemptionEmail };
