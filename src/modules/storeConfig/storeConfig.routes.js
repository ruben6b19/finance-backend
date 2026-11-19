import { Router } from "express";
import { getPublicStoreConfig, getStoreConfig, updateMailConfig } from "./storeConfig.controller.js";
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

// SMTP credentials are tenant-scoped and admin-only; the role guard lives in
// the controller so the route itself only enforces authentication.
router.route("/mail").put(updateMailConfig);

export default router;
