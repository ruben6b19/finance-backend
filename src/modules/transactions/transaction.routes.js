import { Router } from "express";
import {
    createTransaction,
    getTransactions,
    getTransactionById,
    updateTransaction,
    deleteTransaction,
    getTransactionSummary
} from "./transaction.controller.js";
import { verifyFirebaseToken } from "../../middlewares/auth.middleware.js";

const router = Router();

// Middleware de autenticación para todas las rutas de transacciones
router.use(verifyFirebaseToken);

// Rutas específicas
router.route("/summary").get(getTransactionSummary);
router.route("/page/:page").get(getTransactions);
router.route("/all/:page").get(getTransactions);

// Rutas base
router.route("/")
    .get(getTransactions)
    .post(createTransaction);

router.route("/:transactionId")
    .get(getTransactionById)
    .put(updateTransaction)
    .patch(updateTransaction)
    .delete(deleteTransaction);

export default router;
