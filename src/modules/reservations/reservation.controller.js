import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { Reservation } from "./reservation.model.js";
import { Sale } from "../sales/sale.model.js";
import { Product } from "../products/product.model.js";
import { Transaction } from "../transactions/transaction.model.js";
import { applyStockMovement, createSaleRecord } from "../sales/sale.service.js";
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

// Errores de stock del servicio de ventas traducidos al vocabulario de reservas.
const STOCK_ERROR_I18N = {
    INSUFFICIENT_STOCK: "error_reservation_insufficient_stock",
    STOCK_PRODUCT_NOT_FOUND: "error_reservation_product_not_found",
    INVALID_STOCK_PRODUCT: "error_reservation_product_not_found",
    INVALID_STOCK_AMOUNT: "error_reservation_invalid_quantity"
};

const toNumber = (value) => {
    if (value === undefined || value === null) return 0;
    return Number.parseFloat(value.toString());
};

const round2 = (value) => Math.round(value * 100) / 100;

const hasRole = (req, allowedRoles) => {
    const roles = req.user?.role;
    if (roles === undefined || roles === null) return false;
    const list = Array.isArray(roles) ? roles : [roles];
    return list.some((role) => allowedRoles.includes(Number(role)));
};

const createReservation = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const {
        customerName, customerPhone, customerId, items,
        paymentMethod, paymentReference, pickupAt, expiresAt, notes
    } = req.body;

    if (!customerName || !customerName.trim() || !customerPhone || !customerPhone.trim()) {
        return translateErrorResponse(res, lang, "error_reservation_customer_required", 400, translations);
    }

    if (!Array.isArray(items) || items.length === 0) {
        return translateErrorResponse(res, lang, "error_reservation_items_required", 400, translations);
    }

    if (customerId && !mongoose.Types.ObjectId.isValid(customerId)) {
        return translateErrorResponse(res, lang, "error_reservation_invalid_customer_id", 400, translations);
    }

    const selectedPaymentMethod = paymentMethod !== undefined ? Number(paymentMethod) : 1;
    if (![0, 1, 2, 3].includes(selectedPaymentMethod)) {
        return translateErrorResponse(res, lang, "error_reservation_invalid_payment_method", 400, translations);
    }

    const pickupDate = pickupAt ? new Date(pickupAt) : null;
    const expiryDate = expiresAt ? new Date(expiresAt) : null;

    if (!pickupDate || isNaN(pickupDate.getTime()) || !expiryDate || isNaN(expiryDate.getTime())) {
        return translateErrorResponse(res, lang, "error_reservation_invalid_dates", 400, translations);
    }

    if (expiryDate <= pickupDate) {
        return translateErrorResponse(res, lang, "error_reservation_invalid_dates", 400, translations);
    }

    const normalizedItems = [];
    for (const item of items) {
        if (!item || !item.product || !mongoose.Types.ObjectId.isValid(item.product)) {
            return translateErrorResponse(res, lang, "error_reservation_product_not_found", 400, translations);
        }

        const quantity = item.quantity !== undefined ? Number(item.quantity) : 1;
        if (!Number.isFinite(quantity) || quantity < 1) {
            return translateErrorResponse(res, lang, "error_reservation_invalid_quantity", 400, translations);
        }

        const conversionFactor = item.conversionFactor !== undefined ? Number(item.conversionFactor) : 1;
        if (!Number.isFinite(conversionFactor) || conversionFactor <= 0) {
            return translateErrorResponse(res, lang, "error_reservation_invalid_quantity", 400, translations);
        }

        if (item.stockProduct && !mongoose.Types.ObjectId.isValid(item.stockProduct)) {
            return translateErrorResponse(res, lang, "error_reservation_product_not_found", 400, translations);
        }

        normalizedItems.push({
            product: item.product,
            quantity,
            stockProduct: item.stockProduct || null,
            conversionFactor
        });
    }

    // Los precios se toman del producto, nunca del cliente: una reserva no puede
    // fijar un precio que el catálogo no respalda.
    const productIds = [...new Set(normalizedItems.map((item) => String(item.product)))];
    const products = await Product.find({ _id: { $in: productIds } });
    const productMap = new Map(products.map((product) => [String(product._id), product]));

    let totalAmount = 0;
    for (const item of normalizedItems) {
        const product = productMap.get(String(item.product));
        if (!product) {
            return translateErrorResponse(res, lang, "error_reservation_product_not_found", 400, translations);
        }

        item.unitPrice = toNumber(product.price);
        item.subtotal = round2(item.quantity * item.unitPrice);
        totalAmount += item.subtotal;
    }
    totalAmount = round2(totalAmount);

    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
        return translateErrorResponse(res, lang, "error_reservation_invalid_amount", 400, translations);
    }

    const reservationId = new mongoose.Types.ObjectId();
    // Derivado del _id: único por construcción, sin reintentos por colisión.
    const code = reservationId.toString().slice(-8).toUpperCase();

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const sale = await createSaleRecord({
            payload: {
                customerName,
                customerId: customerId || null,
                items: normalizedItems,
                subtotal: totalAmount,
                tax: 0,
                discount: 0,
                totalAmount,
                paymentMethod: selectedPaymentMethod,
                paymentStatus: 1, // pagada en su totalidad al reservar
                saleStatus: 0,
                saleDate: new Date(),
                notes: notes || `Reserva ${code}`
            },
            userId: req.user?.mongoDbId || null,
            session,
            transactionExtra: { reservationId }
        });

        const reservation = await Reservation.create([{
            _id: reservationId,
            code,
            customerName: customerName.trim(),
            customerPhone: customerPhone.trim(),
            customerId: customerId || null,
            items: normalizedItems,
            totalAmount,
            paidAmount: totalAmount,
            paymentMethod: selectedPaymentMethod,
            paymentReference: paymentReference ? paymentReference.trim() : undefined,
            pickupAt: pickupDate,
            expiresAt: expiryDate,
            status: 0,
            saleId: sale._id,
            notes: notes ? notes.trim() : undefined,
            createdBy: req.user?.mongoDbId || null
        }], { session });

        await session.commitTransaction();
        session.endSession();

        return res.status(201).json(
            new ApiResponse(201, reservation[0], translations[lang]?.success_reservation_created || "success_reservation_created")
        );
    } catch (error) {
        if (session.inTransaction()) await session.abortTransaction();
        session.endSession();
        console.error("Error creating reservation:", error);

        const stockErrorCode = STOCK_ERROR_I18N[error?.message];
        if (stockErrorCode) {
            return translateErrorResponse(res, lang, stockErrorCode, 400, translations);
        }

        if (error?.code === 11000) {
            return translateErrorResponse(res, lang, "error_reservation_duplicate_code", 409, translations);
        }

        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getReservations = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const pageParam = req.params.page || req.query.page;
    const {
        limit = 10, search, query, status, customerPhone,
        startDate, endDate, sortBy = 'pickupAt', sortOrder = 'asc'
    } = req.query;

    const filter = {};

    if (status !== undefined && status !== '') {
        filter.status = Number(status);
    }

    if (customerPhone && customerPhone.trim() !== '') {
        filter.customerPhone = { $regex: customerPhone.trim(), $options: 'i' };
    }

    if (startDate || endDate) {
        filter.pickupAt = {};
        if (startDate) filter.pickupAt.$gte = new Date(startDate);
        if (endDate) filter.pickupAt.$lte = new Date(endDate);
    }

    const term = search || query;
    if (term && term.trim() !== '') {
        const searchRegex = { $regex: term.trim(), $options: 'i' };
        filter.$or = [
            { code: searchRegex },
            { customerName: searchRegex },
            { customerPhone: searchRegex }
        ];
    }

    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'asc' ? 1 : -1;

    try {
        const results = await Reservation.paginate(filter, {
            page: parseInt(pageParam) || 1,
            limit: parseInt(limit) || 10,
            sort: sortOptions,
            populate: ['items.product', 'createdBy']
        });

        return res.status(200).json(
            new ApiResponse(200, results, translations[lang]?.success_reservations_fetched || "success_reservations_fetched")
        );
    } catch (error) {
        console.error("Error fetching reservations:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const getReservationById = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { reservationId } = req.params;

    if (!reservationId || !mongoose.Types.ObjectId.isValid(reservationId)) {
        return translateErrorResponse(res, lang, "error_reservation_invalid_id", 400, translations);
    }

    try {
        const reservation = await Reservation.findById(reservationId)
            .populate(['items.product', 'saleId', 'createdBy']);

        if (!reservation) {
            return translateErrorResponse(res, lang, "error_reservation_not_found", 404, translations);
        }

        return res.status(200).json(
            new ApiResponse(200, reservation, translations[lang]?.success_reservation_fetched || "success_reservation_fetched")
        );
    } catch (error) {
        console.error("Error fetching reservation:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const fulfillReservation = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { reservationId } = req.params;

    if (!reservationId || !mongoose.Types.ObjectId.isValid(reservationId)) {
        return translateErrorResponse(res, lang, "error_reservation_invalid_id", 400, translations);
    }

    try {
        const reservation = await Reservation.findById(reservationId).select('status');
        if (!reservation) {
            return translateErrorResponse(res, lang, "error_reservation_not_found", 404, translations);
        }

        // Actualización atómica: dos operadores no pueden entregar dos veces.
        const fulfilled = await Reservation.findOneAndUpdate(
            { _id: reservationId, status: 0 },
            { $set: { status: 1, fulfilledAt: new Date(), fulfilledBy: req.user?.mongoDbId || null } },
            { new: true }
        );

        if (!fulfilled) {
            return translateErrorResponse(res, lang, "error_reservation_not_active", 400, translations);
        }

        return res.status(200).json(
            new ApiResponse(200, fulfilled, translations[lang]?.success_reservation_fulfilled || "success_reservation_fulfilled")
        );
    } catch (error) {
        console.error("Error fulfilling reservation:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

const voidReservation = asyncHandler(async (req, res) => {
    const lang = getLang(req);
    const { reservationId } = req.params;
    const { voidReason } = req.body || {};

    if (!reservationId || !mongoose.Types.ObjectId.isValid(reservationId)) {
        return translateErrorResponse(res, lang, "error_reservation_invalid_id", 400, translations);
    }

    // Reversión administrativa, no devolución al cliente: solo supervisión.
    if (!hasRole(req, [ROLES.ADMIN, ROLES.SUPERVISOR])) {
        return translateErrorResponse(res, lang, "error_reservation_forbidden", 403, translations);
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const reservation = await Reservation.findById(reservationId).session(session);

        if (!reservation) {
            if (session.inTransaction()) await session.abortTransaction();
            session.endSession();
            return translateErrorResponse(res, lang, "error_reservation_not_found", 404, translations);
        }

        if (reservation.status !== 0) {
            if (session.inTransaction()) await session.abortTransaction();
            session.endSession();
            return translateErrorResponse(res, lang, "error_reservation_not_active", 400, translations);
        }

        const sale = await Sale.findById(reservation.saleId).session(session);

        // El candado de "solo ventas de hoy" no aplica acá: esta es la reversión
        // administrativa de una reserva, que por definición puede ser de otro día.
        if (sale && sale.saleStatus !== 2) {
            await applyStockMovement(sale.items, session, 1);
            sale.saleStatus = 2;
            sale.paymentStatus = 2;
            await sale.save({ session });
        }

        if (sale && sale.transactionId) {
            await Transaction.findByIdAndUpdate(
                sale.transactionId,
                { status: 0 },
                { session }
            );
        }

        reservation.status = 3;
        reservation.voidedAt = new Date();
        reservation.voidedBy = req.user?.mongoDbId || null;
        if (voidReason && voidReason.trim()) {
            reservation.voidReason = voidReason.trim();
        }
        await reservation.save({ session });

        await session.commitTransaction();
        session.endSession();

        return res.status(200).json(
            new ApiResponse(200, reservation, translations[lang]?.success_reservation_voided || "success_reservation_voided")
        );
    } catch (error) {
        if (session.inTransaction()) await session.abortTransaction();
        session.endSession();
        console.error("Error voiding reservation:", error);
        return translateErrorResponse(res, lang, "error_internal_server_generic", 500, translations);
    }
});

export {
    createReservation,
    getReservations,
    getReservationById,
    fulfillReservation,
    voidReservation
};
