import { FirestoreRecord } from '../lib/firestore';

export type RateLimitCounterInput = {
    _id?: string;
    key?: string;
    windowMs?: number | string;
    timestamps?: unknown;
    updatedAt?: Date | number | string;
    ttl?: number | string;
};

export class RateLimitCounterError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RateLimitCounterError';
    }
}

const toNonEmptyString = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return undefined;
    }
    return trimmed;
};

const toFiniteNumber = (value: unknown): number | undefined => {
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

const toNonNegativeInt = (value: unknown): number | undefined => {
    const num = toFiniteNumber(value);
    if (num === undefined || num < 0) {
        return undefined;
    }
    return Math.trunc(num);
};

const toDateValue = (value: unknown): Date | undefined => {
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

const normalizeWindowMs = (value: unknown): number => {
    const normalized = toNonNegativeInt(value);
    return normalized ?? 0;
};

const MAX_TIMESTAMPS_STORED = 5000;

const normalizeTimestamps = (value: unknown): number[] => {
    if (!Array.isArray(value)) {
        return [];
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

const deriveTtlSeconds = (value: unknown, windowMs: number): number | undefined => {
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

    static override from(input: Record<string, unknown>): RateLimitCounter {
        const typed = input as RateLimitCounterInput;
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

    override degradeForFireStore(): Record<string, unknown> {
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
