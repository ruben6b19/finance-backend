import { Router } from "express";
import {
    createUnit,
    getUnits,
    getUnitById,
    updateUnit,
    deleteUnit
} from "./unit.controller.js";
import { verifyFirebaseToken } from "../../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyFirebaseToken);

router.route("/page/:page").get(getUnits);
router.route("/all/:page").get(getUnits);

router.route("/")
    .get(getUnits)
    .post(createUnit);

router.route("/:unitId")
    .get(getUnitById)
    .put(updateUnit)
    .patch(updateUnit)
    .delete(deleteUnit);

export default router;
