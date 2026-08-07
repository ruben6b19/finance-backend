import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { ProductCategory } from "./productCategory.model.js";
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

const createProductCategory = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { name, description, status, isSellable, isPurchasable } = req.body;

    if (!name || !name.trim()) {
        return translateErrorResponse(res, lang, "error_productCategory_name_required", 400, translations);
    }

    try {
        const category = await ProductCategory.create({
            name: name.trim(),
            description: description ? description.trim() : '',
            isSellable: isSellable !== undefined ? isSellable : true,
            isPurchasable: isPurchasable !== undefined ? isPurchasable : false,
            status: status !== undefined ? Number(status) : 1,
            createdBy: req.user?.mongoDbId || null
        });

        return res.status(201).json(
            new ApiResponse(201, category, translations[lang]?.success_productCategory_created || "success_productCategory_created")
        );
    } catch (error) {
        if (error.code === 11000) {
            return translateErrorResponse(res, lang, "error_productCategory_duplicate_name", 409, translations);
        }
        console.error("Error creating product category:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getProductCategories = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const pageParam = req.params.page || req.query.page;
    const { limit = 10, search, query, status, isSellable, isPurchasable, sortBy = 'name', sortOrder = 'asc' } = req.query;
    const pageNumber = parseInt(pageParam) || 1;
    const limitNumber = parseInt(limit) || 10;

    const filter = {};

    if (status !== undefined && status !== '') {
        filter.status = Number(status);
    }

    if (isSellable !== undefined && isSellable !== '') {
        filter.isSellable = isSellable === 'true' || isSellable === true;
    }

    if (isPurchasable !== undefined && isPurchasable !== '') {
        filter.isPurchasable = isPurchasable === 'true' || isPurchasable === true;
    }

    const term = search || query;
    if (term && term.trim() !== '') {
        const searchRegex = { $regex: term.trim(), $options: 'i' };
        filter.$or = [
            { name: searchRegex },
            { description: searchRegex }
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
        const results = await ProductCategory.paginate(filter, options);

        return res.status(200).json(
            new ApiResponse(200, results, translations[lang]?.success_productCategories_fetched || "success_productCategories_fetched")
        );
    } catch (error) {
        console.error("Error fetching product categories:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getProductCategoryById = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { categoryId } = req.params;

    if (!categoryId || !mongoose.Types.ObjectId.isValid(categoryId)) {
        return translateErrorResponse(res, lang, "error_productCategory_invalid_id", 400, translations);
    }

    try {
        const category = await ProductCategory.findById(categoryId);

        if (!category) {
            return translateErrorResponse(res, lang, "error_productCategory_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(200, category, translations[lang]?.success_productCategory_fetched || "success_productCategory_fetched")
        );
    } catch (error) {
        console.error("Error fetching product category by ID:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const updateProductCategory = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { categoryId } = req.params;

    if (!categoryId || !mongoose.Types.ObjectId.isValid(categoryId)) {
        return translateErrorResponse(res, lang, "error_productCategory_invalid_id", 400, translations);
    }

    const { name, description, status, isSellable, isPurchasable } = req.body;

    if (name === undefined && description === undefined && status === undefined && isSellable === undefined && isPurchasable === undefined) {
        return translateErrorResponse(res, lang, "error_productCategory_no_fields_update", 400, translations);
    }

    const updateFields = {};

    if (name !== undefined) updateFields.name = name.trim();
    if (description !== undefined) updateFields.description = description ? description.trim() : '';
    if (status !== undefined) updateFields.status = Number(status);
    if (isSellable !== undefined) updateFields.isSellable = isSellable;
    if (isPurchasable !== undefined) updateFields.isPurchasable = isPurchasable;

    try {
        const updatedCategory = await ProductCategory.findByIdAndUpdate(
            categoryId,
            { $set: updateFields },
            { new: true, runValidators: true }
        );

        if (!updatedCategory) {
            return translateErrorResponse(res, lang, "error_productCategory_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(200, updatedCategory, translations[lang]?.success_productCategory_updated || "success_productCategory_updated")
        );
    } catch (error) {
        if (error.code === 11000) {
            return translateErrorResponse(res, lang, "error_productCategory_duplicate_name", 409, translations);
        }
        console.error("Error updating product category:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const deleteProductCategory = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { categoryId } = req.params;

    if (!categoryId || !mongoose.Types.ObjectId.isValid(categoryId)) {
        return translateErrorResponse(res, lang, "error_productCategory_invalid_id", 400, translations);
    }

    try {
        const deletedCategory = await ProductCategory.findByIdAndDelete(categoryId);

        if (!deletedCategory) {
            return translateErrorResponse(res, lang, "error_productCategory_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(200, {}, translations[lang]?.success_productCategory_deleted || "success_productCategory_deleted")
        );
    } catch (error) {
        console.error("Error deleting product category:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

export {
    createProductCategory,
    getProductCategories,
    getProductCategoryById,
    updateProductCategory,
    deleteProductCategory
};
