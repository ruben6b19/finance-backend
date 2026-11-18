import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import { Product } from "./product.model.js";
import { ProductCategory } from "../productCategories/productCategory.model.js";
import { Unit } from "../units/unit.model.js";
import { User } from "../users/user.model.js";
import { ComboDefinition } from "../combos/comboDefinition.model.js";
import { ComboComponent } from "../combos/comboComponent.model.js";
import { ComboPurchase } from "../combos/comboPurchase.model.js";
import { createProduct, updateProduct, deleteProduct } from "./product.controller.js";
import { getTenantModel, resetTenantConnections } from "../tenants/tenantConnection.js";
import { DB_NAME } from "../../constants.js";
import esTranslations from "./es.json" with { type: "json" };

// Creating or editing a combo product opens a transaction, so this suite needs
// a replica set instead of the standalone server used by product.test.js.
jest.setTimeout(120000);

const TENANT_DB = "tenant_product_combos";

// Imported only to register their schemas so populate() can resolve the refs.
void Unit;
void User;

const buildTenant = (dbName = DB_NAME) => ({
    email: "test@example.com",
    dbName,
    getModel: (modelName) => getTenantModel(dbName, modelName)
});

const request = (overrides = {}) => ({
    params: {},
    query: {},
    body: {},
    headers: {},
    user: { mongoDbId: new mongoose.Types.ObjectId() },
    tenant: buildTenant(),
    ...overrides
});

// asyncHandler swallows the handler promise, so the response object resolves
// the test instead of awaiting the controller call.
const call = (handler, req) =>
    new Promise((resolve) => {
        const res = {
            statusCode: 200,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(payload) {
                resolve({ statusCode: this.statusCode, payload });
                return this;
            }
        };
        handler(req, res, (error) => resolve({ error }));
    });

const newUnitId = () => new mongoose.Types.ObjectId().toString();

const createComponentProduct = (overrides = {}) => Product.create({
    name: "Gaseosa",
    price: 7,
    unit: new mongoose.Types.ObjectId(),
    productType: 2,
    isSellable: true,
    isPurchasable: true,
    stock: 10,
    ...overrides
});

const seedCombo = async ({ quantity = 5, referencePrice = 35 } = {}) => {
    const component = await createComponentProduct();
    const combo = await Product.create({
        name: "Combo gaseosas",
        price: 25,
        unit: new mongoose.Types.ObjectId(),
        productType: 3,
        isSellable: true,
        isPurchasable: false,
    });
    const definition = await ComboDefinition.create({
        product: combo._id,
        referencePrice,
        status: 1,
    });
    await ComboComponent.create({
        combo: definition._id,
        product: component._id,
        quantity,
        label: component.name,
        stockProduct: component._id,
        conversionFactor: 1,
    });

    return { component, combo, definition };
};

const seedVoucher = ({ component, combo, definition }) => ComboPurchase.create({
    code: `V${new mongoose.Types.ObjectId().toString().slice(-8).toUpperCase()}`,
    comboProduct: combo._id,
    comboDefinition: definition._id,
    sale: new mongoose.Types.ObjectId(),
    customerName: "Cliente",
    customerPhone: "70000000",
    purchasedAt: new Date(),
    pricePaid: 25,
    balances: [{
        product: component._id,
        includedQty: 5,
        usedQty: 0,
        stockProduct: component._id,
        conversionFactor: 1,
    }],
    totalUnits: 5,
    status: 0,
});

describe("combo products created through the products API", () => {
    let server;

    beforeAll(async () => {
        server = await MongoMemoryReplSet.create({
            replSet: {
                count: 1,
                args: ["--setParameter", "maxTransactionLockRequestTimeoutMillis=10000"]
            }
        });
        await mongoose.connect(server.getUri());

        await Promise.all(
            mongoose.modelNames().map((name) => mongoose.model(name).init())
        );
    }, 120000);

    afterAll(async () => {
        const client = mongoose.connection.getClient();
        resetTenantConnections();

        await mongoose.connection.dropDatabase();
        await client.db(TENANT_DB).dropDatabase();

        await mongoose.connection.close();
        await server.stop();
    }, 60000);

    beforeEach(async () => {
        await Promise.all([
            Product.deleteMany({}),
            ComboDefinition.deleteMany({}),
            ComboComponent.deleteMany({}),
            ComboPurchase.deleteMany({}),
            ProductCategory.deleteMany({}),
            Unit.deleteMany({})
        ]);
    });

    describe("createProduct", () => {
        it("creates only the base combo product without a definition or components", async () => {
            const result = await call(createProduct, request({
                body: {
                    name: "Combo gaseosas",
                    price: 25,
                    unit: newUnitId(),
                    productType: 3
                }
            }));

            expect(result.error).toBeUndefined();
            expect(result.statusCode).toBe(201);

            const product = await Product.findOne({ name: "Combo gaseosas" });
            expect(product).not.toBeNull();
            expect(product.productType).toBe(3);
            expect(product.isSellable).toBe(true);
            expect(product.isPurchasable).toBe(false);

            expect(await ComboDefinition.countDocuments()).toBe(0);
            expect(await ComboComponent.countDocuments()).toBe(0);
        });

        it("ignores components and validity settings when creating the base product", async () => {
            const component = await createComponentProduct();

            const result = await call(createProduct, request({
                body: {
                    name: "Combo con vigencia",
                    price: 25,
                    unit: newUnitId(),
                    productType: 3,
                    validityDays: 30,
                    graceDays: 5,
                    components: [{ product: String(component._id), quantity: 5 }]
                }
            }));

            expect(result.error).toBeUndefined();
            expect(result.statusCode).toBe(201);

            const product = await Product.findOne({ name: "Combo con vigencia" });
            expect(product).not.toBeNull();
            expect(product.productType).toBe(3);
            expect(await ComboDefinition.countDocuments()).toBe(0);
            expect(await ComboComponent.countDocuments()).toBe(0);
        });

        it("ignores validity settings on a non-combo product", async () => {
            const result = await call(createProduct, request({
                body: {
                    name: "Gaseosa con vigencia",
                    price: 7,
                    unit: newUnitId(),
                    productType: 2,
                    validityDays: 30
                }
            }));

            expect(result.error).toBeUndefined();
            expect(result.statusCode).toBe(201);
            expect(await Product.countDocuments({ name: "Gaseosa con vigencia" })).toBe(1);
            expect(await ComboDefinition.countDocuments()).toBe(0);
            expect(await ComboComponent.countDocuments()).toBe(0);
        });

        it("accepts a combo product with no components", async () => {
            const result = await call(createProduct, request({
                body: {
                    name: "Combo vacío",
                    price: 10,
                    unit: newUnitId(),
                    productType: 3
                }
            }));

            expect(result.error).toBeUndefined();
            expect(result.statusCode).toBe(201);
            expect(await Product.countDocuments({ name: "Combo vacío" })).toBe(1);
            expect(await ComboDefinition.countDocuments()).toBe(0);
            expect(await ComboComponent.countDocuments()).toBe(0);
        });

        it("ignores components on a non-combo product", async () => {
            const component = await createComponentProduct();

            const result = await call(createProduct, request({
                body: {
                    name: "Gaseosa suelta",
                    price: 7,
                    unit: newUnitId(),
                    productType: 2,
                    components: [{ product: String(component._id), quantity: 1 }]
                }
            }));

            expect(result.error).toBeUndefined();
            expect(result.statusCode).toBe(201);
            expect(await Product.countDocuments({ name: "Gaseosa suelta" })).toBe(1);
            expect(await ComboDefinition.countDocuments()).toBe(0);
            expect(await ComboComponent.countDocuments()).toBe(0);
        });
    });

    describe("updateProduct", () => {
        it("turns an existing product into a combo and creates its definition", async () => {
            const component = await createComponentProduct();
            const product = await Product.create({
                name: "Promo gaseosas",
                price: 25,
                unit: new mongoose.Types.ObjectId(),
                productType: 2,
            });

            const result = await call(updateProduct, request({
                params: { productId: String(product._id) },
                body: {
                    productType: 3,
                    components: [{ product: String(component._id), quantity: 5 }]
                }
            }));

            expect(result.error).toBeUndefined();
            expect(result.statusCode).toBe(200);

            const stored = await Product.findById(product._id);
            expect(stored.productType).toBe(3);
            expect(stored.isSellable).toBe(true);
            expect(stored.isPurchasable).toBe(false);

            const definition = await ComboDefinition.findOne({ product: product._id });
            expect(definition).not.toBeNull();
            expect(definition.status).toBe(1);
            expect(await ComboComponent.countDocuments({ combo: definition._id })).toBe(1);
        });

        it("replaces the components of an existing combo", async () => {
            const { component, combo, definition } = await seedCombo();
            const extra = await createComponentProduct({ name: "Papas", price: 10 });

            const result = await call(updateProduct, request({
                params: { productId: String(combo._id) },
                body: {
                    components: [
                        { product: String(component._id), quantity: 2 },
                        { product: String(extra._id), quantity: 1 }
                    ]
                }
            }));

            expect(result.error).toBeUndefined();
            expect(result.statusCode).toBe(200);

            const components = await ComboComponent.find({ combo: definition._id });
            expect(components).toHaveLength(2);

            const updatedDefinition = await ComboDefinition.findById(definition._id);
            expect(updatedDefinition.referencePrice.toString()).toBe("24");
        });

        it("persists validity and grace days sent with components", async () => {
            const { component, combo, definition } = await seedCombo();

            const result = await call(updateProduct, request({
                params: { productId: String(combo._id) },
                body: {
                    validityDays: 30,
                    graceDays: 5,
                    components: [{ product: String(component._id), quantity: 5 }]
                }
            }));

            expect(result.error).toBeUndefined();
            expect(result.statusCode).toBe(200);

            const updatedDefinition = await ComboDefinition.findById(definition._id);
            expect(updatedDefinition.validityDays).toBe(30);
            expect(updatedDefinition.graceDays).toBe(5);
        });

        it("updates validity and grace days without reactivating a deactivated definition", async () => {
            const { combo, definition } = await seedCombo();
            await ComboDefinition.updateOne({ _id: definition._id }, { $set: { status: 0 } });

            const result = await call(updateProduct, request({
                params: { productId: String(combo._id) },
                body: { validityDays: 60, graceDays: 7 }
            }));

            expect(result.error).toBeUndefined();
            expect(result.statusCode).toBe(200);

            const updatedDefinition = await ComboDefinition.findById(definition._id);
            expect(updatedDefinition.validityDays).toBe(60);
            expect(updatedDefinition.graceDays).toBe(7);
            expect(updatedDefinition.status).toBe(0);
            expect(await ComboComponent.countDocuments({ combo: definition._id })).toBe(1);
        });

        it("rejects validity or grace days on a non-combo product", async () => {
            const product = await Product.create({
                name: "Gaseosa",
                price: 7,
                unit: new mongoose.Types.ObjectId(),
                productType: 2,
            });

            const result = await call(updateProduct, request({
                params: { productId: String(product._id) },
                body: { validityDays: 30 }
            }));

            expect(result.statusCode).toBe(400);
            expect(result.payload.message).toBe(esTranslations.error_product_combo_settings_require_combo_type);
            expect(await ComboDefinition.countDocuments({ product: product._id })).toBe(0);
        });

        it("rejects null or empty validity days instead of coercing them to zero", async () => {
            const { combo, definition } = await seedCombo();

            for (const body of [{ validityDays: null }, { graceDays: null }, { validityDays: "" }, { graceDays: "" }]) {
                const result = await call(updateProduct, request({
                    params: { productId: String(combo._id) },
                    body
                }));

                expect(result.statusCode).toBe(400);
                expect(result.payload.message).toBe(esTranslations.error_combo_invalid_validity);
            }

            const stored = await ComboDefinition.findById(definition._id);
            expect(stored.validityDays).toBe(0);
            expect(stored.graceDays).toBe(0);
        });

        it("reactivates a deactivated definition when components are sent", async () => {
            const { component, combo, definition } = await seedCombo();
            await ComboDefinition.updateOne({ _id: definition._id }, { $set: { status: 0 } });

            const result = await call(updateProduct, request({
                params: { productId: String(combo._id) },
                body: { components: [{ product: String(component._id), quantity: 5 }] }
            }));

            expect(result.statusCode).toBe(200);
            const updatedDefinition = await ComboDefinition.findById(definition._id);
            expect(updatedDefinition.status).toBe(1);
        });

        it("deactivates the definition when the product stops being a combo", async () => {
            const { combo, definition } = await seedCombo();

            const result = await call(updateProduct, request({
                params: { productId: String(combo._id) },
                body: { productType: 2 }
            }));

            expect(result.error).toBeUndefined();
            expect(result.statusCode).toBe(200);

            const stored = await Product.findById(combo._id);
            expect(stored.productType).toBe(2);

            const updatedDefinition = await ComboDefinition.findById(definition._id);
            expect(updatedDefinition.status).toBe(0);
        });

        it("updates a combo without components when no definition exists", async () => {
            const combo = await Product.create({
                name: "Combo sin definición",
                price: 25,
                unit: new mongoose.Types.ObjectId(),
                productType: 3,
            });

            const result = await call(updateProduct, request({
                params: { productId: String(combo._id) },
                body: { price: 30 }
            }));

            expect(result.error).toBeUndefined();
            expect(result.statusCode).toBe(200);

            const stored = await Product.findById(combo._id);
            expect(stored.price.toString()).toBe("30");
            expect(await ComboDefinition.countDocuments({ product: combo._id })).toBe(0);
            expect(await ComboComponent.countDocuments()).toBe(0);
        });

        it("keeps the existing definition when a combo is edited without components", async () => {
            const { component, combo, definition } = await seedCombo();

            const result = await call(updateProduct, request({
                params: { productId: String(combo._id) },
                body: { price: 30 }
            }));

            expect(result.error).toBeUndefined();
            expect(result.statusCode).toBe(200);

            expect(await ComboDefinition.countDocuments({ product: combo._id })).toBe(1);
            expect(await ComboComponent.countDocuments({ combo: definition._id })).toBe(1);

            const stored = await Product.findById(combo._id);
            expect(stored.price.toString()).toBe("30");
            expect(String(component._id)).toBeTruthy();
        });

        it("still updates plain products without a transaction", async () => {
            const product = await Product.create({
                name: "Gaseosa",
                price: 7,
                unit: new mongoose.Types.ObjectId(),
                productType: 2,
            });

            const result = await call(updateProduct, request({
                params: { productId: String(product._id) },
                body: { price: 9 }
            }));

            expect(result.error).toBeUndefined();
            expect(result.statusCode).toBe(200);
            expect((await Product.findById(product._id)).price.toString()).toBe("9");
            expect(await ComboDefinition.countDocuments()).toBe(0);
        });
    });

    describe("deleteProduct", () => {
        it("hard-deletes the combo product, its definition and its components", async () => {
            const { combo, definition } = await seedCombo();

            const result = await call(deleteProduct, request({
                params: { productId: String(combo._id) }
            }));

            expect(result.error).toBeUndefined();
            expect(result.statusCode).toBe(200);

            expect(await Product.findById(combo._id)).toBeNull();
            expect(await ComboDefinition.findById(definition._id)).toBeNull();
            expect(await ComboComponent.countDocuments({ combo: definition._id })).toBe(0);
        });

        it("keeps already-sold vouchers and their frozen balances after deleting the combo", async () => {
            const { component, combo, definition } = await seedCombo();
            const voucher = await seedVoucher({ component, combo, definition });

            const result = await call(deleteProduct, request({
                params: { productId: String(combo._id) }
            }));

            expect(result.statusCode).toBe(200);

            const storedVoucher = await ComboPurchase.findById(voucher._id).lean();
            expect(storedVoucher).not.toBeNull();
            expect(storedVoucher.balances).toHaveLength(1);
            expect(storedVoucher.balances[0].includedQty).toBe(5);
            expect(storedVoucher.balances[0].usedQty).toBe(0);
            expect(storedVoucher.totalUnits).toBe(5);
        });

        it("deletes a plain product without touching combo data", async () => {
            const { definition } = await seedCombo();
            const plain = await Product.create({
                name: "Gaseosa",
                price: 7,
                unit: new mongoose.Types.ObjectId(),
                productType: 2,
            });

            const result = await call(deleteProduct, request({
                params: { productId: String(plain._id) }
            }));

            expect(result.statusCode).toBe(200);
            expect(await Product.findById(plain._id)).toBeNull();
            expect(await ComboDefinition.findById(definition._id)).not.toBeNull();
        });

        it("returns 404 for a well-formed id that does not exist", async () => {
            const result = await call(deleteProduct, request({
                params: { productId: new mongoose.Types.ObjectId().toString() }
            }));

            expect(result.statusCode).toBe(404);
            expect(result.payload.message).toBe(esTranslations.error_product_not_found);
        });
    });
});

