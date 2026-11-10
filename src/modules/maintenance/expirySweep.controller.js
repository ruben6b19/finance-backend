import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { runExpirySweep as executeExpirySweep } from "./expiry.service.js";
import { ROLES } from "../../constants/roles.js";
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

const hasRole = (req, allowedRoles) => {
    const roles = req.user?.role;
    if (roles === undefined || roles === null) return false;
    const list = Array.isArray(roles) ? roles : [roles];
    return list.some((role) => allowedRoles.includes(Number(role)));
};

const runExpirySweep = asyncHandler(async (req, res) => {
    const lang = getLang(req);

    // Barrido administrativo: expira promesas vencidas, nunca mueve stock ni dinero.
    if (!hasRole(req, [ROLES.ADMIN, ROLES.SUPERVISOR])) {
        return translateErrorResponse(res, lang, "error_expiry_sweep_forbidden", 403, translations);
    }

    const dryRun = req.body?.dryRun === true;

    try {
        const result = await executeExpirySweep({ dryRun });

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    ranAt: result.ranAt,
                    reservations: result.reservations,
                    vouchers: result.vouchers,
                    dryRun
                },
                translations[lang]?.success_expiry_sweep || "success_expiry_sweep"
            )
        );
    } catch (error) {
        console.error("Error running expiry sweep:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

export {
    runExpirySweep
};
