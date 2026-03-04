import { getManagedIdentityAccessToken } from '../services/azure-managed-identity-token';

export type JinaDashboardUser = {
    user_id?: string;
    full_name?: string;
    wallet?: { total_balance: number; total_used?: number; };
    metadata?: any;
    customRateLimits?: any;
};

type JinaDashboardResponse<T> = {
    data: T;
    [key: string]: unknown;
};

const DASHBOARD_BASE_URL = 'https://api.jina.ai/dashboard';
const DEFAULT_TIMEOUT_MS = 10_000;

const isObject = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const normalizeUser = (input: unknown): JinaDashboardUser => {
    if (!isObject(input)) {
        return {};
    }

    const walletSource = isObject(input.wallet) ? input.wallet : {};
    const wallet = {
        total_balance: typeof walletSource.total_balance === 'number' ? walletSource.total_balance : 0,
        total_used: typeof walletSource.total_used === 'number' ? walletSource.total_used : undefined,
    };

    return {
        user_id: typeof input.user_id === 'string' ? input.user_id : undefined,
        full_name: typeof input.full_name === 'string' ? input.full_name : undefined,
        wallet,
        metadata: isObject(input.metadata) ? input.metadata : undefined,
        customRateLimits: isObject(input.customRateLimits) ? input.customRateLimits as Record<string, unknown[]> : undefined,
    };
};

const withTimeout = (timeoutMs: number) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs).unref();
    return { signal: controller.signal, cancel: () => clearTimeout(timeout) };
};

export class JinaEmbeddingsDashboardHTTP {
    private readonly apiKey?: string;
    private readonly baseUrl: string;
    private readonly audience?: string;
    private readonly managedIdentityClientId?: string;

    constructor(apiKey?: string, baseUrl: string = DASHBOARD_BASE_URL, audience?: string, managedIdentityClientId?: string) {
        this.apiKey = apiKey?.trim();
        this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
        this.audience = audience?.trim();
        this.managedIdentityClientId = managedIdentityClientId?.trim();
    }

    private async resolveServerCredential(): Promise<string | undefined> {
        if (this.audience) {
            const managedIdentityToken = await getManagedIdentityAccessToken(
                this.audience,
                this.managedIdentityClientId
            );
            if (managedIdentityToken) {
                return managedIdentityToken;
            }
        }

        if (this.apiKey) {
            return this.apiKey;
        }

        return undefined;
    }

    private async post(path: string, token: string, payload: Record<string, unknown>) {
        if (!token) {
            const err = new Error('Missing token') as Error & { status?: number; };
            err.status = 401;
            throw err;
        }

        const serverCredential = await this.resolveServerCredential();
        if (!serverCredential) {
            const err = new Error(
                'Missing server credential. Configure JINA_EMBEDDINGS_DASHBOARD_AUDIENCE or JINA_EMBEDDINGS_DASHBOARD_API_KEY.'
            ) as Error & { status?: number; };
            err.status = 500;
            throw err;
        }

        const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
        const controller = withTimeout(DEFAULT_TIMEOUT_MS);

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${serverCredential}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            controller.cancel();

            if (res.ok) {
                const json = await res.json().catch(() => ({}));
                return json as Record<string, unknown>;
            }

            const text = await res.text().catch(() => '');
            const err = new Error(`Jina dashboard request failed: ${res.status} ${res.statusText}`) as Error & {
                status?: number;
                body?: string;
            };
            err.status = res.status;
            err.body = text;
            throw err;
        } catch (err) {
            controller.cancel();
            throw err;
        }
    }

    async authorization(token: string): Promise<JinaDashboardResponse<JinaDashboardUser>> {
        const response = await this.post('/authorization', token, { token });
        response.data = normalizeUser(response.data);
        return response as JinaDashboardResponse<JinaDashboardUser>;
    }

    async validateToken(token: string): Promise<JinaDashboardResponse<JinaDashboardUser>> {
        const response = await this.post('/validate', token, { token });
        response.data = normalizeUser(response.data);
        return response as JinaDashboardResponse<JinaDashboardUser>;
    }

    async reportUsage(token: string, body: Record<string, unknown>) {
        return this.post('/usage', token, { token, ...body });
    }
}
