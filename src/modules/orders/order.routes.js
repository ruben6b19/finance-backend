import { Router } from "express";
import { createOrder, getMyOrderById, getMyOrders, getAllOrders, updateOrderStatus } from "./order.controller.js";
import { verifyFirebaseToken } from "../../middlewares/auth.middleware.js";

const router = Router();

router.use(verifyFirebaseToken);

router.route("/")
  .get(getAllOrders)
  .post(createOrder);

router.route("/me").get(getMyOrders);
router.route("/:orderId").get(getMyOrderById);
router.route("/:orderId/status").patch(updateOrderStatus);

export default router;
