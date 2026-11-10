import mongoose, { Schema } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';
import aggregatePaginate from 'mongoose-aggregate-paginate-v2';

// Reglas de un combo. Una definición por producto vendible de tipo 3.
// La disponibilidad del combo es la de sus componentes: no tiene stock propio.
const comboDefinitionSchema = new Schema(
  {
    product: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      unique: true
    },
    // Suma de los componentes a precio de catálogo. Solo informativa.
    referencePrice: {
      type: Schema.Types.Decimal128,
      default: 0
    },
    // 0 => el voucher nunca vence.
    validityDays: {
      type: Number,
      default: 0,
      min: 0
    },
    // Días extra después del vencimiento antes de cerrar el voucher.
    graceDays: {
      type: Number,
      default: 0,
      min: 0
    },
    allowSubstitution: {
      type: Boolean,
      default: false
    },
    terms: {
      type: String,
      trim: true,
      default: ''
    },
    status: {
      type: Number,
      required: true,
      enum: [0, 1], // 0: inactive, 1: active
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

comboDefinitionSchema.plugin(mongoosePaginate);
comboDefinitionSchema.plugin(aggregatePaginate);

export const ComboDefinition = mongoose.model('ComboDefinition', comboDefinitionSchema);
