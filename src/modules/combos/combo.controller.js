import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { getRequestModelResolver } from "../tenants/requestModel.js";
import mongoose from "mongoose";
import esTranslations from './es.json' with { type: 'json' };
import enTranslations from './en.json' with { type: 'json' };
import { translateErrorResponse } from "../../utils/i18nErrorResponse.js";
import { COMBO_PRODUCT_TYPE, normalizeComponents, parseNonNegativeInteger } from "./comboComponents.service.js";

const translations = {
    es: esTranslations,
    en: enTranslations
};

const getLang = (req) => {
    return req.headers['accept-language']?.split(',')[0].substring(0, 2) || req.user?.instituteLang || 'es';
};

const hydrateComponents = async (definitions, getModel) => {
    if (!Array.isArray(definitions) || definitions.length === 0) return [];

    const ids = definitions.map((definition) => definition._id);
    const ComboComponent = getModel("ComboComponent");
    const components = await ComboComponent.find({ combo: { $in: ids } })
        .sort({ createdAt: 1 })
        .lean();

    const byCombo = new Map();
    for (const component of components) {
        const key = String(component.combo);
        if (!byCombo.has(key)) byCombo.set(key, []);
        byCombo.get(key).push(component);
    }

    return definitions.map((definition) => ({
        ...(definition.toObject ? definition.toObject() : definition),
        components: byCombo.get(String(definition._id)) || []
    }));
};

const createCombo = asyncHandler(async (req, res) => {
    // TEMP DEBUG: payload real que manda la app Android. Quitar cuando el
    // contrato de validityDays/graceDays quede confirmado.
    console.log("[createCombo] body recibido:", JSON.stringify(req.body));

    const lang = getLang(req);
    const getModel = getRequestModelResolver(req);
    const Product = getModel("Product");
    const ComboDefinition = getModel("ComboDefinition");
    const ComboComponent = getModel("ComboComponent");
    const {
        product, validityDays, graceDays, allowSubstitution,
        terms, status, components
    } = req.body;

    // La app Android puede omitir estos campos. Omitirlos no es lo mismo que
    // pedir 0 ("nunca vence"): se exige el dato explícito para no grabar un
    // combo con una vigencia que nadie eligió.
    const isMissingComboSetting = (value) =>
        value === undefined || value === null || (typeof value === "string" && value.trim() === "");

    if (isMissingComboSetting(validityDays) || isMissingComboSetting(graceDays)) {
        return translateErrorResponse(res, lang, "error_combo_validity_required", 400, translations);
    }

    if (!product || !mongoose.Types.ObjectId.isValid(product)) {
        return translateErrorResponse(res, lang, "error_combo_product_required", 400, translations);
    }

    const comboProduct = await Product.findById(product);
    if (!comboProduct) {
        return translateErrorResponse(res, lang, "error_combo_product_not_found", 404, translations);
    }

    if (comboProduct.productType !== COMBO_PRODUCT_TYPE) {
        return translateErrorResponse(res, lang, "error_combo_product_not_combo_type", 400, translations);
    }

    const parsedValidityDays = validityDays !== undefined ? parseNonNegativeInteger(validityDays) : 0;
    const parsedGraceDays = graceDays !== undefined ? parseNonNegativeInteger(graceDays) : 0;
    if (Number.isNaN(parsedValidityDays) || Number.isNaN(parsedGraceDays)) {
        return translateErrorResponse(res, lang, "error_combo_invalid_validity", 400, translations);
    }

    const parsedStatus = status !== undefined ? Number(status) : 1;
    if (![0, 1].includes(parsedStatus)) {
        return translateErrorResponse(res, lang, "error_combo_invalid_status", 400, translations);
    }

    const normalized = await normalizeComponents(components, getModel);
    if (normalized.error) {
        return translateErrorResponse(res, lang, normalized.error, 400, translations);
    }

    const existing = await ComboDefinition.findOne({ product });
    if (existing) {
        return translateErrorResponse(res, lang, "error_combo_already_exists", 409, translations);
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const definitions = await ComboDefinition.create([{
            product,
            referencePrice: normalized.referencePrice,
            validityDays: parsedValidityDays,
            graceDays: parsedGraceDays,
            allowSubstitution: Boolean(allowSubstitution),
            terms: terms ? String(terms).trim() : '',
            status: parsedStatus,
            createdBy: req.user?.mongoDbId || null
        }], { session });

        const definition = definitions[0];

        const createdComponents = await ComboComponent.insertMany(
            normalized.components.map((component) => ({ ...component, combo: definition._id })),
            { session }
        );

        await session.commitTransaction();
        session.endSession();

        return res.status(201).json(
            new ApiResponse(
                201,
                { ...definition.toObject(), components: createdComponents },
                translations[lang]?.success_combo_created || "success_combo_created"
            )
        );
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Error creating combo:", error);

        if (error?.code === 11000) {
            return translateErrorResponse(res, lang, "error_combo_already_exists", 409, translations);
        }

        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getCombos = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const getModel = getRequestModelResolver(req);
    const ComboDefinition = getModel("ComboDefinition");
    const pageParam = req.params.page || req.query.page;
    const { limit = 10, status, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

    const filter = {};

    if (status !== undefined && status !== '') {
        filter.status = Number(status);
    }

    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'asc' ? 1 : -1;

    try {
        const results = await ComboDefinition.paginate(filter, {
            page: parseInt(pageParam) || 1,
            limit: parseInt(limit) || 10,
            sort: sortOptions,
            populate: ['product', 'createdBy']
        });

        const hydrated = await hydrateComponents(results.docs, getModel);

        return res.status(200).json(
            new ApiResponse(
                200,
                { ...results, docs: hydrated },
                translations[lang]?.success_combos_fetched || "success_combos_fetched"
            )
        );
    } catch (error) {
        console.error("Error fetching combos:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getComboById = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const getModel = getRequestModelResolver(req);
    const ComboDefinition = getModel("ComboDefinition");
    const { comboId } = req.params;

    if (!comboId || !mongoose.Types.ObjectId.isValid(comboId)) {
        return translateErrorResponse(res, lang, "error_combo_invalid_id", 400, translations);
    }

    try {
        const definition = await ComboDefinition.findById(comboId).populate(['product', 'createdBy']);

        if (!definition) {
            return translateErrorResponse(res, lang, "error_combo_not_found", 404, translations);
        }

        const hydrated = await hydrateComponents([definition], getModel);

        return res.status(200).json(
            new ApiResponse(200, hydrated[0], translations[lang]?.success_combo_fetched || "success_combo_fetched")
        );
    } catch (error) {
        console.error("Error fetching combo:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const updateCombo = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const getModel = getRequestModelResolver(req);
    const ComboDefinition = getModel("ComboDefinition");
    const ComboComponent = getModel("ComboComponent");
    const { comboId } = req.params;
    const {
        validityDays, graceDays, allowSubstitution,
        terms, status, components
    } = req.body;

    if (!comboId || !mongoose.Types.ObjectId.isValid(comboId)) {
        return translateErrorResponse(res, lang, "error_combo_invalid_id", 400, translations);
    }

    if (
        validityDays === undefined &&
        graceDays === undefined &&
        allowSubstitution === undefined &&
        terms === undefined &&
        status === undefined &&
        components === undefined
    ) {
        return translateErrorResponse(res, lang, "error_combo_no_fields_update", 400, translations);
    }

    const updateFields = {};

    if (validityDays !== undefined) {
        const parsed = parseNonNegativeInteger(validityDays);
        if (Number.isNaN(parsed)) {
            return translateErrorResponse(res, lang, "error_combo_invalid_validity", 400, translations);
        }
        updateFields.validityDays = parsed;
    }

    if (graceDays !== undefined) {
        const parsed = parseNonNegativeInteger(graceDays);
        if (Number.isNaN(parsed)) {
            return translateErrorResponse(res, lang, "error_combo_invalid_validity", 400, translations);
        }
        updateFields.graceDays = parsed;
    }

    if (allowSubstitution !== undefined) {
        updateFields.allowSubstitution = Boolean(allowSubstitution);
    }

    if (terms !== undefined) {
        updateFields.terms = terms ? String(terms).trim() : '';
    }

    if (status !== undefined) {
        const parsed = Number(status);
        if (![0, 1].includes(parsed)) {
            return translateErrorResponse(res, lang, "error_combo_invalid_status", 400, translations);
        }
        updateFields.status = parsed;
    }

    let normalized = null;
    if (components !== undefined) {
        normalized = await normalizeComponents(components, getModel);
        if (normalized.error) {
            return translateErrorResponse(res, lang, normalized.error, 400, translations);
        }
        updateFields.referencePrice = normalized.referencePrice;
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const definition = await ComboDefinition.findByIdAndUpdate(
            comboId,
            { $set: updateFields },
            { new: true, runValidators: true, session }
        );

        if (!definition) {
            await session.abortTransaction();
            session.endSession();
            return translateErrorResponse(res, lang, "error_combo_not_found", 404, translations);
        }

        // Reemplazar componentes reescribe solo la definición. Los vouchers ya
        // vendidos conservan su copia de stockProduct y conversionFactor.
        if (normalized) {
            await ComboComponent.deleteMany({ combo: comboId }, { session });
            await ComboComponent.insertMany(
                normalized.components.map((component) => ({ ...component, combo: definition._id })),
                { session }
            );
        }

        await session.commitTransaction();
        session.endSession();

        const hydrated = await hydrateComponents([definition], getModel);

        return res.status(200).json(
            new ApiResponse(200, hydrated[0], translations[lang]?.success_combo_updated || "success_combo_updated")
        );
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Error updating combo:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

export {
    createCombo,
    getCombos,
    getComboById,
    updateCombo
};
