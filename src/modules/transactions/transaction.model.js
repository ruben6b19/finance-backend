import mongoose, { Schema } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';
import aggregatePaginate from 'mongoose-aggregate-paginate-v2';

const transactionSchema = new Schema(
  {
    type: {
      type: Number,
      required: true,
      enum: [0, 1], // 0: Income, 1: Expense
      index: true
    },
    amount: {
      type: Schema.Types.Decimal128, // Exact financial precision
      required: true
    },
    paymentMethod: {
      type: Number,
      required: true,
      enum: [0, 1, 2, 3], // 0: Cash, 1: Transfer, 2: Card, 3: Other
      default: 0
    },
    concept: {
      type: String,
      required: true,
      trim: true
    },
    category: {
      type: Schema.Types.ObjectId,
      ref: 'TransactionCategory',
      required: true
    },
    date: {
      type: Date,
      default: Date.now,
      index: true
    },

    // Future-proof optional references (Null by default)
    saleId: {
      type: Schema.Types.ObjectId,
      ref: 'Sale',
      default: null
    },
    purchaseId: {
      type: Schema.Types.ObjectId,
      ref: 'Purchase',
      default: null
    },

    status: {
      type: Number,
      required: true,
      enum: [0, 1], // 0: Cancelled/Inactive, 1: Active
      default: 1,
      index: true
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

transactionSchema.plugin(mongoosePaginate);
transactionSchema.plugin(aggregatePaginate);

export const Transaction = mongoose.model('Transaction', transactionSchema);
