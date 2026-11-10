import { Router } from "express";
import {
    createStockAdjustment,
    getStockAdjustments
} from "./stockAdjustment.controller.js";
import { verifyFirebaseToken } from "../../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyFirebaseToken);

router.route("/page/:page").get(getStockAdjustments);
router.route("/all/:page").get(getStockAdjustments);

router.route("/")
    .get(getStockAdjustments)
    .post(createStockAdjustment);

export default router;
