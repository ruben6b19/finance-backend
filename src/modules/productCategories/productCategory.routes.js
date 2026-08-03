import { Router } from "express";
import {
    createProductCategory,
    getProductCategories,
    getProductCategoryById,
    updateProductCategory,
    deleteProductCategory
} from "./productCategory.controller.js";
import { verifyFirebaseToken } from "../../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyFirebaseToken);

router.route("/page/:page").get(getProductCategories);
router.route("/all/:page").get(getProductCategories);

router.route("/")
    .get(getProductCategories)
    .post(createProductCategory);

router.route("/:categoryId")
    .get(getProductCategoryById)
    .put(updateProductCategory)
    .patch(updateProductCategory)
    .delete(deleteProductCategory);

export default router;
