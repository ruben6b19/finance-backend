import mongoose, { Schema } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';
import aggregatePaginate from 'mongoose-aggregate-paginate-v2';

const saleItemSchema = new Schema(
  {
    product: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      default: 1
    },
    unitPrice: {
      type: Schema.Types.Decimal128,
      required: true
    },
    subtotal: {
      type: Schema.Types.Decimal128,
      required: true
    }
  },
  { _id: true }
);

const saleSchema = new Schema(
  {
    saleNumber: {
      type: String,
      trim: true,
      index: true
    },
    customerName: {
      type: String,
      trim: true,
      default: 'General Public'
    },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    items: {
      type: [saleItemSchema],
      default: []
    },
    subtotal: {
      type: Schema.Types.Decimal128,
      required: true
    },
    tax: {
      type: Schema.Types.Decimal128,
      default: 0
    },
    discount: {
      type: Schema.Types.Decimal128,
      default: 0
    },
    totalAmount: {
      type: Schema.Types.Decimal128,
      required: true,
      index: true
    },
    paymentMethod: {
      type: Number,
      required: true,
      enum: [0, 1, 2, 3], // 0: Cash, 1: Transfer, 2: Card, 3: Other
      default: 0
    },
    paymentStatus: {
      type: Number,
      required: true,
      enum: [0, 1, 2], // 0: Pending, 1: Paid, 2: Cancelled
      default: 1
    },
    saleStatus: {
      type: Number,
      required: true,
      enum: [0, 1, 2], // 0: Completed, 1: Pending, 2: Cancelled
      default: 0
    },
    saleDate: {
      type: Date,
      default: Date.now,
      index: true
    },
    transactionId: {
      type: Schema.Types.ObjectId,
      ref: 'Transaction',
      default: null
    },
    notes: {
      type: String,
      trim: true
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null
    }
  },
  {
    timestamps: true
  }
);

saleSchema.plugin(mongoosePaginate);
saleSchema.plugin(aggregatePaginate);

export const Sale = mongoose.model('Sale', saleSchema);
