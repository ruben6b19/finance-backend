import mongoose, { Schema } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';

// Saldo vivo de un componente del combo. Se congela al comprar el voucher:
// editar el combo después nunca reescribe lo ya vendido.
const comboBalanceSchema = new Schema(
  {
    // Componente tal como lo conoce el cliente ("Pollo entero").
    product: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true
    },
    // Unidades incluidas en el voucher (admite decimales, ej. 0.25 de pollo).
    includedQty: {
      type: Number,
      required: true,
      min: 0
    },
    // Unidades ya canjeadas de este componente.
    usedQty: {
      type: Number,
      default: 0,
      min: 0
    },
    // Producto cuyo stock consume el canje. null => no toca inventario.
    stockProduct: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      default: null
    },
    // Unidades de stock consumidas por unidad de componente (ej. 8 presas por pollo).
    conversionFactor: {
      type: Number,
      default: 1,
      min: 0
    }
  },
  { _id: true }
);

const comboPurchaseSchema = new Schema(
  {
    // Código operativo corto, derivado del _id para que sea único sin reintentos.
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true
    },
    comboProduct: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true
    },
    comboDefinition: {
      type: Schema.Types.ObjectId,
      ref: 'ComboDefinition',
      required: true
    },
    // Una venta puede emitir varios vouchers (uno por unidad comprada).
    sale: {
      type: Schema.Types.ObjectId,
      ref: 'Sale',
      required: true
    },
    customerName: {
      type: String,
      required: true,
      trim: true
    },
    customerPhone: {
      type: String,
      required: true,
      trim: true
    },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    purchasedAt: {
      type: Date,
      required: true
    },
    // null => el voucher nunca vence.
    expiresAt: {
      type: Date,
      default: null
    },
    // Copiado al comprar el voucher: el vencimiento no consulta la definición,
    // que puede cambiar después de la venta.
    graceDays: {
      type: Number,
      default: 0,
      min: 0
    },
    pricePaid: {
      type: Schema.Types.Decimal128,
      required: true
    },
    balances: {
      type: [comboBalanceSchema],
      default: []
    },
    // Suma denormalizada de includedQty / usedQty.
    totalUnits: {
      type: Number,
      required: true,
      default: 0
    },
    usedUnits: {
      type: Number,
      default: 0,
      min: 0
    },
    // 0: active, 1: exhausted, 2: expired, 3: cancelled, 4: refunded
    status: {
      type: Number,
      enum: [0, 1, 2, 3, 4],
      default: 0
    },
    closedAt: {
      type: Date,
      default: null
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

comboPurchaseSchema.index({ status: 1, expiresAt: 1 });
comboPurchaseSchema.index({ customerPhone: 1 });
comboPurchaseSchema.index({ comboProduct: 1, purchasedAt: -1 });

comboPurchaseSchema.plugin(mongoosePaginate);

export const ComboPurchase = mongoose.model('ComboPurchase', comboPurchaseSchema);
