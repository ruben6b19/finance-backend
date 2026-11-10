import mongoose, { Schema } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';
import aggregatePaginate from 'mongoose-aggregate-paginate-v2';

// Un ítem de reserva congela precio y factor de conversión al momento de reservar:
// si el menú cambia antes del retiro, el cliente conserva lo acordado.
const reservationItemSchema = new Schema(
  {
    product: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true
    },
    // Unidades de la presentación reservada (entera). Las fracciones de pollo
    // se modelan como una presentación propia ("1/4 pollo"), no como 0.25.
    quantity: {
      type: Number,
      required: true,
      min: 1
    },
    unitPrice: {
      type: Schema.Types.Decimal128,
      required: true
    },
    subtotal: {
      type: Schema.Types.Decimal128,
      required: true
    },
    // Producto cuyo stock se descuenta al reservar. null => se usa `product`.
    stockProduct: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      default: null
    },
    // Unidades de stock consumidas por unidad reservada (ej: 1/4 pollo = 2 presas).
    conversionFactor: {
      type: Number,
      default: 1,
      min: 0
    }
  },
  { _id: true }
);

const reservationSchema = new Schema(
  {
    // Código operativo corto, derivado del _id para que sea único sin reintentos.
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true
    },
    customerName: {
      type: String,
      required: true,
      trim: true
    },
    // Sale no tiene teléfono; este es el identificador operativo del cliente.
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
    items: {
      type: [reservationItemSchema],
      required: true,
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'A reservation needs at least one item'
      }
    },
    totalAmount: {
      type: Schema.Types.Decimal128,
      required: true
    },
    // Pago total anticipado: siempre igual a totalAmount. No existe seña parcial.
    paidAmount: {
      type: Schema.Types.Decimal128,
      required: true
    },
    paymentMethod: {
      type: Number,
      required: true,
      enum: [0, 1, 2, 3], // 0: Cash, 1: Transfer, 2: Card, 3: Other
      default: 1
    },
    paymentReference: {
      type: String,
      trim: true
    },
    pickupAt: {
      type: Date,
      required: true,
      index: true
    },
    // Corte de no-show: al vencer no se devuelve stock ni dinero.
    expiresAt: {
      type: Date,
      required: true,
      index: true
    },
    status: {
      type: Number,
      required: true,
      enum: [0, 1, 2, 3], // 0: active, 1: fulfilled, 2: expired, 3: voided
      default: 0,
      index: true
    },
    // La venta existe desde el momento de reservar: la reserva ya está cobrada.
    saleId: {
      type: Schema.Types.ObjectId,
      ref: 'Sale',
      required: true
    },
    fulfilledAt: {
      type: Date,
      default: null
    },
    fulfilledBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null
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
      trim: true
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

reservationSchema.index({ status: 1, expiresAt: 1 });

reservationSchema.plugin(mongoosePaginate);
reservationSchema.plugin(aggregatePaginate);

export const Reservation = mongoose.model('Reservation', reservationSchema);
