import { FirestoreRecord } from '../lib/firestore';

export class RateLimitCounterError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RateLimitCounterError';
    }
}

const toNonEmptyString = (value: unknown) => {
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const toFiniteNumber = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.length === 0) {
            return undefined;
        }

        const parsed = Number(trimmed);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return undefined;
};

const toNonNegativeInt = (value: unknown) => {
    const num = toFiniteNumber(value);
    if (num === undefined || num < 0) {
        return undefined;
    }

    return Math.trunc(num);
};

const toDateValue = (value: unknown) => {
    if (value instanceof Date) {
        return Number.isNaN(value.valueOf()) ? undefined : value;
    }

    if (typeof value === 'string' || typeof value === 'number') {
        const date = new Date(value);
        if (!Number.isNaN(date.valueOf())) {
            return date;
        }
    }

    return undefined;
};

const normalizeWindowMs = (value: unknown) => {
    return toNonNegativeInt(value) ?? 0;
};

const MAX_TIMESTAMPS_STORED = 5000;

const normalizeTimestamps = (value: unknown) => {
    if (!Array.isArray(value)) {
        return [] as number[];
    }

    const normalized: number[] = [];
    for (const entry of value) {
        const num = toNonNegativeInt(entry);
        if (num === undefined) {
            continue;
        }

        normalized.push(num);
    }

    normalized.sort((a, b) => a - b);
    if (normalized.length > MAX_TIMESTAMPS_STORED) {
        return normalized.slice(normalized.length - MAX_TIMESTAMPS_STORED);
    }

    return normalized;
};

const deriveTtlSeconds = (value: unknown, windowMs: number) => {
    const ttlSeconds = toNonNegativeInt(value);
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
        return ttlSeconds;
    }

    if (windowMs > 0) {
        const derived = Math.ceil(windowMs / 1000) * 2;
        return derived > 0 ? derived : undefined;
    }

    return undefined;
};

export class RateLimitCounter extends FirestoreRecord {
    static override collectionName = process.env.RATE_LIMIT_CONTAINER || 'rateLimits';

    override _id = '';
    key = '';
    windowMs = 0;
    timestamps: number[] = [];
    updatedAt?: Date;
    ttl?: number;

    static override from(input: any): RateLimitCounter {
        const typed = input as Record<string, unknown>;
        const instance = super.from(typed) as RateLimitCounter;

        const normalizedId = toNonEmptyString(typed._id)
            ?? toNonEmptyString(typed.key)
            ?? toNonEmptyString(instance._id)
            ?? '';

        instance._id = normalizedId;
        instance.key = toNonEmptyString(typed.key) ?? normalizedId;
        instance.windowMs = normalizeWindowMs(typed.windowMs ?? instance.windowMs);
        instance.timestamps = normalizeTimestamps(typed.timestamps ?? instance.timestamps);
        instance.updatedAt = toDateValue(typed.updatedAt ?? instance.updatedAt);
        instance.ttl = deriveTtlSeconds(typed.ttl ?? instance.ttl, instance.windowMs);

        return instance;
    }

    override degradeForFireStore() {
        const key = toNonEmptyString(this.key) ?? toNonEmptyString(this._id);
        if (key === undefined) {
            throw new RateLimitCounterError('RateLimitCounter requires a key to persist.');
        }

        const windowMs = normalizeWindowMs(this.windowMs);
        const timestamps = normalizeTimestamps(this.timestamps);

        return {
            _id: this._id || key,
            key,
            windowMs,
            timestamps,
            updatedAt: toDateValue(this.updatedAt) ?? new Date(),
            ttl: deriveTtlSeconds(this.ttl, windowMs),
        };
    }
}
