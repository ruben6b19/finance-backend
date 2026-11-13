import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { Product } from "./product.model.js";
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

const createProduct = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const {
        name, description, price, costPrice, stock, category,
        sku, unit, status, productType, purchaseUnit, conversionFactor, imageUrl
    } = req.body;

    // REGLAS DE NEGOCIO PARA VISIBILIDAD (Forzar según tipo)
    let finalIsSellable = true;
    let finalIsPurchasable = false;

    const type = productType !== undefined ? Number(productType) : 1;
    if (type === 0) { // Insumo
        finalIsSellable = false;
        finalIsPurchasable = true;
    } else if (type === 1) { // Final
        finalIsSellable = true;
        finalIsPurchasable = false;
    } else if (type === 2) { // Directo
        finalIsSellable = true;
        finalIsPurchasable = true;
    } else if (type === 3) { // Combo
        finalIsSellable = true;
        finalIsPurchasable = false;
    }

    if (!name || !name.trim()) {
        return translateErrorResponse(res, lang, "error_product_name_required", 400, translations);
    }

    if (price === undefined || Number(price) < 0) {
        return translateErrorResponse(res, lang, "error_product_invalid_price", 400, translations);
    }

    try {
        const product = await Product.create({
            name: name.trim(),
            description: description ? description.trim() : '',
            productType: type,
            isSellable: finalIsSellable,
            isPurchasable: finalIsPurchasable,
            price: Number(price),
            costPrice: costPrice !== undefined ? Number(costPrice) : 0,
            stock: stock !== undefined ? Number(stock) : 0,
            category: category || null,
            unit: unit || null,
            purchaseUnit: purchaseUnit || null,
            conversionFactor: conversionFactor !== undefined ? Number(conversionFactor) : 1,
            sku: sku ? sku.trim() : undefined,
            status: status !== undefined ? Number(status) : 1,
            imageUrl: imageUrl || '',
            createdBy: req.user?.mongoDbId || null
        });

        const populatedProduct = await Product.findById(product._id).populate(['unit', 'createdBy']);

        return res.status(201).json(
            new ApiResponse(201, populatedProduct, translations[lang]?.success_product_created || "success_product_created")
        );
    } catch (error) {
        if (error.code === 11000) {
            return translateErrorResponse(res, lang, "error_product_duplicate_sku", 409, translations);
        }
        console.error("Error creating product:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getProducts = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const pageParam = req.params.page || req.query.page;
    const { limit = 10, search, query, category, status, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
    const pageNumber = parseInt(pageParam) || 1;
    const limitNumber = parseInt(limit) || 10;
    console.log(`Fetching products`);

    const filter = {};

    if (category !== undefined && category !== '') {
        filter.category = category;
    }

    if (status !== undefined && status !== '') {
        filter.status = Number(status);
    }

    const term = search || query;
    if (term && term.trim() !== '') {
        const searchRegex = { $regex: term.trim(), $options: 'i' };
        filter.$or = [
            { name: searchRegex },
            { description: searchRegex },
            { sku: searchRegex }
        ];
    }

    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const options = {
        page: pageNumber,
        limit: limitNumber,
        sort: sortOptions
    };

    try {
        const results = await Product.paginate(filter, { ...options, populate: ['unit', 'createdBy'] });

        return res.status(200).json(
            new ApiResponse(200, results, translations[lang]?.success_products_fetched || "success_products_fetched")
        );
    } catch (error) {
        console.error("Error fetching products:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getProductById = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { productId } = req.params;

    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
        return translateErrorResponse(res, lang, "error_product_invalid_id", 400, translations);
    }

    try {
        const product = await Product.findById(productId).populate(['unit', 'createdBy']);

        if (!product) {
            return translateErrorResponse(res, lang, "error_product_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(200, product, translations[lang]?.success_product_fetched || "success_product_fetched")
        );
    } catch (error) {
        console.error("Error fetching product by ID:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const updateProduct = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { productId } = req.params;
    const body = req.body || {};

    const {
        name, description, price, costPrice, stock, category,
        sku, unit, status, productType, purchaseUnit, conversionFactor, imageUrl
    } = body;

    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
        return translateErrorResponse(res, lang, "error_product_invalid_id", 400, translations);
    }

    // Stock is never overwritten from product edition: every manual change goes
    // through an audited stock adjustment (same rule as before).
    if (stock !== undefined) {
        return translateErrorResponse(res, lang, "error_product_stock_requires_adjustment", 400, translations);
    }

    // Client-sent isSellable/isPurchasable are intentionally ignored: visibility
    // is derived from productType only. A body with just those flags has no
    // valid fields to update.
    if (
        name === undefined &&
        description === undefined &&
        price === undefined &&
        costPrice === undefined &&
        category === undefined &&
        sku === undefined &&
        unit === undefined &&
        status === undefined &&
        productType === undefined &&
        purchaseUnit === undefined &&
        conversionFactor === undefined &&
        imageUrl === undefined
    ) {
        return translateErrorResponse(res, lang, "error_product_no_fields_update", 400, translations);
    }

    const setFields = {};
    const unsetFields = {};
    const objectIdPattern = /^[0-9a-fA-F]{24}$/;

    // Accept only numbers or non-empty numeric strings. null, "" and booleans
    // must never be coerced: Number(null) === 0 and Number(true) === 1 would
    // silently turn them into valid values.
    const isNumericInput = (value) =>
        typeof value === "number" || (typeof value === "string" && value.trim() !== "");

    if (name !== undefined) {
        // Type check first so .trim() is never called on a non-string value.
        if (typeof name !== "string" || name.trim().length === 0) {
            return translateErrorResponse(res, lang, "error_product_name_required", 400, translations);
        }
        setFields.name = name.trim();
    }

    if (description !== undefined) {
        if (description !== null && typeof description !== "string") {
            return translateErrorResponse(res, lang, "error_product_invalid_field", 400, translations);
        }
        setFields.description = description === null ? "" : description.trim();
    }

    if (imageUrl !== undefined) {
        if (imageUrl !== null && typeof imageUrl !== "string") {
            return translateErrorResponse(res, lang, "error_product_invalid_field", 400, translations);
        }
        setFields.imageUrl = imageUrl === null ? "" : imageUrl.trim();
    }

    if (price !== undefined) {
        const numericPrice = isNumericInput(price) ? Number(price) : NaN;
        if (!Number.isFinite(numericPrice) || numericPrice < 0) {
            return translateErrorResponse(res, lang, "error_product_invalid_price", 400, translations);
        }
        setFields.price = numericPrice;
    }

    if (costPrice !== undefined) {
        const numericCostPrice = isNumericInput(costPrice) ? Number(costPrice) : NaN;
        if (!Number.isFinite(numericCostPrice) || numericCostPrice < 0) {
            return translateErrorResponse(res, lang, "error_product_invalid_cost_price", 400, translations);
        }
        setFields.costPrice = numericCostPrice;
    }

    if (conversionFactor !== undefined) {
        const numericConversionFactor = isNumericInput(conversionFactor) ? Number(conversionFactor) : NaN;
        if (!Number.isFinite(numericConversionFactor) || numericConversionFactor <= 0) {
            return translateErrorResponse(res, lang, "error_product_invalid_conversion_factor", 400, translations);
        }
        setFields.conversionFactor = numericConversionFactor;
    }

    if (status !== undefined) {
        const numericStatus = isNumericInput(status) ? Number(status) : NaN;
        if (numericStatus !== 0 && numericStatus !== 1) {
            return translateErrorResponse(res, lang, "error_product_invalid_status", 400, translations);
        }
        setFields.status = numericStatus;
    }

    if (category !== undefined) {
        if (category === null || category === "") {
            setFields.category = null;
        } else if (typeof category === "string" && objectIdPattern.test(category)) {
            setFields.category = category;
        } else {
            return translateErrorResponse(res, lang, "error_product_invalid_reference", 400, translations);
        }
    }

    if (unit !== undefined) {
        // unit is required in the schema: it can never be cleared, only replaced
        // by a valid ObjectId string.
        if (typeof unit !== "string" || !objectIdPattern.test(unit)) {
            return translateErrorResponse(res, lang, "error_product_unit_required", 400, translations);
        }
        setFields.unit = unit;
    }

    if (purchaseUnit !== undefined) {
        if (purchaseUnit === null || purchaseUnit === "") {
            setFields.purchaseUnit = null;
        } else if (typeof purchaseUnit === "string" && objectIdPattern.test(purchaseUnit)) {
            setFields.purchaseUnit = purchaseUnit;
        } else {
            return translateErrorResponse(res, lang, "error_product_invalid_reference", 400, translations);
        }
    }

    if (productType !== undefined) {
        const type = isNumericInput(productType) ? Number(productType) : NaN;
        if (!Number.isInteger(type) || ![0, 1, 2, 3].includes(type)) {
            return translateErrorResponse(res, lang, "error_product_invalid_type", 400, translations);
        }
        setFields.productType = type;
        // Visibility is derived from productType; client flags are ignored.
        // 0: input, 1: final product, 2: direct resale, 3: combo.
        setFields.isSellable = type !== 0;
        setFields.isPurchasable = type !== 1 && type !== 3;
    }

    if (sku !== undefined) {
        if (sku !== null && typeof sku !== "string") {
            return translateErrorResponse(res, lang, "error_product_invalid_sku", 400, translations);
        }
        const trimmedSku = sku === null ? "" : sku.trim();
        if (trimmedSku === "") {
            // Use $unset so the document truly loses the field: Mongoose strips
            // `sku: undefined` from $set.
            unsetFields.sku = "";
        } else {
            setFields.sku = trimmedSku;
        }
    }

    const updateDocument = {};
    if (Object.keys(setFields).length > 0) updateDocument.$set = setFields;
    if (Object.keys(unsetFields).length > 0) updateDocument.$unset = unsetFields;

    try {
        const updatedProduct = await Product.findByIdAndUpdate(
            productId,
            updateDocument,
            { new: true, runValidators: true }
        ).populate(['category', 'unit', 'createdBy']);

        if (!updatedProduct) {
            return translateErrorResponse(res, lang, "error_product_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(200, updatedProduct, translations[lang]?.success_product_updated || "success_product_updated")
        );
    } catch (error) {
        if (error.code === 11000) {
            return translateErrorResponse(res, lang, "error_product_duplicate_sku", 409, translations);
        }
        console.error("Error updating product:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const deleteProduct = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { productId } = req.params;

    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
        return translateErrorResponse(res, lang, "error_product_invalid_id", 400, translations);
    }

    try {
        const deletedProduct = await Product.findByIdAndDelete(productId);

        if (!deletedProduct) {
            return translateErrorResponse(res, lang, "error_product_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(200, {}, translations[lang]?.success_product_deleted || "success_product_deleted")
        );
    } catch (error) {
        console.error("Error deleting product:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

export {
    createProduct,
    getProducts,
    getProductById,
    updateProduct,
    deleteProduct
};
