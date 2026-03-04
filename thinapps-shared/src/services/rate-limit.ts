import { API_CALL_STATUS, APIRoll } from '../db/api-roll';
import { RateLimitCounter } from '../db/rate-limit-counter';
import { getCosmosConfig } from './azure-config';

type RateLimitInputLike = {
    occurrence?: unknown;
    periodSeconds?: unknown;
};

const isRateLimitInputLike = (value: unknown): value is RateLimitInputLike => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

export class RateLimitDesc {
    occurrence: number;
    periodSeconds: number;

    constructor(occurrence: number, periodSeconds: number) {
        this.occurrence = occurrence;
        this.periodSeconds = periodSeconds;
    }

    static from(input: { occurrence: number; periodSeconds: number; }) {
        return new RateLimitDesc(input.occurrence, input.periodSeconds);
    }

    static tryFrom(input: unknown) {
        if (!isRateLimitInputLike(input)) {
            return undefined;
        }

        if (input.occurrence === undefined || input.periodSeconds === undefined) {
            return undefined;
        }

        const occurrence = typeof input.occurrence === 'number' ? input.occurrence : Number(input.occurrence);
        const periodSeconds = typeof input.periodSeconds === 'number' ? input.periodSeconds : Number(input.periodSeconds);

        if (!Number.isFinite(occurrence) || !Number.isFinite(periodSeconds)) {
            return undefined;
        }

        return new RateLimitDesc(occurrence, periodSeconds);
    }
}

export class RateLimitTriggeredError extends Error {
    retryAfter?: number;
    retryAfterDate?: Date;

    constructor(message: string, retryAfter?: number, retryAfterDate?: Date) {
        super(message);
        this.name = 'RateLimitTriggeredError';
        this.retryAfter = retryAfter;
        this.retryAfterDate = retryAfterDate;
    }

    static from(input: { message: string; retryAfter?: number; retryAfterDate?: Date; }) {
        return new RateLimitTriggeredError(input.message, input.retryAfter, input.retryAfterDate);
    }
}

export class RateLimitPersistenceError extends Error {
    override cause?: unknown;

    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = 'RateLimitPersistenceError';
        this.cause = cause;
    }
}

const pruneWindow = (timestamps: number[], periodMs: number, now: number) => {
    const safeWindow = Math.max(periodMs, 1);
    let idx = 0;

    while (idx < timestamps.length && (now - timestamps[idx]) > safeWindow) {
        idx += 1;
    }

    if (idx > 0) {
        timestamps.splice(0, idx);
    }
};

const computeRetryAfter = (periodMs: number, now: number, oldest: number) => {
    const windowMs = Math.max(periodMs, 1);
    return Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
};

type RateLimitRecord = {
    chargeAmount: number;
    uid?: string;
    tags: string[];
    status: API_CALL_STATUS;
    save: () => Promise<APIRoll | undefined>;
};

export class RateLimitControl {
    private buildRecord(uid: string | undefined, tags: string[]): RateLimitRecord {
        const roll = APIRoll.create({ uid, tags });

        const record: RateLimitRecord = {
            chargeAmount: roll.chargeAmount,
            uid: roll.uid,
            tags: roll.tags,
            status: roll.status,
            save: async () => {
                const uidMissing = record.uid === undefined || record.uid === null || record.uid === '';
                if (uidMissing) {
                    return undefined;
                }

                roll.uid = record.uid;
                roll.tags = Array.isArray(record.tags) ? record.tags : [];
                roll.status = record.status ?? roll.status;
                roll.chargeAmount = record.chargeAmount ?? roll.chargeAmount;
                roll.createdAt = roll.createdAt ?? new Date();
                return roll.persist();
            }
        };

        return record;
    }

    private async enforceCosmos(
        key: string,
        descs: RateLimitDesc[],
        now: number,
        windowOverrideMs?: number,
    ) {
        getCosmosConfig();

        if (descs.length === 0) {
            return;
        }

        const windowCandidates = descs.map((desc) => Math.max(1, desc.periodSeconds * 1000));
        if (windowOverrideMs) {
            windowCandidates.push(Math.max(1, windowOverrideMs));
        }

        const maxWindow = Math.max(...windowCandidates);
        const counterId = key;

        let existing;
        try {
            existing = await RateLimitCounter.fromFirestore(counterId);
        } catch (err) {
            throw new RateLimitPersistenceError(`Failed to load rate limit counter for ${counterId}`, err);
        }

        const timestamps = Array.isArray(existing?.timestamps) ? [...existing.timestamps] : [];
        const existingWindow = typeof existing?.windowMs === 'number' ? existing.windowMs : 0;
        const windowForPrune = Math.max(existingWindow, maxWindow);
        pruneWindow(timestamps, windowForPrune, now);

        for (const desc of descs) {
            const windowMs = Math.max(windowOverrideMs ?? (desc.periodSeconds * 1000), 1);
            const active = timestamps.filter((t) => (now - t) <= windowMs);
            if (active.length >= desc.occurrence) {
                const oldest = active[0];
                const retryAfter = computeRetryAfter(windowMs, now, oldest);
                throw new RateLimitTriggeredError(
                    'Rate limit exceeded',
                    retryAfter,
                    new Date(now + retryAfter * 1000),
                );
            }
        }

        timestamps.push(now);

        const record = RateLimitCounter.from({
            _id: counterId,
            key: counterId,
            timestamps,
            windowMs: maxWindow,
            updatedAt: new Date(),
            ttl: Math.ceil(maxWindow / 1000) * 2,
        });

        try {
            await RateLimitCounter.save(record);
        } catch (err) {
            throw new RateLimitPersistenceError(`Failed to persist rate limit counter for ${counterId}`, err);
        }
    }

    async simpleRPCUidBasedLimit(
        _rpc: unknown,
        uid: string,
        tags: string[],
        ...descs: RateLimitDesc[]
    ) {
        const key = `${uid}:${tags.slice().sort().join(',')}`;
        const now = Date.now();
        const record = this.buildRecord(uid, tags);
        await this.enforceCosmos(key, descs, now);

        return record;
    }

    async simpleRpcIPBasedLimit(
        _rpc: unknown,
        ip: string,
        tags: string[],
        desc: [Date, number],
    ) {
        const key = `${ip}:${tags.slice().sort().join(',')}`;
        const now = Date.now();
        const windowMs = Math.max(1, now - desc[0].valueOf());
        const normalizedWindowMs = Math.max(1, Math.round(windowMs));
        const normalizedWindowSeconds = Math.max(1, Math.round(normalizedWindowMs / 1000));
        const rateDesc = new RateLimitDesc(desc[1], normalizedWindowSeconds);
        const counterKey = `${key}:${normalizedWindowSeconds}:${desc[1]}`;
        const record = this.buildRecord(undefined, tags);
        await this.enforceCosmos(counterKey, [rateDesc], now, normalizedWindowMs);

        return record;
    }

    record(input: { uid?: string; tags: string[]; status?: API_CALL_STATUS; chargeAmount?: number; }) {
        const record = this.buildRecord(input.uid, input.tags);
        record.status = input.status ?? record.status;
        record.chargeAmount = input.chargeAmount ?? record.chargeAmount;
        return record;
    }
}
