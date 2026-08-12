import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { Sale } from "./sale.model.js";
import { Product } from "../products/product.model.js";
import { Transaction } from "../transactions/transaction.model.js";
import { TransactionCategory } from "../transactionCategories/transactionCategory.model.js";
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

const createSale = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { saleNumber, customerName, customerId, items, subtotal, tax, discount, totalAmount, paymentMethod, paymentStatus, saleStatus, saleDate, transactionCategory, notes } = req.body;

    if (totalAmount === undefined) {
        return translateErrorResponse(res, lang, "error_sale_required_fields", 400, translations);
    }

    const numericTotalAmount = Number(totalAmount);
    if (isNaN(numericTotalAmount) || numericTotalAmount <= 0) {
        return translateErrorResponse(res, lang, "error_sale_invalid_amount", 400, translations);
    }

    if (items && (!Array.isArray(items) || items.length === 0)) {
        return translateErrorResponse(res, lang, "error_sale_items_required", 400, translations);
    }

    const selectedPaymentMethod = paymentMethod !== undefined ? Number(paymentMethod) : 0;
    if (![0, 1, 2, 3].includes(selectedPaymentMethod)) {
        return translateErrorResponse(res, lang, "error_sale_invalid_payment_method", 400, translations);
    }

    const selectedPaymentStatus = paymentStatus !== undefined ? Number(paymentStatus) : 1;
    if (![0, 1, 2].includes(selectedPaymentStatus)) {
        return translateErrorResponse(res, lang, "error_sale_invalid_payment_status", 400, translations);
    }

    const selectedSaleStatus = saleStatus !== undefined ? Number(saleStatus) : 0;
    if (![0, 1, 2].includes(selectedSaleStatus)) {
        return translateErrorResponse(res, lang, "error_sale_invalid_status", 400, translations);
    }

    let categoryId = transactionCategory;
    if (categoryId && !mongoose.Types.ObjectId.isValid(categoryId)) {
        return translateErrorResponse(res, lang, "error_sale_invalid_transaction_category", 400, translations);
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        if (!categoryId) {
            const defaultCategory = await TransactionCategory.findOne({ name: 'Ventas POS', type: 0, isSystem: true }).session(session);
            if (defaultCategory) {
                categoryId = defaultCategory._id;
            }
        }
        console.log(`Creating sale with categoryId: ${categoryId}`);
        const sale = await Sale.create([{
            saleNumber: saleNumber ? saleNumber.trim() : undefined,
            customerName: customerName ? customerName.trim() : undefined,
            customerId: customerId || null,
            items: items || [],
            subtotal: subtotal !== undefined ? Number(subtotal) : numericTotalAmount,
            tax: tax !== undefined ? Number(tax) : 0,
            discount: discount !== undefined ? Number(discount) : 0,
            totalAmount: numericTotalAmount,
            paymentMethod: selectedPaymentMethod,
            paymentStatus: selectedPaymentStatus,
            saleStatus: selectedSaleStatus,
            saleDate: saleDate ? new Date(saleDate) : new Date(),
            notes: notes ? notes.trim() : undefined,
            createdBy: req.user?.mongoDbId || null
        }], { session });

        const createdSale = sale[0];

        // REDUCCIÓN DE STOCK AUTOMÁTICA
        if (items && items.length > 0) {
            for (const item of items) {
                await Product.findByIdAndUpdate(
                    item.product,
                    { $inc: { stock: -item.quantity } },
                    { session }
                );
            }
        }

        const transaction = await Transaction.create([{
            type: 0,
            amount: numericTotalAmount,
            paymentMethod: selectedPaymentMethod,
            concept: `Venta ${saleNumber ? saleNumber.trim() : createdSale._id}`,
            category: categoryId,
            date: saleDate ? new Date(saleDate) : new Date(),
            saleId: createdSale._id,
            notes: notes ? notes.trim() : undefined,
            createdBy: req.user?.mongoDbId || null
        }], { session });

        console.log(`Created transaction with ID: ${transaction}`);
        createdSale.transactionId = transaction[0]._id;
        await createdSale.save({ session });

        await session.commitTransaction();
        session.endSession();

        return res.status(201).json(
            new ApiResponse(201, createdSale, translations[lang]?.success_sale_created || "success_sale_created")
        );
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Error creating sale:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getSales = asyncHandler(async (req, res) => {
    console.log(`Fetching sales`);
    const lang = getLang(req);
    const pageParam = req.params.page || req.query.page;
    const { limit = 10, search, query, paymentMethod, paymentStatus, saleStatus, userId, startDate, endDate, sortBy = 'saleDate', sortOrder = 'desc' } = req.query;
    const pageNumber = parseInt(pageParam) || 1;
    const limitNumber = parseInt(limit) || 10;

    const filter = {};

    if (userId && userId.trim() !== '') {
        filter.createdBy = userId;
    }

    if (paymentMethod !== undefined && paymentMethod !== '') {
        filter.paymentMethod = Number(paymentMethod);
    }

    if (paymentStatus !== undefined && paymentStatus !== '') {
        filter.paymentStatus = Number(paymentStatus);
    }

    if (saleStatus !== undefined && saleStatus !== '') {
        filter.saleStatus = Number(saleStatus);
    }

    if (startDate || endDate) {
        filter.saleDate = {};
        if (startDate) {
            filter.saleDate.$gte = new Date(startDate);
        }
        if (endDate) {
            filter.saleDate.$lte = new Date(endDate);
        }
    }

    const term = search || query;
    if (term && term.trim() !== '') {
        const searchRegex = { $regex: term.trim(), $options: 'i' };
        filter.$or = [
            { saleNumber: searchRegex },
            { customerName: searchRegex },
            { notes: searchRegex }
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
        const results = await Sale.paginate(filter, { ...options, populate: ['items.product', 'createdBy'] });

        return res.status(200).json(
            new ApiResponse(200, results, translations[lang]?.success_sales_fetched || "success_sales_fetched")
        );
    } catch (error) {
        console.error("Error fetching sales:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getSaleById = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { saleId } = req.params;

    if (!saleId || !mongoose.Types.ObjectId.isValid(saleId)) {
        return translateErrorResponse(res, lang, "error_sale_invalid_id", 400, translations);
    }

    try {
        const sale = await Sale.findById(saleId);

        if (!sale) {
            return translateErrorResponse(res, lang, "error_sale_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(200, sale, translations[lang]?.success_sale_fetched || "success_sale_fetched")
        );
    } catch (error) {
        console.error("Error fetching sale by ID:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const updateSale = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { saleId } = req.params;

    if (!saleId || !mongoose.Types.ObjectId.isValid(saleId)) {
        return translateErrorResponse(res, lang, "error_sale_invalid_id", 400, translations);
    }

    const { saleNumber, customerName, customerId, items, subtotal, tax, discount, totalAmount, paymentMethod, paymentStatus, saleStatus, saleDate, transactionId, notes } = req.body;

    if (
        saleNumber === undefined &&
        customerName === undefined &&
        customerId === undefined &&
        items === undefined &&
        subtotal === undefined &&
        tax === undefined &&
        discount === undefined &&
        totalAmount === undefined &&
        paymentMethod === undefined &&
        paymentStatus === undefined &&
        saleStatus === undefined &&
        saleDate === undefined &&
        transactionId === undefined &&
        notes === undefined
    ) {
        return translateErrorResponse(res, lang, "error_sale_no_fields_update", 400, translations);
    }

    const updateFields = {};

    if (saleNumber !== undefined) updateFields.saleNumber = saleNumber ? saleNumber.trim() : null;
    if (customerName !== undefined) updateFields.customerName = customerName ? customerName.trim() : 'General Public';
    if (customerId !== undefined) updateFields.customerId = customerId || null;
    if (items !== undefined) updateFields.items = items;
    if (subtotal !== undefined) updateFields.subtotal = Number(subtotal);
    if (tax !== undefined) updateFields.tax = Number(tax);
    if (discount !== undefined) updateFields.discount = Number(discount);
    if (transactionId !== undefined) updateFields.transactionId = transactionId || null;
    if (notes !== undefined) updateFields.notes = notes ? notes.trim() : undefined;
    if (saleDate !== undefined) updateFields.saleDate = new Date(saleDate);

    if (totalAmount !== undefined) {
        const numericTotalAmount = Number(totalAmount);
        if (isNaN(numericTotalAmount) || numericTotalAmount <= 0) {
            return translateErrorResponse(res, lang, "error_sale_invalid_amount", 400, translations);
        }
        updateFields.totalAmount = numericTotalAmount;
    }

    if (paymentMethod !== undefined) {
        const numericPaymentMethod = Number(paymentMethod);
        if (![0, 1, 2, 3].includes(numericPaymentMethod)) {
            return translateErrorResponse(res, lang, "error_sale_invalid_payment_method", 400, translations);
        }
        updateFields.paymentMethod = numericPaymentMethod;
    }

    if (paymentStatus !== undefined) {
        const numericPaymentStatus = Number(paymentStatus);
        if (![0, 1, 2].includes(numericPaymentStatus)) {
            return translateErrorResponse(res, lang, "error_sale_invalid_payment_status", 400, translations);
        }
        updateFields.paymentStatus = numericPaymentStatus;
    }

    if (saleStatus !== undefined) {
        const numericSaleStatus = Number(saleStatus);
        if (![0, 1, 2].includes(numericSaleStatus)) {
            return translateErrorResponse(res, lang, "error_sale_invalid_status", 400, translations);
        }
        updateFields.saleStatus = numericSaleStatus;
    }

    try {
        const updatedSale = await Sale.findByIdAndUpdate(
            saleId,
            { $set: updateFields },
            { new: true, runValidators: true }
        );

        if (!updatedSale) {
            return translateErrorResponse(res, lang, "error_sale_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(200, updatedSale, translations[lang]?.success_sale_updated || "success_sale_updated")
        );
    } catch (error) {
        console.error("Error updating sale:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const deleteSale = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { saleId } = req.params;

    if (!saleId || !mongoose.Types.ObjectId.isValid(saleId)) {
        return translateErrorResponse(res, lang, "error_sale_invalid_id", 400, translations);
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const sale = await Sale.findById(saleId).session(session);

        if (!sale) {
            await session.abortTransaction();
            session.endSession();
            return translateErrorResponse(res, lang, "error_sale_not_found", 404, translations);
        }

        // 1. REVERSIÓN DE STOCK (Si la venta no estaba ya cancelada)
        if (sale.saleStatus !== 2) {
            for (const item of sale.items) {
                await Product.updateOne(
                    { _id: item.product, productType: 2 },
                    { $inc: { stock: item.quantity } },
                    { session }
                );
            }
        }

        // 2. ANULACIÓN DE TRANSACCIÓN VINCULADA
        if (sale.transactionId) {
            await Transaction.findByIdAndUpdate(
                sale.transactionId,
                { status: 0 },
                { session }
            );
        }

        // 3. ELIMINACIÓN DEL REGISTRO DE VENTA
        await Sale.findByIdAndDelete(saleId, { session });

        await session.commitTransaction();
        session.endSession();

        return res.status(200).json(
            new ApiResponse(200, {}, translations[lang]?.success_sale_deleted || "success_sale_deleted")
        );
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Error deleting sale:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getSaleSummary = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { startDate, endDate } = req.query;

    const matchStage = {};

    if (startDate || endDate) {
        matchStage.saleDate = {};
        if (startDate) matchStage.saleDate.$gte = new Date(startDate);
        if (endDate) matchStage.saleDate.$lte = new Date(endDate);
    }

    try {
        const summary = await Sale.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: "$paymentStatus",
                    totalAmount: { $sum: { $toDouble: "$totalAmount" } },
                    count: { $sum: 1 }
                }
            }
        ]);

        let totalPaid = 0;
        let totalPending = 0;
        let totalCancelled = 0;
        let paidCount = 0;
        let pendingCount = 0;
        let cancelledCount = 0;

        summary.forEach((item) => {
            if (item._id === 0) {
                totalPending = item.totalAmount;
                pendingCount = item.count;
            } else if (item._id === 1) {
                totalPaid = item.totalAmount;
                paidCount = item.count;
            } else if (item._id === 2) {
                totalCancelled = item.totalAmount;
                cancelledCount = item.count;
            }
        });

        const data = {
            totalPaid,
            totalPending,
            totalCancelled,
            totalRevenue: totalPaid,
            paidCount,
            pendingCount,
            cancelledCount,
            totalSales: paidCount + pendingCount + cancelledCount
        };

        return res.status(200).json(
            new ApiResponse(200, data, translations[lang]?.success_sale_summary_fetched || "success_sale_summary_fetched")
        );
    } catch (error) {
        console.error("Error generating sale summary:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const cancelSale = asyncHandler(async (req, res) => {
  const lang = getLang(req);
  const { saleId } = req.params;

  if (!saleId || !mongoose.Types.ObjectId.isValid(saleId)) {
    return translateErrorResponse(res, lang, "error_sale_invalid_id", 400, translations);
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const sale = await Sale.findById(saleId).session(session);

    if (!sale) {
      await session.abortTransaction();
      session.endSession();
      return translateErrorResponse(res, lang, "error_sale_not_found", 404, translations);
    }

    if (sale.saleStatus === 2) {
      await session.abortTransaction();
      session.endSession();
      return translateErrorResponse(res, lang, "error_sale_already_cancelled", 400, translations);
    }

    sale.saleStatus = 2;
    sale.paymentStatus = 2;
    await sale.save({ session });

    for (const item of sale.items) {
      await Product.updateOne(
        { _id: item.product, productType: 2 },
        { $inc: { stock: item.quantity } },
        { session }
      );
    }

    if (sale.transactionId) {
      await Transaction.findByIdAndUpdate(
        sale.transactionId,
        { status: 0 },
        { session }
      );
    }

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json(
      new ApiResponse(200, sale, translations[lang]?.success_sale_cancelled || "success_sale_cancelled")
    );
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("Error cancelling sale:", error);
    return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
  }
});

export {
    createSale,
    getSales,
    getSaleById,
    updateSale,
    deleteSale,
    getSaleSummary,
    cancelSale
};
