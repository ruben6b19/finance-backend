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

        const populatedProduct = await Product.findById(product._id).populate('unit');

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
        const results = await Product.paginate(filter, { ...options, populate: 'unit' });

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
        const product = await Product.findById(productId).populate('unit');

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

    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
        return translateErrorResponse(res, lang, "error_product_invalid_id", 400, translations);
    }

    const {
        name, description, price, costPrice, stock, category,
        sku, unit, status, productType, purchaseUnit, conversionFactor, imageUrl,
        isSellable, isPurchasable
    } = req.body;

    if (
        name === undefined &&
        description === undefined &&
        price === undefined &&
        costPrice === undefined &&
        stock === undefined &&
        category === undefined &&
        sku === undefined &&
        unit === undefined &&
        status === undefined &&
        productType === undefined &&
        purchaseUnit === undefined &&
        conversionFactor === undefined &&
        imageUrl === undefined &&
        isSellable === undefined &&
        isPurchasable === undefined
    ) {
        return translateErrorResponse(res, lang, "error_product_no_fields_update", 400, translations);
    }

    const updateFields = {};

    if (name !== undefined) updateFields.name = name.trim();
    if (description !== undefined) updateFields.description = description ? description.trim() : '';
    if (price !== undefined) updateFields.price = Number(price);
    if (costPrice !== undefined) updateFields.costPrice = Number(costPrice);
    if (stock !== undefined) updateFields.stock = Number(stock);
    if (category !== undefined) updateFields.category = category || null;
    if (unit !== undefined) updateFields.unit = unit || null;
    if (purchaseUnit !== undefined) updateFields.purchaseUnit = purchaseUnit || null;
    if (productType !== undefined) {
        const type = Number(productType);
        updateFields.productType = type;
        // Forzar visibilidad al actualizar el tipo
        if (type === 0) { updateFields.isSellable = false; updateFields.isPurchasable = true; }
        else if (type === 1) { updateFields.isSellable = true; updateFields.isPurchasable = false; }
        else if (type === 2) { updateFields.isSellable = true; updateFields.isPurchasable = true; }
    }
    // Si no se cambia el tipo, pero se envían casillas, usarlas (opcional, pero las reglas anteriores mandan)
    if (isSellable !== undefined && productType === undefined) updateFields.isSellable = isSellable;
    if (isPurchasable !== undefined && productType === undefined) updateFields.isPurchasable = isPurchasable;

    if (conversionFactor !== undefined) updateFields.conversionFactor = Number(conversionFactor);
    if (sku !== undefined) updateFields.sku = sku ? sku.trim() : undefined;
    if (status !== undefined) updateFields.status = Number(status);
    if (imageUrl !== undefined) updateFields.imageUrl = imageUrl;

    try {
        const updatedProduct = await Product.findByIdAndUpdate(
            productId,
            { $set: updateFields },
            { new: true, runValidators: true }
        ).populate('unit');

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
