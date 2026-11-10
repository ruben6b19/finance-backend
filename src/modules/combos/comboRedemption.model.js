import mongoose, { Schema } from 'mongoose';

// Qué se entregó realmente en un canje. Append-only: una anulación marca
// voided*, nunca elimina la fila.
const redemptionItemSchema = new Schema(
  {
    // Debe coincidir con el product de un ComboBalance del voucher.
    product: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true
    },
    // Consumido del saldo, en las unidades comerciales del balance.
    quantity: {
      type: Number,
      required: true,
      validate: {
        validator: (value) => Number.isFinite(value) && value > 0,
        message: 'Redemption quantity must be a finite number greater than zero'
      }
    }
  },
  { _id: true }
);

const comboRedemptionSchema = new Schema(
  {
    comboPurchase: {
      type: Schema.Types.ObjectId,
      ref: 'ComboPurchase',
      required: true
    },
    items: {
      type: [redemptionItemSchema],
      required: true,
      validate: {
        validator: (value) => Array.isArray(value) && value.length > 0,
        message: 'A redemption needs at least one item'
      }
    },
    // Quién marcó la entrega.
    operator: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    redeemedAt: {
      type: Date,
      required: true
    },
    // Obligatoria: sin ella un doble toque entrega producto gratis sin rastro.
    idempotencyKey: {
      type: String,
      required: true,
      trim: true
    },
    notes: {
      type: String,
      trim: true,
      default: ''
    },
    voidedAt: {
      type: Date,
      default: null
    },
    voidedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    voidReason: {
      type: String,
      trim: true,
      default: ''
    }
  },
  {
    timestamps: true
  }
);

comboRedemptionSchema.index({ comboPurchase: 1, idempotencyKey: 1 }, { unique: true });
comboRedemptionSchema.index({ comboPurchase: 1, redeemedAt: -1 });
comboRedemptionSchema.index({ operator: 1, redeemedAt: -1 });
comboRedemptionSchema.index({ voidedAt: 1 }, { sparse: true });

export const ComboRedemption = mongoose.model('ComboRedemption', comboRedemptionSchema);
