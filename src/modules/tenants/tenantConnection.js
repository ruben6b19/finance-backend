import mongoose from "mongoose";
import { DB_NAME } from "../../constants.js";
import { TENANT_MODEL_SCHEMAS } from "./modelRegistry.js";

const tenantConnections = new Map();

const assertDbName = (dbName) => {
    if (typeof dbName !== "string" || dbName.trim() === "") {
        throw new Error("A tenant database name is required.");
    }
    if (/[/\\. "$*<>:|?]/.test(dbName)) {
        throw new Error(`Invalid tenant database name: "${dbName}".`);
    }
};

const compileModels = (connection) => {
    for (const [name, schema] of TENANT_MODEL_SCHEMAS) {
        if (!connection.models[name]) {
            connection.model(name, schema);
        }
    }
};

/**
 * Returns the connection for a tenant database. The central database reuses
 * the default mongoose connection; every other tenant gets a cached connection
 * that shares the same MongoClient and has all tenant models compiled.
 */
export const getTenantConnection = (dbName) => {
    assertDbName(dbName);

    if (dbName === DB_NAME) return mongoose.connection;

    let connection = tenantConnections.get(dbName);
    if (!connection) {
        connection = mongoose.connection.useDb(dbName, { useCache: true });
        compileModels(connection);
        tenantConnections.set(dbName, connection);
    }
    return connection;
};

/**
 * Returns the model bound to the tenant database. Throws when the model is not
 * part of the tenant registry.
 */
export const getTenantModel = (dbName, modelName) => {
    const connection = getTenantConnection(dbName);
    const model = connection.models[modelName];
    if (!model) {
        throw new Error(`Unknown tenant model: "${modelName}".`);
    }
    return model;
};

export const getCachedTenantDbNames = () => [...tenantConnections.keys()];

/**
 * Clears the connection cache. The underlying MongoClient is owned by the
 * default connection, so it is closed by mongoose.disconnect().
 */
export const resetTenantConnections = () => {
    tenantConnections.clear();
};
