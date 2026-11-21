import { Router } from "express";
import {
    getPublicStoreConfig,
    getStoreConfig,
    updateDeliveryOptions,
    updateCoordinates,
    updateGeneralStoreConfig,
    updateMailConfig,
    getStoreSchedule,
    updateStoreSchedule,
    updateStoreScheduleMode
} from "./storeConfig.controller.js";
import { verifyFirebaseToken } from "../../middlewares/auth.middleware.js";
import { requireStore } from "../../middlewares/resolveStore.middleware.js";

const router = Router();

// The storefront renders the store name before anyone signs in, so this route
// is anonymous and resolves the tenant from the X-Store header. It exposes the
// name, the store coordinates, the time zone and the delivery-option visibility
// flags, never fiscal or contact settings.
router.route("/public").get(requireStore, getPublicStoreConfig);

// Store settings are read by the mobile app with an authenticated session.
router.use(verifyFirebaseToken);

router.route("/").get(getStoreConfig);

// Delivery-option visibility is tenant-scoped and admin-only; the role guard
// lives in the controller so the route itself only enforces authentication.
router.route("/delivery-options").put(updateDeliveryOptions);

// Store coordinates are tenant-scoped and admin-only; the role guard lives in
// the controller so the route itself only enforces authentication.
router.route("/coordinates").put(updateCoordinates);

// Store schedule is tenant-scoped and admin-only; the role guard lives in the
// controller, so the route itself only enforces authentication.
router.route("/schedule").get(getStoreSchedule).put(updateStoreSchedule);
router.route("/schedule/mode").put(updateStoreScheduleMode);

// General store data is tenant-scoped and admin-only; the role guard lives in
// the controller so the route itself only enforces authentication.
router.route("/general").put(updateGeneralStoreConfig);

// SMTP credentials are tenant-scoped and admin-only; the role guard lives in
// the controller so the route itself only enforces authentication.
router.route("/mail").put(updateMailConfig);

export default router;
