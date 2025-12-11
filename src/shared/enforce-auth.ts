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

type TokenSource = {
    tokens: Set<string>;
    fetchedAt: number;
};

const TOKEN_CACHE_TTL_MS = 60_000;
let cachedTokenSource: TokenSource | null = null;

const vaultSecretName = process.env.SELF_HOST_TOKENS_SECRET_NAME || 'self-host-tokens';
const vaultUrl = (process.env.SELF_HOST_TOKENS_VAULT_URL || '').replace(/\/+$/, '');
const managedIdentityClientId = process.env.AZURE_CLIENT_ID;

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

const fetchManagedIdentityToken = async (): Promise<string> => {
    const endpoint = process.env.IDENTITY_ENDPOINT || 'http://169.254.169.254/metadata/identity/oauth2/token';
    const identityHeader = process.env.IDENTITY_HEADER;
    const params = new URLSearchParams({
        resource: 'https://vault.azure.net',
        'api-version': '2019-08-01',
    });
    if (managedIdentityClientId) {
        params.append('client_id', managedIdentityClientId);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
        const response = await fetch(`${endpoint}?${params.toString()}`, {
            method: 'GET',
            headers: {
                Metadata: 'true',
                ...(identityHeader ? { 'X-IDENTITY-HEADER': identityHeader } : {}),
            },
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new AuthenticationFailedError({ message: `Unable to acquire managed identity token (${response.status})` });
        }

        const body = await response.json() as { access_token?: string; };
        if (!body.access_token) {
            throw new AuthenticationFailedError({ message: 'Managed identity token response missing access_token.' });
        }

        return body.access_token;
    } catch (err) {
        if (err instanceof AuthenticationFailedError) {
            throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new AuthenticationFailedError({ message: `Unable to acquire managed identity token: ${message}` });
    } finally {
        clearTimeout(timeout);
    }
};

const parseTokenList = (raw: string): Set<string> => {
    if (raw.trim() === '') {
        return new Set<string>();
    }

    const entries = raw
        .replace(/\n/g, ';')
        .replace(/,/g, ';')
        .split(';')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    const tokens = new Set<string>();
    for (const entry of entries) {
        const [_, value] = entry.includes(':') ? entry.split(':', 2) : ['', entry];
        if (value && value.trim().length > 0) {
            tokens.add(value.trim());
        }
    }

    return tokens;
};

const fetchVaultTokens = async (): Promise<Set<string>> => {
    if (!vaultUrl) {
        throw new AuthenticationFailedError({ message: 'Key Vault URL is not configured for self-host tokens.' });
    }

    const accessToken = await fetchManagedIdentityToken();

    const secretUrl = `${vaultUrl}/secrets/${vaultSecretName}?api-version=7.4`;
    const response = await fetch(secretUrl, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new AuthenticationFailedError({
            message: `Unable to read self-host tokens from Key Vault (${response.status}) ${errorBody}`.trim()
        });
    }

    const body = await response.json() as { value?: string; };
    const value = typeof body.value === 'string' ? body.value : '';
    return parseTokenList(value);
};

const loadTokens = async (): Promise<Set<string>> => {
    const now = Date.now();
    if (cachedTokenSource && now - cachedTokenSource.fetchedAt < TOKEN_CACHE_TTL_MS) {
        return cachedTokenSource.tokens;
    }

    const vaultTokens = await fetchVaultTokens();
    const tokens = new Set<string>(vaultTokens);
    if (tokens.size === 0) {
        throw new AuthenticationFailedError({ message: 'No self-host tokens found in Key Vault.' });
    }

    // eslint-disable-next-line no-console
    console.info(`[self-host-auth] Loaded ${tokens.size} token(s) from Key Vault`);
    cachedTokenSource = { tokens, fetchedAt: now };
    return tokens;
};

JinaEmbeddingsAuthDTO.prototype.getBrief = (async function (this: JinaEmbeddingsAuthDTO) {
    const token = this.bearerToken;
    if (!token) {
        throw new AuthenticationRequiredError({
            message: 'Self-host token is required to authenticate.'
        });
    }

    const tokenSet = await loadTokens();
    if (tokenSet.has(token)) {
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
            message: 'Self-host token is required to authenticate.'
        });
    }
    await auth.assertUser();
    return originalCrawl.apply(this, args as Parameters<typeof originalCrawl>);
}) as typeof CrawlerHost.prototype.crawl;
