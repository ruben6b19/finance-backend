// ./utils/i18nErrorResponse.js

/**
 * Función helper para manejar la traducción y el envío de respuestas de ERROR (4xx y 5xx).
 * @param {object} res - Objeto de respuesta de Express.
 * @param {string} lang - Código de idioma solicitado (ej: 'es', 'en').
 * @param {string} errorCode - Clave de traducción del error (ej: 'error_invalid_subject_id').
 * @param {number} statusCode - Código de estado HTTP (ej: 400, 404, 500).
 * @param {object} translations - Objeto global de traducciones ({ es: esTranslations, en: enTranslations }).
 * @returns {object} Respuesta JSON de error traducida.
 */
export const translateErrorResponse = (res, lang, errorCode, statusCode, translations) => {
    // Intenta usar el idioma solicitado (lang), luego español (es), y finalmente un fallback estático
    const message = translations[lang]?.[errorCode] || translations.es[errorCode] || 'An unexpected error occurred.';
    
    return res.status(statusCode).json({
        success: false,
        statusCode: statusCode,
        message: message
    });
};