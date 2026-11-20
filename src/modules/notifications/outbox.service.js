import { STORE_CONFIG_KEY } from "../storeConfig/storeConfig.model.js";
import { buildOrderStatusMail } from "./orderMail.template.js";

/**
 * Renders an order-status email and stores it in the tenant's outbox. Nothing
 * is sent here: when a session is supplied, the outbox row commits atomically
 * with the order/sale it belongs to.
 */
export const enqueueOrderStatusMail = async ({
    getModel,
    session,
    order,
    status,
    comboVouchers,
    lang
}) => {
    const StoreConfig = getModel("StoreConfig");

    // smtpPassEncrypted has select: false, so the explicit "+field" is required.
    // The password stays encrypted here; only the worker decrypts it at send time.
    const query = StoreConfig.findOne({ key: STORE_CONFIG_KEY })
        .select("name phone whatsapp currency smtpUser smtpPassEncrypted adminBccEmail +smtpPassEncrypted");
    const config = await (session ? query.session(session) : query).lean();

    if (!config?.smtpUser || !config?.smtpPassEncrypted) {
        console.warn("[outbox] tenant SMTP not configured; skipping enqueue", {
            orderCode: order?.code
        });
        return { enqueued: false, reason: "not_configured" };
    }

    if (!order?.customerEmail) {
        console.warn("[outbox] order has no customer email; skipping enqueue", {
            orderCode: order?.code
        });
        return { enqueued: false, reason: "no_recipient" };
    }

    const mail = buildOrderStatusMail({
        order,
        status,
        storeConfig: config,
        comboVouchers,
        lang
    });

    const entry = {
        orderId: order._id,
        orderCode: order.code || "",
        status: "pending",
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date(),
        to: order.customerEmail,
        bcc: config.adminBccEmail || "",
        subject: mail.subject,
        html: mail.html,
        text: mail.text || ""
    };

    // The array form makes Mongoose forward the session to the insert, so the
    // queue row and the order either both commit or both roll back.
    const MailOutbox = getModel("MailOutbox");
    const [doc] = session
        ? await MailOutbox.create([entry], { session })
        : await MailOutbox.create([entry]);

    console.info("[outbox] enqueued order-status mail", {
        id: doc._id.toString(),
        orderCode: entry.orderCode,
        status,
        to: entry.to,
        bcc: entry.bcc || "(none)",
        subject: entry.subject
    });

    return { enqueued: true, id: doc._id };
};
