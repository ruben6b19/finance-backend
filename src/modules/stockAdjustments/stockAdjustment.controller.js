import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { Product } from "../products/product.model.js";
import { StockAdjustment } from "./stockAdjustment.model.js";
import { ROLES } from "../../constants/roles.js";
import mongoose from "mongoose";
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

// Product.stock es Number, pero otros orígenes pueden entregar Decimal128.
const toNumber = (value) => {
    if (value === undefined || value === null) return 0;
    return Number.parseFloat(value.toString());
};

const REASONS = [0, 1, 2, 3, 4];

const createStockAdjustment = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { product, newStock, delta, reason, note } = req.body || {};

    // a. Corrección administrativa: mismo criterio que anular un canje.
    if (!hasRole(req, [ROLES.ADMIN, ROLES.SUPERVISOR])) {
        return translateErrorResponse(res, lang, "error_stock_adjustment_forbidden", 403, translations);
    }

    // b. Producto válido.
    if (!product || !mongoose.Types.ObjectId.isValid(product)) {
        return translateErrorResponse(res, lang, "error_stock_adjustment_invalid_product", 400, translations);
    }

    // c. Exactamente uno de newStock o delta.
    const hasNewStock = newStock !== undefined && newStock !== null;
    const hasDelta = delta !== undefined && delta !== null;

    if (hasNewStock === hasDelta) {
        return translateErrorResponse(res, lang, "error_stock_adjustment_amount_required", 400, translations);
    }

    const parsedNewStock = hasNewStock ? Number(newStock) : null;
    const parsedDelta = hasDelta ? Number(delta) : null;

    if (hasNewStock && (!Number.isFinite(parsedNewStock) || parsedNewStock < 0)) {
        return translateErrorResponse(res, lang, "error_stock_adjustment_invalid_amount", 400, translations);
    }

    if (hasDelta && (!Number.isFinite(parsedDelta) || parsedDelta === 0)) {
        return translateErrorResponse(res, lang, "error_stock_adjustment_invalid_amount", 400, translations);
    }

    // d. Motivo obligatorio y dentro del enum.
    const parsedReason = Number(reason);
    if (reason === undefined || reason === null || !Number.isInteger(parsedReason) || !REASONS.includes(parsedReason)) {
        return translateErrorResponse(res, lang, "error_stock_adjustment_invalid_reason", 400, translations);
    }

    const normalizedNote = note === undefined || note === null ? '' : String(note).trim();

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const currentProduct = await Product.findById(product).session(session);
        if (!currentProduct) {
            await session.abortTransaction();
            session.endSession();
            return translateErrorResponse(res, lang, "error_stock_adjustment_product_not_found", 404, translations);
        }

        // Los combos no tienen stock propio: su disponibilidad es la de sus componentes.
        if (Number(currentProduct.productType) === 3) {
            await session.abortTransaction();
            session.endSession();
            return translateErrorResponse(res, lang, "error_stock_adjustment_combo_product", 400, translations);
        }

        const previousStock = toNumber(currentProduct.stock);
        const computedNewStock = hasNewStock ? parsedNewStock : previousStock + parsedDelta;

        if (computedNewStock < 0) {
            await session.abortTransaction();
            session.endSession();
            return translateErrorResponse(res, lang, "error_stock_adjustment_negative_stock", 400, translations);
        }

        // CAS sobre el stock leído: dos ajustes concurrentes no pueden pisarse.
        const updatedProduct = await Product.findOneAndUpdate(
            { _id: currentProduct._id, stock: previousStock },
            { $set: { stock: computedNewStock } },
            { new: true, session }
        );

        if (!updatedProduct) {
            throw new Error("STOCK_ADJUSTMENT_CONFLICT");
        }

        const created = await StockAdjustment.create([{
            product: currentProduct._id,
            previousStock,
            newStock: computedNewStock,
            delta: computedNewStock - previousStock,
            reason: parsedReason,
            note: normalizedNote,
            operator: req.user?.mongoDbId || null
        }], { session });

        await session.commitTransaction();
        session.endSession();

        return res.status(201).json(
            new ApiResponse(
                201,
                { adjustment: created[0], product: updatedProduct },
                translations[lang]?.success_stock_adjustment_created || "success_stock_adjustment_created"
            )
        );
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Error creating stock adjustment:", error);

        if (error?.message === "STOCK_ADJUSTMENT_CONFLICT" || error?.hasErrorLabel?.('TransientTransactionError')) {
            return translateErrorResponse(res, lang, "error_stock_adjustment_conflict", 409, translations);
        }

        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getStockAdjustments = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const pageParam = req.params.page || req.query.page;
    const { limit = 10, product, reason } = req.query;

    const filter = {};

    if (product !== undefined && product !== '') {
        if (!mongoose.Types.ObjectId.isValid(product)) {
            return translateErrorResponse(res, lang, "error_stock_adjustment_invalid_product", 400, translations);
        }
        filter.product = product;
    }

    if (reason !== undefined && reason !== '') {
        const parsedReason = Number(reason);
        if (!Number.isInteger(parsedReason) || !REASONS.includes(parsedReason)) {
            return translateErrorResponse(res, lang, "error_stock_adjustment_invalid_reason", 400, translations);
        }
        filter.reason = parsedReason;
    }

    try {
        const results = await StockAdjustment.paginate(filter, {
            page: parseInt(pageParam) || 1,
            limit: parseInt(limit) || 10,
            sort: { createdAt: -1 },
            populate: [
                { path: 'product', select: 'name productType stock' },
                { path: 'operator', select: 'fullName email' }
            ]
        });

        return res.status(200).json(
            new ApiResponse(
                200,
                results,
                translations[lang]?.success_stock_adjustments_fetched || "success_stock_adjustments_fetched"
            )
        );
    } catch (error) {
        console.error("Error fetching stock adjustments:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

export {
    createStockAdjustment,
    getStockAdjustments
};
