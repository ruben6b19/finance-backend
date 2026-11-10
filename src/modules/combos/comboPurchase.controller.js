import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { ComboPurchase } from "./comboPurchase.model.js";
import { ComboRedemption } from "./comboRedemption.model.js";
import { Product } from "../products/product.model.js";
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

const round6 = (value) => Math.round(Number(value) * 1e6) / 1e6;

const toNumber = (value) => {
    if (value === undefined || value === null) return 0;
    return Number.parseFloat(value.toString());
};

// Código operativo: 8 caracteres hex derivados del _id.
const CODE_PATTERN = /^[A-F0-9]{8}$/i;

/**
 * Busca un voucher por ObjectId o por su código operativo de 8 caracteres.
 * Debe usar la sesión del llamador cuando corre dentro de una transacción.
 */
const resolveVoucher = async (idOrCode, session = null) => {
    if (idOrCode === undefined || idOrCode === null) return null;

    const value = String(idOrCode).trim();
    if (!value) return null;

    const query = mongoose.Types.ObjectId.isValid(value)
        ? ComboPurchase.findById(value)
        : ComboPurchase.findOne({ code: value.toUpperCase() });

    if (session) query.session(session);

    return query;
};

const buildItemsMap = (items) => {
    const map = new Map();
    for (const item of items || []) {
        map.set(String(item.product), Number(item.quantity));
    }
    return map;
};

// Compara dos listas de ítems como conjuntos de {product, quantity}.
const itemsAreEquivalent = (left, right) => {
    const a = buildItemsMap(left);
    const b = buildItemsMap(right);
    if (a.size !== b.size) return false;

    for (const [product, quantity] of a) {
        if (!b.has(product)) return false;
        if (Math.abs(b.get(product) - quantity) > 1e-9) return false;
    }
    return true;
};

const getComboPurchases = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const pageParam = req.params.page || req.query.page;
    const { limit = 10, status, customerPhone, code, sale, comboProduct } = req.query;

    const filter = {};

    if (status !== undefined && status !== '') {
        filter.status = Number(status);
    }

    if (customerPhone && customerPhone.trim() !== '') {
        filter.customerPhone = { $regex: customerPhone.trim(), $options: 'i' };
    }

    if (code && code.trim() !== '') {
        filter.code = { $regex: code.trim().toUpperCase(), $options: 'i' };
    }

    if (sale !== undefined && sale !== '') {
        if (!mongoose.Types.ObjectId.isValid(sale)) {
            return translateErrorResponse(res, lang, "error_combo_purchase_invalid_id", 400, translations);
        }
        filter.sale = sale;
    }

    if (comboProduct !== undefined && comboProduct !== '') {
        if (!mongoose.Types.ObjectId.isValid(comboProduct)) {
            return translateErrorResponse(res, lang, "error_combo_purchase_invalid_id", 400, translations);
        }
        filter.comboProduct = comboProduct;
    }

    try {
        const results = await ComboPurchase.paginate(filter, {
            page: parseInt(pageParam) || 1,
            limit: parseInt(limit) || 10,
            sort: { purchasedAt: -1 },
            populate: ['comboProduct', 'createdBy']
        });

        return res.status(200).json(
            new ApiResponse(
                200,
                { ...results },
                translations[lang]?.success_combo_purchases_fetched || "success_combo_purchases_fetched"
            )
        );
    } catch (error) {
        console.error("Error fetching combo purchases:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getComboPurchaseById = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { comboPurchaseId } = req.params;

    if (!comboPurchaseId || (!mongoose.Types.ObjectId.isValid(comboPurchaseId) && !CODE_PATTERN.test(comboPurchaseId))) {
        return translateErrorResponse(res, lang, "error_combo_purchase_invalid_id", 400, translations);
    }

    try {
        const voucher = await resolveVoucher(comboPurchaseId);

        if (!voucher) {
            return translateErrorResponse(res, lang, "error_combo_purchase_not_found", 404, translations);
        }

        await voucher.populate(['comboProduct', 'comboDefinition', 'createdBy']);

        return res.status(200).json(
            new ApiResponse(200, voucher, translations[lang]?.success_combo_purchase_fetched || "success_combo_purchase_fetched")
        );
    } catch (error) {
        console.error("Error fetching combo purchase:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getComboPurchaseRedemptions = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { comboPurchaseId } = req.params;

    try {
        const voucher = await resolveVoucher(comboPurchaseId);

        if (!voucher) {
            return translateErrorResponse(res, lang, "error_combo_purchase_not_found", 404, translations);
        }

        // Incluye los canjes anulados: son append-only y quedan como rastro.
        const redemptions = await ComboRedemption.find({ comboPurchase: voucher._id })
            .sort({ redeemedAt: -1 })
            .limit(100)
            .lean();

        return res.status(200).json(
            new ApiResponse(200, redemptions, translations[lang]?.success_redemptions_fetched || "success_redemptions_fetched")
        );
    } catch (error) {
        console.error("Error fetching combo redemptions:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const createRedemption = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { comboPurchaseId } = req.params;
    const { idempotencyKey, items, notes } = req.body || {};

    // a. El voucher debe existir.
    const voucher = await resolveVoucher(comboPurchaseId);
    if (!voucher) {
        return translateErrorResponse(res, lang, "error_combo_purchase_not_found", 404, translations);
    }

    // b. Idempotencia obligatoria.
    const key = typeof idempotencyKey === "string" ? idempotencyKey.trim() : "";
    if (!key) {
        return translateErrorResponse(res, lang, "error_redemption_idempotency_key_required", 400, translations);
    }

    // c. Al menos un ítem.
    if (!Array.isArray(items) || items.length === 0) {
        return translateErrorResponse(res, lang, "error_redemption_items_required", 400, translations);
    }

    // d. Forma de cada ítem y sin componentes repetidos.
    const normalizedItems = [];
    const seenProducts = new Set();

    for (const raw of items) {
        if (!raw || !raw.product || !mongoose.Types.ObjectId.isValid(raw.product)) {
            return translateErrorResponse(res, lang, "error_redemption_unknown_component", 400, translations);
        }

        const quantity = Number(raw.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) {
            return translateErrorResponse(res, lang, "error_redemption_invalid_quantity", 400, translations);
        }

        const productKey = String(raw.product);
        if (seenProducts.has(productKey)) {
            return translateErrorResponse(res, lang, "error_redemption_duplicate_component", 400, translations);
        }
        seenProducts.add(productKey);

        normalizedItems.push({ product: raw.product, quantity });
    }

    // e. Todo ítem debe corresponder a un saldo del voucher.
    const balanceByProduct = new Map();
    for (const balance of voucher.balances || []) {
        balanceByProduct.set(String(balance.product), balance);
    }

    for (const item of normalizedItems) {
        if (!balanceByProduct.has(String(item.product))) {
            return translateErrorResponse(res, lang, "error_redemption_unknown_component", 400, translations);
        }
    }

    // f. Reintento idempotente: se resuelve ANTES de mirar estado, vencimiento o
    // saldo. Si la operación ya se aplicó, el reintento debe devolver el mismo
    // resultado aunque esa operación haya agotado el voucher.
    const existing = await ComboRedemption.findOne({
        comboPurchase: voucher._id,
        idempotencyKey: key
    });

    if (existing) {
        if (itemsAreEquivalent(existing.items, normalizedItems)) {
            return res.status(200).json(
                new ApiResponse(
                    200,
                    { redemption: existing, comboPurchase: voucher },
                    translations[lang]?.success_redemption_created || "success_redemption_created"
                )
            );
        }

        return translateErrorResponse(res, lang, "error_redemption_idempotency_conflict", 409, translations);
    }

    // g. Solo vouchers activos.
    if (Number(voucher.status) !== 0) {
        return translateErrorResponse(res, lang, "error_redemption_not_active", 400, translations);
    }

    // h. Vencimiento con los días de gracia congelados al comprar.
    if (voucher.expiresAt) {
        const graceDays = toNumber(voucher.graceDays) || 0;
        const deadline = new Date(voucher.expiresAt).getTime() + graceDays * 86400000;
        if (Date.now() > deadline) {
            return translateErrorResponse(res, lang, "error_redemption_voucher_expired", 400, translations);
        }
    }

    // i. La cantidad no puede superar el saldo restante.
    for (const item of normalizedItems) {
        const balance = balanceByProduct.get(String(item.product));
        const remaining = toNumber(balance.includedQty) - toNumber(balance.usedQty);
        if (item.quantity - remaining > 1e-9) {
            return translateErrorResponse(res, lang, "error_redemption_exceeds_balance", 400, translations);
        }
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        // Relectura dentro de la sesión: el saldo autoritativo es el de acá.
        const current = await ComboPurchase.findById(voucher._id).session(session);
        if (!current) {
            await session.abortTransaction();
            session.endSession();
            return translateErrorResponse(res, lang, "error_combo_purchase_not_found", 404, translations);
        }

        const currentBalances = new Map();
        for (const balance of current.balances || []) {
            currentBalances.set(String(balance.product), balance);
        }

        // Solo los componentes con stockProduct mueven inventario.
        for (const item of normalizedItems) {
            const balance = currentBalances.get(String(item.product));
            if (!balance || !balance.stockProduct) continue;

            const amount = item.quantity * toNumber(balance.conversionFactor ?? 1);
            const result = await Product.updateOne(
                { _id: balance.stockProduct, stock: { $gte: amount } },
                { $inc: { stock: -amount } },
                { session }
            );

            if (result.matchedCount === 0) {
                throw new Error("REDEMPTION_INSUFFICIENT_STOCK");
            }
        }

        const requestedByProduct = buildItemsMap(normalizedItems);
        const newBalances = (current.balances || []).map((balance) => {
            const base = balance.toObject ? balance.toObject() : { ...balance };
            const requested = requestedByProduct.get(String(balance.product)) || 0;
            return {
                ...base,
                usedQty: round6(toNumber(balance.usedQty) + requested)
            };
        });

        const totalQuantity = normalizedItems.reduce((sum, item) => sum + item.quantity, 0);
        const newUsedUnits = round6(toNumber(current.usedUnits) + totalQuantity);
        const exhausted = newUsedUnits >= toNumber(current.totalUnits) - 1e-9;
        const now = new Date();

        // CAS sobre usedUnits: dos canjes concurrentes no pueden aplicar ambos.
        const updatedVoucher = await ComboPurchase.findOneAndUpdate(
            { _id: current._id, status: 0, usedUnits: current.usedUnits },
            {
                $set: {
                    balances: newBalances,
                    usedUnits: newUsedUnits,
                    status: exhausted ? 1 : 0,
                    closedAt: exhausted ? now : null
                }
            },
            { new: true, session }
        );

        if (!updatedVoucher) {
            throw new Error("REDEMPTION_CONFLICT");
        }

        const created = await ComboRedemption.create([{
            comboPurchase: current._id,
            items: normalizedItems,
            operator: req.user?.mongoDbId || null,
            redeemedAt: now,
            idempotencyKey: key,
            notes: notes ? String(notes).trim() : ''
        }], { session });

        await session.commitTransaction();
        session.endSession();

        return res.status(201).json(
            new ApiResponse(
                201,
                { redemption: created[0], comboPurchase: updatedVoucher },
                translations[lang]?.success_redemption_created || "success_redemption_created"
            )
        );
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Error creating combo redemption:", error);

        if (error?.message === "REDEMPTION_INSUFFICIENT_STOCK") {
            return translateErrorResponse(res, lang, "error_redemption_insufficient_stock", 400, translations);
        }

        if (error?.message === "REDEMPTION_CONFLICT" || error?.hasErrorLabel?.('TransientTransactionError')) {
            return translateErrorResponse(res, lang, "error_redemption_conflict", 409, translations);
        }

        if (error?.code === 11000) {
            // Carrera entre dos reintentos idénticos: el que perdió devuelve el
            // resultado ya persistido en vez de un error si el contenido coincide.
            const duplicate = await ComboRedemption.findOne({
                comboPurchase: voucher._id,
                idempotencyKey: key
            });

            if (duplicate && itemsAreEquivalent(duplicate.items, normalizedItems)) {
                const latestVoucher = await ComboPurchase.findById(voucher._id);
                return res.status(200).json(
                    new ApiResponse(
                        200,
                        { redemption: duplicate, comboPurchase: latestVoucher },
                        translations[lang]?.success_redemption_created || "success_redemption_created"
                    )
                );
            }

            return translateErrorResponse(res, lang, "error_redemption_idempotency_conflict", 409, translations);
        }

        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const voidRedemption = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { comboPurchaseId, redemptionId } = req.params;
    const { voidReason } = req.body || {};

    // a. Reversión administrativa: mismo criterio que anular una reserva.
    if (!hasRole(req, [ROLES.ADMIN, ROLES.SUPERVISOR])) {
        return translateErrorResponse(res, lang, "error_redemption_forbidden", 403, translations);
    }

    // b. Motivo obligatorio.
    const reason = typeof voidReason === "string" ? voidReason.trim() : "";
    if (!reason) {
        return translateErrorResponse(res, lang, "error_redemption_void_reason_required", 400, translations);
    }

    if (!redemptionId || !mongoose.Types.ObjectId.isValid(redemptionId)) {
        return translateErrorResponse(res, lang, "error_redemption_not_found", 404, translations);
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const voucher = await resolveVoucher(comboPurchaseId, session);
        if (!voucher) {
            await session.abortTransaction();
            session.endSession();
            return translateErrorResponse(res, lang, "error_combo_purchase_not_found", 404, translations);
        }

        const redemption = await ComboRedemption.findOne({
            _id: redemptionId,
            comboPurchase: voucher._id
        }).session(session);

        if (!redemption) {
            await session.abortTransaction();
            session.endSession();
            return translateErrorResponse(res, lang, "error_redemption_not_found", 404, translations);
        }

        // c. Reclamo atómico: dos anulaciones no pueden restaurar stock dos veces.
        const now = new Date();
        const claimed = await ComboRedemption.findOneAndUpdate(
            { _id: redemptionId, comboPurchase: voucher._id, voidedAt: null },
            {
                $set: {
                    voidedAt: now,
                    voidedBy: req.user?.mongoDbId || null,
                    voidReason: reason
                }
            },
            { new: true, session }
        );

        if (!claimed) {
            await session.abortTransaction();
            session.endSession();
            return translateErrorResponse(res, lang, "error_redemption_already_voided", 400, translations);
        }

        const balanceByProduct = new Map();
        for (const balance of voucher.balances || []) {
            balanceByProduct.set(String(balance.product), balance);
        }

        // d. Restaurar solo el stock que el canje había descontado.
        for (const item of claimed.items) {
            const balance = balanceByProduct.get(String(item.product));
            if (!balance || !balance.stockProduct) continue;

            const amount = toNumber(item.quantity) * toNumber(balance.conversionFactor ?? 1);
            if (!Number.isFinite(amount) || amount <= 0) continue;

            await Product.updateOne(
                { _id: balance.stockProduct },
                { $inc: { stock: amount } },
                { session }
            );
        }

        const restoredByProduct = buildItemsMap(claimed.items);
        const newBalances = (voucher.balances || []).map((balance) => {
            const base = balance.toObject ? balance.toObject() : { ...balance };
            const restored = restoredByProduct.get(String(balance.product)) || 0;
            const reduced = toNumber(balance.usedQty) - restored;
            return {
                ...base,
                usedQty: reduced < 1e-9 ? 0 : round6(reduced)
            };
        });

        const totalRestored = claimed.items.reduce((sum, item) => sum + toNumber(item.quantity), 0);
        const reducedUsedUnits = toNumber(voucher.usedUnits) - totalRestored;
        const newUsedUnits = reducedUsedUnits < 1e-9 ? 0 : round6(reducedUsedUnits);

        // Un voucher agotado vuelve a estar activo; expired/cancelled no se tocan.
        const reopening = Number(voucher.status) === 1;

        const updatedVoucher = await ComboPurchase.findOneAndUpdate(
            { _id: voucher._id, usedUnits: voucher.usedUnits },
            {
                $set: {
                    balances: newBalances,
                    usedUnits: newUsedUnits,
                    status: reopening ? 0 : voucher.status,
                    closedAt: reopening ? null : voucher.closedAt
                }
            },
            { new: true, session }
        );

        if (!updatedVoucher) {
            throw new Error("REDEMPTION_CONFLICT");
        }

        await session.commitTransaction();
        session.endSession();

        return res.status(200).json(
            new ApiResponse(
                200,
                { redemption: claimed, comboPurchase: updatedVoucher },
                translations[lang]?.success_redemption_voided || "success_redemption_voided"
            )
        );
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Error voiding combo redemption:", error);

        if (error?.message === "REDEMPTION_CONFLICT" || error?.hasErrorLabel?.('TransientTransactionError')) {
            return translateErrorResponse(res, lang, "error_redemption_conflict", 409, translations);
        }

        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

export {
    getComboPurchases,
    getComboPurchaseById,
    getComboPurchaseRedemptions,
    createRedemption,
    voidRedemption
};
