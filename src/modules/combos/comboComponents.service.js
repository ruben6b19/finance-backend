import mongoose from "mongoose";

// Un combo es un producto vendible que no tiene stock propio: su
// disponibilidad es la de los componentes que lo integran.
export const COMBO_PRODUCT_TYPE = 3;

const toNumber = (value) => {
    if (value === undefined || value === null) return 0;
    return Number.parseFloat(value.toString());
};

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Vigencia y días de gracia: 0 es válido y significa "nunca vence". null, ""
 * y cualquier valor no numérico son inválidos; no deben convertirse en 0 por
 * coerción (Number(null) === 0). Devuelve el entero o NaN.
 */
export const parseNonNegativeInteger = (value) => {
    if (typeof value === "number") {
        return Number.isInteger(value) && value >= 0 ? value : NaN;
    }

    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed >= 0 ? parsed : NaN;
    }

    return NaN;
};

/**
 * Valida y normaliza los componentes de un combo, y calcula su precio de
 * referencia a partir del catálogo del tenant. No escribe nada.
 * Devuelve { error: "<i18n key>" } o { components, referencePrice }.
 *
 * Compartido por el alta de combos y por el alta/edición de productos de tipo
 * 3, para que ambos caminos acepten exactamente la misma forma de componente.
 */
export const normalizeComponents = async (rawComponents, getModel) => {
    if (!Array.isArray(rawComponents) || rawComponents.length === 0) {
        return { error: "error_combo_components_required" };
    }

    const normalized = [];
    const seenProducts = new Set();

    for (const raw of rawComponents) {
        if (!raw || !raw.product || !mongoose.Types.ObjectId.isValid(raw.product)) {
            return { error: "error_combo_component_product_not_found" };
        }

        const productKey = String(raw.product);
        if (seenProducts.has(productKey)) {
            return { error: "error_combo_duplicate_component" };
        }
        seenProducts.add(productKey);

        const quantity = raw.quantity !== undefined ? Number(raw.quantity) : 1;
        if (!Number.isFinite(quantity) || quantity <= 0) {
            return { error: "error_combo_invalid_quantity" };
        }

        const conversionFactor = raw.conversionFactor !== undefined ? Number(raw.conversionFactor) : 1;
        if (!Number.isFinite(conversionFactor) || conversionFactor <= 0) {
            return { error: "error_combo_invalid_quantity" };
        }

        if (raw.stockProduct && !mongoose.Types.ObjectId.isValid(raw.stockProduct)) {
            return { error: "error_combo_component_product_not_found" };
        }

        normalized.push({
            product: raw.product,
            quantity,
            label: raw.label ? String(raw.label).trim() : '',
            stockProduct: raw.stockProduct || null,
            conversionFactor
        });
    }

    const productIds = [...seenProducts];
    const Product = getModel("Product");
    const products = await Product.find({ _id: { $in: productIds } });
    const productMap = new Map(products.map((product) => [String(product._id), product]));

    let referencePrice = 0;
    for (const component of normalized) {
        const product = productMap.get(String(component.product));
        if (!product) {
            return { error: "error_combo_component_product_not_found" };
        }

        // Un combo dentro de un combo vuelve recursivos el precio y los saldos.
        if (product.productType === COMBO_PRODUCT_TYPE) {
            return { error: "error_combo_component_is_combo" };
        }

        // El voucher muestra el componente al cliente: sin etiqueta explícita
        // se usa el nombre del producto, igual que en los combos creados a mano.
        if (!component.label) {
            component.label = product.name;
        }

        referencePrice += component.quantity * toNumber(product.price);
    }

    return { components: normalized, referencePrice: round2(referencePrice) };
};
