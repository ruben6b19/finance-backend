import mongoose, { Schema } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';
import aggregatePaginate from 'mongoose-aggregate-paginate-v2';

const productCategorySchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
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

productCategorySchema.plugin(mongoosePaginate);
productCategorySchema.plugin(aggregatePaginate);

export const ProductCategory = mongoose.model('ProductCategory', productCategorySchema);
