import { CosmosClient, type Container, type CosmosClientOptions, type SqlParameter } from '@azure/cosmos';
import { randomUUID } from 'crypto';
import { getCosmosConfig } from '../services/azure-config';

type WhereOperator = '==' | '<' | '<=' | '>' | '>=';
type OrderDirection = 'asc' | 'desc';

type QueryFilter = { field: string; op: WhereOperator; value: unknown; };

type FirestoreQueryResult = {
    docs: FirestoreDocumentSnapshot[];
};

export type SetOptions = { merge?: boolean; };

type UpdateInput = Record<string, unknown>;

type FirestoreBatchOp = () => Promise<unknown>;

type FirestoreTransactionFn = (transaction: FirestoreTransaction) => Promise<unknown>;

type CollectionConfig = {
    partitionKey: string;
    ttlSeconds?: number;
};

const defaultDateFields = [
    'createdAt',
    'updatedAt',
    'finishedAt',
    'expireAt',
    'lastSyncedAt',
] as const;

const DEFAULT_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_RATE_LIMIT_TTL_SECONDS = 24 * 60 * 60;
const rateLimitContainerName = process.env.RATE_LIMIT_CONTAINER || 'rateLimits';

const COLLECTION_CONFIG: Record<string, CollectionConfig> = {
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

const isIncrement = (value: unknown): value is { __op: 'increment'; value: number; } => {
    return Boolean(value) && typeof value === 'object' && (value as Record<string, unknown>).__op === 'increment';
};

const toDate = (value: unknown): Date | undefined => {
    if (value instanceof Date) {
        return value;
    }
    if (value && typeof value === 'object' && 'toDate' in (value as Record<string, unknown>)) {
        const converted = Reflect.get(value as Record<string, unknown>, 'toDate');
        if (typeof converted === 'function') {
            const date = converted.call(value) as Date;
            return Number.isNaN(date.valueOf()) ? undefined : date;
        }
    }
    if (typeof value === 'string' || typeof value === 'number') {
        const date = new Date(value);
        return Number.isNaN(date.valueOf()) ? undefined : date;
    }
    return undefined;
};

const hydrateDates = (target: Record<string, unknown>, fields: readonly string[]) => {
    for (const field of fields) {
        const maybeDate = toDate(target[field]);
        if (maybeDate) {
            target[field] = maybeDate;
        }
    }
};

const serializeValue = (value: unknown): unknown => {
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
        const entries = Object.entries(value as Record<string, unknown>)
            .map(([k, v]) => [k, serializeValue(v)] as const)
            .filter(([, v]) => v !== undefined);
        return Object.fromEntries(entries);
    }
    return value;
};

const resolveCollectionConfig = (collectionName: string): CollectionConfig => {
    return COLLECTION_CONFIG[collectionName] ?? { partitionKey: 'id' };
};

const resolveTtlSeconds = (collectionName: string, data: Record<string, unknown>): number | undefined => {
    const explicit = typeof data.ttl === 'number' ? data.ttl : undefined;
    const cfg = COLLECTION_CONFIG[collectionName];
    return explicit ?? cfg?.ttlSeconds;
};

const applyDotPath = (target: Record<string, unknown>, path: string, value: unknown) => {
    const parts = path.split('.');
    let cursor: Record<string, unknown> = target;
    for (let i = 0; i < parts.length - 1; i += 1) {
        const key = parts[i];
        if (cursor[key] === undefined || cursor[key] === null || typeof cursor[key] !== 'object') {
            cursor[key] = {};
        }
        cursor = cursor[key] as Record<string, unknown>;
    }
    const last = parts[parts.length - 1];
    cursor[last] = value;
};

const mergeObjects = (base: Record<string, unknown>, patch: Record<string, unknown>) => {
    const result = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) {
            continue;
        }
        if (isIncrement(value)) {
            const current = typeof result[key] === 'number' ? (result[key] as number) : 0;
            result[key] = current + value.value;
            continue;
        }
        if (key.includes('.')) {
            applyDotPath(result, key, value);
            continue;
        }
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            result[key] = mergeObjects(
                (result[key] as Record<string, unknown>) || {},
                value as Record<string, unknown>
            );
            continue;
        }
        result[key] = value;
    }
    return result;
};

let cosmosClient: CosmosClient | undefined;

const getContainer = (collectionName: string): Container => {
    const cfg = getCosmosConfig();
    if (!cfg.enabled) {
        throw new Error('Cosmos DB is disabled. Set COSMOS_ENABLED=true to enable it.');
    }
    if (!cosmosClient) {
        if (!cfg.endpoint) {
            throw new Error('Cosmos endpoint is not configured.');
        }
        const options: CosmosClientOptions = { endpoint: cfg.endpoint };
        if (cfg.credential) {
            options.aadCredentials = cfg.credential;
        } else if (cfg.key) {
            options.key = cfg.key;
        } else {
            throw new Error('Cosmos configuration is missing both credential and key.');
        }
        cosmosClient = new CosmosClient(options);
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

class FirestoreDocumentSnapshot {
    id: string;
    private documentData: Record<string, unknown>;
    exists: boolean;

    constructor(id: string, data?: Record<string, unknown>) {
        this.id = id;
        this.documentData = data || {};
        this.exists = Boolean(data);
    }

    data() {
        return this.documentData;
    }
}

export class FirestoreQuery {
    private collectionName: string;
    private model: typeof FirestoreRecord;
    private filters: QueryFilter[];
    private order?: { field: string; direction: OrderDirection; };
    private limitValue?: number;
    private offsetValue?: number;

    constructor(model: typeof FirestoreRecord, collectionName: string, filters: QueryFilter[] = []) {
        this.model = model;
        this.collectionName = collectionName;
        this.filters = filters;
    }

    where(field: string, op: WhereOperator, value: unknown): FirestoreQuery {
        return new FirestoreQuery(this.model, this.collectionName, [...this.filters, { field, op, value }]);
    }

    orderBy(field: string, direction: OrderDirection = 'asc') {
        const next = new FirestoreQuery(this.model, this.collectionName, this.filters);
        next.order = { field, direction };
        next.limitValue = this.limitValue;
        next.offsetValue = this.offsetValue;
        return next;
    }

    limit(n: number) {
        const next = new FirestoreQuery(this.model, this.collectionName, this.filters);
        next.order = this.order;
        next.limitValue = n;
        next.offsetValue = this.offsetValue;
        return next;
    }

    offset(n: number) {
        const next = new FirestoreQuery(this.model, this.collectionName, this.filters);
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
                        value: value as SqlParameter['value'],
                    })),
                }).fetchAll();
                const count = Array.isArray(resources) ? Number(resources[0]) || 0 : 0;
                return {
                    data: () => ({ count }),
                };
            }
        };
    }

    async get(): Promise<FirestoreQueryResult> {
        const container = getContainer(this.collectionName);
        const { query, params } = this.buildQuery();
        const { resources } = await container.items.query({
            query,
            parameters: Object.entries(params).map(([name, value]) => ({
                name: `@${name}`,
                value: value as SqlParameter['value'],
            }))
        }).fetchAll();

        const docs = resources.map((item) => {
            const data = { ...item } as Record<string, unknown>;
            const id = (item as Record<string, unknown>).id as string;
            hydrateDates(data, defaultDateFields);
            return new FirestoreDocumentSnapshot(id, data);
        });

        return { docs };
    }
}

class FirestoreDocumentReference {
    id: string;
    private model: typeof FirestoreRecord;

    constructor(id: string, collectionName: string, model: typeof FirestoreRecord) {
        this.id = id;
        this.model = model;
    }

    async get() {
        return this.model.fromFirestore(this.id);
    }

    async set(data: Record<string, unknown>, options?: SetOptions) {
        if (options?.merge) {
            return this.model.save({ ...data, _id: this.id }, this.id, true);
        }
        return this.model.save({ ...data, _id: this.id }, this.id, false);
    }

    async update(data: UpdateInput) {
        return this.model.save({ _id: this.id, ...data }, this.id, true);
    }
}

class FirestoreBatch {
    private ops: FirestoreBatchOp[] = [];

    set(ref: FirestoreDocumentReference, data: Record<string, unknown>, options?: SetOptions) {
        this.ops.push(() => ref.set(data, options));
    }

    update(ref: FirestoreDocumentReference, data: UpdateInput) {
        this.ops.push(() => ref.update(data));
    }

    async commit() {
        await Promise.all(this.ops.map((op) => op()));
    }
}

class FirestoreTransaction {
    private model: typeof FirestoreRecord;

    constructor(model: typeof FirestoreRecord) {
        this.model = model;
    }

    async get(ref: FirestoreDocumentReference) {
        const record = await this.model.fromFirestore(ref.id);
        if (!record) {
            return new FirestoreDocumentSnapshot(ref.id, undefined);
        }
        const data = { ...(record as Record<string, unknown>) };
        for (const field of defaultDateFields) {
            const value = data[field];
            if (value instanceof Date) {
                data[field] = Timestamp.fromDate(value);
            }
        }
        return new FirestoreDocumentSnapshot(ref.id, data);
    }

    async update(ref: FirestoreDocumentReference, data: UpdateInput) {
        await this.model.save({ _id: ref.id, ...data }, ref.id, true);
    }

    async set(ref: FirestoreDocumentReference, data: Record<string, unknown>, options?: SetOptions) {
        await this.model.save({ ...data, _id: ref.id }, ref.id, Boolean(options?.merge));
    }
}

export class FirestoreRecord {
    static collectionName: string;

    _id!: string;
    [k: string]: any;

    static get DB() {
        const model = this;
        return {
            batch: () => new FirestoreBatch(),
            runTransaction: async (fn: FirestoreTransactionFn) => {
                const tx = new FirestoreTransaction(model);
                return fn(tx);
            },
        };
    }

    static get COLLECTION() {
        return {
            doc: (id?: string) => new FirestoreDocumentReference(id ?? randomUUID(), (this as typeof FirestoreRecord).collectionName, this as typeof FirestoreRecord),
            where: (field: string, op: WhereOperator, value: unknown) => new FirestoreQuery(this as typeof FirestoreRecord, (this as typeof FirestoreRecord).collectionName).where(field, op, value),
            orderBy: (field: string, direction?: OrderDirection) => new FirestoreQuery(this as typeof FirestoreRecord, (this as typeof FirestoreRecord).collectionName).orderBy(field, direction),
        };
    }

    static get OPS() {
        return {
            increment: (value: number) => ({ __op: 'increment' as const, value }),
        };
    }

    static from(input: Record<string, unknown>): any {
        const instance: any = new (this as any)();
        Object.assign(instance, input);
        const inputId = input?._id;
        if (!instance._id && typeof inputId === 'string') {
            instance._id = inputId;
        }
        hydrateDates(instance, defaultDateFields);
        return instance;
    }

    static async fromFirestore(id: string): Promise<any | undefined> {
        const collectionName = (this as typeof FirestoreRecord).collectionName;
        const data = await queryById(collectionName, id);
        if (!data) {
            return undefined;
        }
        const mapped = { _id: id, ...data } as Record<string, unknown>;
        hydrateDates(mapped, defaultDateFields);
        return (this as any).from(mapped);
    }

    static async fromFirestoreQuery(query: FirestoreQuery): Promise<any[]> {
        const snap = await query.get();
        return snap.docs.map((doc) => (this as any).from({ _id: doc.id, ...(doc.data() as Record<string, unknown>) }));
    }

    static async save(data: any, docId?: string, options?: boolean | SetOptions): Promise<any> {
        const collectionName = (this as typeof FirestoreRecord).collectionName;
        const { partitionKey: pkField } = resolveCollectionConfig(collectionName);
        const merge = typeof options === 'object' ? options?.merge === true : Boolean(options);
        const raw = typeof (data as FirestoreRecord).degradeForFireStore === 'function' ? (data as FirestoreRecord).degradeForFireStore() : { ...(data as Record<string, unknown>) };
        const id = docId ?? (raw._id as string | undefined) ?? (raw.id as string | undefined) ?? randomUUID();
        const enriched: Record<string, unknown> = {
            ...raw,
            _id: raw._id ?? id,
            id,
        };
        hydrateDates(enriched, defaultDateFields);
        const ttlSeconds = resolveTtlSeconds(collectionName, enriched);
        if (ttlSeconds !== undefined) {
            enriched.ttl = ttlSeconds;
        }
        const partitionKey = pkField === 'id' ? id : (enriched[pkField] as string | undefined);
        if (pkField !== 'id' && (partitionKey === undefined || partitionKey === null)) {
            throw new Error(`Missing partition key ${pkField} for ${collectionName}`);
        }

        const cfg = getCosmosConfig();

        if (cfg.enabled) {
            const container = getContainer(collectionName);

            if (merge) {
                const existing = await queryById(collectionName, id);
                const merged = mergeObjects(existing ?? {}, enriched);
                await container.items.upsert(serializeValue(merged) as Record<string, unknown>);
                const mapped = { _id: id, ...merged } as Record<string, unknown>;
                hydrateDates(mapped, defaultDateFields);
                return (this as any).from(mapped);
            }

            const prepared = serializeValue(enriched) as Record<string, unknown>;
            await container.items.upsert(prepared);
            const mapped = { _id: id, ...enriched } as Record<string, unknown>;
            hydrateDates(mapped, defaultDateFields);
            return (this as any).from(mapped);
        }
    }

    degradeForFireStore(): Record<string, unknown> {
        return { ...this } as Record<string, unknown>;
    }
}

export class Timestamp {
    private readonly date: Date;

    constructor(date: Date) {
        this.date = date;
    }

    static fromDate(date: Date) {
        return new Timestamp(date);
    }

    static now() {
        return new Timestamp(new Date());
    }

    toDate() {
        return this.date;
    }
}
