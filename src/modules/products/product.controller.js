import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { getRequestModel, getRequestModelResolver } from "../tenants/requestModel.js";
import mongoose from "mongoose";
import esTranslations from './es.json' with { type: 'json' };
import enTranslations from './en.json' with { type: 'json' };
import { translateErrorResponse } from "../../utils/i18nErrorResponse.js";
import { COMBO_PRODUCT_TYPE, normalizeComponents, parseNonNegativeInteger } from "../combos/comboComponents.service.js";

const translations = {
    es: esTranslations,
    en: enTranslations
};

const getLang = (req) => {
    return req.headers['accept-language']?.split(',')[0].substring(0, 2) || req.user?.instituteLang || 'es';
};

const STOCK_TRACKED_PRODUCT_TYPES = [0, 2];
const DERIVED_STOCK_PRODUCT_TYPES = [1, 2];

const isValidObjectIdString = (value) =>
    typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value);

// Only finite numbers and non-empty numeric strings are accepted. Booleans,
// null, empty strings, NaN and Infinity must never be coerced into a factor.
const isFinitePositiveStockFactor = (value) => {
    if (typeof value === "number") return Number.isFinite(value) && value > 0;
    if (typeof value === "string" && value.trim() !== "") {
        const numeric = Number(value);
        return Number.isFinite(numeric) && numeric > 0;
    }
    return false;
};

/**
 * Shared validation for the derived-stock fields (stockProduct,
 * stockConversionFactor) used by both createProduct and updateProduct.
 *
 * Every lookup goes through the tenant model resolver, never the central
 * connection. Returns either { error: <translation key> } or the resolved
 * values that must be persisted on the product.
 *
 * @param {object} options
 * @param {*} options.stockProductValue        Raw req.body.stockProduct.
 * @param {*} options.stockFactorValue         Raw req.body.stockConversionFactor.
 * @param {Function} options.getModel          Tenant model resolver.
 * @param {number} options.resultingType       productType after the operation.
 * @param {*} [options.currentStockProduct]    Existing linked stock product.
 * @param {number} [options.currentStockFactor] Existing conversion factor.
 * @param {string|null} [options.productId]    Product being updated (null on create).
 * @param {boolean} [options.productTypeChanged] Whether the update changes productType.
 */
const resolveProductStockConfig = async ({
    stockProductValue,
    stockFactorValue,
    getModel,
    resultingType,
    currentStockProduct = null,
    currentStockFactor = 1,
    productId = null,
    productTypeChanged = false
}) => {
    const isClear = stockProductValue === null || stockProductValue === "";
    const linkProvided = stockProductValue !== undefined && !isClear;
    const factorProvided = stockFactorValue !== undefined;
    const hasCurrentConfig = Boolean(currentStockProduct);
    const isDerivedTypeAllowed = DERIVED_STOCK_PRODUCT_TYPES.includes(resultingType);

    // An existing configuration cannot survive a switch to combos (which use
    // component-based stock) or to an input product (type 0).
    if (productTypeChanged && hasCurrentConfig && !isDerivedTypeAllowed) {
        return { error: "error_product_stock_link_requires_sellable_type" };
    }

    // A clear request resets to schema defaults and ignores any factor sent
    // alongside it.
    if (isClear) {
        return { stockProduct: null, stockConversionFactor: 1 };
    }

    // Nothing to validate or persist when neither field was sent.
    if (!linkProvided && !factorProvided) {
        return {
            stockProduct: currentStockProduct ?? null,
            stockConversionFactor: hasCurrentConfig ? (currentStockFactor ?? 1) : 1
        };
    }

    // A factor without a link is meaningless unless a configuration already
    // exists (factor-only update).
    if (!linkProvided && factorProvided && !hasCurrentConfig) {
        return { error: "error_product_stock_factor_requires_link" };
    }

    let resolvedFactor = 1;
    if (factorProvided) {
        if (!isFinitePositiveStockFactor(stockFactorValue)) {
            return { error: "error_product_invalid_stock_factor" };
        }
        resolvedFactor = Number(stockFactorValue);
    } else if (hasCurrentConfig) {
        resolvedFactor = currentStockFactor ?? 1;
    }

    let resolvedLink = currentStockProduct ?? null;
    if (linkProvided) {
        if (!isDerivedTypeAllowed) {
            return { error: "error_product_stock_link_requires_sellable_type" };
        }
        if (!isValidObjectIdString(stockProductValue)) {
            return { error: "error_product_invalid_stock_reference" };
        }
        if (productId && String(stockProductValue) === String(productId)) {
            return { error: "error_product_invalid_stock_reference" };
        }

        const Product = getModel("Product");
        const target = await Product.findById(stockProductValue).select("productType").lean();
        if (!target || !STOCK_TRACKED_PRODUCT_TYPES.includes(target.productType)) {
            return { error: "error_product_invalid_stock_reference" };
        }

        resolvedLink = stockProductValue;
    }

    if (resolvedLink && !isDerivedTypeAllowed) {
        return { error: "error_product_stock_link_requires_sellable_type" };
    }

    return { stockProduct: resolvedLink, stockConversionFactor: resolvedFactor };
};

const createProduct = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const getModel = getRequestModelResolver(req);
    const Product = getModel("Product");
    const {
        name, description, price, costPrice, stock, category,
        sku, unit, status, productType, purchaseUnit, conversionFactor, imageUrl,
        components, validityDays, graceDays, stockProduct, stockConversionFactor
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

    const productFields = {
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
    };

    const isCombo = type === COMBO_PRODUCT_TYPE;

    if (!isCombo && components !== undefined) {
        return translateErrorResponse(res, lang, "error_product_components_require_combo_type", 400, translations);
    }

    // La vigencia y los días de gracia pertenecen a la definición del combo:
    // 0 días de vigencia significa que el voucher nunca vence.
    let parsedValidityDays = 0;
    let parsedGraceDays = 0;

    if (validityDays !== undefined) {
        parsedValidityDays = parseNonNegativeInteger(validityDays);
        if (Number.isNaN(parsedValidityDays)) {
            return translateErrorResponse(res, lang, "error_combo_invalid_validity", 400, translations);
        }
    }

    if (graceDays !== undefined) {
        parsedGraceDays = parseNonNegativeInteger(graceDays);
        if (Number.isNaN(parsedGraceDays)) {
            return translateErrorResponse(res, lang, "error_combo_invalid_validity", 400, translations);
        }
    }

    if (!isCombo && (validityDays !== undefined || graceDays !== undefined)) {
        return translateErrorResponse(res, lang, "error_product_combo_settings_require_combo_type", 400, translations);
    }

    const stockConfig = await resolveProductStockConfig({
        stockProductValue: stockProduct,
        stockFactorValue: stockConversionFactor,
        getModel,
        resultingType: type
    });
    if (stockConfig.error) {
        return translateErrorResponse(res, lang, stockConfig.error, 400, translations);
    }
    productFields.stockProduct = stockConfig.stockProduct;
    productFields.stockConversionFactor = stockConfig.stockConversionFactor;

    // Un combo solo es pedible con una definición activa y al menos un
    // componente. Crearlo sin componentes dejaría un producto visible pero
    // invendible, así que el alta crea producto, definición y componentes
    // dentro de la misma transacción.
    if (isCombo) {
        const normalized = await normalizeComponents(components, getModel);
        if (normalized.error) {
            return translateErrorResponse(res, lang, normalized.error, 400, translations);
        }

        const ComboDefinition = getModel("ComboDefinition");
        const ComboComponent = getModel("ComboComponent");

        const session = await mongoose.startSession();
        session.startTransaction();
        let committed = false;

        try {
            const [product] = await Product.create([productFields], { session });

            const [definition] = await ComboDefinition.create([{
                product: product._id,
                referencePrice: normalized.referencePrice,
                validityDays: parsedValidityDays,
                graceDays: parsedGraceDays,
                allowSubstitution: false,
                terms: '',
                status: 1,
                createdBy: req.user?.mongoDbId || null
            }], { session });

            await ComboComponent.insertMany(
                normalized.components.map((component) => ({ ...component, combo: definition._id })),
                { session }
            );

            await session.commitTransaction();
            committed = true;

            const populatedProduct = await Product.findById(product._id).populate(['unit', 'createdBy']);

            return res.status(201).json(
                new ApiResponse(201, populatedProduct, translations[lang]?.success_product_created || "success_product_created")
            );
        } catch (error) {
            if (!committed) {
                await session.abortTransaction();
            }

            if (error.code === 11000) {
                return translateErrorResponse(res, lang, "error_product_duplicate_sku", 409, translations);
            }
            console.error("Error creating combo product:", error);
            return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
        } finally {
            await session.endSession();
        }
    }

    try {
        const product = await Product.create(productFields);

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
    const Product = getRequestModel(req, "Product");
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
    const Product = getRequestModel(req, "Product");
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
    const getModel = getRequestModelResolver(req);
    const Product = getModel("Product");
    const { productId } = req.params;
    const body = req.body || {};

    const {
        name, description, price, costPrice, stock, category,
        sku, unit, status, productType, purchaseUnit, conversionFactor, imageUrl,
        components, validityDays, graceDays, stockProduct, stockConversionFactor
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
        imageUrl === undefined &&
        components === undefined &&
        validityDays === undefined &&
        graceDays === undefined &&
        stockProduct === undefined &&
        stockConversionFactor === undefined
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

    // La vigencia y los días de gracia pertenecen a la definición del combo:
    // 0 días de vigencia significa que el voucher nunca vence.
    let parsedValidityDays;
    let parsedGraceDays;

    if (validityDays !== undefined) {
        parsedValidityDays = parseNonNegativeInteger(validityDays);
        if (Number.isNaN(parsedValidityDays)) {
            return translateErrorResponse(res, lang, "error_combo_invalid_validity", 400, translations);
        }
    }

    if (graceDays !== undefined) {
        parsedGraceDays = parseNonNegativeInteger(graceDays);
        if (Number.isNaN(parsedGraceDays)) {
            return translateErrorResponse(res, lang, "error_combo_invalid_validity", 400, translations);
        }
    }

    const existing = await Product.findById(productId)
        .select("productType stockProduct stockConversionFactor")
        .lean();
    if (!existing) {
        return translateErrorResponse(res, lang, "error_product_not_found", 404, translations);
    }

    const resultingType = setFields.productType !== undefined ? setFields.productType : existing.productType;
    const wasCombo = existing.productType === COMBO_PRODUCT_TYPE;
    const willBeCombo = resultingType === COMBO_PRODUCT_TYPE;

    const stockConfig = await resolveProductStockConfig({
        stockProductValue: stockProduct,
        stockFactorValue: stockConversionFactor,
        getModel,
        resultingType,
        currentStockProduct: existing.stockProduct,
        currentStockFactor: existing.stockConversionFactor,
        productId,
        productTypeChanged: setFields.productType !== undefined
    });
    if (stockConfig.error) {
        return translateErrorResponse(res, lang, stockConfig.error, 400, translations);
    }
    if (stockProduct !== undefined || stockConversionFactor !== undefined) {
        setFields.stockProduct = stockConfig.stockProduct;
        setFields.stockConversionFactor = stockConfig.stockConversionFactor;
    }

    const ComboDefinition = getModel("ComboDefinition");
    const ComboComponent = getModel("ComboComponent");

    // Vigencia y gracia viven en la definición del combo: enviarlas en un
    // producto que no es combo no tendría dónde persistirse.
    const hasComboSettings = validityDays !== undefined || graceDays !== undefined;
    if (hasComboSettings && !willBeCombo) {
        return translateErrorResponse(res, lang, "error_product_combo_settings_require_combo_type", 400, translations);
    }

    const comboDefinitionFields = {};
    if (validityDays !== undefined) comboDefinitionFields.validityDays = parsedValidityDays;
    if (graceDays !== undefined) comboDefinitionFields.graceDays = parsedGraceDays;

    let normalizedCombo = null;
    if (components !== undefined) {
        if (!willBeCombo) {
            return translateErrorResponse(res, lang, "error_product_components_require_combo_type", 400, translations);
        }

        normalizedCombo = await normalizeComponents(components, getModel);
        if (normalizedCombo.error) {
            return translateErrorResponse(res, lang, normalizedCombo.error, 400, translations);
        }
    } else if (willBeCombo) {
        // Pasar a tipo combo siempre exige la receta. Editar un combo existente
        // sin enviar componentes es válido mientras conserve los suyos, para no
        // reactivar sin querer una definición desactivada a propósito.
        if (!wasCombo) {
            return translateErrorResponse(res, lang, "error_combo_components_required", 400, translations);
        }

        const definition = await ComboDefinition.findOne({ product: productId }).select("_id").lean();
        const hasComponents = definition
            ? await ComboComponent.exists({ combo: definition._id })
            : false;

        if (!hasComponents) {
            return translateErrorResponse(res, lang, "error_combo_components_required", 400, translations);
        }
    }

    const updateDocument = {};
    if (Object.keys(setFields).length > 0) updateDocument.$set = setFields;
    if (Object.keys(unsetFields).length > 0) updateDocument.$unset = unsetFields;

    // Solo los cambios de combo necesitan transacción: el producto y su
    // definición/componentes deben moverse juntos. Los productos comunes siguen
    // con un único update, que además funciona en MongoDB standalone.
    const needsComboTransaction = normalizedCombo !== null || wasCombo !== willBeCombo || hasComboSettings;

    if (!needsComboTransaction) {
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
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    let committed = false;

    try {
        const updatedProduct = await Product.findByIdAndUpdate(
            productId,
            updateDocument,
            { new: true, runValidators: true, session }
        );

        if (!updatedProduct) {
            await session.abortTransaction();
            return translateErrorResponse(res, lang, "error_product_not_found", 404, translations);
        }

        if (normalizedCombo) {
            // Una definición por producto: el upsert no toca los vouchers ya
            // vendidos y reemplaza la receta para las ventas futuras.
            const definition = await ComboDefinition.findOneAndUpdate(
                { product: productId },
                {
                    $set: { referencePrice: normalizedCombo.referencePrice, status: 1, ...comboDefinitionFields },
                    $setOnInsert: { createdBy: req.user?.mongoDbId || null }
                },
                { new: true, upsert: true, runValidators: true, session }
            );

            await ComboComponent.deleteMany({ combo: definition._id }, { session });
            await ComboComponent.insertMany(
                normalizedCombo.components.map((component) => ({ ...component, combo: definition._id })),
                { session }
            );
        } else if (hasComboSettings) {
            // Solo cambia la vigencia/gracia: se actualiza la definición sin
            // tocar componentes ni reactivar una definición desactivada.
            await ComboDefinition.updateOne(
                { product: productId },
                { $set: comboDefinitionFields },
                { runValidators: true, session }
            );
        } else if (wasCombo && !willBeCombo) {
            // Deja de ser combo: se desactiva la definición para que no habilite
            // pedidos si el producto vuelve al tipo 3 sin componentes.
            await ComboDefinition.updateMany({ product: productId }, { $set: { status: 0 } }, { session });
        }

        await session.commitTransaction();
        committed = true;

        const populatedProduct = await Product.findById(productId)
            .populate(['category', 'unit', 'createdBy']);

        return res.status(200).json(
            new ApiResponse(200, populatedProduct, translations[lang]?.success_product_updated || "success_product_updated")
        );
    } catch (error) {
        if (!committed) {
            await session.abortTransaction();
        }

        if (error.code === 11000) {
            return translateErrorResponse(res, lang, "error_product_duplicate_sku", 409, translations);
        }
        console.error("Error updating product:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    } finally {
        await session.endSession();
    }
});

const deleteProduct = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const getModel = getRequestModelResolver(req);
    const Product = getModel("Product");
    const { productId } = req.params;

    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
        return translateErrorResponse(res, lang, "error_product_invalid_id", 400, translations);
    }

    try {
        const existing = await Product.findById(productId).select("productType").lean();

        if (!existing) {
            return translateErrorResponse(res, lang, "error_product_not_found", 404, translations);
        }

        // Un producto común se borra solo; no tiene datos asociados.
        if (existing.productType !== COMBO_PRODUCT_TYPE) {
            await Product.findByIdAndDelete(productId);

            return res.status(200).json(
                new ApiResponse(200, {}, translations[lang]?.success_product_deleted || "success_product_deleted")
            );
        }

        // Un combo arrastra su definición y sus componentes. Los vouchers ya
        // vendidos conservan su copia congelada de saldos, así que se siguen
        // canjeando: borrar la receta no toca el historial de ventas.
        const ComboDefinition = getModel("ComboDefinition");
        const ComboComponent = getModel("ComboComponent");

        const session = await mongoose.startSession();
        session.startTransaction();
        let committed = false;

        try {
            const definitions = await ComboDefinition.find({ product: productId })
                .select("_id")
                .session(session)
                .lean();

            const definitionIds = definitions.map((definition) => definition._id);

            if (definitionIds.length > 0) {
                await ComboComponent.deleteMany({ combo: { $in: definitionIds } }, { session });
                await ComboDefinition.deleteMany({ product: productId }, { session });
            }

            await Product.findByIdAndDelete(productId, { session });

            await session.commitTransaction();
            committed = true;

            return res.status(200).json(
                new ApiResponse(200, {}, translations[lang]?.success_product_deleted || "success_product_deleted")
            );
        } catch (error) {
            if (!committed) {
                await session.abortTransaction();
            }
            console.error("Error deleting combo product:", error);
            return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
        } finally {
            await session.endSession();
        }
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
