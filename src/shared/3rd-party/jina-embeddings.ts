type WalletBrief = {
    total_balance: number;
    total_used?: number;
};

type JinaUserBrief = {
    user_id?: string;
    full_name?: string;
    wallet?: WalletBrief;
    metadata?: Record<string, unknown>;
    customRateLimits?: Record<string, unknown>;
};

type DashboardResponse<T> = {
    data: T;
};

type ApiError = Error & { status?: number; body?: string; };

const DASHBOARD_BASE_URL = 'https://api.jina.ai/dashboard';
const DEFAULT_TIMEOUT_MS = 10_000;

const isObject = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const normalizeUser = (input: unknown): JinaUserBrief => {
    if (!isObject(input)) {
        return {};
    }
    const walletSource = isObject(input.wallet) ? input.wallet : {};
    const wallet: WalletBrief = {
        total_balance: typeof walletSource.total_balance === 'number' ? walletSource.total_balance : 0,
        total_used: typeof walletSource.total_used === 'number' ? walletSource.total_used : undefined,
    };

    return {
        user_id: typeof input.user_id === 'string' ? input.user_id : undefined,
        full_name: typeof input.full_name === 'string' ? input.full_name : undefined,
        wallet,
        metadata: isObject(input.metadata) ? input.metadata : undefined,
        customRateLimits: isObject(input.customRateLimits) ? input.customRateLimits : undefined,
    };
};

const buildStubUser = (token: string): JinaUserBrief => {
    const userId = token ? `user_${token.slice(0, 8)}` : 'anonymous';
    return {
        user_id: userId,
        full_name: userId,
        wallet: { total_balance: 1_000_000 },
    };
};

const withTimeout = (timeoutMs: number) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs).unref();
    return { signal: controller.signal, cancel: () => clearTimeout(timeout) };
};

export class JinaEmbeddingsDashboardHTTP {
    private apiKey: string;
    private baseUrl: string;

    constructor(apiKey: string, baseUrl: string = DASHBOARD_BASE_URL) {
        this.apiKey = apiKey?.trim();
        this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    }

    private async post<T>(
        paths: string[],
        token: string,
        payload: Record<string, unknown>
    ): Promise<T> {
        if (!token) {
            const err: ApiError = new Error('Missing token');
            err.status = 401;
            throw err;
        }

        if (!this.apiKey) {
            // No server credential available; behave like the legacy stub.
            return { data: buildStubUser(token) } as T;
        }

        let lastError: ApiError | undefined;
        for (const path of paths) {
            const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
            const controller = withTimeout(DEFAULT_TIMEOUT_MS);
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                    },
                    body: JSON.stringify(payload),
                    signal: controller.signal,
                });
                controller.cancel();

                if (res.ok) {
                    const json = await res.json().catch(() => ({})) as unknown;
                    return json as T;
                }

                const text = await res.text().catch(() => '');
                const err: ApiError = new Error(`Jina dashboard request failed: ${res.status} ${res.statusText}`);
                err.status = res.status;
                err.body = text;
                lastError = err;

                // Try the next candidate path on soft errors.
                if (res.status >= 500) {
                    continue;
                }
            } catch (err) {
                controller.cancel();
                const apiErr: ApiError = err instanceof Error ? err : new Error(String(err));
                lastError = apiErr;
                continue;
            }
        }

        if (lastError) {
            throw lastError;
        }

        const err: ApiError = new Error('Jina dashboard request failed');
        err.status = 500;
        throw err;
    }

    async authorization(token: string): Promise<DashboardResponse<JinaUserBrief>> {
        const response = await this.post<DashboardResponse<JinaUserBrief>>(
            ['/authorization', '/auth/authorization'],
            token,
            { token }
        );
        response.data = normalizeUser(response.data);
        return response;
    }

    async validateToken(token: string): Promise<DashboardResponse<JinaUserBrief>> {
        const response = await this.post<DashboardResponse<JinaUserBrief>>(
            ['/validate', '/authorization', '/auth/validate'],
            token,
            { token }
        );
        response.data = normalizeUser(response.data);
        return response;
    }

    async reportUsage(token: string, body: Record<string, unknown>): Promise<unknown> {
        return this.post<unknown>(
            ['/usage', '/reportUsage', '/usage/report'],
            token,
            { token, ...body }
        );
    }
}
