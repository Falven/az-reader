import { FirestoreRecord } from '../lib/firestore';
import { RateLimitDesc } from '../services/rate-limit';

export type WalletBrief = {
    total_balance: number;
    total_used?: number;
};

export type AccountMetadata = Record<string, unknown> & {
    speed_level?: string;
};

type CustomRateLimitPersisted = {
    occurrence: number;
    periodSeconds: number;
    effectiveFrom?: Date;
    expiresAt?: Date;
};

type CustomRateLimitMap = Record<string, CustomRateLimit[]>;

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const toNumber = (value: unknown): number | undefined => {
    const num = typeof value === 'string' ? Number(value) : (typeof value === 'number' ? value : undefined);
    if (num === undefined || Number.isNaN(num)) {
        return undefined;
    }
    return num;
};

const toDateValue = (value: unknown): Date | undefined => {
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

const normalizeWallet = (input: unknown): WalletBrief => {
    const source = isRecord(input) ? input : {};
    const totalBalance = toNumber(source.total_balance) ?? 0;
    const totalUsed = toNumber(source.total_used);
    return totalUsed !== undefined ? { total_balance: totalBalance, total_used: totalUsed } : { total_balance: totalBalance };
};

const normalizeMetadata = (input: unknown): AccountMetadata => {
    if (!isRecord(input)) {
        return {};
    }
    const metadata: AccountMetadata = { ...input };
    if (typeof metadata.speed_level === 'number') {
        metadata.speed_level = String(metadata.speed_level);
    } else if (typeof metadata.speed_level !== 'string') {
        delete metadata.speed_level;
    }
    return metadata;
};

class CustomRateLimitParsingError extends Error {
    override name = 'CustomRateLimitParsingError';
}

class CustomRateLimit extends RateLimitDesc {
    effectiveFrom?: Date;
    expiresAt?: Date;

    constructor(occurrence: number, periodSeconds: number, effectiveFrom?: Date, expiresAt?: Date) {
        super(occurrence, periodSeconds);
        this.effectiveFrom = effectiveFrom;
        this.expiresAt = expiresAt;
    }

    static override from(input: unknown): CustomRateLimit {
        const parsed = CustomRateLimit.tryFrom(input);
        if (!parsed) {
            throw new CustomRateLimitParsingError('Invalid custom rate limit configuration');
        }
        return parsed;
    }

    static override tryFrom(input: unknown): CustomRateLimit | undefined {
        if (!isRecord(input)) {
            return undefined;
        }
        const occurrence = toNumber(input.occurrence);
        const periodSeconds = toNumber(input.periodSeconds);
        if (occurrence === undefined || periodSeconds === undefined) {
            return undefined;
        }
        const effectiveFrom = toDateValue(
            input.effectiveFrom ?? input.effective_from ?? input.activeFrom
        );
        const expiresAt = toDateValue(
            input.expiresAt ?? input.expires_at ?? input.expires
        );
        return new CustomRateLimit(occurrence, periodSeconds, effectiveFrom, expiresAt);
    }

    isEffective(reference: Date = new Date()): boolean {
        const now = reference.valueOf();
        if (this.effectiveFrom && now < this.effectiveFrom.valueOf()) {
            return false;
        }
        if (this.expiresAt && now >= this.expiresAt.valueOf()) {
            return false;
        }
        return true;
    }

    toPersisted(): CustomRateLimitPersisted {
        const persisted: CustomRateLimitPersisted = {
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

const normalizeCustomRateLimits = (input: unknown): CustomRateLimitMap | undefined => {
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

const serializeCustomRateLimits = (input?: CustomRateLimitMap): Record<string, CustomRateLimitPersisted[]> | undefined => {
    if (!input) {
        return undefined;
    }
    const entries: Array<[string, CustomRateLimitPersisted[]]> = [];
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

    override _id!: string;
    user_id?: string;
    full_name?: string;
    wallet: WalletBrief = { total_balance: 0 };
    metadata?: AccountMetadata;
    lastSyncedAt?: Date;
    customRateLimits?: CustomRateLimitMap;

    static override from(input: Record<string, unknown>): JinaEmbeddingsTokenAccount {
        const instance = super.from(input) as JinaEmbeddingsTokenAccount;
        instance.wallet = normalizeWallet(input.wallet);
        instance.metadata = normalizeMetadata(input.metadata);
        const limits = normalizeCustomRateLimits(input.customRateLimits);
        if (limits) {
            instance.customRateLimits = limits;
        }
        return instance;
    }

    override degradeForFireStore(): Record<string, unknown> {
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
