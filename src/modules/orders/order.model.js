import mongoose, { Schema } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';

export const ORDER_STATUS = { PENDING: 0, CONFIRMED: 1, CANCELLED: 2, COMPLETED: 3 };
export const DELIVERY_TYPES = ['pickup', 'delivery'];

const orderItemSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true, trim: true },
    unitPrice: { type: Schema.Types.Decimal128, required: true },
    quantity: { type: Number, required: true, min: 1 },
    subtotal: { type: Schema.Types.Decimal128, required: true },
  },
  { _id: false }
);

const orderSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, trim: true, uppercase: true },
    customer: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    customerName: { type: String, required: true, trim: true },
    customerPhone: { type: String, required: true, trim: true },
    customerEmail: { type: String, default: '', trim: true },
    deliveryType: { type: String, enum: DELIVERY_TYPES, required: true },
    address: { type: String, default: '', trim: true },
    pickupAt: { type: Date, required: true },
    items: {
      type: [orderItemSchema],
      validate: { validator: (value) => Array.isArray(value) && value.length > 0, message: 'items_required' },
    },
    total: { type: Schema.Types.Decimal128, required: true },
    status: { type: Number, enum: Object.values(ORDER_STATUS), default: ORDER_STATUS.PENDING },
    notes: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

orderSchema.index({ customer: 1, createdAt: -1 });
orderSchema.index({ pickupAt: 1 });
orderSchema.plugin(mongoosePaginate);

export const Order = mongoose.model('Order', orderSchema);
