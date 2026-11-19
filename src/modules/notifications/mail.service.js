import nodemailer from "nodemailer";
import { STORE_CONFIG_KEY } from "../storeConfig/storeConfig.model.js";
import { decrypt } from "../../utils/mailCrypto.js";
import { buildOrderStatusMail } from "./orderMail.template.js";

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

    await transport.sendMail({
        from: config.smtpUser,
        to,
        bcc: config.adminBccEmail || undefined,
        subject,
        html,
        text
    });

    return { sent: true };
};

/**
 * Sends the customer an email when an order is confirmed or rejected, using the
 * SMTP credentials of the tenant that owns the order.
 *
 * Kept for backward compatibility with callers that still render and send in
 * one step. The order flow now writes to the outbox instead; this function and
 * the outbox worker both go through sendRawMail so behaviour stays identical.
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

export { sendOrderStatusEmail };
