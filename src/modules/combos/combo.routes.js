import { Router } from "express";
import {
    createCombo,
    getCombos,
    getComboById,
    updateCombo
} from "./combo.controller.js";
import { verifyFirebaseToken } from "../../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyFirebaseToken);

router.route("/page/:page").get(getCombos);
router.route("/all/:page").get(getCombos);

router.route("/")
    .get(getCombos)
    .post(createCombo);

router.route("/:comboId")
    .get(getComboById)
    .put(updateCombo)
    .patch(updateCombo);

export default router;
