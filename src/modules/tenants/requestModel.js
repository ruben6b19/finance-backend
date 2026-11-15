import { ApiError } from "../../utils/ApiError.js";

/**
 * Returns the model bound to the database of the current request.
 *
 * Routes protected by verifyFirebaseToken always carry req.tenant. A missing
 * tenant context is a wiring error, so it fails loudly instead of silently
 * falling back to the central database and mixing stores.
 */
export const getRequestModel = (req, modelName) => {
    if (!req?.tenant || typeof req.tenant.getModel !== "function") {
        throw new ApiError(500, "No se pudo resolver la tienda de la solicitud.");
    }
    return req.tenant.getModel(modelName);
};
