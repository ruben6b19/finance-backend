// Global JSON error handler. Mounted last so no thrown error reaches the
// default Express HTML error handler.

const MESSAGES = {
    es: {
        generic: "Ha ocurrido un error inesperado en el servidor.",
        badRequest: "La solicitud no es válida.",
        conflict: "La solicitud entra en conflicto con un recurso existente.",
        fallback: "La solicitud no pudo procesarse.",
        notFound: "Recurso no encontrado."
    },
    en: {
        generic: "An unexpected error occurred on the server.",
        badRequest: "The request is invalid.",
        conflict: "The request conflicts with an existing resource.",
        fallback: "The request could not be processed.",
        notFound: "Resource not found."
    }
};

const getLang = (req) => {
    const header = req?.headers?.["accept-language"];
    if (typeof header !== "string") return "es";
    const prefix = header.split(",")[0].substring(0, 2).toLowerCase();
    return prefix === "en" ? "en" : "es";
};

const isClientErrorStatus = (value) => Number.isInteger(value) && value >= 400 && value <= 599;

// body-parser 2.x marks malformed JSON with type "entity.parse.failed" and a
// 400 status, so this must be checked before trusting err.statusCode/status.
const isJsonParseError = (err) =>
    err?.type === "entity.parse.failed" || (err instanceof SyntaxError && err?.status === 400);

const resolveStatusCode = (err) => {
    if (isJsonParseError(err)) return 400;

    if (isClientErrorStatus(err?.statusCode)) return err.statusCode;
    if (isClientErrorStatus(err?.status)) return err.status;

    if (err?.name === "ValidationError" || err?.name === "CastError") return 400;
    if (err?.code === 11000) return 409;

    return 500;
};

const resolveMessage = (err, statusCode, lang) => {
    const messages = MESSAGES[lang];

    if (statusCode >= 500) {
        return messages.generic;
    }

    // Never expose parser internals (positions, token names) to the client.
    if (isJsonParseError(err)) {
        return messages.badRequest;
    }

    if (typeof err?.message === "string" && err.message.trim() !== "") {
        return err.message;
    }

    if (statusCode === 400) return messages.badRequest;
    if (statusCode === 409) return messages.conflict;

    return messages.fallback;
};

const logError = (err, req, statusCode) => {
    const method = req?.method || "UNKNOWN";
    const url = req?.originalUrl || req?.url || "";

    if (statusCode >= 500) {
        // Full error (including stack) for server errors. Headers and body are
        // intentionally never logged.
        console.error(`[error] ${method} ${url} ${statusCode}`, err);
        return;
    }

    // Single line without stack for client errors.
    console.warn(`[warn] ${method} ${url} ${statusCode} - ${err?.message}`);
};

const errorHandler = (err, req, res, next) => {
    if (res.headersSent) {
        return next(err);
    }

    const statusCode = resolveStatusCode(err);
    const lang = getLang(req);
    const message = resolveMessage(err, statusCode, lang);

    logError(err, req, statusCode);

    return res.status(statusCode).json({
        success: false,
        statusCode,
        message
    });
};

// Catch-all 404 for unmatched routes. Exactly three parameters so Express
// treats it as normal middleware (four would make it an error handler).
const notFoundHandler = (req, res, _next) => {
    const message = MESSAGES[getLang(req)].notFound;

    return res.status(404).json({
        success: false,
        statusCode: 404,
        message
    });
};

export { errorHandler, notFoundHandler };
