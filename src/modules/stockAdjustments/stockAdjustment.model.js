import mongoose, { Schema } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';

// Rastro auditable de todo cambio manual de stock. El stock sigue viviendo
// únicamente en Product; este documento explica quién lo cambió y por qué.
const stockAdjustmentSchema = new Schema(
  {
    product: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true
    },
    previousStock: {
      type: Number,
      required: true
    },
    newStock: {
      type: Number,
      required: true,
      min: 0
    },
    delta: {
      type: Number,
      required: true
    },
    // 0: conteo inicial, 1: recuento, 2: merma, 3: rotura, 4: otro.
    reason: {
      type: Number,
      required: true,
      enum: [0, 1, 2, 3, 4]
    },
    note: {
      type: String,
      trim: true,
      default: ''
    },
    operator: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    }
  },
  {
    timestamps: true
  }
);

stockAdjustmentSchema.index({ product: 1, createdAt: -1 });
stockAdjustmentSchema.index({ createdAt: -1 });
stockAdjustmentSchema.index({ operator: 1, createdAt: -1 });

stockAdjustmentSchema.plugin(mongoosePaginate);

export const StockAdjustment = mongoose.model('StockAdjustment', stockAdjustmentSchema);
