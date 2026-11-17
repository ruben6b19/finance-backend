import mongoose from "mongoose";
import { issueComboVouchers } from "../combos/comboPurchase.service.js";

// Productos con inventario real: insumos (0) y reventa (2).
// Los productos de menú (1) no se controlan por stock, igual que antes.
const STOCK_TRACKED_PRODUCT_TYPES = [0, 2];
const COMBO_PRODUCT_TYPE = 3;

const stockTargetId = (item) => item.stockProduct || item.product;

const stockAmount = (item) => {
    const quantity = item.quantity !== undefined ? Number(item.quantity) : 1;
    const factor = item.conversionFactor !== undefined ? Number(item.conversionFactor) : 1;
    return quantity * factor;
};

const isMissingStockConfig = (value) => value === undefined || value === null || value === "";

/**
 * Resolves the derived stock configuration of sale items server-side.
 *
 * Products such as a chicken presentation do not hold stock themselves: they
 * declare which product does (`stockProduct`) and how many stock units each
 * sold unit consumes (`stockConversionFactor`). Clients that only send
 * `product` and `quantity` therefore still get the correct stock movement.
 *
 * Explicit client values always win: an item is only enriched when BOTH
 * `stockProduct` and `conversionFactor` are absent. Products without the
 * derived configuration are left untouched. The input array is never mutated.
 *
 * @param {Array} items Raw sale items.
 * @param {Function} getModel Tenant model resolver.
 * @returns {Promise<Array>} A new array with the resolved items.
 */
export const resolveSaleStockItems = async (items, getModel) => {
    if (!Array.isArray(items)) return items;
    if (items.length === 0) return [];

    const productIds = [...new Set(items
        .filter((item) => item &&
            isMissingStockConfig(item.stockProduct) &&
            isMissingStockConfig(item.conversionFactor) &&
            mongoose.Types.ObjectId.isValid(item.product))
        .map((item) => String(item.product)))];

    if (productIds.length === 0) return [...items];

    const Product = getModel("Product");
    const products = await Product.find({ _id: { $in: productIds } })
        .select("stockProduct stockConversionFactor")
        .lean();

    const derivedByProductId = new Map(
        products.map((product) => [String(product._id), product])
    );

    return items.map((item) => {
        if (!item ||
            !isMissingStockConfig(item.stockProduct) ||
            !isMissingStockConfig(item.conversionFactor)) {
            return item;
        }

        const derived = derivedByProductId.get(String(item.product));
        if (!derived || !derived.stockProduct ||
            !mongoose.Types.ObjectId.isValid(derived.stockProduct)) {
            return item;
        }

        const rawFactor = isMissingStockConfig(derived.stockConversionFactor)
            ? 1
            : derived.stockConversionFactor;
        const factor = Number(rawFactor);
        if (!Number.isFinite(factor) || factor <= 0) return item;

        return { ...item, stockProduct: derived.stockProduct, conversionFactor: factor };
    });
};

/**
 * Aplica un movimiento de stock para los ítems de una venta.
 * direction -1 => descuenta (venta). direction +1 => repone (anulación).
 * Cuando el producto controla stock, el descuento es condicional para que
 * nunca quede en negativo, ni siquiera bajo concurrencia.
 *
 * @param {Array} items
 * @param {mongoose.ClientSession} session
 * @param {number} direction
 * @param {Function} getModel  Resolver del tenant; todas las lecturas y
 *        escrituras deben caer en la misma base que el resto del flujo.
 */
export const applyStockMovement = async (items, session, direction, getModel) => {
    if (!Array.isArray(items) || items.length === 0) return;

    const Product = getModel("Product");

    for (const item of items) {
        const targetId = stockTargetId(item);

        if (!targetId || !mongoose.Types.ObjectId.isValid(targetId)) {
            throw new Error("INVALID_STOCK_PRODUCT");
        }

        const amount = stockAmount(item);
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error("INVALID_STOCK_AMOUNT");
        }

        const target = await Product.findById(targetId).session(session);
        if (!target) {
            throw new Error("STOCK_PRODUCT_NOT_FOUND");
        }

        // Un combo no tiene stock propio: su disponibilidad es la de sus
        // componentes, que descuentan al canjearse (ComboRedemption).
        if (!item.stockProduct && target.productType === COMBO_PRODUCT_TYPE) {
            continue;
        }

        if (direction > 0) {
            await Product.updateOne(
                { _id: targetId },
                { $inc: { stock: amount } },
                { session }
            );
            continue;
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

const resolveCategoryId = async (categoryId, session, getModel) => {
    if (categoryId) return categoryId;

    const TransactionCategory = getModel("TransactionCategory");
    const defaultCategory = await TransactionCategory.findOne({
        name: 'Ventas POS',
        type: 0,
        isSystem: true
    }).session(session);

    return defaultCategory ? defaultCategory._id : null;
};

/**
 * Crea una venta completa: Sale + movimiento de stock + Transaction + vouchers
 * de combo (uno por unidad vendida cuando la venta incluye productos tipo 3).
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
 * @param {Function} params.getModel  Resolver del tenant.
 * @returns {Promise<object>} La venta creada; `comboVouchers` queda adjunto
 *          como propiedad no persistida.
 */
export const createSaleRecord = async ({ payload, userId, session, transactionExtra = {}, getModel }) => {
    const {
        saleNumber,
        customerName,
        customerPhone,
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

    const resolvedCategoryId = await resolveCategoryId(categoryId, session, getModel);
    const effectiveDate = saleDate ? new Date(saleDate) : new Date();

    const Sale = getModel("Sale");
    const Transaction = getModel("Transaction");

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
        await applyStockMovement(items, session, -1, getModel);
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

    // VOUCHERS DE COMBO
    // Los combos no mueven stock: cada unidad vendida emite un voucher con su
    // saldo de componentes congelado.
    const comboVouchers = await issueComboVouchers({
        items,
        customerName,
        customerPhone,
        customerId,
        sale: createdSale,
        purchasedAt: effectiveDate,
        paymentStatus,
        saleStatus,
        userId,
        session,
        getModel
    });
    createdSale.comboVouchers = comboVouchers;

    return createdSale;
};
