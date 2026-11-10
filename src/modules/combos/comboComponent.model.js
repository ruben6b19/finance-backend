import mongoose, { Schema } from 'mongoose';

// Qué incluye un combo. Una fila por producto incluido.
// `stockProduct: null` significa que el componente no toca inventario (pollo),
// mientras que un componente embotellado apunta a su producto de stock.
const comboComponentSchema = new Schema(
  {
    combo: {
      type: Schema.Types.ObjectId,
      ref: 'ComboDefinition',
      required: true,
      index: true
    },
    // El componente tal como lo conoce el cliente ("Pollo entero").
    product: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true
    },
    // Unidades incluidas. Admite decimales (5 pollos, 0.25 de pollo).
    quantity: {
      type: Number,
      required: true,
      validate: {
        validator: (value) => Number.isFinite(value) && value > 0,
        message: 'Component quantity must be greater than zero'
      }
    },
    label: {
      type: String,
      trim: true,
      default: ''
    },
    stockProduct: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      default: null
    },
    // Unidades de stock consumidas por unidad de componente.
    conversionFactor: {
      type: Number,
      default: 1,
      min: 0
    }
  },
  {
    timestamps: true
  }
);

// Un producto no puede aparecer dos veces en el mismo combo: los saldos se
// identifican por producto y un duplicado los vuelve ambiguos.
comboComponentSchema.index({ combo: 1, product: 1 }, { unique: true });

export const ComboComponent = mongoose.model('ComboComponent', comboComponentSchema);
