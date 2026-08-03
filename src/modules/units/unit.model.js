import mongoose, { Schema } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';

const unitSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true
    },
    symbol: {
      type: String,
      required: true,
      trim: true,
      lowercase: true
    },
    // TIPO DE UNIDAD
    // 0: Peso / Masa (kg, g)
    // 1: Volumen / Líquido (l, ml)
    // 2: Conteo / Piezas (un, pza)
    // 3: Empaque / Contenedor (saco, caja, paquete, balde)
    unitType: {
      type: Number,
      required: true,
      enum: [0, 1, 2, 3],
      default: 2,
      index: true
    },
    allowDecimals: {
      type: Boolean,
      default: false
    },
    status: {
      type: Number,
      required: true,
      enum: [0, 1],
      default: 1,
      index: true
    }
  },
  {
    timestamps: true
  }
);

unitSchema.plugin(mongoosePaginate);

export const Unit = mongoose.model('Unit', unitSchema);
