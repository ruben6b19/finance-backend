import { Router } from "express";
import { getStoreConfig } from "./storeConfig.controller.js";
import { verifyFirebaseToken } from "../../middlewares/auth.middleware.js";

const router = Router();

// Store settings are read by the mobile app with an authenticated session.
router.use(verifyFirebaseToken);

router.route("/").get(getStoreConfig);

export default router;
