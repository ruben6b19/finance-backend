import { Router } from "express";
import {
    createReservation,
    getReservations,
    getReservationById,
    fulfillReservation,
    voidReservation
} from "./reservation.controller.js";
import { verifyFirebaseToken } from "../../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyFirebaseToken);

router.route("/page/:page").get(getReservations);
router.route("/all/:page").get(getReservations);

router.route("/")
    .get(getReservations)
    .post(createReservation);

router.route("/:reservationId/fulfill")
    .post(fulfillReservation);

router.route("/:reservationId/void")
    .post(voidReservation);

router.route("/:reservationId")
    .get(getReservationById);

export default router;
