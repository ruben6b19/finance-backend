import { Router } from "express";
import { getPublicStoreConfig, getStoreConfig } from "./storeConfig.controller.js";
import { verifyFirebaseToken } from "../../middlewares/auth.middleware.js";
import { requireStore } from "../../middlewares/resolveStore.middleware.js";

const router = Router();

// The storefront renders the store name before anyone signs in, so this route
// is anonymous and resolves the tenant from the X-Store header. It exposes
// only the name, never the fiscal or contact settings.
router.route("/public").get(requireStore, getPublicStoreConfig);

// Store settings are read by the mobile app with an authenticated session.
router.use(verifyFirebaseToken);

router.route("/").get(getStoreConfig);

export default router;
