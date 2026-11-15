import mongoose from "mongoose";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { validateDescriptionAddress, validateName } from "../../utils/regex.js";
import { ROLES } from "../../constants/roles.js";
import { roleAtLeast } from "../../utils/roles.js";
import { Product } from "../products/product.model.js";
import { resolveFirebaseUser } from "../users/user.service.js";
import { User } from "../users/user.model.js";
import { Order, ORDER_STATUS, DELIVERY_TYPES } from "./order.model.js";
import { createSaleRecord } from "../sales/sale.service.js";
import { getCentralModel } from "../tenants/requestModel.js";
import { ComboDefinition } from "../combos/comboDefinition.model.js";
import { ComboComponent } from "../combos/comboComponent.model.js";

const COMBO_PRODUCT_TYPE = 3;
const PUBLIC_PRODUCT_TYPES = [1, 2, COMBO_PRODUCT_TYPE];
const MAX_QUANTITY = 99;
const MAX_ITEMS = 50;
const MAX_DAYS_AHEAD = 30;
const MAX_NOTES = 300;
const PHONE_REGEX = /^[+()\d\s-]{6,25}$/;

const toNumber = (value) => {
  if (value === undefined || value === null) return 0;
  return Number.parseFloat(value.toString());
};

const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

const toDecimal = (value) => mongoose.Types.Decimal128.fromString(round2(value).toFixed(2));

const toOrderDto = (order) => ({
  id: String(order._id),
  code: order.code,
  status: order.status,
  deliveryType: order.deliveryType,
  address: order.address || '',
  pickupAt: new Date(order.pickupAt).toISOString(),
  customerName: order.customerName,
  customerPhone: order.customerPhone,
  customerEmail: order.customerEmail || '',
  notes: order.notes || '',
  items: order.items.map((item) => ({
    productId: String(item.product?._id || item.product),
    name: item.name || item.product?.name || 'Producto',
    unitPrice: toNumber(item.unitPrice),
    quantity: item.quantity,
    subtotal: toNumber(item.subtotal),
  })),
  total: toNumber(order.total),
  createdAt: order.createdAt,
});

const respondUserError = (res, result) => {
  if (result.error === "missing_uid") {
    return res.status(401).json(new ApiResponse(401, {}, "error_token_missing_uid"));
  }
  if (result.error === "missing_email") {
    return res.status(400).json(new ApiResponse(400, {}, "error_user_email_required"));
  }
  return res.status(500).json(new ApiResponse(500, {}, "error_internal_server_generic"));
};

const createOrder = asyncHandler(async (req, res) => {
  const resolved = await resolveFirebaseUser({
    firebaseUid: req.user?.firebaseUid,
    email: req.user?.email,
    name: req.user?.name,
  });
  if (resolved.error) return respondUserError(res, resolved);

  const { items, deliveryType, pickupAt, address, phone, notes } = req.body || {};

  // 1. Items: shape, ids, quantities and duplicate aggregation.
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
    return res.status(400).json(new ApiResponse(400, {}, "error_order_invalid_items"));
  }

  const quantities = new Map();
  for (const entry of items) {
    const productId = entry?.productId;
    const quantity = entry?.quantity;
    if (typeof productId !== "string" || !mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json(new ApiResponse(400, {}, "error_order_invalid_items"));
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      return res.status(400).json(new ApiResponse(400, {}, "error_order_invalid_items"));
    }
    const key = String(productId);
    const sum = (quantities.get(key) || 0) + quantity;
    if (sum > MAX_QUANTITY) {
      return res.status(400).json(new ApiResponse(400, {}, "error_order_invalid_items"));
    }
    quantities.set(key, sum);
  }

  const ids = [...quantities.keys()];
  const products = await Product.find({ _id: { $in: ids }, status: 1, isSellable: true });
  if (products.length !== ids.length) {
    return res.status(400).json(new ApiResponse(400, {}, "error_order_product_not_found"));
  }

  // 1b. A combo is only orderable when it can actually be vouchered: active
  //     definition with at least one component. The vouchers are issued when
  //     staff confirms the order, so an incomplete combo would blow up there
  //     instead of at checkout, where the customer can still react.
  const comboProductIds = products
    .filter((product) => product.productType === COMBO_PRODUCT_TYPE)
    .map((product) => product._id);

  if (comboProductIds.length > 0) {
    const definitions = await ComboDefinition.find({
      product: { $in: comboProductIds },
      status: 1,
    }).select("_id product");
    const definitionIdByProduct = new Map(
      definitions.map((definition) => [String(definition.product), String(definition._id)]),
    );
    const definitionIds = definitions.map((definition) => definition._id);

    const componentCounts = definitionIds.length > 0
      ? await ComboComponent.aggregate([
          { $match: { combo: { $in: definitionIds } } },
          { $group: { _id: "$combo", total: { $sum: 1 } } },
        ])
      : [];
    const combosWithComponents = new Set(
      componentCounts
        .filter((entry) => entry.total > 0)
        .map((entry) => String(entry._id)),
    );

    const hasUnavailableCombo = comboProductIds.some((productId) => {
      const definitionId = definitionIdByProduct.get(String(productId));
      return !definitionId || !combosWithComponents.has(definitionId);
    });

    if (hasUnavailableCombo) {
      return res.status(400).json(new ApiResponse(400, {}, "error_order_combo_unavailable"));
    }
  }

  // 2. Prices are always computed server-side from the stored product price.
  const normalizedItems = [];
  let total = 0;
  for (const product of products) {
    if (!PUBLIC_PRODUCT_TYPES.includes(product.productType)) {
      return res.status(400).json(new ApiResponse(400, {}, "error_order_product_not_found"));
    }
    const quantity = quantities.get(String(product._id));
    const unitPrice = toNumber(product.price);
    const subtotal = round2(unitPrice * quantity);
    total = round2(total + subtotal);
    normalizedItems.push({
      product: product._id,
      name: product.name,
      unitPrice: toDecimal(unitPrice),
      quantity,
      subtotal: toDecimal(subtotal),
    });
  }

  if (!Number.isFinite(total) || total <= 0) {
    return res.status(400).json(new ApiResponse(400, {}, "error_order_invalid_amount"));
  }

  // 3. Delivery type and address.
  if (!Object.values(DELIVERY_TYPES).includes(deliveryType)) {
    return res.status(400).json(new ApiResponse(400, {}, "error_order_invalid_delivery_type"));
  }

  let normalizedAddress = '';
  if (deliveryType === DELIVERY_TYPES.DELIVERY) {
    const trimmedAddress = typeof address === "string" ? address.trim() : "";
    if (
      trimmedAddress.length < 5 ||
      trimmedAddress.length > 150 ||
      !validateDescriptionAddress.test(trimmedAddress)
    ) {
      return res.status(400).json(new ApiResponse(400, {}, "error_order_address_required"));
    }
    normalizedAddress = trimmedAddress;
  }

  // 4. Phone.
  const trimmedPhone = typeof phone === "string" ? phone.trim() : "";
  if (trimmedPhone.length < 6 || trimmedPhone.length > 25 || !PHONE_REGEX.test(trimmedPhone)) {
    return res.status(400).json(new ApiResponse(400, {}, "error_order_phone_required"));
  }

  // 4b. Customer contact name (mandatory, client-supplied).
  const rawContactName =
    typeof req.body?.contactName === "string" ? req.body.contactName.trim() : "";

  if (!validateName.test(rawContactName)) {
    return res
      .status(400)
      .json(new ApiResponse(400, {}, "error_order_contact_name_required"));
  }

  // 5. Pickup date.
  const pickupDate = new Date(pickupAt);
  const now = Date.now();
  if (
    Number.isNaN(pickupDate.getTime()) ||
    pickupDate.getTime() < now - 5 * 60 * 1000 ||
    pickupDate.getTime() > now + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000
  ) {
    return res.status(400).json(new ApiResponse(400, {}, "error_order_invalid_pickup_at"));
  }

  // 6. Notes.
  let normalizedNotes = '';
  if (notes !== undefined && notes !== null) {
    if (typeof notes !== "string") {
      return res.status(400).json(new ApiResponse(400, {}, "error_order_invalid_notes"));
    }
    normalizedNotes = notes.trim();
    if (normalizedNotes.length > MAX_NOTES) {
      return res.status(400).json(new ApiResponse(400, {}, "error_order_invalid_notes"));
    }
  }

  // 7. Keep the customer profile in sync with the contact data used here.
  //    The order already keeps its own immutable snapshot (customerName,
  //    customerPhone, customerEmail), so editing the profile later never
  //    rewrites past orders. Staff profiles are managed by an administrator
  //    and must not be renamed from the storefront checkout.
  if (!roleAtLeast(resolved.user.role, ROLES.SELLER)) {
    const profilePatch = {};

    if (rawContactName !== resolved.user.fullName) {
      profilePatch.fullName = rawContactName;
    }

    if (trimmedPhone !== (resolved.user.phone || '')) {
      profilePatch.phone = trimmedPhone;
    }

    if (Object.keys(profilePatch).length > 0) {
      try {
        await User.updateOne(
          { _id: resolved.user._id },
          { $set: profilePatch },
          { runValidators: true }
        );
      } catch (error) {
        // Best effort: the order snapshot is authoritative, so a profile sync
        // failure must never block the customer's purchase.
        console.error("createOrder profile sync failed:", error?.message);
      }
    }
  }

  try {
    const orderId = new mongoose.Types.ObjectId();
    const code = `PED-${orderId.toString().slice(-6).toUpperCase()}`;
    const order = await Order.create({
      _id: orderId,
      code,
      customer: resolved.user._id,
      customerName: rawContactName,
      customerPhone: trimmedPhone,
      customerEmail: resolved.user.email || '',
      deliveryType,
      address: normalizedAddress,
      pickupAt: pickupDate,
      items: normalizedItems,
      total: toDecimal(total),
      status: ORDER_STATUS.PENDING,
      notes: normalizedNotes,
    });

    return res.status(201).json(new ApiResponse(201, toOrderDto(order), "success_order_created"));
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json(new ApiResponse(409, {}, "error_order_duplicate_code"));
    }
    console.error("createOrder failed:", error);
    return res.status(500).json(new ApiResponse(500, {}, "error_internal_server_generic"));
  }
});

const getMyOrders = asyncHandler(async (req, res) => {
  const resolved = await resolveFirebaseUser({
    firebaseUid: req.user?.firebaseUid,
    email: req.user?.email,
    name: req.user?.name,
  });
  if (resolved.error) return respondUserError(res, resolved);

  const orders = await Order.find({ customer: resolved.user._id })
    .populate('items.product', 'name')
    .sort({ createdAt: -1 })
    .limit(50);

  return res.status(200).json(new ApiResponse(200, orders.map(toOrderDto), "success_orders_fetched"));
});

const getMyOrderById = asyncHandler(async (req, res) => {
  const resolved = await resolveFirebaseUser({
    firebaseUid: req.user?.firebaseUid,
    email: req.user?.email,
    name: req.user?.name,
  });
  if (resolved.error) return respondUserError(res, resolved);

  const { orderId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    return res.status(400).json(new ApiResponse(400, {}, "error_order_invalid_id"));
  }

  const order = await Order.findOne({ _id: orderId, customer: resolved.user._id }).populate('items.product', 'name');
  if (!order) {
    return res.status(404).json(new ApiResponse(404, {}, "error_order_not_found"));
  }

  return res.status(200).json(new ApiResponse(200, toOrderDto(order), "success_order_fetched"));
});

const getAllOrders = asyncHandler(async (req, res) => {
  const resolved = await resolveFirebaseUser({
    firebaseUid: req.user?.firebaseUid,
    email: req.user?.email,
    name: req.user?.name,
  });
  if (resolved.error) return respondUserError(res, resolved);

  // Only staff may list every order. Clients see their own via GET /orders/me.
  // Read the role from the Mongo user, not from req.user: Firebase custom claims
  // are not set for storefront clients, so hasRole(req, ...) would deny everyone.
  if (!roleAtLeast(resolved.user.role, ROLES.SELLER)) {
    return res
      .status(403)
      .json(new ApiResponse(403, {}, "error_orders_list_forbidden"));
  }

  const orders = await Order.find({})
    .populate('items.product', 'name')
    .sort({ createdAt: -1 })
    .limit(100);

  return res.status(200).json(new ApiResponse(200, orders.map(toOrderDto), "success_orders_fetched"));
});

const STOCK_ERROR_I18N = {
  INSUFFICIENT_STOCK: "error_order_insufficient_stock",
  STOCK_PRODUCT_NOT_FOUND: "error_order_product_not_found",
  INVALID_STOCK_PRODUCT: "error_order_product_not_found",
  INVALID_STOCK_AMOUNT: "error_order_invalid_quantity"
};

// Errores que puede lanzar la emisión de vouchers al confirmar un pedido con
// combos. Se traducen al vocabulario del pedido en vez de filtrar un 500.
const COMBO_ERROR_I18N = {
  COMBO_PRODUCT_NOT_FOUND: "error_order_product_not_found",
  COMBO_CUSTOMER_PHONE_REQUIRED: "error_order_phone_required",
  COMBO_INVALID_QUANTITY: "error_order_invalid_items",
  COMBO_INVALID_PRICE: "error_order_invalid_amount",
  COMBO_PAYMENT_REQUIRED: "error_order_combo_unavailable",
  COMBO_DEFINITION_NOT_FOUND: "error_order_combo_unavailable",
  COMBO_INACTIVE: "error_order_combo_unavailable",
  COMBO_ALREADY_REDEEMED: "error_order_combo_unavailable"
};

const updateOrderStatus = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  const { status } = req.body || {};

  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    return res.status(400).json(new ApiResponse(400, {}, "error_order_invalid_id"));
  }

  const targetStatus = Number(status);
  if (![1, 2].includes(targetStatus)) {
    return res.status(400).json(new ApiResponse(400, {}, "error_order_invalid_status"));
  }

  const resolved = await resolveFirebaseUser({
    firebaseUid: req.user?.firebaseUid,
    email: req.user?.email,
    name: req.user?.name,
  });
  if (resolved.error) return respondUserError(res, resolved);

  if (!roleAtLeast(resolved.user.role, ROLES.SELLER)) {
    return res.status(403).json(new ApiResponse(403, {}, "error_orders_status_forbidden"));
  }

  const order = await Order.findOne({ _id: orderId });
  if (!order) {
    return res.status(404).json(new ApiResponse(404, {}, "error_order_not_found"));
  }

  if (order.status !== 0) {
    return res.status(409).json(new ApiResponse(409, {}, "error_order_invalid_transition"));
  }

  if (targetStatus === 2) {
    const updated = await Order.findOneAndUpdate(
      { _id: orderId, status: 0 },
      { $set: { status: 2 } },
      { new: true }
    );
    if (!updated) {
      return res.status(409).json(new ApiResponse(409, {}, "error_order_invalid_transition"));
    }
    return res.status(200).json(new ApiResponse(200, toOrderDto(updated), "success_order_cancelled"));
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const updatedOrder = await Order.findOneAndUpdate(
      { _id: orderId, status: 0 },
      { $set: { status: 1 } },
      { new: true, session }
    );

    if (!updatedOrder) {
      if (session.inTransaction()) await session.abortTransaction();
      session.endSession();
      return res.status(409).json(new ApiResponse(409, {}, "error_order_invalid_transition"));
    }

    const sale = await createSaleRecord({
      payload: {
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        customerId: order.customer,
        items: order.items.map(item => ({
          product: item.product,
          quantity: item.quantity,
          unitPrice: toNumber(item.unitPrice),
          subtotal: toNumber(item.subtotal)
        })),
        subtotal: toNumber(order.total),
        tax: 0,
        discount: 0,
        totalAmount: toNumber(order.total),
        paymentMethod: 0,
        paymentStatus: 1,
        saleStatus: 0,
        notes: `Pedido ${order.code}`
      },
      userId: resolved.user._id,
      session,
      transactionExtra: { orderId: order._id },
      // Orders are not tenant-routed yet: keep the whole flow in the central
      // database until this module is migrated.
      getModel: getCentralModel
    });

    // El pedido guarda la venta que generó: sin este vínculo el ingreso queda
    // huérfano y solo se puede rastrear por el texto de las notas.
    updatedOrder.saleId = sale._id;
    await updatedOrder.save({ session });

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json(new ApiResponse(200, toOrderDto(updatedOrder), "success_order_confirmed"));
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    session.endSession();
    console.error("updateOrderStatus confirmation failed:", error);

    const stockErrorCode = STOCK_ERROR_I18N[error?.message];
    if (stockErrorCode) {
      return res.status(400).json(new ApiResponse(400, {}, stockErrorCode));
    }

    const comboErrorCode = COMBO_ERROR_I18N[error?.message];
    if (comboErrorCode) {
      return res.status(400).json(new ApiResponse(400, {}, comboErrorCode));
    }

    // Falla interna: se loguea arriba, pero al cliente no se le filtran detalles.
    return res.status(500).json(new ApiResponse(500, {}, "error_internal_server_generic"));
  }
});

export { createOrder, getMyOrders, getMyOrderById, getAllOrders, updateOrderStatus };
