import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { findStoreBySlug, isValidSlug } from "../modules/tenants/store.service.js";
import { getTenantConnection, getTenantModel } from "../modules/tenants/tenantConnection.js";

const STORE_HEADER = "X-Store";

/**
 * Resolves the store of a request from the X-Store header.
 *
 * A missing header is not an error: the request keeps its previous behaviour
 * (authenticated users are routed by their email mapping). A header that is
 * present must name a valid, active store, otherwise the request fails before
 * reaching any controller.
 */
export const resolveStore = asyncHandler(async (req, _res, next) => {
    const header = req.header(STORE_HEADER);

    if (header === undefined) return next();

    const received = String(header).trim();
    const slug = received.toLowerCase();

    if (slug === "") {
        return next(new ApiError(400, `El header ${STORE_HEADER} está vacío.`));
    }

    if (!isValidSlug(slug)) {
        return next(new ApiError(400, `El identificador de tienda "${received}" no es válido.`));
    }

    let store;
    try {
        store = await findStoreBySlug(slug);
    } catch (error) {
        console.error("Store resolution failed:", error);
        return next(new ApiError(503, "No se pudo resolver la tienda de la solicitud."));
    }

    if (!store) {
        return next(new ApiError(404, `La tienda "${slug}" no existe o está inactiva.`));
    }

    req.store = {
        slug: store.slug,
        dbName: store.dbName,
        name: store.name
    };
    req.tenant = {
        storeSlug: store.slug,
        dbName: store.dbName,
        getConnection: () => getTenantConnection(store.dbName),
        getModel: (modelName) => getTenantModel(store.dbName, modelName)
    };

    return next();
});

/**
 * Rejects a request that reached a store-only route without a resolved tenant.
 * Used by public routes, where there is no authenticated user to fall back on.
 */
export const requireStore = (req, _res, next) => {
    if (!req.tenant) {
        return next(new ApiError(
            400,
            `Falta el header ${STORE_HEADER}. Enviá el identificador de la tienda para continuar.`
        ));
    }

    return next();
};
