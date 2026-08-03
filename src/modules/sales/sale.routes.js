import { Router } from "express";
import {
    createSale,
    getSales,
    getSaleById,
    updateSale,
    deleteSale,
    getSaleSummary,
    cancelSale
} from "./sale.controller.js";
import { verifyFirebaseToken } from "../../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyFirebaseToken);

router.route("/summary").get(getSaleSummary);
router.route("/page/:page").get(getSales);
router.route("/all/:page").get(getSales);

router.route("/")
    .get(getSales)
    .post(createSale);

router.route("/:saleId/cancel")
    .post(cancelSale);

router.route("/:saleId")
    .get(getSaleById)
    .put(updateSale)
    .patch(updateSale)
    .delete(deleteSale);

export default router;
