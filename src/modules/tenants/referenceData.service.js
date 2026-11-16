import { DB_NAME } from "../../constants.js";

/**
 * Reference data every store needs before it can operate: units, transaction
 * categories and product categories. It lives in the central database and is
 * copied into each new store database instead of being retyped by the operator.
 */
export const REFERENCE_MODELS = ["Unit", "TransactionCategory", "ProductCategory"];

// Never copied between databases:
// - _id and timestamps belong to the source document, and reusing the _id would
//   tie two databases to the same identity;
// - createdBy points to a user of the source database, so the id would be a
//   dangling reference in the target.
const DROPPED_FIELDS = new Set(["_id", "createdAt", "updatedAt", "__v", "createdBy"]);

// `name` is unique in all three models, which makes it the natural key for an
// idempotent upsert.
const NATURAL_KEY = "name";

const toInsertable = (doc) =>
    Object.fromEntries(
        Object.entries(doc).filter(
            ([field]) => field !== NATURAL_KEY && !DROPPED_FIELDS.has(field)
        )
    );

const requireModelResolver = (getModel) => {
    if (typeof getModel !== "function") {
        throw new Error("copyReferenceData requires a model resolver.");
    }
    return getModel;
};

const copyCollection = async ({ modelName, sourceDbName, targetDbName, dryRun, getModel }) => {
    const Source = getModel(sourceDbName, modelName);
    const Target = getModel(targetDbName, modelName);

    const documents = await Source.find().lean();
    let created = 0;
    let existing = 0;

    for (const document of documents) {
        const key = document[NATURAL_KEY];
        if (typeof key !== "string" || key.trim() === "") {
            throw new Error(`${modelName} has a document without a usable ${NATURAL_KEY}.`);
        }

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
        collections.push(
            await copyCollection({ modelName, sourceDbName, targetDbName, dryRun, getModel })
        );
    }

    const total = collections.reduce(
        (accumulator, entry) => ({
            read: accumulator.read + entry.read,
            created: accumulator.created + entry.created,
            existing: accumulator.existing + entry.existing
        }),
        { read: 0, created: 0, existing: 0 }
    );

    return { sourceDbName, targetDbName, dryRun, collections, total };
};
