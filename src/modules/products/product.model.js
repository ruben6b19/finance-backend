import mongoose, { Schema } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';
import aggregatePaginate from 'mongoose-aggregate-paginate-v2';

const productSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    description: {
      type: String,
      trim: true,
      default: ''
    },
    // TIPO DE PRODUCTO
    // 0: Insumo / Materia Prima (ej. Arroz, Pollo Entero, Aceite)
    // 1: Producto Final / Menú (ej. 1/4 de Pollo, Porción de Papas)
    // 2: Producto Directo / Reventa (ej. Gaseosa 2L, Cerveza)
    productType: {
      type: Number,
      required: true,
      enum: [0, 1, 2],
      default: 1,
      index: true
    },
    // Banderas rápidas para filtros de UI y validaciones
    isSellable: {
      type: Boolean,
      default: true
    },
    isPurchasable: {
      type: Boolean,
      default: false
    },
    // UNIDAD DE MEDIDA (Crucial para Compras de Insumos)
    unit: { // Unidad Base / Venta
      type: Schema.Types.ObjectId,
      ref: 'Unit',
      required: true
    },
    purchaseUnit: { // Unidad de Compra (opcional)
      type: Schema.Types.ObjectId,
      ref: 'Unit',
      default: null
    },
    conversionFactor: { // Factor para convertir compra a base (ej: 1 caja = 24 unidades)
      type: Number,
      default: 1
    },
    // PRECIOS
    price: { // Precio de Venta al cliente
      type: Schema.Types.Decimal128,
      default: 0
    },
    costPrice: { // Precio de Costo / Compra
      type: Schema.Types.Decimal128,
      default: 0
    },
    stock: {
      type: Number,
      default: 0,
      min: 0
    },
    category: {
      type: Schema.Types.ObjectId,
      ref: 'ProductCategory',
      default: null
    },
    sku: {
      type: String,
      trim: true,
      unique: true,
      sparse: true
    },
    status: {
      type: Number,
      required: true,
      enum: [0, 1], // 0: inactive, 1: active
      default: 1,
      index: true
    },
    imageUrl: {
      type: String,
      trim: true,
      default: ''
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

productSchema.plugin(mongoosePaginate);
productSchema.plugin(aggregatePaginate);

export const Product = mongoose.model('Product', productSchema);
