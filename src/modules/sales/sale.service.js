import mongoose from "mongoose";
import { Sale } from "./sale.model.js";
import { Product } from "../products/product.model.js";
import { Transaction } from "../transactions/transaction.model.js";
import { TransactionCategory } from "../transactionCategories/transactionCategory.model.js";

// Productos con inventario real: insumos (0) y reventa (2).
// Los productos de menú (1) no se controlan por stock, igual que antes.
const STOCK_TRACKED_PRODUCT_TYPES = [0, 2];

const stockTargetId = (item) => item.stockProduct || item.product;

const stockAmount = (item) => {
    const quantity = item.quantity !== undefined ? Number(item.quantity) : 1;
    const factor = item.conversionFactor !== undefined ? Number(item.conversionFactor) : 1;
    return quantity * factor;
};

/**
 * Aplica un movimiento de stock para los ítems de una venta.
 * direction -1 => descuenta (venta). direction +1 => repone (anulación).
 * Cuando el producto controla stock, el descuento es condicional para que
 * nunca quede en negativo, ni siquiera bajo concurrencia.
 */
export const applyStockMovement = async (items, session, direction) => {
    if (!Array.isArray(items) || items.length === 0) return;

    for (const item of items) {
        const targetId = stockTargetId(item);

        if (!targetId || !mongoose.Types.ObjectId.isValid(targetId)) {
            throw new Error("INVALID_STOCK_PRODUCT");
        }

        const amount = stockAmount(item);
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error("INVALID_STOCK_AMOUNT");
        }

        if (direction > 0) {
            await Product.updateOne(
                { _id: targetId },
                { $inc: { stock: amount } },
                { session }
            );
            continue;
        }

        const target = await Product.findById(targetId).session(session);
        if (!target) {
            throw new Error("STOCK_PRODUCT_NOT_FOUND");
        }

        const tracksStock = Boolean(item.stockProduct) ||
            STOCK_TRACKED_PRODUCT_TYPES.includes(target.productType);

        const filter = tracksStock
            ? { _id: targetId, stock: { $gte: amount } }
            : { _id: targetId };

        const result = await Product.updateOne(
            filter,
            { $inc: { stock: -amount } },
            { session }
        );

        if (tracksStock && result.matchedCount === 0) {
            throw new Error("INSUFFICIENT_STOCK");
        }
    }
};

export const STOCK_ERROR_CODES = {
    INSUFFICIENT_STOCK: "error_sale_insufficient_stock",
    STOCK_PRODUCT_NOT_FOUND: "error_sale_stock_product_not_found",
    INVALID_STOCK_PRODUCT: "error_sale_stock_product_not_found",
    INVALID_STOCK_AMOUNT: "error_sale_invalid_item_quantity"
};

const resolveCategoryId = async (categoryId, session) => {
    if (categoryId) return categoryId;

    const defaultCategory = await TransactionCategory.findOne({
        name: 'Ventas POS',
        type: 0,
        isSystem: true
    }).session(session);

    return defaultCategory ? defaultCategory._id : null;
};

/**
 * Crea una venta completa: Sale + movimiento de stock + Transaction.
 * Es el único camino por el que se crea una venta, para que el POS, las
 * reservas y los combos compartan exactamente las mismas reglas.
 *
 * Debe ejecutarse dentro de una transacción de Mongo abierta por el llamador.
 *
 * @param {object} params
 * @param {object} params.payload  Campos de la venta ya validados y normalizados.
 * @param {string|mongoose.Types.ObjectId|null} params.userId  Autor de la venta.
 * @param {mongoose.ClientSession} params.session  Sesión activa.
 * @param {object} [params.transactionExtra]  Campos extra para la Transaction
 *        (por ejemplo `reservationId`).
 * @returns {Promise<object>} La venta creada.
 */
export const createSaleRecord = async ({ payload, userId, session, transactionExtra = {} }) => {
    const {
        saleNumber,
        customerName,
        customerId = null,
        items = [],
        subtotal,
        tax = 0,
        discount = 0,
        totalAmount,
        paymentMethod = 0,
        paymentStatus = 1,
        saleStatus = 0,
        saleDate,
        categoryId,
        notes
    } = payload;

    const resolvedCategoryId = await resolveCategoryId(categoryId, session);
    const effectiveDate = saleDate ? new Date(saleDate) : new Date();

    const sale = await Sale.create([{
        saleNumber: saleNumber ? saleNumber.trim() : undefined,
        customerName: customerName ? customerName.trim() : undefined,
        customerId: customerId || null,
        items,
        subtotal: subtotal !== undefined ? Number(subtotal) : Number(totalAmount),
        tax: Number(tax),
        discount: Number(discount),
        totalAmount: Number(totalAmount),
        paymentMethod: Number(paymentMethod),
        paymentStatus: Number(paymentStatus),
        saleStatus: Number(saleStatus),
        saleDate: effectiveDate,
        notes: notes ? notes.trim() : undefined,
        createdBy: userId || null
    }], { session });

    const createdSale = sale[0];

    // REDUCCIÓN DE STOCK AUTOMÁTICA
    // Respeta stockProduct/conversionFactor y nunca deja stock negativo
    // en productos que sí controlan inventario.
    if (items.length > 0) {
        await applyStockMovement(items, session, -1);
    }

    const transaction = await Transaction.create([{
        type: 0,
        amount: Number(totalAmount),
        paymentMethod: Number(paymentMethod),
        concept: `Venta ${saleNumber ? saleNumber.trim() : createdSale._id}`,
        category: resolvedCategoryId,
        date: effectiveDate,
        ...transactionExtra,
        // Los campos propios de la venta ganan siempre sobre los extras.
        saleId: createdSale._id,
        notes: notes ? notes.trim() : undefined,
        createdBy: userId || null
    }], { session });

    createdSale.transactionId = transaction[0]._id;
    await createdSale.save({ session });

    return createdSale;
};
