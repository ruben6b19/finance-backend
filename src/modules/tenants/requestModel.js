import mongoose from "mongoose";
import { ApiError } from "../../utils/ApiError.js";

/**
 * Returns the model resolver bound to the database of the current request.
 *
 * Routes protected by verifyFirebaseToken always carry req.tenant. A missing
 * tenant context is a wiring error, so it fails loudly instead of silently
 * falling back to the central database and mixing stores.
 */
export const getRequestModelResolver = (req) => {
    if (!req?.tenant || typeof req.tenant.getModel !== "function") {
        throw new ApiError(500, "No se pudo resolver la tienda de la solicitud.");
    }
    return req.tenant.getModel;
};

/**
 * Returns the model bound to the database of the current request.
 */
export const getRequestModel = (req, modelName) => getRequestModelResolver(req)(modelName);

/**
 * Resolver for modules that are not tenant-routed yet. Keeping it explicit and
 * greppable makes migrating a module a deliberate change instead of an
 * accidental fallback to the central database.
 */
export const getCentralModel = (modelName) => mongoose.model(modelName);
