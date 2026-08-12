import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { Transaction } from "./transaction.model.js";
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

const createTransaction = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { type, amount, paymentMethod, concept, category, date, saleId, purchaseId, notes } = req.body;

    // 1. Validation - Required fields
    if (
        type === undefined ||
        amount === undefined ||
        !concept || (typeof concept === 'string' && concept.trim() === '') ||
        !category
    ) {
        return translateErrorResponse(res, lang, "error_transaction_required_fields", 400, translations);
    }

    // 2. Validation - Type (0: Income, 1: Expense)
    const numericType = Number(type);
    if (![0, 1].includes(numericType)) {
        return translateErrorResponse(res, lang, "error_transaction_invalid_type", 400, translations);
    }

    // 3. Validation - Amount (> 0)
    const numericAmount = Number(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
        return translateErrorResponse(res, lang, "error_transaction_invalid_amount", 400, translations);
    }

    // 4. Validation - Payment method (0: Cash, 1: Transfer, 2: Card, 3: Other)
    const selectedPaymentMethod = paymentMethod !== undefined ? Number(paymentMethod) : 0;
    if (![0, 1, 2, 3].includes(selectedPaymentMethod)) {
        return translateErrorResponse(res, lang, "error_transaction_invalid_payment_method", 400, translations);
    }

    try {
        const transaction = await Transaction.create({
            type: numericType,
            amount: numericAmount,
            paymentMethod: selectedPaymentMethod,
            concept: concept.trim(),
            category: category,
            date: date ? new Date(date) : new Date(),
            saleId: saleId || null,
            purchaseId: purchaseId || null,
            notes: notes ? notes.trim() : undefined,
            createdBy: req.user?.mongoDbId || null
        });

        return res.status(201).json(
            new ApiResponse(201, transaction, translations[lang]?.success_transaction_created || "success_transaction_created")
        );
    } catch (error) {
        console.error("Error creating transaction:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getTransactions = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const pageParam = req.params.page || req.query.page;
    const { limit = 10, search, query, type, category, paymentMethod, startDate, endDate, sortBy = 'date', sortOrder = 'desc' } = req.query;
    console.log("getTransactions query params:", req.query);
    const pageNumber = parseInt(pageParam) || 1;
    const limitNumber = parseInt(limit) || 10;

    const filter = { status: 1 };

    // Filter by type (0: Income, 1: Expense)
    if (type !== undefined && type !== '') {
        filter.type = Number(type);
    }

    if (category && category.trim() !== '') {
        filter.category = category;
    }

    // Filter by payment method
    if (paymentMethod !== undefined && paymentMethod !== '') {
        filter.paymentMethod = Number(paymentMethod);
    }

    // Date range filter
    if (startDate || endDate) {
        filter.date = {};
        if (startDate) {
            filter.date.$gte = new Date(startDate);
        }
        if (endDate) {
            filter.date.$lte = new Date(endDate);
        }
    }

    const term = search || query;
    if (term && term.trim() !== '') {
        const searchRegex = { $regex: term.trim(), $options: 'i' };
        filter.$or = [
            { concept: searchRegex }
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
        const results = await Transaction.paginate(filter, { ...options, populate: 'createdBy' });

        console.log("getTransactions results:", results.pages, results.totalDocs, results.limit, results.page, results.totalPages);
        return res.status(200).json(
            new ApiResponse(200, results, translations[lang]?.success_transactions_fetched || "success_transactions_fetched")
        );
    } catch (error) {
        console.error("Error fetching transactions:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getTransactionById = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { transactionId } = req.params;

    if (!transactionId || !mongoose.Types.ObjectId.isValid(transactionId)) {
        return translateErrorResponse(res, lang, "error_transaction_invalid_id", 400, translations);
    }

    try {
        const transaction = await Transaction.findById(transactionId);

        if (!transaction) {
            return translateErrorResponse(res, lang, "error_transaction_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(200, transaction, translations[lang]?.success_transaction_fetched || "success_transaction_fetched")
        );
    } catch (error) {
        console.error("Error fetching transaction by ID:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const updateTransaction = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { transactionId } = req.params;

    if (!transactionId || !mongoose.Types.ObjectId.isValid(transactionId)) {
        return translateErrorResponse(res, lang, "error_transaction_invalid_id", 400, translations);
    }

    const { type, amount, paymentMethod, concept, category, date, saleId, purchaseId, notes } = req.body;

    if (
        type === undefined &&
        amount === undefined &&
        paymentMethod === undefined &&
        concept === undefined &&
        category === undefined &&
        date === undefined &&
        saleId === undefined &&
        purchaseId === undefined &&
        notes === undefined
    ) {
        return translateErrorResponse(res, lang, "error_transaction_no_fields_update", 400, translations);
    }

    const updateFields = {};

    if (type !== undefined) {
        const numericType = Number(type);
        if (![0, 1].includes(numericType)) {
            return translateErrorResponse(res, lang, "error_transaction_invalid_type", 400, translations);
        }
        updateFields.type = numericType;
    }

    if (amount !== undefined) {
        const numericAmount = Number(amount);
        if (isNaN(numericAmount) || numericAmount <= 0) {
            return translateErrorResponse(res, lang, "error_transaction_invalid_amount", 400, translations);
        }
        updateFields.amount = numericAmount;
    }

    if (paymentMethod !== undefined) {
        const numericPaymentMethod = Number(paymentMethod);
        if (![0, 1, 2, 3].includes(numericPaymentMethod)) {
            return translateErrorResponse(res, lang, "error_transaction_invalid_payment_method", 400, translations);
        }
        updateFields.paymentMethod = numericPaymentMethod;
    }

    if (concept !== undefined) updateFields.concept = concept.trim();
    if (category !== undefined) updateFields.category = category || null;
    if (date !== undefined) updateFields.date = new Date(date);
    if (saleId !== undefined) updateFields.saleId = saleId || null;
    if (purchaseId !== undefined) updateFields.purchaseId = purchaseId || null;
    if (notes !== undefined) updateFields.notes = notes.trim();

    try {
        const transaction = await Transaction.findById(transactionId);

        if (!transaction) {
            return translateErrorResponse(res, lang, "error_transaction_not_found", 404, translations);
        }

        // Rule 1: No system transactions
        if (transaction.saleId || transaction.purchaseId) {
            return translateErrorResponse(res, lang, "error_transaction_immutable_system", 403, translations);
        }

        // Rule 2: Only today's transactions
        const txDate = new Date(transaction.date).toISOString().split('T')[0];
        const today = new Date().toISOString().split('T')[0];
        if (txDate !== today) {
            return translateErrorResponse(res, lang, "error_transaction_immutable_date", 403, translations);
        }

        const updatedTransaction = await Transaction.findByIdAndUpdate(
            transactionId,
            { $set: updateFields },
            { new: true, runValidators: true }
        );

        return res.status(200).json(
            new ApiResponse(200, updatedTransaction, translations[lang]?.success_transaction_updated || "success_transaction_updated")
        );
    } catch (error) {
        console.error("Error updating transaction:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const deleteTransaction = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { transactionId } = req.params;

    if (!transactionId || !mongoose.Types.ObjectId.isValid(transactionId)) {
        return translateErrorResponse(res, lang, "error_transaction_invalid_id", 400, translations);
    }

    try {
        const transaction = await Transaction.findById(transactionId);

        if (!transaction) {
            return translateErrorResponse(res, lang, "error_transaction_not_found", 404, translations);
        }

        // Rule 1: No system transactions
        if (transaction.saleId || transaction.purchaseId) {
            return translateErrorResponse(res, lang, "error_transaction_immutable_system", 403, translations);
        }

        // Rule 2: Only today's transactions
        const txDate = new Date(transaction.date).toISOString().split('T')[0];
        const today = new Date().toISOString().split('T')[0];
        if (txDate !== today) {
            return translateErrorResponse(res, lang, "error_transaction_immutable_date", 403, translations);
        }

        await Transaction.findByIdAndUpdate(transactionId, { status: 0 });

        return res.status(200).json(
            new ApiResponse(200, {}, translations[lang]?.success_transaction_deleted || "success_transaction_deleted")
        );
    } catch (error) {
        console.error("Error deleting transaction:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getTransactionSummary = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { startDate, endDate, category } = req.query;

    const matchStage = { status: 1 };

    if (category && category.trim() !== '') {
        matchStage.category = new mongoose.Types.ObjectId(category);
    }

    if (startDate || endDate) {
        matchStage.date = {};
        if (startDate) matchStage.date.$gte = new Date(startDate);
        if (endDate) matchStage.date.$lte = new Date(endDate);
    }

    try {
        const summary = await Transaction.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: "$type",
                    totalAmount: { $sum: { $toDouble: "$amount" } },
                    count: { $sum: 1 }
                }
            }
        ]);

        let totalIncome = 0;
        let totalExpense = 0;
        let incomeCount = 0;
        let expenseCount = 0;

        summary.forEach((item) => {
            if (item._id === 0) {
                totalIncome = item.totalAmount;
                incomeCount = item.count;
            } else if (item._id === 1) {
                totalExpense = item.totalAmount;
                expenseCount = item.count;
            }
        });

        const data = {
            totalIncome,
            totalExpense,
            balance: totalIncome - totalExpense,
            incomeCount,
            expenseCount,
            totalTransactions: incomeCount + expenseCount
        };

        return res.status(200).json(
            new ApiResponse(200, data, translations[lang]?.success_transaction_summary_fetched || "success_transaction_summary_fetched")
        );
    } catch (error) {
        console.error("Error generating transaction summary:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

export {
    createTransaction,
    getTransactions,
    getTransactionById,
    updateTransaction,
    deleteTransaction,
    getTransactionSummary
};
