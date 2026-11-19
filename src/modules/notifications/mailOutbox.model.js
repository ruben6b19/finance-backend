import mongoose, { Schema } from "mongoose";

/**
 * Tenant-scoped queue of rendered order-status emails. The request path only
 * inserts documents here; a separate worker claims and delivers them, so an
 * SMTP outage can never affect a checkout or a status change.
 */
const mailOutboxSchema = new Schema(
    {
        orderId: {
            type: Schema.Types.ObjectId,
            required: true,
            index: true
        },
        orderCode: {
            type: String,
            default: ""
        },
        status: {
            type: String,
            enum: ["pending", "processing", "sent", "failed"],
            default: "pending",
            index: true
        },
        attempts: {
            type: Number,
            default: 0
        },
        maxAttempts: {
            type: Number,
            default: 5
        },
        nextAttemptAt: {
            type: Date,
            default: () => new Date()
        },
        lockedAt: {
            type: Date,
            default: null
        },
        lastError: {
            type: String,
            default: ""
        },
        sentAt: {
            type: Date,
            default: null
        },
        to: {
            type: String,
            required: true
        },
        bcc: {
            type: String,
            default: ""
        },
        subject: {
            type: String,
            required: true
        },
        html: {
            type: String,
            required: true
        },
        text: {
            type: String,
            default: ""
        }
    },
    {
        timestamps: true
    }
);

// The worker claims the earliest due pending entry; this index serves exactly
// that query and keeps the scan cheap as the outbox grows.
mailOutboxSchema.index({ status: 1, nextAttemptAt: 1 });

export const MailOutbox = mongoose.model("MailOutbox", mailOutboxSchema);
