import mongoose, { Schema } from "mongoose";
import { DEFAULT_TIME_ZONE } from "../../utils/boliviaTime.js";
import { SCHEDULE_MODE, SCHEDULE_MODES } from "../../utils/storeScheduleModes.js";

// Fixed key that guarantees a single store schedule document.
export const STORE_SCHEDULE_KEY = "store-schedule";

const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const isTime = (value) => typeof value === "string" && HHMM_PATTERN.test(value);

const isValidTimeZone = (value) => {
    if (typeof value !== "string" || value.trim() === "") return false;
    try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
    } catch (error) {
        return false;
    }
};

const storeScheduleSchema = new Schema(
    {
        key: {
            type: String,
            required: true,
            unique: true,
            default: STORE_SCHEDULE_KEY,
            immutable: true
        },
        // IANA time zone (not a fixed offset) so DST is handled automatically.
        timezone: {
            type: String,
            trim: true,
            required: true,
            default: DEFAULT_TIME_ZONE
        },
        autoScheduleEnabled: { type: Boolean, default: true },
        openTime: {
            type: String,
            trim: true,
            default: "08:00",
            validate: { validator: isTime, message: "error_store_schedule_invalid" }
        },
        closeTime: {
            type: String,
            trim: true,
            default: "21:00",
            validate: { validator: isTime, message: "error_store_schedule_invalid" }
        },
        // 0 = Sunday, 1 = Monday ... 6 = Saturday.
        closedDays: {
            type: [{
                type: Number,
                min: 0,
                max: 6,
                validate: { validator: Number.isInteger, message: "error_store_schedule_invalid" }
            }],
            default: [0]
        },
        scheduleMode: {
            type: Number,
            enum: [...SCHEDULE_MODES],
            default: SCHEDULE_MODE.AUTO
        },
        // Empty means the forced-open window has no end.
        forceOpenUntil: {
            type: String,
            trim: true,
            default: "",
            validate: {
                validator: (value) => value === "" || isTime(value),
                message: "error_store_schedule_invalid"
            }
        }
    },
    {
        timestamps: true
    }
);

storeScheduleSchema.path("timezone").validate({
    validator: isValidTimeZone,
    message: "error_store_schedule_invalid"
});

// Windows never cross midnight: a later open than close is a configuration
// error instead of an implicit next-day window.
storeScheduleSchema.pre("validate", function () {
    if (
        typeof this.openTime === "string" &&
        typeof this.closeTime === "string" &&
        this.openTime >= this.closeTime
    ) {
        this.invalidate("openTime", "error_store_schedule_invalid");
    }
});

storeScheduleSchema.statics.getSingleton = function () {
    return this.findOne({ key: STORE_SCHEDULE_KEY });
};

export const StoreSchedule = mongoose.model("StoreSchedule", storeScheduleSchema);
