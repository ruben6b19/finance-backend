import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { Purchase } from "./purchase.model.js";
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

const createPurchase = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { purchaseNumber, supplierName, supplierId, items, subtotal, tax, discount, totalAmount, paymentMethod, paymentStatus, purchaseStatus, purchaseDate, transactionCategory, notes } = req.body;

    if (totalAmount === undefined) {
        return translateErrorResponse(res, lang, "error_purchase_required_fields", 400, translations);
    }

    const numericTotalAmount = Number(totalAmount);
    if (isNaN(numericTotalAmount) || numericTotalAmount <= 0) {
        return translateErrorResponse(res, lang, "error_purchase_invalid_amount", 400, translations);
    }

    if (items && (!Array.isArray(items) || items.length === 0)) {
        return translateErrorResponse(res, lang, "error_purchase_items_required", 400, translations);
    }

    const selectedPaymentMethod = paymentMethod !== undefined ? Number(paymentMethod) : 0;
    if (![0, 1, 2, 3].includes(selectedPaymentMethod)) {
        return translateErrorResponse(res, lang, "error_purchase_invalid_payment_method", 400, translations);
    }

    const selectedPaymentStatus = paymentStatus !== undefined ? Number(paymentStatus) : 0;
    if (![0, 1, 2].includes(selectedPaymentStatus)) {
        return translateErrorResponse(res, lang, "error_purchase_invalid_payment_status", 400, translations);
    }

    const selectedPurchaseStatus = purchaseStatus !== undefined ? Number(purchaseStatus) : 0;
    if (![0, 1, 2].includes(selectedPurchaseStatus)) {
        return translateErrorResponse(res, lang, "error_purchase_invalid_status", 400, translations);
    }

    let categoryId = transactionCategory;
    if (categoryId && !mongoose.Types.ObjectId.isValid(categoryId)) {
        return translateErrorResponse(res, lang, "error_purchase_invalid_transaction_category", 400, translations);
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        if (!categoryId) {
            const defaultCategory = await TransactionCategory.findOne({ name: 'Compra de Insumos', type: 1, isSystem: true }).session(session);
            if (defaultCategory) {
                categoryId = defaultCategory._id;
            }
        }

        const purchaseResults = await Purchase.create([{
            purchaseNumber: purchaseNumber ? purchaseNumber.trim() : undefined,
            supplierName: supplierName ? supplierName.trim() : undefined,
            supplierId: supplierId || null,
            items: items || [],
            subtotal: subtotal !== undefined ? Number(subtotal) : numericTotalAmount,
            tax: tax !== undefined ? Number(tax) : 0,
            discount: discount !== undefined ? Number(discount) : 0,
            totalAmount: numericTotalAmount,
            paymentMethod: selectedPaymentMethod,
            paymentStatus: selectedPaymentStatus,
            purchaseStatus: selectedPurchaseStatus,
            purchaseDate: purchaseDate ? new Date(purchaseDate) : new Date(),
            notes: notes ? notes.trim() : undefined,
            createdBy: req.user?.mongoDbId || null
        }], { session });

        const purchase = purchaseResults[0];

        // ACTUALIZACIÓN DE STOCK AUTOMÁTICA
        if (items && items.length > 0) {
            for (const item of items) {
                const { product, quantity, conversionFactor = 1 } = item;
                const increaseAmount = Number(quantity) * Number(conversionFactor);

                await Product.findByIdAndUpdate(
                    product,
                    { $inc: { stock: increaseAmount } },
                    { session }
                );
            }
        }

        // CREACIÓN DE TRANSACCIÓN AUTOMÁTICA (Gasto)
        const transactionResults = await Transaction.create([{
            type: 1, // Gasto
            amount: numericTotalAmount,
            paymentMethod: selectedPaymentMethod,
            concept: `Compra ${purchaseNumber ? purchaseNumber.trim() : purchase._id}`,
            category: categoryId,
            date: purchaseDate ? new Date(purchaseDate) : new Date(),
            purchaseId: purchase._id,
            notes: notes ? notes.trim() : undefined
        }], { session });

        purchase.transactionId = transactionResults[0]._id;
        await purchase.save({ session });

        await session.commitTransaction();
        session.endSession();

        return res.status(201).json(
            new ApiResponse(201, purchase, translations[lang]?.success_purchase_created || "success_purchase_created")
        );
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Error creating purchase:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getPurchases = asyncHandler(async (req, res) => {
    console.log(`Fetching purchases`);
    const lang = getLang(req);
    const pageParam = req.params.page || req.query.page;
    const { limit = 10, search, query, paymentMethod, paymentStatus, purchaseStatus, startDate, endDate, sortBy = 'purchaseDate', sortOrder = 'desc' } = req.query;
    const pageNumber = parseInt(pageParam) || 1;
    const limitNumber = parseInt(limit) || 10;
    
    const filter = {};

    if (paymentMethod !== undefined && paymentMethod !== '') {
        filter.paymentMethod = Number(paymentMethod);
    }

    if (paymentStatus !== undefined && paymentStatus !== '') {
        filter.paymentStatus = Number(paymentStatus);
    }

    if (purchaseStatus !== undefined && purchaseStatus !== '') {
        filter.purchaseStatus = Number(purchaseStatus);
    }

    if (startDate || endDate) {
        filter.purchaseDate = {};
        if (startDate) {
            filter.purchaseDate.$gte = new Date(startDate);
        }
        if (endDate) {
            filter.purchaseDate.$lte = new Date(endDate);
        }
    }

    const term = search || query;
    if (term && term.trim() !== '') {
        const searchRegex = { $regex: term.trim(), $options: 'i' };
        filter.$or = [
            { purchaseNumber: searchRegex },
            { supplierName: searchRegex },
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
        const results = await Purchase.paginate(filter, { ...options, populate: 'items.product' });

        return res.status(200).json(
            new ApiResponse(200, results, translations[lang]?.success_purchases_fetched || "success_purchases_fetched")
        );
    } catch (error) {
        console.error("Error fetching purchases:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getPurchaseById = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { purchaseId } = req.params;

    if (!purchaseId || !mongoose.Types.ObjectId.isValid(purchaseId)) {
        return translateErrorResponse(res, lang, "error_purchase_invalid_id", 400, translations);
    }

    try {
        const purchase = await Purchase.findById(purchaseId);

        if (!purchase) {
            return translateErrorResponse(res, lang, "error_purchase_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(200, purchase, translations[lang]?.success_purchase_fetched || "success_purchase_fetched")
        );
    } catch (error) {
        console.error("Error fetching purchase by ID:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const updatePurchase = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { purchaseId } = req.params;

    if (!purchaseId || !mongoose.Types.ObjectId.isValid(purchaseId)) {
        return translateErrorResponse(res, lang, "error_purchase_invalid_id", 400, translations);
    }

    const { purchaseNumber, supplierName, supplierId, items, subtotal, tax, discount, totalAmount, paymentMethod, paymentStatus, purchaseStatus, purchaseDate, transactionId, notes } = req.body;

    if (
        purchaseNumber === undefined &&
        supplierName === undefined &&
        supplierId === undefined &&
        items === undefined &&
        subtotal === undefined &&
        tax === undefined &&
        discount === undefined &&
        totalAmount === undefined &&
        paymentMethod === undefined &&
        paymentStatus === undefined &&
        purchaseStatus === undefined &&
        purchaseDate === undefined &&
        transactionId === undefined &&
        notes === undefined
    ) {
        return translateErrorResponse(res, lang, "error_purchase_no_fields_update", 400, translations);
    }

    const updateFields = {};

    if (purchaseNumber !== undefined) updateFields.purchaseNumber = purchaseNumber ? purchaseNumber.trim() : null;
    if (supplierName !== undefined) updateFields.supplierName = supplierName ? supplierName.trim() : 'Proveedor General';
    if (supplierId !== undefined) updateFields.supplierId = supplierId || null;
    if (items !== undefined) updateFields.items = items;
    if (subtotal !== undefined) updateFields.subtotal = Number(subtotal);
    if (tax !== undefined) updateFields.tax = Number(tax);
    if (discount !== undefined) updateFields.discount = Number(discount);
    if (transactionId !== undefined) updateFields.transactionId = transactionId || null;
    if (notes !== undefined) updateFields.notes = notes ? notes.trim() : undefined;
    if (purchaseDate !== undefined) updateFields.purchaseDate = new Date(purchaseDate);

    if (totalAmount !== undefined) {
        const numericTotalAmount = Number(totalAmount);
        if (isNaN(numericTotalAmount) || numericTotalAmount <= 0) {
            return translateErrorResponse(res, lang, "error_purchase_invalid_amount", 400, translations);
        }
        updateFields.totalAmount = numericTotalAmount;
    }

    if (paymentMethod !== undefined) {
        const numericPaymentMethod = Number(paymentMethod);
        if (![0, 1, 2, 3].includes(numericPaymentMethod)) {
            return translateErrorResponse(res, lang, "error_purchase_invalid_payment_method", 400, translations);
        }
        updateFields.paymentMethod = numericPaymentMethod;
    }

    if (paymentStatus !== undefined) {
        const numericPaymentStatus = Number(paymentStatus);
        if (![0, 1, 2].includes(numericPaymentStatus)) {
            return translateErrorResponse(res, lang, "error_purchase_invalid_payment_status", 400, translations);
        }
        updateFields.paymentStatus = numericPaymentStatus;
    }

    if (purchaseStatus !== undefined) {
        const numericPurchaseStatus = Number(purchaseStatus);
        if (![0, 1, 2].includes(numericPurchaseStatus)) {
            return translateErrorResponse(res, lang, "error_purchase_invalid_status", 400, translations);
        }
        updateFields.purchaseStatus = numericPurchaseStatus;
    }

    try {
        const updatedPurchase = await Purchase.findByIdAndUpdate(
            purchaseId,
            { $set: updateFields },
            { new: true, runValidators: true }
        );

        if (!updatedPurchase) {
            return translateErrorResponse(res, lang, "error_purchase_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(200, updatedPurchase, translations[lang]?.success_purchase_updated || "success_purchase_updated")
        );
    } catch (error) {
        console.error("Error updating purchase:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const deletePurchase = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { purchaseId } = req.params;

    if (!purchaseId || !mongoose.Types.ObjectId.isValid(purchaseId)) {
        return translateErrorResponse(res, lang, "error_purchase_invalid_id", 400, translations);
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const purchase = await Purchase.findById(purchaseId).session(session);

        if (!purchase) {
            await session.abortTransaction();
            session.endSession();
            return translateErrorResponse(res, lang, "error_purchase_not_found", 404, translations);
        }

        // 1. REVERSIÓN DE STOCK (Solo para Productos Directos - Tipo 2)
        if (purchase.items && purchase.items.length > 0) {
            for (const item of purchase.items) {
                const { product, quantity, conversionFactor = 1 } = item;
                const decreaseAmount = Number(quantity) * Number(conversionFactor) * -1;

                await Product.updateOne(
                    { _id: product, productType: 2 },
                    { $inc: { stock: decreaseAmount } },
                    { session }
                );
            }
        }

        // 2. ANULACIÓN DE TRANSACCIÓN VINCULADA
        if (purchase.transactionId) {
            await Transaction.findByIdAndUpdate(
                purchase.transactionId,
                { status: 0 },
                { session }
            );
        }

        // 3. ELIMINACIÓN DEL REGISTRO DE COMPRA
        await Purchase.findByIdAndDelete(purchaseId, { session });

        await session.commitTransaction();
        session.endSession();

        return res.status(200).json(
            new ApiResponse(200, {}, translations[lang]?.success_purchase_deleted || "success_purchase_deleted")
        );
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Error deleting purchase:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getPurchaseSummary = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { startDate, endDate } = req.query;

    const matchStage = {};

    if (startDate || endDate) {
        matchStage.purchaseDate = {};
        if (startDate) matchStage.purchaseDate.$gte = new Date(startDate);
        if (endDate) matchStage.purchaseDate.$lte = new Date(endDate);
    }

    try {
        const summary = await Purchase.aggregate([
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
            totalSpent: totalPaid,
            paidCount,
            pendingCount,
            cancelledCount,
            totalPurchases: paidCount + pendingCount + cancelledCount
        };

        return res.status(200).json(
            new ApiResponse(200, data, translations[lang]?.success_purchase_summary_fetched || "success_purchase_summary_fetched")
        );
    } catch (error) {
        console.error("Error generating purchase summary:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

export {
    createPurchase,
    getPurchases,
    getPurchaseById,
    updatePurchase,
    deletePurchase,
    getPurchaseSummary
};
