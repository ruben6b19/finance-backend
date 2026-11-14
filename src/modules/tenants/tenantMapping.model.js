import mongoose, { Schema } from "mongoose";

const tenantMappingSchema = new Schema(
    {
        email: {
            type: String,
            required: true,
            unique: true,
            index: true,
            lowercase: true,
            trim: true
        },
        dbName: {
            type: String,
            required: true,
            trim: true
        }
    },
    {
        timestamps: true
    }
);

export const TenantMapping = mongoose.model("TenantMapping", tenantMappingSchema);
