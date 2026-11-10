import { Router } from "express";
import { runExpirySweep } from "./expirySweep.controller.js";
import { verifyFirebaseToken } from "../../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyFirebaseToken);

router.route("/expiry-sweep").post(runExpirySweep);

export default router;
