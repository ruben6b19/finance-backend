import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { STORE_CONFIG_KEY } from "./storeConfig.model.js";
import { getRequestModel } from "../tenants/requestModel.js";
import esTranslations from './es.json' with { type: 'json' };
import enTranslations from './en.json' with { type: 'json' };
import { translateErrorResponse } from "../../utils/i18nErrorResponse.js";
import { ROLES } from "../../constants/roles.js";
import { hasRoleAtLeast } from "../../utils/roles.js";
import { encrypt } from "../../utils/mailCrypto.js";
import { DEFAULT_TIME_ZONE } from "../../utils/boliviaTime.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

    try {
        const config = await StoreConfig.findOne({ key: STORE_CONFIG_KEY })
            .select("name latitude longitude timezone dineInEnabled pickupEnabled deliveryEnabled -_id")
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
                    timezone: config.timezone ?? DEFAULT_TIME_ZONE,
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
            .select("name razonSocial nit phone whatsapp address latitude longitude timezone currency dineInEnabled pickupEnabled deliveryEnabled ticketFooter logoUrl -_id")
            .lean();

        if (!config) {
            return translateErrorResponse(res, lang, "error_store_config_not_found", 404, translations);
        }

        const data = { ...config, timezone: config.timezone ?? DEFAULT_TIME_ZONE };

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
 * Sets the tenant's IANA time zone. Business windows and customer emails both
 * use this value, so numeric offsets are rejected by Intl.
 */
const updateTimezone = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const StoreConfig = getRequestModel(req, "StoreConfig");

    try {
        if (!hasRoleAtLeast(req, ROLES.ADMIN)) {
            return translateErrorResponse(res, lang, "error_store_config_admin_only", 403, translations);
        }

        const { timezone } = req.body || {};
        const trimmedTimezone = typeof timezone === "string" ? timezone.trim() : "";

        let isValid = trimmedTimezone.length > 0;
        if (isValid) {
            try {
                new Intl.DateTimeFormat("en", { timeZone: trimmedTimezone });
            } catch (error) {
                isValid = false;
            }
        }

        if (!isValid) {
            return translateErrorResponse(res, lang, "error_store_config_invalid_timezone", 400, translations);
        }

        const config = await StoreConfig.findOneAndUpdate(
            { key: STORE_CONFIG_KEY },
            { $set: { timezone: trimmedTimezone } },
            { new: true, runValidators: true }
        );

        if (!config) {
            return translateErrorResponse(res, lang, "error_store_config_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(
                200,
                { timezone: config.timezone },
                translations[lang]?.success_store_timezone_saved || "success_store_timezone_saved"
            )
        );
    } catch (error) {
        console.error("Error updating store timezone:", error);
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

export { getStoreConfig, getPublicStoreConfig, updateDeliveryOptions, updateCoordinates, updateTimezone, updateMailConfig };
