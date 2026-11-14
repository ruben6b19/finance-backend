import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { StoreConfig, STORE_CONFIG_KEY } from "./storeConfig.model.js";
import esTranslations from './es.json' with { type: 'json' };
import enTranslations from './en.json' with { type: 'json' };
import { translateErrorResponse } from "../../utils/i18nErrorResponse.js";

const translations = {
    es: esTranslations,
    en: enTranslations
};

const getLang = (req) => {
    return req.headers['accept-language']?.split(',')[0].substring(0, 2) || req.user?.instituteLang || 'es';
};

const getStoreConfig = asyncHandler(async (req, res) => {
    const lang = getLang(req);

    try {
        const config = await StoreConfig.findOne({ key: STORE_CONFIG_KEY })
            .select("name razonSocial nit phone whatsapp address currency ticketFooter logoUrl -_id")
            .lean();

        if (!config) {
            return translateErrorResponse(res, lang, "error_store_config_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(200, config, translations[lang]?.success_store_config_fetched || "success_store_config_fetched")
        );
    } catch (error) {
        console.error("Error fetching store config:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

export { getStoreConfig };
