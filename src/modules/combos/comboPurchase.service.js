import mongoose from "mongoose";
import { Product } from "../products/product.model.js";
import { ComboDefinition } from "./comboDefinition.model.js";
import { ComboComponent } from "./comboComponent.model.js";
import { ComboPurchase } from "./comboPurchase.model.js";

const COMBO_PRODUCT_TYPE = 3;

export const COMBO_VOUCHER_ERROR_CODES = {
    COMBO_PRODUCT_NOT_FOUND: "error_sale_combo_product_not_found",
    COMBO_PAYMENT_REQUIRED: "error_sale_combo_payment_required",
    COMBO_CUSTOMER_PHONE_REQUIRED: "error_sale_combo_customer_phone_required",
    COMBO_INVALID_QUANTITY: "error_sale_combo_invalid_quantity",
    COMBO_DEFINITION_NOT_FOUND: "error_sale_combo_definition_missing",
    COMBO_INACTIVE: "error_sale_combo_inactive",
    COMBO_INVALID_PRICE: "error_sale_combo_invalid_price",
    COMBO_ALREADY_REDEEMED: "error_sale_combo_already_redeemed"
};

const parseUnitPrice = (value) => {
    const text = value !== null && value !== undefined && typeof value.toString === "function"
        ? value.toString()
        : value;
    return Number.parseFloat(text);
};

/**
 * Emite un voucher ComboPurchase por cada unidad de combo vendida.
 * Debe ejecutarse dentro de la transacción abierta por el llamador: usa su
 * sesión para todas las lecturas y escrituras.
 *
 * @param {object} params
 * @param {Array} params.items  Ítems de la venta.
 * @param {string} [params.customerName]
 * @param {string} [params.customerPhone]
 * @param {string|mongoose.Types.ObjectId|null} [params.customerId]
 * @param {object} params.sale  Venta recién creada.
 * @param {Date} params.purchasedAt  Fecha efectiva de la compra.
 * @param {number} params.paymentStatus  Estado de pago de la venta.
 * @param {number} params.saleStatus  Estado de la venta.
 * @param {string|mongoose.Types.ObjectId|null} [params.userId]
 * @param {mongoose.ClientSession} params.session  Sesión activa.
 * @returns {Promise<Array>} Vouchers creados.
 */
export const issueComboVouchers = async ({
    items,
    customerName,
    customerPhone,
    customerId,
    sale,
    purchasedAt,
    paymentStatus,
    saleStatus,
    userId,
    session
}) => {
    if (!Array.isArray(items) || items.length === 0) return [];

    const productIds = [];
    for (const item of items) {
        if (!item?.product || !mongoose.Types.ObjectId.isValid(item.product)) {
            throw new Error("COMBO_PRODUCT_NOT_FOUND");
        }
        productIds.push(String(item.product));
    }

    const products = await Product.find({
        _id: { $in: [...new Set(productIds)] }
    }).session(session);
    const productMap = new Map(products.map((product) => [String(product._id), product]));

    const comboItems = [];
    for (const item of items) {
        const product = productMap.get(String(item.product));
        if (!product) {
            throw new Error("COMBO_PRODUCT_NOT_FOUND");
        }
        if (product.productType === COMBO_PRODUCT_TYPE) {
            comboItems.push(item);
        }
    }

    if (comboItems.length === 0) return [];
    if (Number(saleStatus) === 2) return [];
    if (Number(paymentStatus) !== 1) {
        throw new Error("COMBO_PAYMENT_REQUIRED");
    }
    if (typeof customerPhone !== "string" || customerPhone.trim() === "") {
        throw new Error("COMBO_CUSTOMER_PHONE_REQUIRED");
    }

    const normalizedCustomerName = customerName ? customerName.trim() : "";
    const normalizedCustomerPhone = customerPhone.trim();
    const purchaseDate = purchasedAt ? new Date(purchasedAt) : new Date();
    const vouchers = [];

    for (const item of comboItems) {
        const quantity = Number(item.quantity);
        if (!Number.isInteger(quantity) || quantity < 1) {
            throw new Error("COMBO_INVALID_QUANTITY");
        }

        const definition = await ComboDefinition.findOne({ product: item.product }).session(session);
        if (!definition) {
            throw new Error("COMBO_DEFINITION_NOT_FOUND");
        }
        if (Number(definition.status) !== 1) {
            throw new Error("COMBO_INACTIVE");
        }

        const components = await ComboComponent.find({ combo: definition._id })
            .sort({ createdAt: 1 })
            .session(session);
        if (components.length === 0) {
            throw new Error("COMBO_DEFINITION_NOT_FOUND");
        }

        const unitPrice = parseUnitPrice(item.unitPrice);
        if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
            throw new Error("COMBO_INVALID_PRICE");
        }

        const validityDays = Number(definition.validityDays) || 0;
        const expiresAt = validityDays > 0
            ? new Date(purchaseDate.getTime() + validityDays * 86400000)
            : null;

        const balances = components.map((component) => ({
            product: component.product,
            includedQty: Number(component.quantity),
            usedQty: 0,
            stockProduct: component.stockProduct || null,
            conversionFactor: Number(component.conversionFactor ?? 1)
        }));
        const totalUnits = balances.reduce(
            (sum, balance) => sum + balance.includedQty,
            0
        );

        const docs = [];
        for (let unit = 0; unit < quantity; unit += 1) {
            const voucherId = new mongoose.Types.ObjectId();
            docs.push({
                _id: voucherId,
                code: voucherId.toString().slice(-8).toUpperCase(),
                comboProduct: item.product,
                comboDefinition: definition._id,
                sale: sale._id,
                customerName: normalizedCustomerName || "General Public",
                customerPhone: normalizedCustomerPhone,
                customerId: customerId || null,
                purchasedAt: purchaseDate,
                expiresAt,
                graceDays: Number(definition.graceDays) || 0,
                pricePaid: unitPrice,
                balances,
                totalUnits,
                usedUnits: 0,
                status: 0,
                createdBy: userId || null
            });
        }

        const created = await ComboPurchase.create(docs, { session, ordered: true });
        vouchers.push(...created);
    }

    return vouchers;
};

/**
 * Cancela los vouchers emitidos por una venta anulada.
 * Si alguno ya fue canjeado, la anulación completa debe rechazarse.
 *
 * @param {object} params
 * @param {string|mongoose.Types.ObjectId} params.saleId
 * @param {mongoose.ClientSession} params.session  Sesión activa.
 * @param {Date} [params.closedAt]
 * @returns {Promise<number>} Cantidad de vouchers modificados.
 */
export const cancelComboVouchersForSale = async ({
    saleId,
    session,
    closedAt = new Date()
}) => {
    const vouchers = await ComboPurchase.find({ sale: saleId }).session(session);

    if (vouchers.some((voucher) => Number(voucher.usedUnits) > 0)) {
        throw new Error("COMBO_ALREADY_REDEEMED");
    }

    if (vouchers.length === 0) return 0;

    const result = await ComboPurchase.updateMany(
        { sale: saleId },
        { $set: { status: 3, closedAt } },
        { session }
    );

    return result.modifiedCount;
};
