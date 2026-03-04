import { AutoCastable, AuthenticationRequiredError } from 'civkit/civ-rpc';

/**
 * Thin compatibility DTO kept for legacy imports from `../shared/dto/jina-embeddings-auth`.
 * The active implementation lives in `src/dto/jina-embeddings-auth.ts`.
 */
export class JinaEmbeddingsAuthDTO extends AutoCastable {
    uid?: string;
    bearerToken?: string;
    user?: any;

    static override from(input: any) {
        const instance = super.from(input) as JinaEmbeddingsAuthDTO;
        if (!instance.bearerToken && input?._token) {
            instance.bearerToken = input._token;
        }
        return instance;
    }

    async getBrief(_ignoreCache?: boolean | string) {
        return this.user;
    }

    async reportUsage(_tokenCount: number, _mdl: string, _endpoint?: string) {
        return undefined;
    }

    async solveUID() {
        return this.uid;
    }

    async assertUID() {
        if (!this.uid) {
            throw new AuthenticationRequiredError('Authentication failed');
        }

        return this.uid;
    }

    async assertUser() {
        if (!this.user) {
            throw new AuthenticationRequiredError('Authentication failed');
        }

        return this.user;
    }

    async assertTier(_n: number, _feature?: string) {
        return true;
    }

    getRateLimits(..._tags: string[]) {
        return undefined;
    }
}
