import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { getRequestModelResolver } from "../tenants/requestModel.js";
import { ROLES } from "../../constants/roles.js";
import { hasRoleAtLeast, normalizeRoles, roleAtLeast } from "../../utils/roles.js";
import { resolveFirebaseUser } from "../users/user.service.js";
import { checkRedemptionVoidWindow } from "./redemption.policy.js";
import mongoose from "mongoose";
import esTranslations from './es.json' with { type: 'json' };
import enTranslations from './en.json' with { type: 'json' };
import { translateErrorResponse } from "../../utils/i18nErrorResponse.js";
import { sendComboRedemptionEmail } from "../notifications/mail.service.js";

const translations = {
    es: esTranslations,
    en: enTranslations
};

const getLang = (req) => {
    return req.headers['accept-language']?.split(',')[0].substring(0, 2) || req.user?.instituteLang || 'es';
};

// Mirrors order.controller.js: claim-based staff callers keep their current
// behaviour, while every other caller gets an authoritative Mongo profile.
const respondUserError = (res, result) => {
    if (result.error === "missing_uid") {
        return res.status(401).json(new ApiResponse(401, {}, "error_token_missing_uid"));
    }
    if (result.error === "missing_email") {
        return res.status(400).json(new ApiResponse(400, {}, "error_user_email_required"));
    }
    return res.status(500).json(new ApiResponse(500, {}, "error_internal_server_generic"));
};

const resolveReadRequester = async (req, res, getModel) => {
    if (hasRoleAtLeast(req, ROLES.SELLER)) {
        return { isStaff: true, customerId: null };
    }

    const resolved = await resolveFirebaseUser({
        firebaseUid: req.user?.firebaseUid,
        email: req.user?.email,
        name: req.user?.name,
        getModel
    });
    if (resolved.error) {
        return { errorResponse: respondUserError(res, resolved) };
    }

    return {
        isStaff: roleAtLeast(resolved.user.role, ROLES.SELLER),
        customerId: resolved.user._id
    };
};

// A voucher without customerId is legacy data and belongs to nobody.
const isVoucherOwnedBy = (voucher, customerId) =>
    Boolean(customerId && voucher?.customerId && String(voucher.customerId) === String(customerId));

const round6 = (value) => Math.round(Number(value) * 1e6) / 1e6;

const toNumber = (value) => {
    if (value === undefined || value === null) return 0;
    return Number.parseFloat(value.toString());
};

// Código operativo: 8 caracteres hex derivados del _id.
const CODE_PATTERN = /^[A-F0-9]{8}$/i;

/**
 * Busca un voucher por ObjectId o por su código operativo de 8 caracteres.
 * Debe usar la sesión del llamador cuando corre dentro de una transacción, y
 * el resolver del tenant para no leer de otra base.
 */
const resolveVoucher = async (idOrCode, session = null, getModel) => {
    if (idOrCode === undefined || idOrCode === null) return null;

    const value = String(idOrCode).trim();
    if (!value) return null;

    const ComboPurchase = getModel("ComboPurchase");

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
    const getModel = getRequestModelResolver(req);
    const ComboPurchase = getModel("ComboPurchase");
    const pageParam = req.params.page || req.query.page;
    const { limit = 10, status, customerPhone, code, sale, comboProduct } = req.query;

    const requester = await resolveReadRequester(req, res, getModel);
    if (requester.errorResponse) return requester.errorResponse;

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

    if (!requester.isStaff) {
        filter.customerId = requester.customerId;
    }

    try {
        const results = await ComboPurchase.paginate(filter, {
            page: parseInt(pageParam) || 1,
            limit: parseInt(limit) || 10,
            sort: { purchasedAt: -1 },
            populate: [
                'comboProduct',
                'createdBy',
                // El cliente muestra el nombre del componente, no su ObjectId.
                { path: 'balances.product', select: 'name' }
            ]
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
    const getModel = getRequestModelResolver(req);
    const { comboPurchaseId } = req.params;

    const requester = await resolveReadRequester(req, res, getModel);
    if (requester.errorResponse) return requester.errorResponse;

    if (!comboPurchaseId || (!mongoose.Types.ObjectId.isValid(comboPurchaseId) && !CODE_PATTERN.test(comboPurchaseId))) {
        return translateErrorResponse(res, lang, "error_combo_purchase_invalid_id", 400, translations);
    }

    try {
        const voucher = await resolveVoucher(comboPurchaseId, null, getModel);

        if (!voucher) {
            return translateErrorResponse(res, lang, "error_combo_purchase_not_found", 404, translations);
        }

        if (!requester.isStaff && !isVoucherOwnedBy(voucher, requester.customerId)) {
            return translateErrorResponse(res, lang, "error_combo_purchase_not_found", 404, translations);
        }

        await voucher.populate([
            'comboProduct',
            'comboDefinition',
            'createdBy',
            // El cliente muestra el nombre del componente, no su ObjectId.
            { path: 'balances.product', select: 'name' }
        ]);

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
    const getModel = getRequestModelResolver(req);
    const { comboPurchaseId } = req.params;

    const requester = await resolveReadRequester(req, res, getModel);
    if (requester.errorResponse) return requester.errorResponse;

    try {
        const voucher = await resolveVoucher(comboPurchaseId, null, getModel);

        if (!voucher) {
            return translateErrorResponse(res, lang, "error_combo_purchase_not_found", 404, translations);
        }

        if (!requester.isStaff && !isVoucherOwnedBy(voucher, requester.customerId)) {
            return translateErrorResponse(res, lang, "error_combo_purchase_not_found", 404, translations);
        }

        const ComboRedemption = getModel("ComboRedemption");

        // Incluye los canjes anulados: son append-only y quedan como rastro.
        const redemptions = await ComboRedemption.find({ comboPurchase: voucher._id })
            .sort({ redeemedAt: -1 })
            .limit(100)
            // El historial muestra el nombre del componente, no su ObjectId.
            .populate('items.product', 'name')
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
    const getModel = getRequestModelResolver(req);
    const ComboPurchase = getModel("ComboPurchase");
    const ComboRedemption = getModel("ComboRedemption");
    const Product = getModel("Product");
    const { comboPurchaseId } = req.params;
    const { idempotencyKey, items, notes } = req.body || {};

    // Canje operativo: lo registra el personal de mostrador, nunca un cliente.
    if (!hasRoleAtLeast(req, ROLES.SELLER)) {
        return translateErrorResponse(res, lang, "error_redemption_not_allowed", 403, translations);
    }

    // a. El voucher debe existir.
    const voucher = await resolveVoucher(comboPurchaseId, null, getModel);
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

    let updatedVoucher;
    let created;

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

        // Balances with their own stockProduct are self-contained; for the
        // others, resolve the component product's live derived stock config.
        // Menu (1) and combo (3) products without derivation hold no stock.
        const plainComponentIds = [...new Set(normalizedItems
            .map((item) => {
                const balance = currentBalances.get(String(item.product));
                return balance && !balance.stockProduct ? String(balance.product) : null;
            })
            .filter(Boolean))];

        const componentProducts = new Map();
        if (plainComponentIds.length) {
            const products = await Product.find({ _id: { $in: plainComponentIds } })
                .select("productType stockProduct stockConversionFactor")
                .session(session)
                .lean();
            for (const product of products) {
                componentProducts.set(String(product._id), product);
            }
        }

        for (const item of normalizedItems) {
            const balance = currentBalances.get(String(item.product));
            if (!balance) continue;

            const derived = componentProducts.get(String(balance.product));
            const derivedTarget = derived?.stockProduct && mongoose.Types.ObjectId.isValid(derived.stockProduct)
                ? String(derived.stockProduct) : null;
            const stockTargetId = balance.stockProduct || derivedTarget || balance.product;
            const tracksStock = Boolean(balance.stockProduct || derivedTarget) ||
                [0, 2].includes(derived?.productType);
            if (!tracksStock) continue;

            // A balance with its own stockProduct is self-contained (frozen at
            // purchase) -> use its conversionFactor. Without a derived target
            // the product has no derivation to borrow, so the balance's frozen
            // factor still wins. Only a genuinely derived component uses the
            // product's live stockConversionFactor (schema default 1).
            const factor = balance.stockProduct || !derivedTarget
                ? toNumber(balance.conversionFactor ?? 1)
                : toNumber(derived.stockConversionFactor ?? balance.conversionFactor ?? 1);
            const amount = item.quantity * factor;
            const result = await Product.updateOne(
                { _id: stockTargetId, stock: { $gte: amount } },
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
        updatedVoucher = await ComboPurchase.findOneAndUpdate(
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

        created = await ComboRedemption.create([{
            comboPurchase: current._id,
            items: normalizedItems,
            operator: req.user?.mongoDbId || null,
            redeemedAt: now,
            idempotencyKey: key,
            notes: notes ? String(notes).trim() : ''
        }], { session });

        await session.commitTransaction();
        session.endSession();
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

    // Mail is best-effort and runs after commit. The recipient comes from the
    // voucher owner, never from the counter staff member making the request.
    try {
        const User = getModel("User");
        const customer = voucher.customerId
            ? await User.findById(voucher.customerId).select("email").lean()
            : null;

        const redeemedIds = [...new Set(normalizedItems.map((item) => String(item.product)))];
        const productDocs = await Product.find({ _id: { $in: redeemedIds } }).select("name").lean();
        const nameById = new Map(productDocs.map((doc) => [String(doc._id), doc.name]));

        const balanceById = new Map();
        for (const balance of updatedVoucher.balances || []) {
            balanceById.set(String(balance.product), balance);
        }

        const itemsWithNames = normalizedItems.map((item) => {
            const balance = balanceById.get(String(item.product));
            return {
                name: nameById.get(String(item.product)) || String(item.product),
                quantity: item.quantity,
                remaining: Math.max(0, (Number(balance?.includedQty) || 0) - (Number(balance?.usedQty) || 0))
            };
        });

        const result = await sendComboRedemptionEmail({
            getModel,
            voucher: updatedVoucher,
            redemption: created[0],
            items: itemsWithNames,
            to: customer?.email,
            lang
        });
        console.info("[mail] redemption send result", {
            voucherCode: updatedVoucher?.code, ...result
        });
    } catch (error) {
        console.error("[mail] failed to send combo redemption email", error);
    }

    return res.status(201).json(
        new ApiResponse(
            201,
            { redemption: created[0], comboPurchase: updatedVoucher },
            translations[lang]?.success_redemption_created || "success_redemption_created"
        )
    );
});

// Mongo puede abortar una transacción con TransientTransactionError (contención
// de locks o cambios de catálogo). El contrato de Mongo es reintentarla: no es
// un conflicto del cliente. Un commit con resultado incierto NO se reintenta,
// porque la transacción pudo haberse aplicado.
const VOID_TX_MAX_ATTEMPTS = 3;

const isRetryableTransactionError = (error) =>
    error?.hasErrorLabel?.('TransientTransactionError') &&
    !error?.hasErrorLabel?.('UnknownTransactionCommitResult');

const voidRedemption = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const getModel = getRequestModelResolver(req);
    const ComboPurchase = getModel("ComboPurchase");
    const ComboRedemption = getModel("ComboRedemption");
    const Product = getModel("Product");
    const { comboPurchaseId, redemptionId } = req.params;
    const { voidReason } = req.body || {};

    // a. Anulación de un canje: el vendedor solo el mismo día; supervisor y
    // admin hasta 7 días. Se mide sobre la fecha del canje.
    if (!hasRoleAtLeast(req, ROLES.SELLER)) {
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

    for (let attempt = 1; attempt <= VOID_TX_MAX_ATTEMPTS; attempt += 1) {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const voucher = await resolveVoucher(comboPurchaseId, session, getModel);
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

            // b. Ventana de anulación: se mide sobre la fecha del canje original.
            const voidCheck = checkRedemptionVoidWindow({
                redeemedAt: redemption.redeemedAt,
                roles: normalizeRoles(req.user?.role)
            });

            if (!voidCheck.allowed) {
                await session.abortTransaction();
                session.endSession();
                return translateErrorResponse(res, lang, voidCheck.errorCode, 403, translations);
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

            // d. Restore exactly what the redemption decremented, using the
            // same stock rule: derived target or tracked plain product (0/2).
            const plainComponentIds = [...new Set(claimed.items
                .map((item) => {
                    const balance = balanceByProduct.get(String(item.product));
                    return balance && !balance.stockProduct ? String(balance.product) : null;
                })
                .filter(Boolean))];

            const componentProducts = new Map();
            if (plainComponentIds.length) {
                const products = await Product.find({ _id: { $in: plainComponentIds } })
                    .select("productType stockProduct stockConversionFactor")
                    .session(session)
                    .lean();
                for (const product of products) {
                    componentProducts.set(String(product._id), product);
                }
            }

            for (const item of claimed.items) {
                const balance = balanceByProduct.get(String(item.product));
                if (!balance) continue;

                const derived = componentProducts.get(String(balance.product));
                const derivedTarget = derived?.stockProduct && mongoose.Types.ObjectId.isValid(derived.stockProduct)
                    ? String(derived.stockProduct) : null;
                const stockTargetId = balance.stockProduct || derivedTarget || balance.product;
                const tracksStock = Boolean(balance.stockProduct || derivedTarget) ||
                    [0, 2].includes(derived?.productType);
                if (!tracksStock) continue;

                // Keep the decrement/restore factors in sync: a frozen
                // stockProduct (or a product with no derived target) uses the
                // balance factor; only a genuinely derived component borrows
                // the product's live stockConversionFactor (schema default 1).
                const factor = balance.stockProduct || !derivedTarget
                    ? toNumber(balance.conversionFactor ?? 1)
                    : toNumber(derived.stockConversionFactor ?? balance.conversionFactor ?? 1);
                const amount = toNumber(item.quantity) * factor;
                if (!Number.isFinite(amount) || amount <= 0) continue;

                await Product.updateOne(
                    { _id: stockTargetId },
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
            try {
                await session.abortTransaction();
            } catch {
                // El servidor pudo haber abortado la transacción antes.
            }
            session.endSession();

            if (isRetryableTransactionError(error) && attempt < VOID_TX_MAX_ATTEMPTS) {
                continue;
            }

            console.error("Error voiding combo redemption:", error);

            if (error?.message === "REDEMPTION_CONFLICT") {
                return translateErrorResponse(res, lang, "error_redemption_conflict", 409, translations);
            }

            return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
        }
    }
});

const getVoucherReconciliation = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const getModel = getRequestModelResolver(req);
    const ComboPurchase = getModel("ComboPurchase");
    const ComboRedemption = getModel("ComboRedemption");
    const MAX_REPORTED = 200;
    const TOLERANCE = 1e-6;

    const requester = await resolveReadRequester(req, res, getModel);
    if (requester.errorResponse) return requester.errorResponse;
    if (!requester.isStaff) {
        return translateErrorResponse(res, lang, "error_voucher_reconciliation_forbidden", 403, translations);
    }

    try {
        // Lectura completa: el reporte no repara nada, solo detecta desvíos.
        const vouchers = await ComboPurchase.find({}, {
            code: 1,
            status: 1,
            balances: 1,
            usedUnits: 1,
            totalUnits: 1
        }).lean();

        // Una sola pasada sobre los canjes vigentes (los anulados no cuentan).
        const totals = await ComboRedemption.aggregate([
            { $match: { voidedAt: null } },
            { $unwind: '$items' },
            {
                $group: {
                    _id: { voucher: '$comboPurchase', product: '$items.product' },
                    total: { $sum: '$items.quantity' }
                }
            }
        ]);

        const redemptionTotals = new Map();
        for (const row of totals) {
            redemptionTotals.set(`${row._id.voucher}:${row._id.product}`, toNumber(row.total));
        }

        const driftVouchers = [];

        for (const voucher of vouchers) {
            const issues = [];
            const balances = voucher.balances || [];

            let includedSum = 0;
            let usedSum = 0;

            for (const balance of balances) {
                const includedQty = toNumber(balance.includedQty);
                const usedQty = toNumber(balance.usedQty);
                includedSum += includedQty;
                usedSum += usedQty;

                // Invariante 2: el saldo gastado debe coincidir con los canjes.
                const redeemedQty = redemptionTotals.get(`${voucher._id}:${balance.product}`) || 0;
                if (Math.abs(redeemedQty - usedQty) > TOLERANCE) {
                    issues.push({
                        type: 'balance_mismatch',
                        product: balance.product,
                        expectedUsedQty: round6(redeemedQty),
                        actualUsedQty: round6(usedQty)
                    });
                }
            }

            const storedUsedUnits = toNumber(voucher.usedUnits);
            const storedTotalUnits = toNumber(voucher.totalUnits);

            // Invariante 4: los totales denormalizados reflejan los saldos.
            if (Math.abs(usedSum - storedUsedUnits) > TOLERANCE) {
                issues.push({
                    type: 'used_units_mismatch',
                    expected: round6(usedSum),
                    actual: round6(storedUsedUnits)
                });
            }

            if (Math.abs(includedSum - storedTotalUnits) > TOLERANCE) {
                issues.push({
                    type: 'total_units_mismatch',
                    expected: round6(includedSum),
                    actual: round6(storedTotalUnits)
                });
            }

            // Invariante 3: solo aplica a activos (0) y agotados (1).
            const status = Number(voucher.status);
            if (status === 1 && storedUsedUnits < storedTotalUnits - 1e-9) {
                issues.push({
                    type: 'status_mismatch',
                    expectedStatus: 0,
                    actualStatus: 1,
                    usedUnits: round6(storedUsedUnits),
                    totalUnits: round6(storedTotalUnits)
                });
            }

            if (status === 0 && storedUsedUnits >= storedTotalUnits - 1e-9) {
                issues.push({
                    type: 'status_mismatch',
                    expectedStatus: 1,
                    actualStatus: 0,
                    usedUnits: round6(storedUsedUnits),
                    totalUnits: round6(storedTotalUnits)
                });
            }

            if (issues.length > 0) {
                driftVouchers.push({
                    comboPurchase: voucher._id,
                    code: voucher.code,
                    issues
                });
            }
        }

        const truncated = driftVouchers.length > MAX_REPORTED;

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    checked: vouchers.length,
                    driftCount: driftVouchers.length,
                    truncated,
                    vouchers: truncated ? driftVouchers.slice(0, MAX_REPORTED) : driftVouchers
                },
                translations[lang]?.success_voucher_reconciliation || "success_voucher_reconciliation"
            )
        );
    } catch (error) {
        console.error("Error reconciling combo vouchers:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

export {
    getComboPurchases,
    getComboPurchaseById,
    getComboPurchaseRedemptions,
    createRedemption,
    voidRedemption,
    getVoucherReconciliation
};
