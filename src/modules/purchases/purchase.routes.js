import { Router } from "express";
import {
    createPurchase,
    getPurchases,
    getPurchaseById,
    updatePurchase,
    deletePurchase,
    getPurchaseSummary
} from "./purchase.controller.js";
import { verifyFirebaseToken } from "../../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyFirebaseToken);

router.route("/summary").get(getPurchaseSummary);
router.route("/page/:page").get(getPurchases);
router.route("/all/:page").get(getPurchases);

router.route("/")
    .get(getPurchases)
    .post(createPurchase);

router.route("/:purchaseId")
    .get(getPurchaseById)
    .put(updatePurchase)
    .patch(updatePurchase)
    .delete(deletePurchase);

export default router;
