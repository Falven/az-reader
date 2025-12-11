import { AuthenticationFailedError, AuthenticationRequiredError } from 'civkit/civ-rpc';
import 'reflect-metadata';
import { CrawlerHost } from '../api/crawler';
import { JinaEmbeddingsAuthDTO } from '../dto/jina-embeddings-auth';
import { JinaEmbeddingsTokenAccount } from './db/jina-embeddings-token-account';

/**
 * Enforce API key authentication for crawler endpoints.
 * The search server already asserts user presence; this ensures the crawler
 * path requires the same Jina token.
 */
const originalCrawl = CrawlerHost.prototype.crawl;

const selfHostTokens = new Set(
    (process.env.SELF_HOST_API_KEY || process.env.SELF_HOST_API_KEYS || '')
        .split(',')
        .map((token) => token.trim())
        .filter((token) => token !== '')
);

const makeLocalAccount = (token: string): JinaEmbeddingsTokenAccount => {
    const syntheticId = `selfhost-${token.slice(0, 8)}`;
    return JinaEmbeddingsTokenAccount.from({
        _id: token,
        user_id: syntheticId,
        full_name: 'Self-hosted user',
        wallet: { total_balance: Number.MAX_SAFE_INTEGER / 2 },
        metadata: { speed_level: '3' },
    } as Record<string, unknown>);
};

const originalGetBrief = JinaEmbeddingsAuthDTO.prototype.getBrief;

JinaEmbeddingsAuthDTO.prototype.getBrief = (async function (this: JinaEmbeddingsAuthDTO, ignoreCache?: boolean | string) {
    if (!selfHostTokens.size) {
        return originalGetBrief.call(this, ignoreCache);
    }

    const token = this.bearerToken;
    if (!token) {
        throw new AuthenticationRequiredError({
            message: 'Jina API key is required to authenticate. Please get one from https://jina.ai'
        });
    }

    if (selfHostTokens.has(token)) {
        const account = makeLocalAccount(token);
        this.user = account;
        this.uid = account.user_id;
        return account;
    }

    throw new AuthenticationFailedError({
        message: 'Invalid API key for self-hosted deployment.'
    });
}) as typeof JinaEmbeddingsAuthDTO.prototype.getBrief;

CrawlerHost.prototype.crawl = (async function (this: CrawlerHost, ...args) {
    const auth = args[2] as JinaEmbeddingsAuthDTO | undefined;
    if (!auth) {
        throw new AuthenticationRequiredError({
            message: 'Jina API key is required to authenticate. Please get one from https://jina.ai'
        });
    }
    await auth.assertUser();
    return originalCrawl.apply(this, args as Parameters<typeof originalCrawl>);
}) as typeof CrawlerHost.prototype.crawl;
