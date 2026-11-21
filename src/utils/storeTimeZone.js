import { STORE_SCHEDULE_KEY } from "../modules/storeConfig/storeSchedule.model.js";
import { getRequestModelResolver } from "../modules/tenants/requestModel.js";
import { DEFAULT_TIME_ZONE } from "./boliviaTime.js";

/**
 * Reads the tenant's configured IANA time zone from its StoreSchedule.
 * Accepts a tenant model resolver so non-request callers (mail, workers) use
 * the same source of truth. A failed read must not break the request: the
 * legacy Bolivia zone is used as the fallback.
 */
export const getStoreTimeZone = async (getModel) => {
    try {
        const StoreSchedule = getModel("StoreSchedule");
        const schedule = typeof StoreSchedule.getSingleton === "function"
            ? await StoreSchedule.getSingleton()
            : await StoreSchedule.findOne({ key: STORE_SCHEDULE_KEY }).lean();
        return schedule?.timezone || DEFAULT_TIME_ZONE;
    } catch (error) {
        console.warn("[timezone] falling back to the default store time zone:", error?.message);
        return DEFAULT_TIME_ZONE;
    }
};

/**
 * Request-bound wrapper kept for all existing business-rule callers.
 */
export const getRequestTimeZone = async (req) => {
    let getModel;
    try {
        getModel = getRequestModelResolver(req);
    } catch (error) {
        console.warn("[timezone] falling back to the default store time zone:", error?.message);
        return DEFAULT_TIME_ZONE;
    }
    return getStoreTimeZone(getModel);
};
