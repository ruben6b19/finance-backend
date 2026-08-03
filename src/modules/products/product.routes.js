import { Router } from "express";
import {
    createProduct,
    getProducts,
    getProductById,
    updateProduct,
    deleteProduct
} from "./product.controller.js";
import { verifyFirebaseToken } from "../../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyFirebaseToken);

router.route("/page/:page").get(getProducts);
router.route("/all/:page").get(getProducts);

router.route("/")
    .get(getProducts)
    .post(createProduct);

router.route("/:productId")
    .get(getProductById)
    .put(updateProduct)
    .patch(updateProduct)
    .delete(deleteProduct);

export default router;
