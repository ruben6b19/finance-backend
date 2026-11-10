import { Router } from "express";
import {
    getComboPurchases,
    getComboPurchaseById,
    getComboPurchaseRedemptions,
    createRedemption,
    voidRedemption,
    getVoucherReconciliation
} from "./comboPurchase.controller.js";
import { verifyFirebaseToken } from "../../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyFirebaseToken);

router.route("/page/:page").get(getComboPurchases);
router.route("/all/:page").get(getComboPurchases);

router.route("/")
    .get(getComboPurchases);

// Debe declararse antes de "/:comboPurchaseId" para no interpretarse como un código.
router.route("/reconciliation")
    .get(getVoucherReconciliation);

router.route("/:comboPurchaseId/redemptions")
    .get(getComboPurchaseRedemptions)
    .post(createRedemption);

router.route("/:comboPurchaseId/redemptions/:redemptionId/void")
    .post(voidRedemption);

router.route("/:comboPurchaseId")
    .get(getComboPurchaseById);

export default router;
