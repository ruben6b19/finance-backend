import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Product } from "./product.model.js";
import { ProductCategory } from "../productCategories/productCategory.model.js";
import { Unit } from "../units/unit.model.js";
import { User } from "../users/user.model.js";
import { updateProduct, createProduct, getProductById, getProducts } from "./product.controller.js";
import { getTenantModel, resetTenantConnections } from "../tenants/tenantConnection.js";
import { DB_NAME } from "../../constants.js";
import esTranslations from "./es.json" with { type: "json" };

const buildTenant = (dbName = DB_NAME) => ({
    email: "test@example.com",
    dbName,
    getModel: (modelName) => getTenantModel(dbName, modelName)
});

const TENANT_DB = "tenant_products";

// Models are imported only to register their schemas so populate() can resolve
// the "category", "unit" and "createdBy" refs.
void Unit;
void User;

// asyncHandler does not return the handler promise, so tests must wait for the
// response (or next) signal instead of awaiting the controller call itself.
const createResMock = (onResponse) => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockImplementation((payload) => {
        onResponse(payload);
        return res;
    });
    return res;
};

const callUpdate = async (productId, body) => {
    const req = { params: { productId }, body, headers: {}, tenant: buildTenant() };

    let resolveResponse;
    const responseReceived = new Promise((resolve) => {
        resolveResponse = resolve;
    });

    const res = createResMock(resolveResponse);
    const next = jest.fn(() => resolveResponse(undefined));

    await updateProduct(req, res, next);
    await responseReceived;

    return { res, next, payload: res.json.mock.calls[0]?.[0] };
};

const callCreate = async (body) => {
    const req = { params: {}, query: {}, body, headers: {}, tenant: buildTenant() };

    let resolveResponse;
    const responseReceived = new Promise((resolve) => {
        resolveResponse = resolve;
    });

    const res = createResMock(resolveResponse);
    const next = jest.fn(() => resolveResponse(undefined));

    await createProduct(req, res, next);
    await responseReceived;

    return { res, next, payload: res.json.mock.calls[0]?.[0] };
};

const expectTranslatedError = (result, statusCode, errorKey) => {
    expect(result.next).not.toHaveBeenCalled();
    expect(result.res.status).toHaveBeenCalledWith(statusCode);
    expect(result.payload).toEqual({
        success: false,
        statusCode,
        message: esTranslations[errorKey]
    });
};

const snapshotStoredState = async (productId) => {
    const stored = await Product.findById(productId).lean();
    return {
        productType: stored.productType,
        status: stored.status,
        unit: stored.unit.toString(),
        isSellable: stored.isSellable,
        isPurchasable: stored.isPurchasable,
        price: stored.price.toString(),
        costPrice: stored.costPrice.toString()
    };
};

const expectDocumentUnchanged = async (productId, snapshot) => {
    expect(await snapshotStoredState(productId)).toEqual(snapshot);
};

const createProductFixture = (overrides = {}) => Product.create({
    name: "Test Product",
    price: 10,
    costPrice: 5,
    unit: new mongoose.Types.ObjectId(),
    ...overrides
});

describe("updateProduct integration test", () => {
    let mongoServer;

    beforeAll(async () => {
        mongoServer = await MongoMemoryServer.create();
        await mongoose.connect(mongoServer.getUri());

        // Los duplicados se detectan por el índice único (error 11000). Si el
        // índice todavía se está construyendo en background, el update pasa y
        // el test falla de forma intermitente. Esperarlo lo vuelve determinista.
        await Promise.all(
            mongoose.modelNames().map((name) => mongoose.model(name).init())
        );
    });

    afterAll(async () => {
        const client = mongoose.connection.getClient();
        resetTenantConnections();

        await mongoose.connection.dropDatabase();
        await client.db(TENANT_DB).dropDatabase();

        await mongoose.connection.close();
        await mongoServer.stop();
    });

    beforeEach(async () => {
        await Product.deleteMany({});
        await ProductCategory.deleteMany({});
        await Unit.deleteMany({});
    });

    it("clears sku when an empty string is sent", async () => {
        const product = await createProductFixture({ sku: "SKU-001" });

        const result = await callUpdate(product._id.toString(), { sku: "" });

        expect(result.next).not.toHaveBeenCalled();
        expect(result.res.status).toHaveBeenCalledWith(200);

        const stored = await Product.findById(product._id).lean();
        expect(stored.sku).toBeUndefined();
    });

    it("rejects a non-string name with a translated 400 instead of a 500", async () => {
        const product = await createProductFixture();

        const result = await callUpdate(product._id.toString(), { name: 5 });

        expectTranslatedError(result, 400, "error_product_name_required");
    });

    it("rejects a whitespace-only name with a translated 400", async () => {
        const product = await createProductFixture();

        const result = await callUpdate(product._id.toString(), { name: "   " });

        expectTranslatedError(result, 400, "error_product_name_required");
    });

    it("rejects a negative price with a translated 400", async () => {
        const product = await createProductFixture();

        const result = await callUpdate(product._id.toString(), { price: -5 });

        expectTranslatedError(result, 400, "error_product_invalid_price");
    });

    it("rejects a NaN price with a translated 400", async () => {
        const product = await createProductFixture();

        const result = await callUpdate(product._id.toString(), { price: "not-a-number" });

        expectTranslatedError(result, 400, "error_product_invalid_price");
    });

    it("rejects a null price with a translated 400", async () => {
        const product = await createProductFixture();

        const result = await callUpdate(product._id.toString(), { price: null });

        expectTranslatedError(result, 400, "error_product_invalid_price");
    });

    it("rejects a boolean price with a translated 400 and keeps the stored price", async () => {
        const product = await createProductFixture();
        const before = await snapshotStoredState(product._id);

        const result = await callUpdate(product._id.toString(), { price: true });

        expectTranslatedError(result, 400, "error_product_invalid_price");
        await expectDocumentUnchanged(product._id, before);
    });

    it("rejects a negative cost price with a translated 400", async () => {
        const product = await createProductFixture();

        const result = await callUpdate(product._id.toString(), { costPrice: -1 });

        expectTranslatedError(result, 400, "error_product_invalid_cost_price");
    });

    it("rejects a boolean cost price with a translated 400 and keeps the stored cost price", async () => {
        const product = await createProductFixture();
        const before = await snapshotStoredState(product._id);

        const result = await callUpdate(product._id.toString(), { costPrice: false });

        expectTranslatedError(result, 400, "error_product_invalid_cost_price");
        await expectDocumentUnchanged(product._id, before);
    });

    it("accepts zero and numeric-string prices", async () => {
        const product = await createProductFixture();

        const zeroResult = await callUpdate(product._id.toString(), { price: 0, costPrice: 0 });
        expect(zeroResult.next).not.toHaveBeenCalled();
        expect(zeroResult.res.status).toHaveBeenCalledWith(200);
        expect(zeroResult.payload.data.price.toString()).toBe("0");
        expect(zeroResult.payload.data.costPrice.toString()).toBe("0");

        const stringResult = await callUpdate(product._id.toString(), { price: "12.5" });
        expect(stringResult.next).not.toHaveBeenCalled();
        expect(stringResult.res.status).toHaveBeenCalledWith(200);
        expect(stringResult.payload.data.price.toString()).toBe("12.5");
    });

    it("rejects an out-of-range numeric productType with a translated 400", async () => {
        const product = await createProductFixture();

        const result = await callUpdate(product._id.toString(), { productType: 7 });

        expectTranslatedError(result, 400, "error_product_invalid_type");
    });

    it("rejects a non-numeric productType with a translated 400", async () => {
        const product = await createProductFixture();

        const result = await callUpdate(product._id.toString(), { productType: "abc" });

        expectTranslatedError(result, 400, "error_product_invalid_type");
    });

    it("rejects a malformed category id with a translated 400", async () => {
        const product = await createProductFixture();

        const result = await callUpdate(product._id.toString(), { category: "not-an-object-id" });

        expectTranslatedError(result, 400, "error_product_invalid_reference");
    });

    it("rejects a malformed unit id with a translated 400", async () => {
        const product = await createProductFixture();

        const result = await callUpdate(product._id.toString(), { unit: "no-es-id" });

        expectTranslatedError(result, 400, "error_product_unit_required");
    });

    it("rejects an empty unit with a translated 400", async () => {
        const product = await createProductFixture();

        const result = await callUpdate(product._id.toString(), { unit: "" });

        expectTranslatedError(result, 400, "error_product_unit_required");
    });

    it("rejects a null unit with a translated 400 and keeps the stored unit", async () => {
        const product = await createProductFixture();
        const before = await snapshotStoredState(product._id);

        const result = await callUpdate(product._id.toString(), { unit: null });

        expectTranslatedError(result, 400, "error_product_unit_required");
        await expectDocumentUnchanged(product._id, before);
    });

    it("rejects a null productType with a translated 400 and keeps the stored visibility", async () => {
        const product = await createProductFixture();
        const before = await snapshotStoredState(product._id);

        const result = await callUpdate(product._id.toString(), { productType: null });

        expectTranslatedError(result, 400, "error_product_invalid_type");
        await expectDocumentUnchanged(product._id, before);
    });

    it("rejects a boolean productType with a translated 400 and keeps the stored visibility", async () => {
        const product = await createProductFixture();
        const before = await snapshotStoredState(product._id);

        const result = await callUpdate(product._id.toString(), { productType: false });

        expectTranslatedError(result, 400, "error_product_invalid_type");
        await expectDocumentUnchanged(product._id, before);
    });

    it("rejects a zero conversion factor with a translated 400", async () => {
        const product = await createProductFixture();

        const result = await callUpdate(product._id.toString(), { conversionFactor: 0 });

        expectTranslatedError(result, 400, "error_product_invalid_conversion_factor");
    });

    it("rejects a boolean conversion factor with a translated 400", async () => {
        const product = await createProductFixture();

        const result = await callUpdate(product._id.toString(), { conversionFactor: true });

        expectTranslatedError(result, 400, "error_product_invalid_conversion_factor");
    });

    it("rejects an invalid status with a translated 400", async () => {
        const product = await createProductFixture();

        const result = await callUpdate(product._id.toString(), { status: 5 });

        expectTranslatedError(result, 400, "error_product_invalid_status");
    });

    it("rejects a null status with a translated 400 and keeps the stored status", async () => {
        const product = await createProductFixture();
        const before = await snapshotStoredState(product._id);

        const result = await callUpdate(product._id.toString(), { status: null });

        expectTranslatedError(result, 400, "error_product_invalid_status");
        await expectDocumentUnchanged(product._id, before);
    });

    it("rejects a boolean status with a translated 400 and keeps the stored status", async () => {
        const product = await createProductFixture();
        const before = await snapshotStoredState(product._id);

        const result = await callUpdate(product._id.toString(), { status: true });

        expectTranslatedError(result, 400, "error_product_invalid_status");
        await expectDocumentUnchanged(product._id, before);
    });

    it("rejects a non-string sku with a translated 400", async () => {
        const product = await createProductFixture();

        const result = await callUpdate(product._id.toString(), { sku: 123 });

        expectTranslatedError(result, 400, "error_product_invalid_sku");
    });

    it("rejects a non-string description with a translated 400", async () => {
        const product = await createProductFixture();

        const result = await callUpdate(product._id.toString(), { description: 42 });

        expectTranslatedError(result, 400, "error_product_invalid_field");
    });

    it.each([
        [0, false, true],
        [1, true, false],
        [2, true, true]
    ])("derives visibility flags from productType %i", async (type, expectedSellable, expectedPurchasable) => {
        const product = await createProductFixture();

        const result = await callUpdate(product._id.toString(), { productType: type });

        expect(result.next).not.toHaveBeenCalled();
        expect(result.res.status).toHaveBeenCalledWith(200);

        const stored = await Product.findById(product._id).lean();
        expect(stored.productType).toBe(type);
        expect(stored.isSellable).toBe(expectedSellable);
        expect(stored.isPurchasable).toBe(expectedPurchasable);
    });

    it("allows productType 3 without components so combos can be configured later", async () => {
        const product = await createProductFixture();

        const result = await callUpdate(product._id.toString(), { productType: 3 });

        expect(result.next).not.toHaveBeenCalled();
        expect(result.res.status).toHaveBeenCalledWith(200);

        const stored = await Product.findById(product._id).lean();
        expect(stored.productType).toBe(3);
        expect(stored.isSellable).toBe(true);
        expect(stored.isPurchasable).toBe(false);
    });

    it("ignores client-sent visibility flags when productType is omitted", async () => {
        const product = await createProductFixture();

        const result = await callUpdate(product._id.toString(), {
            name: "Renamed Product",
            isSellable: false,
            isPurchasable: true
        });

        expect(result.next).not.toHaveBeenCalled();
        expect(result.res.status).toHaveBeenCalledWith(200);

        const stored = await Product.findById(product._id).lean();
        expect(stored.name).toBe("Renamed Product");
        expect(stored.isSellable).toBe(true);
        expect(stored.isPurchasable).toBe(false);
    });

    it("rejects a body that only contains visibility flags", async () => {
        const product = await createProductFixture();

        const result = await callUpdate(product._id.toString(), { isSellable: false });

        expectTranslatedError(result, 400, "error_product_no_fields_update");
    });

    it("still rejects stock updates with a translated 400", async () => {
        const product = await createProductFixture();

        const result = await callUpdate(product._id.toString(), { stock: 10 });

        expectTranslatedError(result, 400, "error_product_stock_requires_adjustment");
    });

    it("returns 404 for a well-formed id that does not exist", async () => {
        const result = await callUpdate(new mongoose.Types.ObjectId().toString(), { name: "Ghost" });

        expectTranslatedError(result, 404, "error_product_not_found");
    });

    it("returns 400 for a malformed product id", async () => {
        const result = await callUpdate("malformed-id", { name: "Ghost" });

        expectTranslatedError(result, 400, "error_product_invalid_id");
    });

    it("returns 409 when the new sku duplicates another product", async () => {
        await createProductFixture({ name: "First", sku: "SKU-001" });
        const second = await createProductFixture({ name: "Second", sku: "SKU-002" });

        const result = await callUpdate(second._id.toString(), { sku: "SKU-001" });

        expectTranslatedError(result, 409, "error_product_duplicate_sku");
    });

    it("applies a valid partial edit and returns the populated category", async () => {
        const product = await createProductFixture();
        const category = await ProductCategory.create({ name: "Beverages" });

        const result = await callUpdate(product._id.toString(), {
            name: "  Updated Name  ",
            price: 25.5,
            category: category._id.toString(),
            imageUrl: null
        });

        expect(result.next).not.toHaveBeenCalled();
        expect(result.res.status).toHaveBeenCalledWith(200);
        expect(result.payload.success).toBe(true);
        expect(result.payload.data.name).toBe("Updated Name");
        expect(result.payload.data.price.toString()).toBe("25.5");
        expect(result.payload.data.imageUrl).toBe("");
        expect(result.payload.data.category).not.toBeNull();
        expect(result.payload.data.category.name).toBe("Beverages");
    });

    it("accepts a valid unit id and clears the category with an empty string", async () => {
        const product = await createProductFixture();
        const unit = await Unit.create({ name: "Kilogram", symbol: "kg" });

        const result = await callUpdate(product._id.toString(), {
            unit: unit._id.toString(),
            category: ""
        });

        expect(result.next).not.toHaveBeenCalled();
        expect(result.res.status).toHaveBeenCalledWith(200);
        expect(result.payload.data.unit).not.toBeNull();
        expect(result.payload.data.unit.name).toBe("Kilogram");
        expect(result.payload.data.category).toBeNull();
    });

    describe("derived stock configuration", () => {
        const newUnitId = () => new mongoose.Types.ObjectId().toString();
        const createStockTarget = (overrides = {}) => createProductFixture({
            name: "Stock Target",
            productType: 2,
            ...overrides
        });
        const storedStockConfig = async (productId) => {
            const stored = await Product.findById(productId).lean();
            return {
                stockProduct: stored.stockProduct ? stored.stockProduct.toString() : null,
                stockConversionFactor: stored.stockConversionFactor
            };
        };
        const baseCreateBody = (overrides = {}) => ({
            name: "Presentation",
            price: 10,
            unit: newUnitId(),
            productType: 1,
            ...overrides
        });

        describe("createProduct", () => {
            it("persists a valid link and a numeric-string factor", async () => {
                const target = await createStockTarget();

                const result = await callCreate(baseCreateBody({
                    stockProduct: target._id.toString(),
                    stockConversionFactor: "2"
                }));

                expect(result.next).not.toHaveBeenCalled();
                expect(result.res.status).toHaveBeenCalledWith(201);
                expect(await storedStockConfig(result.payload.data._id)).toEqual({
                    stockProduct: target._id.toString(),
                    stockConversionFactor: 2
                });
            });

            it("accepts a type 0 input as the stock target", async () => {
                const target = await createStockTarget({ name: "Rice", productType: 0 });

                const result = await callCreate(baseCreateBody({
                    stockProduct: target._id.toString()
                }));

                expect(result.res.status).toHaveBeenCalledWith(201);
                expect(await storedStockConfig(result.payload.data._id)).toEqual({
                    stockProduct: target._id.toString(),
                    stockConversionFactor: 1
                });
            });

            it("defaults the factor to 1 when the link is sent alone", async () => {
                const target = await createStockTarget();

                const result = await callCreate(baseCreateBody({
                    stockProduct: target._id.toString()
                }));

                expect(result.res.status).toHaveBeenCalledWith(201);
                expect(await storedStockConfig(result.payload.data._id)).toEqual({
                    stockProduct: target._id.toString(),
                    stockConversionFactor: 1
                });
            });

            it("leaves defaults untouched for an ordinary product without the fields", async () => {
                const result = await callCreate(baseCreateBody({ name: "Plain Product" }));

                expect(result.res.status).toHaveBeenCalledWith(201);
                expect(await storedStockConfig(result.payload.data._id)).toEqual({
                    stockProduct: null,
                    stockConversionFactor: 1
                });
            });

            it.each([null, ""])("leaves defaults when the link is cleared with %p on create", async (clearValue) => {
                const result = await callCreate(baseCreateBody({
                    stockProduct: clearValue,
                    stockConversionFactor: 7
                }));

                expect(result.res.status).toHaveBeenCalledWith(201);
                expect(await storedStockConfig(result.payload.data._id)).toEqual({
                    stockProduct: null,
                    stockConversionFactor: 1
                });
            });

            it("rejects a malformed stock product id", async () => {
                const result = await callCreate(baseCreateBody({ stockProduct: "not-an-object-id" }));

                expectTranslatedError(result, 400, "error_product_invalid_stock_reference");
                expect(await Product.countDocuments({ name: "Presentation" })).toBe(0);
            });

            it("rejects an unknown stock product", async () => {
                const result = await callCreate(baseCreateBody({
                    stockProduct: new mongoose.Types.ObjectId().toString()
                }));

                expectTranslatedError(result, 400, "error_product_invalid_stock_reference");
                expect(await Product.countDocuments({ name: "Presentation" })).toBe(0);
            });

            it.each([1, 3])("rejects a non-stock-tracked target (type %i)", async (productType) => {
                const target = await createStockTarget({ name: `Non Stock ${productType}`, productType });

                const result = await callCreate(baseCreateBody({
                    stockProduct: target._id.toString()
                }));

                expectTranslatedError(result, 400, "error_product_invalid_stock_reference");
            });

            it.each([0, -1, null, "", true, "abc", NaN, Infinity])(
                "rejects an invalid stock factor %p",
                async (factor) => {
                    const target = await createStockTarget();

                    const result = await callCreate(baseCreateBody({
                        stockProduct: target._id.toString(),
                        stockConversionFactor: factor
                    }));

                    expectTranslatedError(result, 400, "error_product_invalid_stock_factor");
                    expect(await Product.countDocuments({ name: "Presentation" })).toBe(0);
                }
            );

            it("rejects a derived link on a combo product", async () => {
                const target = await createStockTarget();

                const result = await callCreate(baseCreateBody({
                    productType: 3,
                    stockProduct: target._id.toString(),
                    stockConversionFactor: 2
                }));

                expectTranslatedError(result, 400, "error_product_stock_link_requires_sellable_type");
                expect(await Product.countDocuments({ name: "Presentation" })).toBe(0);
            });

            it("rejects a factor without a stock product on create", async () => {
                const result = await callCreate(baseCreateBody({ stockConversionFactor: 2 }));

                expectTranslatedError(result, 400, "error_product_stock_factor_requires_link");
                expect(await Product.countDocuments({ name: "Presentation" })).toBe(0);
            });
        });

        describe("updateProduct", () => {
            it("adds a link and factor to an existing product", async () => {
                const target = await createStockTarget();
                const product = await createProductFixture({ name: "Presentation", productType: 1 });

                const result = await callUpdate(product._id.toString(), {
                    stockProduct: target._id.toString(),
                    stockConversionFactor: 3
                });

                expect(result.next).not.toHaveBeenCalled();
                expect(result.res.status).toHaveBeenCalledWith(200);
                expect(await storedStockConfig(product._id)).toEqual({
                    stockProduct: target._id.toString(),
                    stockConversionFactor: 3
                });
            });

            it("defaults the factor to 1 when only the link is sent", async () => {
                const target = await createStockTarget();
                const product = await createProductFixture({ name: "Presentation", productType: 1 });

                const result = await callUpdate(product._id.toString(), {
                    stockProduct: target._id.toString()
                });

                expect(result.res.status).toHaveBeenCalledWith(200);
                expect(await storedStockConfig(product._id)).toEqual({
                    stockProduct: target._id.toString(),
                    stockConversionFactor: 1
                });
            });

            it("allows a factor-only change on an already configured product", async () => {
                const target = await createStockTarget();
                const product = await createProductFixture({
                    name: "Presentation",
                    productType: 1,
                    stockProduct: target._id,
                    stockConversionFactor: 2
                });

                const result = await callUpdate(product._id.toString(), { stockConversionFactor: 4 });

                expect(result.res.status).toHaveBeenCalledWith(200);
                expect(await storedStockConfig(product._id)).toEqual({
                    stockProduct: target._id.toString(),
                    stockConversionFactor: 4
                });
            });

            it.each([null, ""])("clears the configuration and ignores a factor sent with %p", async (clearValue) => {
                const target = await createStockTarget();
                const product = await createProductFixture({
                    name: "Presentation",
                    productType: 1,
                    stockProduct: target._id,
                    stockConversionFactor: 4
                });

                const result = await callUpdate(product._id.toString(), {
                    stockProduct: clearValue,
                    stockConversionFactor: 9
                });

                expect(result.res.status).toHaveBeenCalledWith(200);
                expect(await storedStockConfig(product._id)).toEqual({
                    stockProduct: null,
                    stockConversionFactor: 1
                });
            });

            it("rejects a self-reference", async () => {
                const product = await createProductFixture({ name: "Presentation", productType: 1 });

                const result = await callUpdate(product._id.toString(), {
                    stockProduct: product._id.toString()
                });

                expectTranslatedError(result, 400, "error_product_invalid_stock_reference");
                expect(await storedStockConfig(product._id)).toEqual({
                    stockProduct: null,
                    stockConversionFactor: 1
                });
            });

            it("rejects an unknown target without modifying the product", async () => {
                const product = await createProductFixture({ name: "Presentation", productType: 1 });

                const result = await callUpdate(product._id.toString(), {
                    stockProduct: new mongoose.Types.ObjectId().toString()
                });

                expectTranslatedError(result, 400, "error_product_invalid_stock_reference");
                expect(await storedStockConfig(product._id)).toEqual({
                    stockProduct: null,
                    stockConversionFactor: 1
                });
            });

            it("rejects changing a configured product to type 3", async () => {
                const target = await createStockTarget();
                const product = await createProductFixture({
                    name: "Presentation",
                    productType: 1,
                    stockProduct: target._id,
                    stockConversionFactor: 2
                });

                const result = await callUpdate(product._id.toString(), { productType: 3 });

                expectTranslatedError(result, 400, "error_product_stock_link_requires_sellable_type");
                const stored = await Product.findById(product._id).lean();
                expect(stored.productType).toBe(1);
                expect(await storedStockConfig(product._id)).toEqual({
                    stockProduct: target._id.toString(),
                    stockConversionFactor: 2
                });
            });

            it("rejects a factor on an unconfigured product", async () => {
                const product = await createProductFixture({ name: "Presentation", productType: 1 });

                const result = await callUpdate(product._id.toString(), { stockConversionFactor: 2 });

                expectTranslatedError(result, 400, "error_product_stock_factor_requires_link");
            });

            it("keeps an existing configuration when other fields are updated", async () => {
                const target = await createStockTarget();
                const product = await createProductFixture({
                    name: "Presentation",
                    productType: 1,
                    stockProduct: target._id,
                    stockConversionFactor: 2
                });

                const result = await callUpdate(product._id.toString(), { name: "Renamed" });

                expect(result.res.status).toHaveBeenCalledWith(200);
                expect(await storedStockConfig(product._id)).toEqual({
                    stockProduct: target._id.toString(),
                    stockConversionFactor: 2
                });
            });

            it("keeps defaults when an ordinary product is updated without stock fields", async () => {
                const product = await createProductFixture({ name: "Presentation", productType: 1 });

                const result = await callUpdate(product._id.toString(), { name: "Renamed" });

                expect(result.res.status).toHaveBeenCalledWith(200);
                expect(await storedStockConfig(product._id)).toEqual({
                    stockProduct: null,
                    stockConversionFactor: 1
                });
            });
        });
    });

    describe("tenant routing", () => {
        const tenantProduct = () => getTenantModel(TENANT_DB, "Product");

        const call = async (handler, req) => {
            let resolveResponse;
            const responseReceived = new Promise((resolve) => {
                resolveResponse = resolve;
            });

            const res = createResMock(resolveResponse);
            const next = jest.fn(() => resolveResponse(undefined));

            await handler(req, res, next);
            await responseReceived;

            return { res, next, payload: res.json.mock.calls[0]?.[0] };
        };

        const buildCreateRequest = (tenant) => ({
            body: {
                name: "Tenant Product",
                price: 10,
                unit: new mongoose.Types.ObjectId().toString()
            },
            headers: {},
            ...(tenant ? { tenant } : {})
        });

        beforeEach(async () => {
            await tenantProduct().deleteMany({});
        });

        it("creates the product in the tenant database, never in the central one", async () => {
            const result = await call(createProduct, buildCreateRequest(buildTenant(TENANT_DB)));

            expect(result.next).not.toHaveBeenCalled();
            expect(result.res.status).toHaveBeenCalledWith(201);

            expect(await tenantProduct().countDocuments()).toBe(1);
            expect(await Product.countDocuments()).toBe(0);
        });

        it("resolves the stock target through the tenant model resolver", async () => {
            const tenantStock = await tenantProduct().create({
                name: "Tenant Stock",
                price: 1,
                unit: new mongoose.Types.ObjectId(),
                productType: 2
            });
            const centralStock = await createProductFixture({ name: "Central Stock", productType: 2 });

            const created = await call(createProduct, {
                ...buildCreateRequest(buildTenant(TENANT_DB)),
                body: {
                    ...buildCreateRequest(buildTenant(TENANT_DB)).body,
                    productType: 1,
                    stockProduct: String(tenantStock._id)
                }
            });

            expect(created.res.status).toHaveBeenCalledWith(201);
            const stored = await tenantProduct().findById(created.payload.data._id).lean();
            expect(String(stored.stockProduct)).toBe(String(tenantStock._id));

            const rejected = await call(createProduct, {
                ...buildCreateRequest(buildTenant(TENANT_DB)),
                body: {
                    ...buildCreateRequest(buildTenant(TENANT_DB)).body,
                    productType: 1,
                    stockProduct: String(centralStock._id)
                }
            });

            expectTranslatedError(rejected, 400, "error_product_invalid_stock_reference");
        });

        it("reads a product from its tenant and returns 404 from another database", async () => {
            const created = await call(createProduct, buildCreateRequest(buildTenant(TENANT_DB)));
            const productId = created.payload.data._id.toString();

            const tenantRead = await call(getProductById, {
                params: { productId },
                headers: {},
                tenant: buildTenant(TENANT_DB)
            });

            expect(tenantRead.res.status).toHaveBeenCalledWith(200);
            expect(tenantRead.payload.data._id.toString()).toBe(productId);

            const centralRead = await call(getProductById, {
                params: { productId },
                headers: {},
                tenant: buildTenant(DB_NAME)
            });

            expectTranslatedError(centralRead, 404, "error_product_not_found");
        });

        it("lists only the products of the caller's tenant", async () => {
            await call(createProduct, buildCreateRequest(buildTenant(TENANT_DB)));

            const tenantList = await call(getProducts, {
                params: {},
                query: {},
                headers: {},
                tenant: buildTenant(TENANT_DB)
            });

            expect(tenantList.res.status).toHaveBeenCalledWith(200);
            expect(tenantList.payload.data.totalDocs).toBe(1);

            const centralList = await call(getProducts, {
                params: {},
                query: {},
                headers: {},
                tenant: buildTenant(DB_NAME)
            });

            expect(centralList.res.status).toHaveBeenCalledWith(200);
            expect(centralList.payload.data.totalDocs).toBe(0);
        });

        it("refuses to run without a tenant context instead of writing to the central database", async () => {
            const result = await call(createProduct, buildCreateRequest(null));

            expect(result.next).toHaveBeenCalledTimes(1);
            expect(result.next.mock.calls[0][0].statusCode).toBe(500);
            expect(result.res.json).not.toHaveBeenCalled();
            expect(await Product.countDocuments()).toBe(0);
        });
    });
});
