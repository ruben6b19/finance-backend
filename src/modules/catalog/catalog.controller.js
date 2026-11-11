import mongoose from "mongoose";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { Product } from "../products/product.model.js";

// 0 = insumo / materia prima -> nunca público
const PUBLIC_PRODUCT_TYPES = [1, 2, 3];

function toPublicPrice(price) {
    const raw = price;
    const value = raw && typeof raw.toString === "function"
        ? Number(raw.toString())
        : Number(raw ?? 0);

    return Number.isFinite(value) ? value : 0;
}

function toPublicProduct(product) {
    return {
        id: String(product._id),
        name: product.name,
        description: product.description || "",
        price: toPublicPrice(product.price),
        image: product.imageUrl || "",
        isCombo: product.productType === 3,
        stock: product.productType === 3 ? null : Number(product.stock ?? 0),
    };
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const getPublicProducts = asyncHandler(async (req, res) => {
    try {
        const search = typeof req.query.search === "string"
            ? req.query.search.trim()
            : "";

        const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
        const requestedLimit = Number.parseInt(req.query.limit, 10) || 100;
        const limit = Math.min(100, Math.max(1, requestedLimit));

        const filter = {
            status: 1,
            isSellable: true,
            productType: { $in: PUBLIC_PRODUCT_TYPES },
        };

        if (search) {
            const pattern = new RegExp(escapeRegExp(search), "i");
            filter.$or = [
                { name: pattern },
                { description: pattern },
                { sku: pattern },
            ];
        }

        const results = await Product.paginate(filter, {
            page,
            limit,
            sort: { productType: 1, name: 1 },
        });

        res.status(200).json(new ApiResponse(
            200,
            {
                products: results.docs.map(toPublicProduct),
                total: results.totalDocs,
                page: results.page,
                limit: results.limit,
                totalPages: results.totalPages,
            },
            "success_products_fetched"
        ));
    } catch (error) {
        console.error("getPublicProducts error:", error);
        res.status(500).json(new ApiResponse(500, {}, "error_internal_server_generic"));
    }
});

const getPublicProductById = asyncHandler(async (req, res) => {
    try {
        const { productId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(productId)) {
            return res.status(400).json(new ApiResponse(400, {}, "error_product_invalid_id"));
        }

        const product = await Product.findOne({
            _id: productId,
            status: 1,
            isSellable: true,
            productType: { $in: PUBLIC_PRODUCT_TYPES },
        });

        if (!product) {
            return res.status(404).json(new ApiResponse(404, {}, "error_product_not_found"));
        }

        res.status(200).json(new ApiResponse(200, toPublicProduct(product), "success_product_fetched"));
    } catch (error) {
        console.error("getPublicProductById error:", error);
        res.status(500).json(new ApiResponse(500, {}, "error_internal_server_generic"));
    }
});

export { getPublicProducts, getPublicProductById };
