import { Router } from "express";
import { requireStore } from "../../middlewares/resolveStore.middleware.js";
import { getPublicProductById, getPublicProducts } from "./catalog.controller.js";

const router = Router();

// The public catalog is anonymous: there is no authenticated user to resolve
// the store from, so the tenant always comes from the X-Store header.
router.use(requireStore);

router.route("/products").get(getPublicProducts);
router.route("/products/:productId").get(getPublicProductById);

export default router;
