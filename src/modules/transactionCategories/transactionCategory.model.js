import mongoose, { Schema } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';
import aggregatePaginate from 'mongoose-aggregate-paginate-v2';

const transactionCategorySchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true
    },
    type: {
      type: Number,
      required: true,
      enum: [0, 1], // 0: Income, 1: Expense
      index: true
    },
    description: {
      type: String,
      trim: true,
      default: ''
    },
    status: {
      type: Number,
      required: true,
      enum: [0, 1],
      default: 1,
      index: true
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

transactionCategorySchema.plugin(mongoosePaginate);
transactionCategorySchema.plugin(aggregatePaginate);

export const TransactionCategory = mongoose.model('TransactionCategory', transactionCategorySchema);
