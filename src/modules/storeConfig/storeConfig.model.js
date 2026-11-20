import mongoose, { Schema } from "mongoose";
import { DEFAULT_TIME_ZONE } from "../../utils/boliviaTime.js";

// Fixed key that guarantees a single store configuration document.
export const STORE_CONFIG_KEY = "store";

const storeConfigSchema = new Schema(
    {
        key: {
            type: String,
            required: true,
            unique: true,
            default: STORE_CONFIG_KEY,
            immutable: true
        },
        name: {
            type: String,
            required: true,
            trim: true
        },
        razonSocial: {
            type: String,
            trim: true,
            default: ""
        },
        nit: {
            type: String,
            trim: true,
            default: ""
        },
        phone: {
            type: String,
            trim: true,
            default: ""
        },
        whatsapp: {
            type: String,
            trim: true,
            default: ""
        },
        address: {
            type: String,
            trim: true,
            default: ""
        },
        // Store geo coordinates for storefront display. null means "not
        // configured" — never invent coordinates for a store.
        latitude: { type: Number, default: null },
        longitude: { type: Number, default: null },
        currency: {
            type: String,
            trim: true,
            default: "Bs."
        },
        // IANA time zone (not a fixed offset) so DST is handled automatically.
        timezone: {
            type: String,
            trim: true,
            default: DEFAULT_TIME_ZONE
        },
        // Drive storefront delivery-option visibility.
        dineInEnabled: { type: Boolean, default: true },
        pickupEnabled: { type: Boolean, default: true },
        deliveryEnabled: { type: Boolean, default: true },
        ticketFooter: {
            type: String,
            trim: true,
            default: "¡Gracias por su preferencia!"
        },
        logoUrl: {
            type: String,
            trim: true,
            default: ""
        },
        smtpUser: {
            type: String,
            default: "",
            trim: true
        },
        smtpPassEncrypted: {
            type: String,
            default: "",
            select: false
        },
        adminBccEmail: {
            type: String,
            default: "",
            trim: true
        }
    },
    {
        timestamps: true
    }
);

storeConfigSchema.path("timezone").validate({
    validator: (value) => {
        if (typeof value !== "string" || value.trim() === "") return false;
        try {
            new Intl.DateTimeFormat("en", { timeZone: value });
            return true;
        } catch (error) {
            return false;
        }
    },
    message: "error_store_config_invalid_timezone"
});

storeConfigSchema.statics.getSingleton = function () {
    return this.findOne({ key: STORE_CONFIG_KEY });
};

export const StoreConfig = mongoose.model("StoreConfig", storeConfigSchema);
