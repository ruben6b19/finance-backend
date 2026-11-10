import { Router } from "express";
import {
    getComboPurchases,
    getComboPurchaseById,
    getComboPurchaseRedemptions,
    createRedemption,
    voidRedemption
} from "./comboPurchase.controller.js";
import { verifyFirebaseToken } from "../../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyFirebaseToken);

router.route("/page/:page").get(getComboPurchases);
router.route("/all/:page").get(getComboPurchases);

router.route("/")
    .get(getComboPurchases);

router.route("/:comboPurchaseId/redemptions")
    .get(getComboPurchaseRedemptions)
    .post(createRedemption);

router.route("/:comboPurchaseId/redemptions/:redemptionId/void")
    .post(voidRedemption);

router.route("/:comboPurchaseId")
    .get(getComboPurchaseById);

export default router;
