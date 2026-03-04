import { randomUUID } from 'crypto';
import { getCosmosConfig } from '../services/azure-config';

type CosmosSdk = any;

type IncrementOp = {
    __op: 'increment';
    value: number;
};

const loadCosmosSdk = (): CosmosSdk => {
    try {
        return require('@azure/cosmos') as CosmosSdk;
    } catch {
        throw new Error('Cosmos SDK "@azure/cosmos" is required for Cosmos DB support.');
    }
};

const defaultDateFields = [
    'createdAt',
    'updatedAt',
    'finishedAt',
    'expireAt',
    'lastSyncedAt',
];

const DEFAULT_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_RATE_LIMIT_TTL_SECONDS = 24 * 60 * 60;
const rateLimitContainerName = process.env.RATE_LIMIT_CONTAINER || 'rateLimits';

const COLLECTION_CONFIG: Record<string, { partitionKey: string; ttlSeconds?: number; }> = {
    apiRolls: { partitionKey: 'uid' },
    jinaEmbeddingsTokenAccounts: { partitionKey: 'id' },
    crawled: { partitionKey: 'urlPathDigest', ttlSeconds: DEFAULT_CACHE_TTL_SECONDS },
    pdfs: { partitionKey: 'urlDigest', ttlSeconds: DEFAULT_CACHE_TTL_SECONDS },
    searchResults: { partitionKey: 'queryDigest', ttlSeconds: DEFAULT_CACHE_TTL_SECONDS },
    SERPResults: { partitionKey: 'queryDigest', ttlSeconds: DEFAULT_CACHE_TTL_SECONDS },
    serperSearchResults: { partitionKey: 'queryDigest', ttlSeconds: DEFAULT_CACHE_TTL_SECONDS },
    domainBlockades: { partitionKey: 'domain' },
    adaptiveCrawlTasks: { partitionKey: 'id' },
    imgAlts: { partitionKey: 'urlDigest', ttlSeconds: DEFAULT_CACHE_TTL_SECONDS },
    robots: { partitionKey: 'digest', ttlSeconds: DEFAULT_CACHE_TTL_SECONDS },
    [rateLimitContainerName]: { partitionKey: 'key', ttlSeconds: DEFAULT_RATE_LIMIT_TTL_SECONDS },
};

const isIncrement = (value: unknown): value is IncrementOp => {
    return Boolean(value) && typeof value === 'object' && (value as IncrementOp).__op === 'increment';
};

const toDate = (value: unknown) => {
    if (value instanceof Date) {
        return value;
    }

    if (value && typeof value === 'object' && 'toDate' in value) {
        const converted = Reflect.get(value as Record<string, unknown>, 'toDate');
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

const hydrateDates = (target: Record<string, any>, fields: string[]) => {
    for (const field of fields) {
        const maybeDate = toDate(target[field]);
        if (maybeDate) {
            target[field] = maybeDate;
        }
    }
};

const serializeValue = (value: unknown): any => {
    if (value === undefined) {
        return undefined;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    if (Array.isArray(value)) {
        const mapped = value.map(serializeValue).filter((v) => v !== undefined);
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

const resolveCollectionConfig = (collectionName: string) => {
    return COLLECTION_CONFIG[collectionName] ?? { partitionKey: 'id' };
};

const resolveTtlSeconds = (collectionName: string, data: Record<string, unknown>) => {
    const explicit = typeof data.ttl === 'number' ? data.ttl : undefined;
    const cfg = COLLECTION_CONFIG[collectionName];
    return explicit ?? cfg?.ttlSeconds;
};

const applyDotPath = (target: Record<string, any>, path: string, value: unknown) => {
    const parts = path.split('.');
    let cursor = target;

    for (let i = 0; i < parts.length - 1; i += 1) {
        const key = parts[i];
        if (cursor[key] === undefined || cursor[key] === null || typeof cursor[key] !== 'object') {
            cursor[key] = {};
        }
        cursor = cursor[key];
    }

    const last = parts[parts.length - 1];
    cursor[last] = value;
};

const getDotPath = (target: Record<string, any>, path: string) => {
    const parts = path.split('.');
    let cursor: unknown = target;

    for (const part of parts) {
        if (!cursor || typeof cursor !== 'object') {
            return undefined;
        }

        const record = cursor as Record<string, unknown>;
        if (!(part in record)) {
            return undefined;
        }

        cursor = record[part];
    }

    return cursor;
};

const mergeObjects = (base: Record<string, any>, patch: Record<string, any>) => {
    const result: Record<string, any> = { ...base };

    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) {
            continue;
        }

        if (key.includes('.')) {
            if (isIncrement(value)) {
                const current = getDotPath(result, key);
                const currentNumber = typeof current === 'number' ? current : 0;
                applyDotPath(result, key, currentNumber + value.value);
            } else {
                applyDotPath(result, key, value);
            }
            continue;
        }

        if (isIncrement(value)) {
            const current = typeof result[key] === 'number' ? result[key] : 0;
            result[key] = current + value.value;
            continue;
        }

        if (value && typeof value === 'object' && !Array.isArray(value)) {
            result[key] = mergeObjects(result[key] || {}, value as Record<string, any>);
            continue;
        }

        result[key] = value;
    }

    return result;
};

let cosmosClient: any;

const getContainer = (collectionName: string) => {
    const cfg = getCosmosConfig();

    if (!cosmosClient) {
        if (!cfg.endpoint) {
            throw new Error('Cosmos endpoint is not configured.');
        }

        const options: Record<string, unknown> = { endpoint: cfg.endpoint };
        options.aadCredentials = cfg.credential;

        const cosmos = loadCosmosSdk();
        cosmosClient = new cosmos.CosmosClient(options as any);
    }

    return cosmosClient.database(cfg.databaseId).container(collectionName);
};

const queryById = async (collectionName: string, id: string) => {
    const container = getContainer(collectionName);
    const { resources } = await container.items.query({
        query: 'SELECT * FROM c WHERE c.id = @id OR c._id = @id OFFSET 0 LIMIT 1',
        parameters: [{ name: '@id', value: id }]
    }).fetchAll();

    return resources[0] as Record<string, unknown> | undefined;
};

class FirestoreDocumentSnapshot<T = any> {
    readonly exists: boolean;

    constructor(
        readonly id: string,
        private readonly documentData?: T,
    ) {
        this.exists = Boolean(documentData);
    }

    data() {
        return this.documentData as T;
    }
}

export class FirestoreQuery<T = any> {
    private order?: { field: string; direction: 'asc' | 'desc'; };
    private limitValue?: number;
    private offsetValue?: number;

    constructor(
        private readonly model: typeof FirestoreRecord,
        private readonly collectionName: string,
        private readonly filters: Array<{ field: string; op: string; value: unknown; }> = [],
    ) { }

    where(field: string, op: string, value: unknown) {
        return new FirestoreQuery<T>(this.model, this.collectionName, [...this.filters, { field, op, value }]);
    }

    orderBy(field: string, direction: 'asc' | 'desc' = 'asc') {
        const next = new FirestoreQuery<T>(this.model, this.collectionName, this.filters);
        next.order = { field, direction };
        next.limitValue = this.limitValue;
        next.offsetValue = this.offsetValue;
        return next;
    }

    limit(n: number) {
        const next = new FirestoreQuery<T>(this.model, this.collectionName, this.filters);
        next.order = this.order;
        next.limitValue = n;
        next.offsetValue = this.offsetValue;
        return next;
    }

    offset(n: number) {
        const next = new FirestoreQuery<T>(this.model, this.collectionName, this.filters);
        next.order = this.order;
        next.limitValue = this.limitValue;
        next.offsetValue = n;
        return next;
    }

    private buildQuery() {
        const params: Record<string, unknown> = {};
        const clauses: string[] = [];

        for (let i = 0; i < this.filters.length; i += 1) {
            const f = this.filters[i];
            const name = `@p${i}`;
            clauses.push(`c.${f.field} ${f.op === '==' ? '=' : f.op} ${name}`);
            params[name.slice(1)] = f.value instanceof Date ? f.value.toISOString() : f.value;
        }

        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const order = this.order ? `ORDER BY c.${this.order.field} ${this.order.direction.toUpperCase()}` : '';
        const offset = `OFFSET ${this.offsetValue ?? 0}`;
        const limit = `LIMIT ${this.limitValue ?? 1000}`;

        return {
            query: `SELECT * FROM c ${where} ${order} ${offset} ${limit}`,
            params,
        };
    }

    count() {
        const query = this;
        return {
            get: async () => {
                const container = getContainer(query.collectionName);
                const clauses: string[] = [];
                const params: Record<string, unknown> = {};

                for (let i = 0; i < query.filters.length; i += 1) {
                    const f = query.filters[i];
                    const name = `@p${i}`;
                    clauses.push(`c.${f.field} ${f.op === '==' ? '=' : f.op} ${name}`);
                    params[name.slice(1)] = f.value instanceof Date ? f.value.toISOString() : f.value;
                }

                const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
                const { resources } = await container.items.query({
                    query: `SELECT VALUE COUNT(1) FROM c ${where}`,
                    parameters: Object.entries(params).map(([name, value]) => ({
                        name: `@${name}`,
                        value,
                    })),
                }).fetchAll();

                const count = Array.isArray(resources) ? Number(resources[0]) || 0 : 0;
                return {
                    data: () => ({ count }),
                };
            }
        };
    }

    async get() {
        const container = getContainer(this.collectionName);
        const { query, params } = this.buildQuery();

        const { resources } = await container.items.query({
            query,
            parameters: Object.entries(params).map(([name, value]) => ({
                name: `@${name}`,
                value,
            }))
        }).fetchAll();

        const docs = resources.map((item: Record<string, any>) => {
            const data = { ...item };
            const id = (typeof item.id === 'string' && item.id.length > 0)
                ? item.id
                : (typeof item._id === 'string' && item._id.length > 0 ? item._id : randomUUID());
            hydrateDates(data, defaultDateFields);
            return new FirestoreDocumentSnapshot(id, data as T);
        });

        return { docs };
    }
}

class FirestoreDocumentReference {
    constructor(
        readonly id: string,
        _collectionName: string,
        private readonly model: typeof FirestoreRecord,
    ) { }

    async get() {
        return this.model.fromFirestore(this.id);
    }

    async set(data: Record<string, unknown>, options?: { merge?: boolean; }) {
        if (options?.merge) {
            return this.model.save({ ...data, _id: this.id }, this.id, true);
        }

        return this.model.save({ ...data, _id: this.id }, this.id, false);
    }

    async update(data: Record<string, unknown>) {
        return this.model.save({ _id: this.id, ...data }, this.id, true);
    }
}

class FirestoreBatch {
    private readonly ops: Array<() => Promise<unknown>> = [];

    set(ref: FirestoreDocumentReference, data: Record<string, unknown>, options?: { merge?: boolean; }) {
        this.ops.push(() => ref.set(data, options));
    }

    update(ref: FirestoreDocumentReference, data: Record<string, unknown>) {
        this.ops.push(() => ref.update(data));
    }

    async commit() {
        await Promise.all(this.ops.map((op) => op()));
    }
}

class FirestoreTransaction {
    constructor(private readonly model: typeof FirestoreRecord) { }

    async get(ref: FirestoreDocumentReference) {
        const record = await this.model.fromFirestore(ref.id);
        if (!record) {
            return new FirestoreDocumentSnapshot(ref.id, undefined);
        }

        const data = { ...record };
        for (const field of defaultDateFields) {
            const value = (data as Record<string, unknown>)[field];
            if (value instanceof Date) {
                (data as Record<string, unknown>)[field] = Timestamp.fromDate(value);
            }
        }

        return new FirestoreDocumentSnapshot(ref.id, data);
    }

    async update(ref: FirestoreDocumentReference, data: Record<string, unknown>) {
        await this.model.save({ _id: ref.id, ...data }, ref.id, true);
    }

    async set(ref: FirestoreDocumentReference, data: Record<string, unknown>, options?: { merge?: boolean; }) {
        await this.model.save({ ...data, _id: ref.id }, ref.id, Boolean(options?.merge));
    }
}

export class FirestoreRecord {
    static collectionName: string;

    _id?: string;
    [key: string]: unknown;

    static get DB() {
        const model = this;
        return {
            batch: () => new FirestoreBatch(),
            runTransaction: async (fn: (tx: FirestoreTransaction) => Promise<unknown>) => {
                const tx = new FirestoreTransaction(model as any);
                return fn(tx);
            },
        };
    }

    static get COLLECTION() {
        return {
            doc: (id?: string) => new FirestoreDocumentReference(id ?? randomUUID(), this.collectionName, this as any),
            where: (field: string, op: string, value: unknown) => new FirestoreQuery(this as any, this.collectionName).where(field, op, value),
            orderBy: (field: string, direction?: 'asc' | 'desc') => new FirestoreQuery(this as any, this.collectionName).orderBy(field, direction),
        };
    }

    static get OPS() {
        return {
            increment: (value: number): IncrementOp => ({ __op: 'increment', value }),
        };
    }

    static from(input: any): any {
        const instance = new (this as any)();
        Object.assign(instance, input);

        const inputId = input?._id;
        if (!instance._id && typeof inputId === 'string') {
            instance._id = inputId;
        }

        hydrateDates(instance, defaultDateFields);
        return instance;
    }

    static async fromFirestore(id: string): Promise<any> {
        const collectionName = (this as any).collectionName;
        const data = await queryById(collectionName, id);
        if (!data) {
            return undefined;
        }

        const mapped = { _id: id, ...data };
        hydrateDates(mapped, defaultDateFields);
        return (this as any).from(mapped);
    }

    static async fromFirestoreQuery(query: FirestoreQuery<any>) {
        const snap = await query.get();
        return snap.docs.map((doc: { id: string; data(): any; }) =>
            (this as any).from({ _id: doc.id, ...doc.data() })
        );
    }

    static async save(data: any, docId?: string, options?: { merge?: boolean; } | boolean): Promise<any> {
        const collectionName = (this as any).collectionName;
        const { partitionKey: pkField } = resolveCollectionConfig(collectionName);
        const merge = typeof options === 'object' ? options?.merge === true : Boolean(options);
        const raw = typeof data.degradeForFireStore === 'function' ? data.degradeForFireStore() : { ...data };
        const id = docId ?? raw._id ?? raw.id ?? randomUUID();

        const enriched = {
            ...raw,
            _id: raw._id ?? id,
            id,
        } as Record<string, any>;

        hydrateDates(enriched, defaultDateFields);

        const ttlSeconds = resolveTtlSeconds(collectionName, enriched);
        if (ttlSeconds !== undefined) {
            enriched.ttl = ttlSeconds;
        }

        const partitionKey = pkField === 'id' ? id : enriched[pkField];
        if (pkField !== 'id' && (partitionKey === undefined || partitionKey === null)) {
            throw new Error(`Missing partition key ${pkField} for ${collectionName}`);
        }

        const container = getContainer(collectionName);
        if (merge) {
            const existing = await queryById(collectionName, id);
            const merged = mergeObjects(existing ?? {}, enriched);
            await container.items.upsert(serializeValue(merged));
            const mapped = { _id: id, ...merged };
            hydrateDates(mapped, defaultDateFields);
            return (this as any).from(mapped);
        }

        const prepared = serializeValue(enriched);
        await container.items.upsert(prepared);
        const mapped = { _id: id, ...enriched };
        hydrateDates(mapped, defaultDateFields);
        return (this as any).from(mapped);
    }

    degradeForFireStore(): Record<string, unknown> {
        return { ...this };
    }
}

export class Timestamp {
    constructor(private readonly date: Date) { }

    static fromDate(date: Date) {
        return new Timestamp(date);
    }

    static now() {
        return new Timestamp(new Date());
    }

    toDate() {
        return this.date;
    }

    valueOf() {
        return this.date.valueOf();
    }
}
