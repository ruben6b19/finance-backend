import { DB_NAME } from "../../constants.js";

/**
 * Reference data every store needs before it can operate: units, transaction
 * categories and product categories. It lives in the central database and is
 * copied into each new store database instead of being retyped by the operator.
 *
 * It can also be exported to a JSON file, so the catalogue survives even if the
 * source database is wiped or replaced.
 */
export const REFERENCE_MODELS = ["Unit", "TransactionCategory", "ProductCategory"];

// Format version of the exported JSON file. Bump it only on a breaking change:
// an importer refuses a version it does not understand instead of guessing.
export const REFERENCE_PACK_VERSION = 1;

// Never copied between databases:
// - _id and timestamps belong to the source document, and reusing the _id would
//   tie two databases to the same identity;
// - createdBy points to a user of the source database, so the id would be a
//   dangling reference in the target.
const DROPPED_FIELDS = new Set(["_id", "createdAt", "updatedAt", "__v", "createdBy"]);

// `name` is unique in all three models, which makes it the natural key for an
// idempotent upsert.
const NATURAL_KEY = "name";

const toInsertable = (document) =>
    Object.fromEntries(
        Object.entries(document).filter(
            ([field]) => field !== NATURAL_KEY && !DROPPED_FIELDS.has(field)
        )
    );

const toExportable = (document) =>
    Object.fromEntries(
        Object.entries(document).filter(([field]) => !DROPPED_FIELDS.has(field))
    );

const requireModelResolver = (getModel) => {
    if (typeof getModel !== "function") {
        throw new Error("The reference data flow requires a model resolver.");
    }
    return getModel;
};

const readDocuments = async ({ modelName, dbName, getModel }) => {
    const documents = await getModel(dbName, modelName).find().lean();

    return documents.map((document) => {
        const key = document[NATURAL_KEY];
        if (typeof key !== "string" || key.trim() === "") {
            throw new Error(`${modelName} has a document without a usable ${NATURAL_KEY}.`);
        }
        return toExportable(document);
    });
};

const writeDocuments = async ({ modelName, documents, targetDbName, dryRun, getModel }) => {
    const Target = getModel(targetDbName, modelName);
    let created = 0;
    let existing = 0;

    for (const document of documents) {
        const key = document[NATURAL_KEY];

        if (dryRun) {
            const found = await Target.exists({ [NATURAL_KEY]: key });
            if (found) existing += 1;
            else created += 1;
            continue;
        }

        // $setOnInsert keeps the copy idempotent and never overwrites a document
        // the operator already edited in the store database.
        const result = await Target.updateOne(
            { [NATURAL_KEY]: key },
            { $setOnInsert: toInsertable(document) },
            { upsert: true }
        );

        if (result.upsertedCount > 0) created += 1;
        else existing += 1;
    }

    // A store database initialized by db:create already has its indexes; this
    // keeps the copy self-sufficient when it runs against a bare database.
    if (!dryRun && created > 0) {
        await Target.createIndexes();
    }

    return { model: modelName, read: documents.length, created, existing };
};

const summarize = (collections) => {
    const total = collections.reduce(
        (accumulator, entry) => ({
            read: accumulator.read + entry.read,
            created: accumulator.created + entry.created,
            existing: accumulator.existing + entry.existing
        }),
        { read: 0, created: 0, existing: 0 }
    );

    return total;
};

const validatePack = (pack) => {
    if (!pack || typeof pack !== "object" || typeof pack.collections !== "object") {
        throw new Error("The reference data file is not a valid pack.");
    }

    const version = Number(pack.version ?? REFERENCE_PACK_VERSION);
    if (!Number.isInteger(version) || version > REFERENCE_PACK_VERSION) {
        throw new Error(
            `Unsupported reference data pack version: ${pack.version}. ` +
            `This build understands up to version ${REFERENCE_PACK_VERSION}.`
        );
    }

    for (const modelName of REFERENCE_MODELS) {
        if (!Array.isArray(pack.collections[modelName])) {
            throw new Error(`The reference data pack is missing the "${modelName}" collection.`);
        }
    }
};

/**
 * Reads the reference data of `sourceDbName` into a portable pack.
 *
 * The pack is plain JSON: it keeps every business field and drops the fields
 * that only make sense inside the source database.
 */
export const exportReferencePack = async ({ sourceDbName = DB_NAME, getModel } = {}) => {
    requireModelResolver(getModel);

    const collections = {};
    for (const modelName of REFERENCE_MODELS) {
        collections[modelName] = await readDocuments({ modelName, dbName: sourceDbName, getModel });
    }

    return {
        version: REFERENCE_PACK_VERSION,
        exportedAt: new Date().toISOString(),
        sourceDatabase: sourceDbName,
        collections
    };
};

/**
 * Writes a pack into `targetDbName`. Same idempotency rules as copyReferenceData:
 * a document already present (matched by name) is left untouched.
 */
export const importReferencePack = async ({ pack, targetDbName, dryRun = false, getModel } = {}) => {
    requireModelResolver(getModel);

    if (!targetDbName || typeof targetDbName !== "string") {
        throw new Error("A target database name is required.");
    }
    validatePack(pack);

    const collections = [];
    for (const modelName of REFERENCE_MODELS) {
        collections.push(
            await writeDocuments({
                modelName,
                documents: pack.collections[modelName],
                targetDbName,
                dryRun,
                getModel
            })
        );
    }

    return {
        sourceDbName: pack.sourceDatabase ?? null,
        targetDbName,
        dryRun,
        collections,
        total: summarize(collections)
    };
};

/**
 * Copies the reference data of `sourceDbName` into `targetDbName`.
 *
 * Idempotent: a document already present in the target (matched by name) is
 * left untouched, so re-running after the operator added their own units or
 * categories only fills the gaps.
 */
export const copyReferenceData = async ({
    sourceDbName = DB_NAME,
    targetDbName,
    dryRun = false,
    getModel
} = {}) => {
    requireModelResolver(getModel);

    if (!targetDbName || typeof targetDbName !== "string") {
        throw new Error("A target database name is required.");
    }
    if (sourceDbName === targetDbName) {
        throw new Error("The source and target databases are the same.");
    }

    const collections = [];
    for (const modelName of REFERENCE_MODELS) {
        const documents = await readDocuments({ modelName, dbName: sourceDbName, getModel });
        collections.push(
            await writeDocuments({ modelName, documents, targetDbName, dryRun, getModel })
        );
    }

    return { sourceDbName, targetDbName, dryRun, collections, total: summarize(collections) };
};
