import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { Unit } from "./unit.model.js";
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

const createUnit = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { name, symbol, unitType, allowDecimals, status } = req.body;

    if (!name || !name.trim()) {
        return translateErrorResponse(res, lang, "error_unit_name_required", 400, translations);
    }

    if (!symbol || !symbol.trim()) {
        return translateErrorResponse(res, lang, "error_unit_symbol_required", 400, translations);
    }

    try {
        const unit = await Unit.create({
            name: name.trim(),
            symbol: symbol.trim().toLowerCase(),
            unitType: unitType !== undefined ? Number(unitType) : 2,
            allowDecimals: allowDecimals !== undefined ? Boolean(allowDecimals) : false,
            status: status !== undefined ? Number(status) : 1
        });

        return res.status(201).json(
            new ApiResponse(201, unit, translations[lang]?.success_unit_created || "success_unit_created")
        );
    } catch (error) {
        if (error.code === 11000) {
            return translateErrorResponse(res, lang, "error_unit_duplicate_name", 409, translations);
        }
        console.error("Error creating unit:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getUnits = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const pageParam = req.params.page || req.query.page;
    const { limit = 10, search, query, status, unitType, sortBy = 'name', sortOrder = 'asc' } = req.query;
    const pageNumber = parseInt(pageParam) || 1;
    const limitNumber = parseInt(limit) || 10;

    const filter = {};

    if (status !== undefined && status !== '') {
        filter.status = Number(status);
    }

    if (unitType !== undefined && unitType !== '') {
        filter.unitType = Number(unitType);
    }

    const term = search || query;
    if (term && term.trim() !== '') {
        const searchRegex = { $regex: term.trim(), $options: 'i' };
        filter.$or = [
            { name: searchRegex },
            { symbol: searchRegex }
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
        const results = await Unit.paginate(filter, options);

        return res.status(200).json(
            new ApiResponse(200, results, translations[lang]?.success_units_fetched || "success_units_fetched")
        );
    } catch (error) {
        console.error("Error fetching units:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getUnitById = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { unitId } = req.params;

    if (!unitId || !mongoose.Types.ObjectId.isValid(unitId)) {
        return translateErrorResponse(res, lang, "error_unit_invalid_id", 400, translations);
    }

    try {
        const unit = await Unit.findById(unitId);

        if (!unit) {
            return translateErrorResponse(res, lang, "error_unit_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(200, unit, translations[lang]?.success_unit_fetched || "success_unit_fetched")
        );
    } catch (error) {
        console.error("Error fetching unit by ID:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const updateUnit = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { unitId } = req.params;

    if (!unitId || !mongoose.Types.ObjectId.isValid(unitId)) {
        return translateErrorResponse(res, lang, "error_unit_invalid_id", 400, translations);
    }

    const { name, symbol, unitType, allowDecimals, status } = req.body;

    if (
        name === undefined &&
        symbol === undefined &&
        unitType === undefined &&
        allowDecimals === undefined &&
        status === undefined
    ) {
        return translateErrorResponse(res, lang, "error_unit_no_fields_update", 400, translations);
    }

    const updateFields = {};

    if (name !== undefined) updateFields.name = name.trim();
    if (symbol !== undefined) updateFields.symbol = symbol.trim().toLowerCase();
    if (unitType !== undefined) updateFields.unitType = Number(unitType);
    if (allowDecimals !== undefined) updateFields.allowDecimals = Boolean(allowDecimals);
    if (status !== undefined) updateFields.status = Number(status);

    try {
        const updatedUnit = await Unit.findByIdAndUpdate(
            unitId,
            { $set: updateFields },
            { new: true, runValidators: true }
        );

        if (!updatedUnit) {
            return translateErrorResponse(res, lang, "error_unit_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(200, updatedUnit, translations[lang]?.success_unit_updated || "success_unit_updated")
        );
    } catch (error) {
        if (error.code === 11000) {
            return translateErrorResponse(res, lang, "error_unit_duplicate_name", 409, translations);
        }
        console.error("Error updating unit:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const deleteUnit = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { unitId } = req.params;

    if (!unitId || !mongoose.Types.ObjectId.isValid(unitId)) {
        return translateErrorResponse(res, lang, "error_unit_invalid_id", 400, translations);
    }

    try {
        const deletedUnit = await Unit.findByIdAndDelete(unitId);

        if (!deletedUnit) {
            return translateErrorResponse(res, lang, "error_unit_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(200, {}, translations[lang]?.success_unit_deleted || "success_unit_deleted")
        );
    } catch (error) {
        console.error("Error deleting unit:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

export {
    createUnit,
    getUnits,
    getUnitById,
    updateUnit,
    deleteUnit
};
