import { getRequestModel } from "../modules/tenants/requestModel.js";
import { STORE_CONFIG_KEY } from "../modules/storeConfig/storeConfig.model.js";
import { DEFAULT_TIME_ZONE } from "./boliviaTime.js";

/**
 * Reads the tenant's configured IANA time zone for business rules.
 * A missing config or a failed read must not break the request: the legacy
 * Bolivia zone is used as the fallback.
 */
export const getRequestTimeZone = async (req) => {
    try {
        const StoreConfig = getRequestModel(req, "StoreConfig");
        const config = await StoreConfig.findOne({ key: STORE_CONFIG_KEY })
            .select("timezone")
            .lean();
        return config?.timezone || DEFAULT_TIME_ZONE;
    } catch (error) {
        console.warn("[timezone] falling back to the default store time zone:", error?.message);
        return DEFAULT_TIME_ZONE;
    }
};
