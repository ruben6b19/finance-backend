import { Sale } from "../sales/sale.model.js";
import { Transaction } from "../transactions/transaction.model.js";
import { TransactionCategory } from "../transactionCategories/transactionCategory.model.js";
import { Purchase } from "../purchases/purchase.model.js";
import { User } from "../users/user.model.js";
import { StockAdjustment } from "../stockAdjustments/stockAdjustment.model.js";
import { Order } from "../orders/order.model.js";
import { ProductCategory } from "../productCategories/productCategory.model.js";
import { Reservation } from "../reservations/reservation.model.js";
import { Unit } from "../units/unit.model.js";
import { StoreConfig } from "../storeConfig/storeConfig.model.js";
import { Product } from "../products/product.model.js";
import { ComboRedemption } from "../combos/comboRedemption.model.js";
import { ComboPurchase } from "../combos/comboPurchase.model.js";
import { ComboComponent } from "../combos/comboComponent.model.js";
import { ComboDefinition } from "../combos/comboDefinition.model.js";
import { MailOutbox } from "../notifications/mailOutbox.model.js";

// TenantMapping is intentionally excluded: it lives in the central database
// and must never be routed to a tenant connection.
const MODELS = [
    Sale,
    Transaction,
    TransactionCategory,
    Purchase,
    User,
    StockAdjustment,
    Order,
    ProductCategory,
    Reservation,
    Unit,
    StoreConfig,
    Product,
    ComboRedemption,
    ComboPurchase,
    ComboComponent,
    ComboDefinition,
    MailOutbox
];

export const TENANT_MODEL_SCHEMAS = new Map(
    MODELS.map((model) => [model.modelName, model.schema])
);
