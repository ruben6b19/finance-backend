import mongoose, { Schema } from "mongoose";
import { STATUS } from "../../constants/roles.js";

/**
 * Central store registry: maps the public slug (sent by clients in the
 * X-Store header) to the database that holds the store data.
 *
 * This model lives in the CENTRAL database only. It is intentionally excluded
 * from TENANT_MODEL_SCHEMAS: a store database must never carry it.
 */
const storeSchema = new Schema(
    {
        slug: {
            type: String,
            required: true,
            unique: true,
            index: true,
            lowercase: true,
            trim: true,
            match: /^[a-z0-9]+(-[a-z0-9]+)*$/
        },
        dbName: {
            type: String,
            required: true,
            unique: true,
            index: true,
            trim: true
        },
        name: {
            type: String,
            required: true,
            trim: true
        },
        status: {
            type: Number,
            enum: Object.values(STATUS),
            default: STATUS.ACTIVE
        }
    },
    {
        timestamps: true
    }
);

export const Store = mongoose.model("Store", storeSchema);
