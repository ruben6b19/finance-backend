import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { STORE_CONFIG_KEY } from "./storeConfig.model.js";
import { STORE_SCHEDULE_KEY } from "./storeSchedule.model.js";
import { evaluateStoreOpenState } from "../../utils/storeSchedule.js";
import { getRequestModel } from "../tenants/requestModel.js";
import esTranslations from './es.json' with { type: 'json' };
import enTranslations from './en.json' with { type: 'json' };
import { translateErrorResponse } from "../../utils/i18nErrorResponse.js";
import { ROLES } from "../../constants/roles.js";
import { hasRoleAtLeast } from "../../utils/roles.js";
import { encrypt } from "../../utils/mailCrypto.js";
import { DEFAULT_TIME_ZONE } from "../../utils/boliviaTime.js";
import { SCHEDULE_MODE, isScheduleMode, normalizeScheduleMode } from "../../utils/storeScheduleModes.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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

// Reading the schedule is best effort everywhere: a store provisioned before
// this feature has no document yet and must keep working (fail-open).
const readStoreSchedule = async (req) => {
    try {
        return await getRequestModel(req, "StoreSchedule").getSingleton();
    } catch (error) {
        console.warn("[schedule] falling back to a missing schedule:", error?.message);
        return null;
    }
};

const toAdminScheduleResponse = (schedule) => {
    const state = evaluateStoreOpenState(schedule);
    return {
        timezone: schedule.timezone || DEFAULT_TIME_ZONE,
        autoScheduleEnabled: schedule.autoScheduleEnabled ?? true,
        openTime: schedule.openTime || "08:00",
        closeTime: schedule.closeTime || "21:00",
        closedDays: Array.isArray(schedule.closedDays) ? schedule.closedDays : [0],
        scheduleMode: normalizeScheduleMode(schedule.scheduleMode),
        forceOpenUntil: schedule.forceOpenUntil || "",
        isOpen: state.isOpen,
        effectiveMode: state.effectiveMode
    };
};

const translations = {
    es: esTranslations,
    en: enTranslations
};

const getLang = (req) => {
    return req.headers['accept-language']?.split(',')[0].substring(0, 2) || req.user?.instituteLang || 'es';
};

/**
 * Public shape of the store settings: the storefront shows the store name,
 * the three delivery-option visibility flags, the store coordinates and its
 * IANA time zone before anyone signs in, but this route never exposes the
 * fiscal or contact data the authenticated route returns.
 */
const getPublicStoreConfig = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    // The tenant comes from the X-Store header (requireStore), because a
    // public request has no authenticated user to resolve it from.
    const StoreConfig = getRequestModel(req, "StoreConfig");
    const schedule = await readStoreSchedule(req);
    const openState = evaluateStoreOpenState(schedule);

    try {
        const config = await StoreConfig.findOne({ key: STORE_CONFIG_KEY })
            .select("name latitude longitude dineInEnabled pickupEnabled deliveryEnabled -_id")
            .lean();

        if (!config) {
            return translateErrorResponse(res, lang, "error_store_config_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    name: config.name,
                    latitude: config.latitude ?? null,
                    longitude: config.longitude ?? null,
                    // Kept on this endpoint for existing clients, now owned by StoreSchedule.
                    timezone: schedule?.timezone || DEFAULT_TIME_ZONE,
                    isOpen: openState.isOpen,
                    scheduleMode: openState.effectiveMode,
                    dineInEnabled: config.dineInEnabled ?? true,
                    pickupEnabled: config.pickupEnabled ?? true,
                    deliveryEnabled: config.deliveryEnabled ?? true
                },
                translations[lang]?.success_store_name_fetched || "success_store_name_fetched"
            )
        );
    } catch (error) {
        console.error("Error fetching public store config:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getStoreConfig = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    // Every store keeps its own settings, so the document is read from the
    // database of the authenticated user, never from the central one.
    const StoreConfig = getRequestModel(req, "StoreConfig");

    try {
        const config = await StoreConfig.findOne({ key: STORE_CONFIG_KEY })
            .select("name razonSocial nit phone whatsapp address latitude longitude currency dineInEnabled pickupEnabled deliveryEnabled ticketFooter logoUrl -_id")
            .lean();

        if (!config) {
            return translateErrorResponse(res, lang, "error_store_config_not_found", 404, translations);
        }

        const data = { ...config };

        return res.status(200).json(
            new ApiResponse(200, data, translations[lang]?.success_store_config_fetched || "success_store_config_fetched")
        );
    } catch (error) {
        console.error("Error fetching store config:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const updateDeliveryOptions = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const StoreConfig = getRequestModel(req, "StoreConfig");

    try {
        if (!hasRoleAtLeast(req, ROLES.ADMIN)) {
            return translateErrorResponse(res, lang, "error_store_config_admin_only", 403, translations);
        }

        const { dineInEnabled, pickupEnabled, deliveryEnabled } = req.body || {};

        if (
            typeof dineInEnabled !== "boolean" ||
            typeof pickupEnabled !== "boolean" ||
            typeof deliveryEnabled !== "boolean"
        ) {
            return translateErrorResponse(res, lang, "error_store_config_invalid_delivery_options", 400, translations);
        }

        const config = await StoreConfig.findOneAndUpdate(
            { key: STORE_CONFIG_KEY },
            {
                $set: {
                    dineInEnabled,
                    pickupEnabled,
                    deliveryEnabled
                }
            },
            { new: true, runValidators: true }
        );

        if (!config) {
            return translateErrorResponse(res, lang, "error_store_config_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    dineInEnabled: config.dineInEnabled,
                    pickupEnabled: config.pickupEnabled,
                    deliveryEnabled: config.deliveryEnabled
                },
                translations[lang]?.success_store_delivery_options_saved || "success_store_delivery_options_saved"
            )
        );
    } catch (error) {
        console.error("Error updating store delivery options:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const updateCoordinates = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const StoreConfig = getRequestModel(req, "StoreConfig");

    try {
        if (!hasRoleAtLeast(req, ROLES.ADMIN)) {
            return translateErrorResponse(res, lang, "error_store_config_admin_only", 403, translations);
        }

        const { latitude, longitude } = req.body || {};

        // null clears a coordinate; otherwise both values must be finite numbers
        // in range. Missing fields are undefined and therefore rejected, so
        // partial updates are not allowed. Strings are never coerced.
        const isLatitudeValid =
            latitude === null ||
            (typeof latitude === "number" && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90);
        const isLongitudeValid =
            longitude === null ||
            (typeof longitude === "number" && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180);

        if (!isLatitudeValid || !isLongitudeValid) {
            return translateErrorResponse(res, lang, "error_store_config_invalid_coordinates", 400, translations);
        }

        const config = await StoreConfig.findOneAndUpdate(
            { key: STORE_CONFIG_KEY },
            {
                $set: {
                    latitude,
                    longitude
                }
            },
            { new: true, runValidators: true }
        );

        if (!config) {
            return translateErrorResponse(res, lang, "error_store_config_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(
                200,
                { latitude: config.latitude, longitude: config.longitude },
                translations[lang]?.success_store_coordinates_saved || "success_store_coordinates_saved"
            )
        );
    } catch (error) {
        console.error("Error updating store coordinates:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

/**
 * Updates the tenant's general store data. All nine fields are required as
 * strings so a partial update can never silently clear a value; every field is
 * trimmed before it is stored, and only the store name must be non-blank.
 */
const updateGeneralStoreConfig = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const StoreConfig = getRequestModel(req, "StoreConfig");

    try {
        if (!hasRoleAtLeast(req, ROLES.ADMIN)) {
            return translateErrorResponse(res, lang, "error_store_config_admin_only", 403, translations);
        }

        const { name, razonSocial, nit, phone, whatsapp, address, currency, ticketFooter, logoUrl } = req.body || {};

        // null and missing values are not strings, so they are rejected here.
        // Short-circuiting keeps name.trim() safe when the body is malformed.
        const allFieldsAreStrings = [name, razonSocial, nit, phone, whatsapp, address, currency, ticketFooter, logoUrl]
            .every((value) => typeof value === "string");

        if (!allFieldsAreStrings || name.trim().length === 0) {
            return translateErrorResponse(res, lang, "error_store_config_invalid_general_data", 400, translations);
        }

        const config = await StoreConfig.findOneAndUpdate(
            { key: STORE_CONFIG_KEY },
            {
                $set: {
                    name: name.trim(),
                    razonSocial: razonSocial.trim(),
                    nit: nit.trim(),
                    phone: phone.trim(),
                    whatsapp: whatsapp.trim(),
                    address: address.trim(),
                    currency: currency.trim(),
                    ticketFooter: ticketFooter.trim(),
                    logoUrl: logoUrl.trim()
                }
            },
            { new: true, runValidators: true }
        );

        if (!config) {
            return translateErrorResponse(res, lang, "error_store_config_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    name: config.name,
                    razonSocial: config.razonSocial,
                    nit: config.nit,
                    phone: config.phone,
                    whatsapp: config.whatsapp,
                    address: config.address,
                    currency: config.currency,
                    ticketFooter: config.ticketFooter,
                    logoUrl: config.logoUrl
                },
                translations[lang]?.success_store_general_data_saved || "success_store_general_data_saved"
            )
        );
    } catch (error) {
        console.error("Error updating general store data:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

/**
 * Stores the SMTP credentials of the request tenant. The password is encrypted
 * before it reaches the database and is never included in the response.
 */
const updateMailConfig = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const StoreConfig = getRequestModel(req, "StoreConfig");

    try {
        if (!hasRoleAtLeast(req, ROLES.ADMIN)) {
            return translateErrorResponse(res, lang, "error_store_config_admin_only", 403, translations);
        }

        const { smtpUser, smtpPassword, adminBccEmail } = req.body || {};
        const trimmedUser = typeof smtpUser === "string" ? smtpUser.trim() : "";
        const trimmedBcc = typeof adminBccEmail === "string" ? adminBccEmail.trim() : "";
        const hasPassword = typeof smtpPassword === "string" && smtpPassword.length > 0;

        if (!trimmedUser || !hasPassword || !EMAIL_PATTERN.test(trimmedBcc)) {
            return translateErrorResponse(res, lang, "error_store_config_invalid_mail", 400, translations);
        }

        let encryptedPassword;
        try {
            encryptedPassword = encrypt(smtpPassword);
        } catch (error) {
            console.error("Error encrypting the store mail password:", error);
            return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
        }

        const config = await StoreConfig.findOneAndUpdate(
            { key: STORE_CONFIG_KEY },
            {
                $set: {
                    smtpUser: trimmedUser,
                    smtpPassEncrypted: encryptedPassword,
                    adminBccEmail: trimmedBcc
                }
            },
            { new: true, runValidators: true }
        );

        if (!config) {
            return translateErrorResponse(res, lang, "error_store_config_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(
                200,
                { smtpUser: config.smtpUser, adminBccEmail: config.adminBccEmail },
                translations[lang]?.success_store_mail_config_saved || "success_store_mail_config_saved"
            )
        );
    } catch (error) {
        console.error("Error updating store mail config:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

/**
 * Returns the tenant's full store schedule plus the evaluated open state.
 * This is an admin-only view: stored mode and effective mode are both exposed
 * so an expired SCHEDULE_MODE.FORCE_OPEN window is visible without mutating the
 * document.
 */
const getStoreSchedule = asyncHandler(async (req, res) => {
    const lang = getLang(req);

    try {
        if (!hasRoleAtLeast(req, ROLES.ADMIN)) {
            return translateErrorResponse(res, lang, "error_store_config_admin_only", 403, translations);
        }

        const schedule = await readStoreSchedule(req);
        if (!schedule) {
            return translateErrorResponse(res, lang, "error_store_config_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(
                200,
                toAdminScheduleResponse(schedule),
                translations[lang]?.success_store_config_fetched || "success_store_config_fetched"
            )
        );
    } catch (error) {
        console.error("Error fetching store schedule:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

/**
 * Replaces the tenant's schedule. Every field is mandatory so a partial update
 * can never leave an inconsistent window; all values are validated before the
 * write, including the no-midnight-crossing open/close constraint.
 */
const updateStoreSchedule = asyncHandler(async (req, res) => {
    const lang = getLang(req);

    try {
        if (!hasRoleAtLeast(req, ROLES.ADMIN)) {
            return translateErrorResponse(res, lang, "error_store_config_admin_only", 403, translations);
        }

        const { timezone, autoScheduleEnabled, openTime, closeTime, closedDays, scheduleMode, forceOpenUntil } = req.body || {};
        const trimmedTimezone = typeof timezone === "string" ? timezone.trim() : "";
        const trimmedOpen = typeof openTime === "string" ? openTime.trim() : "";
        const trimmedClose = typeof closeTime === "string" ? closeTime.trim() : "";
        const trimmedUntil = typeof forceOpenUntil === "string" ? forceOpenUntil.trim() : "";

        const isValid =
            isValidTimeZone(trimmedTimezone) &&
            typeof autoScheduleEnabled === "boolean" &&
            isTime(trimmedOpen) &&
            isTime(trimmedClose) &&
            trimmedOpen < trimmedClose &&
            Array.isArray(closedDays) &&
            closedDays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) &&
            isScheduleMode(scheduleMode) &&
            typeof forceOpenUntil === "string" &&
            (trimmedUntil === "" || isTime(trimmedUntil));

        if (!isValid) {
            return translateErrorResponse(res, lang, "error_store_schedule_invalid", 400, translations);
        }

        const StoreSchedule = getRequestModel(req, "StoreSchedule");
        const schedule = await StoreSchedule.findOneAndUpdate(
            { key: STORE_SCHEDULE_KEY },
            {
                $set: {
                    timezone: trimmedTimezone,
                    autoScheduleEnabled,
                    openTime: trimmedOpen,
                    closeTime: trimmedClose,
                    closedDays,
                    scheduleMode,
                    forceOpenUntil: trimmedUntil
                }
            },
            { new: true, runValidators: true }
        );

        if (!schedule) {
            return translateErrorResponse(res, lang, "error_store_config_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(
                200,
                toAdminScheduleResponse(schedule),
                translations[lang]?.success_store_schedule_saved || "success_store_schedule_saved"
            )
        );
    } catch (error) {
        console.error("Error updating store schedule:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

/**
 * Instant pause/resume toggle. SCHEDULE_MODE.FORCE_CLOSED wins over every other
 * setting; SCHEDULE_MODE.FORCE_OPEN may carry an optional local HH:mm expiry,
 * after which evaluation falls back to SCHEDULE_MODE.AUTO without rewriting the
 * stored mode.
 */
const updateStoreScheduleMode = asyncHandler(async (req, res) => {
    const lang = getLang(req);

    try {
        if (!hasRoleAtLeast(req, ROLES.ADMIN)) {
            return translateErrorResponse(res, lang, "error_store_config_admin_only", 403, translations);
        }

        const { scheduleMode, forceOpenUntil } = req.body || {};
        const hasUntil = forceOpenUntil !== undefined;
        const trimmedUntil = typeof forceOpenUntil === "string" ? forceOpenUntil.trim() : "";

        const isValid =
            isScheduleMode(scheduleMode) &&
            (!hasUntil || (typeof forceOpenUntil === "string" && (trimmedUntil === "" || isTime(trimmedUntil))));

        if (!isValid) {
            return translateErrorResponse(res, lang, "error_store_schedule_invalid", 400, translations);
        }

        const patch = { scheduleMode };
        if (hasUntil) patch.forceOpenUntil = trimmedUntil;

        const StoreSchedule = getRequestModel(req, "StoreSchedule");
        const schedule = await StoreSchedule.findOneAndUpdate(
            { key: STORE_SCHEDULE_KEY },
            { $set: patch },
            { new: true, runValidators: true }
        );

        if (!schedule) {
            return translateErrorResponse(res, lang, "error_store_config_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(
                200,
                toAdminScheduleResponse(schedule),
                translations[lang]?.success_store_schedule_saved || "success_store_schedule_saved"
            )
        );
    } catch (error) {
        console.error("Error updating store schedule mode:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

export {
    getStoreConfig,
    getPublicStoreConfig,
    updateDeliveryOptions,
    updateCoordinates,
    updateGeneralStoreConfig,
    updateMailConfig,
    getStoreSchedule,
    updateStoreSchedule,
    updateStoreScheduleMode
};
