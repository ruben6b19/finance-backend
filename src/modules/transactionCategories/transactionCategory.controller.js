import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { TransactionCategory } from "./transactionCategory.model.js";
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

const createTransactionCategory = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { name, type, description, status } = req.body;

    if (!name || !name.trim()) {
        return translateErrorResponse(res, lang, "error_transactionCategory_name_required", 400, translations);
    }

    const numericType = Number(type);
    if (![0, 1].includes(numericType)) {
        return translateErrorResponse(res, lang, "error_transactionCategory_invalid_type", 400, translations);
    }

    try {
        const category = await TransactionCategory.create({
            name: name.trim(),
            type: numericType,
            description: description ? description.trim() : '',
            status: status !== undefined ? Number(status) : 1,
            createdBy: req.user?.mongoDbId || null
        });

        return res.status(201).json(
            new ApiResponse(201, category, translations[lang]?.success_transactionCategory_created || "success_transactionCategory_created")
        );
    } catch (error) {
        if (error.code === 11000) {
            return translateErrorResponse(res, lang, "error_transactionCategory_duplicate_name", 409, translations);
        }
        console.error("Error creating transaction category:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getTransactionCategories = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const pageParam = req.params.page || req.query.page;
    const { limit = 10, search, query, type, status, sortBy = 'name', sortOrder = 'asc' } = req.query;
    const pageNumber = parseInt(pageParam) || 1;
    const limitNumber = parseInt(limit) || 10;

    const filter = {};

    if (type !== undefined && type !== '') {
        filter.type = Number(type);
    }

    if (status !== undefined && status !== '') {
        filter.status = Number(status);
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
        const results = await TransactionCategory.paginate(filter, options);

        console.log("Fetched transaction categories:", results); // Debugging log
        return res.status(200).json(
            new ApiResponse(200, results, translations[lang]?.success_transactionCategories_fetched || "success_transactionCategories_fetched")
        );
    } catch (error) {
        console.error("Error fetching transaction categories:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getTransactionCategoryById = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { categoryId } = req.params;

    if (!categoryId || !mongoose.Types.ObjectId.isValid(categoryId)) {
        return translateErrorResponse(res, lang, "error_transactionCategory_invalid_id", 400, translations);
    }

    try {
        const category = await TransactionCategory.findById(categoryId);

        if (!category) {
            return translateErrorResponse(res, lang, "error_transactionCategory_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(200, category, translations[lang]?.success_transactionCategory_fetched || "success_transactionCategory_fetched")
        );
    } catch (error) {
        console.error("Error fetching transaction category by ID:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const updateTransactionCategory = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { categoryId } = req.params;

    if (!categoryId || !mongoose.Types.ObjectId.isValid(categoryId)) {
        return translateErrorResponse(res, lang, "error_transactionCategory_invalid_id", 400, translations);
    }

    const { name, type, description, status } = req.body;

    if (name === undefined && type === undefined && description === undefined && status === undefined) {
        return translateErrorResponse(res, lang, "error_transactionCategory_no_fields_update", 400, translations);
    }

    const updateFields = {};

    if (name !== undefined) updateFields.name = name.trim();
    if (type !== undefined) {
        const numericType = Number(type);
        if (![0, 1].includes(numericType)) {
            return translateErrorResponse(res, lang, "error_transactionCategory_invalid_type", 400, translations);
        }
        updateFields.type = numericType;
    }
    if (description !== undefined) updateFields.description = description ? description.trim() : '';
    if (status !== undefined) updateFields.status = Number(status);

    try {
        const updatedCategory = await TransactionCategory.findByIdAndUpdate(
            categoryId,
            { $set: updateFields },
            { new: true, runValidators: true }
        );

        if (!updatedCategory) {
            return translateErrorResponse(res, lang, "error_transactionCategory_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(200, updatedCategory, translations[lang]?.success_transactionCategory_updated || "success_transactionCategory_updated")
        );
    } catch (error) {
        if (error.code === 11000) {
            return translateErrorResponse(res, lang, "error_transactionCategory_duplicate_name", 409, translations);
        }
        console.error("Error updating transaction category:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const deleteTransactionCategory = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { categoryId } = req.params;

    if (!categoryId || !mongoose.Types.ObjectId.isValid(categoryId)) {
        return translateErrorResponse(res, lang, "error_transactionCategory_invalid_id", 400, translations);
    }

    try {
        const deletedCategory = await TransactionCategory.findByIdAndDelete(categoryId);

        if (!deletedCategory) {
            return translateErrorResponse(res, lang, "error_transactionCategory_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(200, {}, translations[lang]?.success_transactionCategory_deleted || "success_transactionCategory_deleted")
        );
    } catch (error) {
        console.error("Error deleting transaction category:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

export {
    createTransactionCategory,
    getTransactionCategories,
    getTransactionCategoryById,
    updateTransactionCategory,
    deleteTransactionCategory
};
