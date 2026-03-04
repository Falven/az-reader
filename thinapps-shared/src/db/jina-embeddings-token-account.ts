import { FirestoreRecord } from '../lib/firestore';
import { RateLimitDesc } from '../services/rate-limit';

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const toNumber = (value: unknown) => {
    const num = typeof value === 'string'
        ? Number(value)
        : (typeof value === 'number' ? value : undefined);

    if (num === undefined || Number.isNaN(num)) {
        return undefined;
    }

    return num;
};

const toDateValue = (value: unknown) => {
    if (value instanceof Date) {
        return value;
    }

    if (typeof value === 'string' || typeof value === 'number') {
        const d = new Date(value);
        if (!Number.isNaN(d.valueOf())) {
            return d;
        }
    }

    return undefined;
};

const normalizeWallet = (input: unknown) => {
    const source = isRecord(input) ? input : {};
    const totalBalance = toNumber(source.total_balance) ?? 0;
    const totalUsed = toNumber(source.total_used);

    return totalUsed !== undefined
        ? { total_balance: totalBalance, total_used: totalUsed }
        : { total_balance: totalBalance };
};

const normalizeMetadata = (input: unknown) => {
    if (!isRecord(input)) {
        return {} as Record<string, unknown>;
    }

    const metadata: Record<string, unknown> = { ...input };
    if (typeof metadata.speed_level === 'number') {
        metadata.speed_level = String(metadata.speed_level);
    } else if (typeof metadata.speed_level !== 'string') {
        delete metadata.speed_level;
    }

    return metadata;
};

class CustomRateLimitParsingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CustomRateLimitParsingError';
    }
}

class CustomRateLimit extends RateLimitDesc {
    effectiveFrom?: Date;
    expiresAt?: Date;

    constructor(occurrence: number, periodSeconds: number, effectiveFrom?: Date, expiresAt?: Date) {
        super(occurrence, periodSeconds);
        this.effectiveFrom = effectiveFrom;
        this.expiresAt = expiresAt;
    }

    static override from(input: unknown) {
        const parsed = CustomRateLimit.tryFrom(input);
        if (!parsed) {
            throw new CustomRateLimitParsingError('Invalid custom rate limit configuration');
        }

        return parsed;
    }

    static override tryFrom(input: unknown) {
        if (!isRecord(input)) {
            return undefined;
        }

        const occurrence = toNumber(input.occurrence);
        const periodSeconds = toNumber(input.periodSeconds);
        if (occurrence === undefined || periodSeconds === undefined) {
            return undefined;
        }

        const effectiveFrom = toDateValue(input.effectiveFrom ?? input.effective_from ?? input.activeFrom);
        const expiresAt = toDateValue(input.expiresAt ?? input.expires_at ?? input.expires);

        return new CustomRateLimit(occurrence, periodSeconds, effectiveFrom, expiresAt);
    }

    isEffective(reference: Date = new Date()) {
        const now = reference.valueOf();
        if (this.effectiveFrom && now < this.effectiveFrom.valueOf()) {
            return false;
        }

        if (this.expiresAt && now >= this.expiresAt.valueOf()) {
            return false;
        }

        return true;
    }

    toPersisted() {
        const persisted: Record<string, unknown> = {
            occurrence: this.occurrence,
            periodSeconds: this.periodSeconds,
        };

        if (this.effectiveFrom) {
            persisted.effectiveFrom = this.effectiveFrom;
        }

        if (this.expiresAt) {
            persisted.expiresAt = this.expiresAt;
        }

        return persisted;
    }
}

const normalizeCustomRateLimits = (input: unknown) => {
    if (!isRecord(input)) {
        return undefined;
    }

    const entries: Array<[string, CustomRateLimit[]]> = [];
    for (const [tag, value] of Object.entries(input)) {
        const rawList = Array.isArray(value) ? value : [value];
        const limits = rawList
            .map((candidate) => CustomRateLimit.tryFrom(candidate))
            .filter((limit): limit is CustomRateLimit => limit !== undefined);
        if (limits.length > 0) {
            entries.push([tag, limits]);
        }
    }

    if (entries.length === 0) {
        return undefined;
    }

    return Object.fromEntries(entries);
};

const serializeCustomRateLimits = (input?: Record<string, CustomRateLimit[]>) => {
    if (!input) {
        return undefined;
    }

    const entries: Array<[string, unknown[]]> = [];
    for (const [tag, limits] of Object.entries(input)) {
        const serialized = limits.map((limit) => limit.toPersisted());
        if (serialized.length > 0) {
            entries.push([tag, serialized]);
        }
    }

    if (entries.length === 0) {
        return undefined;
    }

    return Object.fromEntries(entries);
};

export class JinaEmbeddingsTokenAccount extends FirestoreRecord {
    static override collectionName = 'jinaEmbeddingsTokenAccounts';

    override _id?: string;
    user_id?: string;
    full_name?: string;
    wallet: { total_balance: number; total_used?: number; } = { total_balance: 0 };
    metadata?: any;
    customRateLimits?: any;
    lastSyncedAt?: Date;

    static override from(input: any): JinaEmbeddingsTokenAccount {
        const instance = super.from(input) as JinaEmbeddingsTokenAccount;
        instance.wallet = normalizeWallet(input.wallet);
        instance.metadata = normalizeMetadata(input.metadata);

        const limits = normalizeCustomRateLimits(input.customRateLimits);
        instance.customRateLimits = limits;

        return instance;
    }

    override degradeForFireStore() {
        const base: Record<string, unknown> = {
            _id: this._id,
            user_id: this.user_id,
            full_name: this.full_name,
            wallet: normalizeWallet(this.wallet),
            metadata: this.metadata ? normalizeMetadata(this.metadata) : undefined,
            lastSyncedAt: this.lastSyncedAt,
        };

        const serializedLimits = serializeCustomRateLimits(this.customRateLimits);
        if (serializedLimits) {
            base.customRateLimits = serializedLimits;
        }

        return base;
    }
}
