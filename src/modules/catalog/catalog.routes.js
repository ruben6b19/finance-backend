import { Router } from "express";
import { getPublicProductById, getPublicProducts } from "./catalog.controller.js";

const router = Router();

router.route("/products").get(getPublicProducts);
router.route("/products/:productId").get(getPublicProductById);

export default router;
