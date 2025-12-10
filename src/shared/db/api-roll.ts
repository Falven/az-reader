import { randomUUID } from 'crypto';
import { FirestoreRecord } from '../lib/firestore';

export enum API_CALL_STATUS {
    SUCCESS = 'SUCCESS',
    FAILURE = 'FAILURE'
}

type APIRollInput = {
    _id?: string;
    uid?: string;
    tags?: string[];
    status?: API_CALL_STATUS;
    chargeAmount?: number;
    createdAt?: Date;
};

const toNormalizedTags = (input?: string[]) => {
    if (!Array.isArray(input)) {
        return [] as string[];
    }

    const normalized: string[] = [];
    for (const tag of input) {
        if (typeof tag !== 'string') {
            continue;
        }
        const trimmed = tag.trim();
        if (trimmed.length === 0) {
            continue;
        }
        if (!normalized.includes(trimmed)) {
            normalized.push(trimmed);
        }
    }

    return normalized;
};

export class APIRoll extends FirestoreRecord {
    static override collectionName = 'apiRolls';

    override _id: string = '';
    uid?: string;
    tags: string[] = [];
    status: API_CALL_STATUS = API_CALL_STATUS.SUCCESS;
    chargeAmount: number = 0;
    createdAt: Date = new Date();

    static override from(input: APIRollInput): APIRoll {
        const roll = super.from(input) as APIRoll;
        roll._id = typeof roll._id === 'string' && roll._id.length > 0 ? roll._id : (input._id ?? randomUUID());
        roll.uid = typeof input.uid === 'string' && input.uid.length > 0 ? input.uid : roll.uid;
        roll.tags = toNormalizedTags(input.tags ?? roll.tags);
        roll.status = roll.status ?? API_CALL_STATUS.SUCCESS;
        roll.chargeAmount = typeof roll.chargeAmount === 'number' && Number.isFinite(roll.chargeAmount) ? roll.chargeAmount : 0;
        roll.createdAt = roll.createdAt ?? new Date();

        return roll;
    }

    static create(input: APIRollInput): APIRoll {
        const createdAt = input.createdAt ?? new Date();
        return APIRoll.from({
            _id: input._id ?? randomUUID(),
            uid: input.uid,
            tags: input.tags,
            status: input.status ?? API_CALL_STATUS.SUCCESS,
            chargeAmount: input.chargeAmount ?? 0,
            createdAt,
        });
    }

    async persist(): Promise<APIRoll | undefined> {
        const uidMissing = this.uid === undefined || this.uid === null || this.uid === '';
        if (uidMissing) {
            return undefined;
        }
        if (this._id.length === 0) {
            this._id = randomUUID();
        }
        if (this.createdAt === undefined || this.createdAt === null) {
            this.createdAt = new Date();
        }

        return APIRoll.save(this, this._id, true) as Promise<APIRoll | undefined>;
    }
}
