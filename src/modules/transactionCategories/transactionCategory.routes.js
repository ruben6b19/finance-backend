import { Router } from "express";
import {
    createTransactionCategory,
    getTransactionCategories,
    getTransactionCategoryById,
    updateTransactionCategory,
    deleteTransactionCategory
} from "./transactionCategory.controller.js";
import { verifyFirebaseToken } from "../../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyFirebaseToken);

router.route("/page/:page").get(getTransactionCategories);
router.route("/all/:page").get(getTransactionCategories);

router.route("/")
    .get(getTransactionCategories)
    .post(createTransactionCategory);

router.route("/:categoryId")
    .get(getTransactionCategoryById)
    .put(updateTransactionCategory)
    .patch(updateTransactionCategory)
    .delete(deleteTransactionCategory);

export default router;
