import { CosmosClient, type Container, type CosmosClientOptions, type SqlParameter, type SqlQuerySpec } from '@azure/cosmos';
import { randomUUID } from 'crypto';
import { getCosmosConfig } from '../services/azure-config';

type QueryParameters = Record<string, unknown>;

const defaultDateFields = ['createdAt', 'expireAt', 'lastSyncedAt', 'finishedAt', 'updatedAt'] as const;

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

const buildParameters = (params?: QueryParameters): SqlParameter[] => {
    if (!params) {
        return [];
    }

    return Object.entries(params).map(([name, value]) => ({
        name: name.startsWith('@') ? name : `@${name}`,
        value: value as SqlParameter['value'],
    }));
};

let client: CosmosClient | undefined;

const ensureContainer = (containerName: string): Container => {
    const config = getCosmosConfig();
    if (!config.enabled) {
        throw new Error('Cosmos DB is disabled. Set COSMOS_ENABLED=true to enable it.');
    }
    if (!client) {
        if (!config.endpoint) {
            throw new Error('Cosmos endpoint is not configured.');
        }
        const options: CosmosClientOptions = { endpoint: config.endpoint };
        if (config.credential) {
            options.aadCredentials = config.credential;
        } else if (config.key) {
            options.key = config.key;
        } else {
            throw new Error('Cosmos configuration is missing both credential and key.');
        }
        client = new CosmosClient(options);
    }
    return client.database(config.databaseId).container(containerName);
};

export class CosmosRecord {
    static containerName: string;
    static partitionKey = 'id';
    static dateFields: readonly string[] = defaultDateFields;

    _id!: string;
    [k: string]: unknown;

    static get CONTAINER(): Container {
        return ensureContainer((this as typeof CosmosRecord).containerName);
    }

    static get OPS() {
        return {
            increment: (delta: number) => delta,
        };
    }

    static from(input: Record<string, unknown>): any {
        const instance: Record<string, unknown> = new (this as any)();
        const data = { ...input };
        data._id = (data._id as string | undefined) ?? (data.id as string | undefined) ?? randomUUID();

        hydrateDates(data, (this as typeof CosmosRecord).dateFields);

        Object.assign(instance, data);

        return instance;
    }

    static async fromId<T extends CosmosRecord>(id: string, partitionKey?: string): Promise<T | undefined> {
        const pk = partitionKey ?? this.resolvePartitionKey({ _id: id });
        const item = this.CONTAINER.item(id, pk);
        const response = await item.read<Record<string, unknown>>();
        if (!response.resource) {
            return undefined;
        }

        return this.from(response.resource) as T;
    }

    static async fromQuery<T extends CosmosRecord>(query: string | SqlQuerySpec, params?: QueryParameters): Promise<T[]> {
        const spec: SqlQuerySpec = typeof query === 'string' ? { query, parameters: buildParameters(params) } : query;
        const { resources } = await this.CONTAINER.items.query(spec).fetchAll();

        return resources.map((item: Record<string, unknown>) => this.from(item) as T);
    }

    static async queryRaw<T = Record<string, unknown>>(query: string | SqlQuerySpec, params?: QueryParameters): Promise<T[]> {
        const spec: SqlQuerySpec = typeof query === 'string' ? { query, parameters: buildParameters(params) } : query;
        const { resources } = await this.CONTAINER.items.query(spec).fetchAll();

        return resources as T[];
    }

    static async save<T extends CosmosRecord>(data: T | Record<string, unknown>, docId?: string): Promise<T> {
        const { prepared } = this.prepareForStorage(data, docId);
        const { resource } = await this.CONTAINER.items.upsert(prepared);

        return this.from(resource ?? prepared) as T;
    }

    static async upsert<T extends CosmosRecord>(data: T | Record<string, unknown>, docId?: string): Promise<T> {
        return this.save<T>(data, docId);
    }

    static async delete(id: string, partitionKey?: string) {
        const pk = partitionKey ?? this.resolvePartitionKey({ _id: id });
        await this.CONTAINER.item(id, pk).delete();
    }

    static prepareForStorage(data: Record<string, unknown> | CosmosRecord, docId?: string) {
        const raw = typeof (data as CosmosRecord).degradeForStore === 'function' ?
            (data as CosmosRecord).degradeForStore() :
            { ...(data as Record<string, unknown>) };

        const id = docId ?? (raw._id as string | undefined) ?? (raw.id as string | undefined) ?? randomUUID();

        const enriched: Record<string, unknown> = {
            ...raw,
            _id: raw._id ?? id,
            id,
        };

        const partitionKey = this.resolvePartitionKey(enriched);

        hydrateDates(enriched, (this as typeof CosmosRecord).dateFields);

        const prepared = serializeValue(enriched) as Record<string, unknown>;

        return { prepared, partitionKey };
    }

    static resolvePartitionKey(data: Record<string, unknown>) {
        const pkField = (this as typeof CosmosRecord).partitionKey || 'id';
        const pk = data[pkField] ?? (pkField === 'id' ? data._id : undefined);

        if (pk === undefined || pk === null) {
            throw new Error(`Missing partition key "${pkField}" for ${(this as typeof CosmosRecord).name}`);
        }

        return pk as string;
    }

    degradeForStore(): Record<string, unknown> {
        return serializeValue({ ...this }) as Record<string, unknown>;
    }
}
