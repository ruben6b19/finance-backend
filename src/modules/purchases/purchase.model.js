import mongoose, { Schema } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';
import aggregatePaginate from 'mongoose-aggregate-paginate-v2';

const purchaseItemSchema = new Schema(
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
    unit: { // Unidad en la que se compró (ej: Caja)
      type: Schema.Types.ObjectId,
      ref: 'Unit',
      required: true
    },
    conversionFactor: { // Factor usado en el momento de la compra
      type: Number,
      required: true,
      default: 1
    },
    subtotal: {
      type: Schema.Types.Decimal128,
      required: true
    }
  },
  { _id: true }
);

const purchaseSchema = new Schema(
  {
    purchaseNumber: {
      type: String,
      trim: true,
      index: true
    },
    supplierName: {
      type: String,
      trim: true,
      default: 'Proveedor General'
    },
    supplierId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    items: {
      type: [purchaseItemSchema],
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
      enum: [0, 1, 2, 3],
      default: 0
    },
    paymentStatus: {
      type: Number,
      required: true,
      enum: [0, 1, 2],
      default: 0
    },
    purchaseStatus: {
      type: Number,
      required: true,
      enum: [0, 1, 2],
      default: 0
    },
    purchaseDate: {
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

purchaseSchema.plugin(mongoosePaginate);
purchaseSchema.plugin(aggregatePaginate);

export const Purchase = mongoose.model('Purchase', purchaseSchema);
