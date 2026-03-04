// @ts-nocheck
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CosmosRecord = void 0;
const loadCosmosSdk = () => {
    try {
        return require("@azure/cosmos");
    }
    catch (error) {
        throw new Error('Cosmos SDK "@azure/cosmos" is required for Cosmos DB support.');
    }
};
const crypto_1 = require("crypto");
const azure_config_1 = require("../services/azure-config");
const defaultDateFields = ['createdAt', 'expireAt', 'lastSyncedAt', 'finishedAt', 'updatedAt'];
const toDate = (value) => {
    if (value instanceof Date) {
        return value;
    }
    if (value && typeof value === 'object' && 'toDate' in value) {
        const converted = Reflect.get(value, 'toDate');
        if (typeof converted === 'function') {
            const date = converted.call(value);
            return Number.isNaN(date.valueOf()) ? undefined : date;
        }
    }
    if (typeof value === 'string' || typeof value === 'number') {
        const date = new Date(value);
        return Number.isNaN(date.valueOf()) ? undefined : date;
    }
    return undefined;
};
const hydrateDates = (target, fields) => {
    for (const field of fields) {
        const maybeDate = toDate(target[field]);
        if (maybeDate) {
            target[field] = maybeDate;
        }
    }
};
const serializeValue = (value) => {
    if (value === undefined) {
        return undefined;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (Array.isArray(value)) {
        const mapped = value
            .map(serializeValue)
            .filter((v) => v !== undefined);
        return mapped;
    }
    if (value && typeof value === 'object') {
        if (value instanceof Buffer) {
            return value.toString('base64');
        }
        const entries = Object.entries(value)
            .map(([k, v]) => [k, serializeValue(v)])
            .filter(([, v]) => v !== undefined);
        return Object.fromEntries(entries);
    }
    return value;
};
const buildParameters = (params) => {
    if (!params) {
        return [];
    }
    return Object.entries(params).map(([name, value]) => ({
        name: name.startsWith('@') ? name : `@${name}`,
        value: value,
    }));
};
let client;
const ensureContainer = (containerName) => {
    const config = (0, azure_config_1.getCosmosConfig)();
    if (!client) {
        if (!config.endpoint) {
            throw new Error('Cosmos endpoint is not configured.');
        }
        const options = { endpoint: config.endpoint };
        options.aadCredentials = config.credential;
        const cosmos = loadCosmosSdk();
        client = new cosmos.CosmosClient(options);
    }
    return client.database(config.databaseId).container(containerName);
};
class CosmosRecord {
    static { this.partitionKey = 'id'; }
    static { this.dateFields = defaultDateFields; }
    static get CONTAINER() {
        return ensureContainer(this.containerName);
    }
    static get OPS() {
        return {
            increment: (delta) => delta,
        };
    }
    static from(input) {
        const instance = new this();
        const data = { ...input };
        data._id = data._id ?? data.id ?? (0, crypto_1.randomUUID)();
        hydrateDates(data, this.dateFields);
        Object.assign(instance, data);
        return instance;
    }
    static async fromId(id, partitionKey) {
        const pk = partitionKey ?? this.resolvePartitionKey({ _id: id });
        const item = this.CONTAINER.item(id, pk);
        const response = await item.read();
        if (!response.resource) {
            return undefined;
        }
        return this.from(response.resource);
    }
    static async fromQuery(query, params) {
        const spec = typeof query === 'string' ? { query, parameters: buildParameters(params) } : query;
        const { resources } = await this.CONTAINER.items.query(spec).fetchAll();
        return resources.map((item) => this.from(item));
    }
    static async queryRaw(query, params) {
        const spec = typeof query === 'string' ? { query, parameters: buildParameters(params) } : query;
        const { resources } = await this.CONTAINER.items.query(spec).fetchAll();
        return resources;
    }
    static async save(data, docId) {
        const { prepared } = this.prepareForStorage(data, docId);
        const { resource } = await this.CONTAINER.items.upsert(prepared);
        return this.from(resource ?? prepared);
    }
    static async upsert(data, docId) {
        return this.save(data, docId);
    }
    static async delete(id, partitionKey) {
        const pk = partitionKey ?? this.resolvePartitionKey({ _id: id });
        await this.CONTAINER.item(id, pk).delete();
    }
    static prepareForStorage(data, docId) {
        const raw = typeof data.degradeForStore === 'function' ?
            data.degradeForStore() :
            { ...data };
        const id = docId ?? raw._id ?? raw.id ?? (0, crypto_1.randomUUID)();
        const enriched = {
            ...raw,
            _id: raw._id ?? id,
            id,
        };
        const partitionKey = this.resolvePartitionKey(enriched);
        hydrateDates(enriched, this.dateFields);
        const prepared = serializeValue(enriched);
        return { prepared, partitionKey };
    }
    static resolvePartitionKey(data) {
        const pkField = this.partitionKey || 'id';
        const pk = data[pkField] ?? (pkField === 'id' ? data._id : undefined);
        if (pk === undefined || pk === null) {
            throw new Error(`Missing partition key "${pkField}" for ${this.name}`);
        }
        return pk;
    }
    degradeForStore() {
        return serializeValue({ ...this });
    }
}
exports.CosmosRecord = CosmosRecord;
