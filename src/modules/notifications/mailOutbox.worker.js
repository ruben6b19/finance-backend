import { STORE_CONFIG_KEY } from "../storeConfig/storeConfig.model.js";
import { sendRawMail } from "./mail.service.js";

const TERMINAL_REASONS = new Set(["not_configured", "no_recipient", "decrypt_failed"]);

// 60s, 120s, 240s... capped at six hours.
const backoffMs = (attempt) =>
    Math.min(60_000 * 2 ** (attempt - 1), 6 * 60 * 60 * 1000);

/**
 * Delivers tenant outbox entries. A single findOneAndUpdate claims each entry
 * (pending -> processing), so concurrent workers cannot send the same mail
 * twice. Each tenant is isolated: one broken store never blocks the others.
 */
export const runMailOutboxSweep = async ({
    targets,
    getModelFor,
    createTransport,
    now = new Date(),
    limit = 50,
    staleMs = 10 * 60 * 1000,
    maxAttempts = 5
}) => {
    const summary = {
        scannedTargets: 0,
        claimed: 0,
        sent: 0,
        retried: 0,
        failed: 0,
        perTarget: []
    };

    const at = now instanceof Date ? now : new Date(now);
    const staleBefore = new Date(at.getTime() - staleMs);

    for (const dbName of targets) {
        const perTarget = { dbName, claimed: 0, sent: 0, retried: 0, failed: 0 };
        summary.scannedTargets += 1;

        try {
            const MailOutbox = getModelFor(dbName, "MailOutbox");

            // A claim left behind by a crashed worker becomes available again.
            await MailOutbox.updateMany(
                { status: "processing", lockedAt: { $lt: staleBefore } },
                { $set: { status: "pending", lockedAt: null } }
            );

            for (let iteration = 0; iteration < limit; iteration += 1) {
                const entry = await MailOutbox.findOneAndUpdate(
                    { status: "pending", nextAttemptAt: { $lte: at } },
                    { $set: { status: "processing", lockedAt: at } },
                    { new: true, sort: { nextAttemptAt: 1 } }
                );
                if (!entry) break;

                perTarget.claimed += 1;
                summary.claimed += 1;
                console.info("[outbox] claimed entry", {
                    id: entry._id.toString(),
                    dbName,
                    to: entry.to,
                    attempts: entry.attempts || 0
                });

                try {
                    let result = null;
                    let error = null;
                    try {
                        const StoreConfig = getModelFor(dbName, "StoreConfig");
                        const config = await StoreConfig.findOne({ key: STORE_CONFIG_KEY })
                            .select("+smtpPassEncrypted")
                            .lean();

                        result = await sendRawMail({
                            config,
                            to: entry.to,
                            subject: entry.subject,
                            html: entry.html,
                            text: entry.text,
                            createTransport
                        });
                    } catch (caught) {
                        error = caught;
                    }

                    if (result?.sent === true) {
                        await MailOutbox.updateOne(
                            { _id: entry._id, status: "processing" },
                            { $set: { status: "sent", sentAt: at, lockedAt: null, lastError: "" } }
                        );
                        perTarget.sent += 1;
                        summary.sent += 1;
                        console.info("[outbox] mail sent", {
                            id: entry._id.toString(), dbName, to: entry.to, bcc: entry.bcc || "(none)"
                        });
                    } else if (result?.sent === false && TERMINAL_REASONS.has(result.reason)) {
                        await MailOutbox.updateOne(
                            { _id: entry._id, status: "processing" },
                            { $set: { status: "failed", lockedAt: null, lastError: result.reason } }
                        );
                        perTarget.failed += 1;
                        summary.failed += 1;
                        console.warn("[outbox] mail failed permanently", {
                            id: entry._id.toString(), dbName, to: entry.to, reason: result.reason
                        });
                    } else {
                        // Transport failure or any unclassified result: retry
                        // with backoff, or give up once the attempt budget is spent.
                        const attempts = (entry.attempts || 0) + 1;
                        const exhausted = attempts >= (entry.maxAttempts || maxAttempts);
                        const lastError = String(error?.message || result?.reason || "send failed");
                        const patch = exhausted
                            ? { status: "failed", lockedAt: null, lastError }
                            : {
                                  status: "pending",
                                  lockedAt: null,
                                  attempts,
                                  nextAttemptAt: new Date(at.getTime() + backoffMs(attempts)),
                                  lastError
                              };

                        await MailOutbox.updateOne(
                            { _id: entry._id, status: "processing" },
                            { $set: patch }
                        );

                        if (exhausted) {
                            perTarget.failed += 1;
                            summary.failed += 1;
                        } else {
                            perTarget.retried += 1;
                            summary.retried += 1;
                        }
                        console.warn("[outbox] mail attempt failed", {
                            id: entry._id.toString(), dbName, to: entry.to,
                            attempts, exhausted, nextAttemptAt: patch.nextAttemptAt, lastError
                        });
                    }
                } catch (entryError) {
                    // Keep the claim for the stale-reset on the next sweep; one
                    // poisoned row must never abort the rest of the batch.
                    console.error(`[outbox] failed to process entry ${entry._id}`, entryError);
                }
            }
        } catch (error) {
            perTarget.error = error?.message || String(error);
            console.error(`[outbox] sweep failed for ${dbName}`, error);
        }

        summary.perTarget.push(perTarget);
    }

    return summary;
};
