import { Router } from "express";
import { createOrder, getMyOrderById, getMyOrders, getAllOrders } from "./order.controller.js";
import { verifyFirebaseToken } from "../../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyFirebaseToken);

router.route("/")
  .get(getAllOrders)
  .post(createOrder);

router.route("/me").get(getMyOrders);
router.route("/:orderId").get(getMyOrderById);

export default router;
