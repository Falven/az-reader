import {
    BraveSearch,
    type BraveSearchOptions,
    type WebSearchApiResponse,
} from 'brave-search';
import type { WebSearchOptionalHeaderOptions } from './brave-types';

export type WebSearchQueryParams = {
    q: string;
    count?: number;
    searchLang?: string;
    search_lang?: string;
    country?: string;
    safesearch?: string;
    spellcheck?: boolean;
    [key: string]: unknown;
};

export type BraveSearchResult = {
    title: string;
    url: string;
    description?: string;
    snippet?: string;
    [key: string]: unknown;
};

export type BraveWebSearchParsed = {
    web: {
        results: BraveSearchResult[];
    };
};

type BraveRawResponse = {
    web?: {
        results?: unknown[];
    };
    [key: string]: unknown;
};

const toTrimmedString = (value: unknown) => {
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
};

const normalizeBraveResult = (entry: unknown): BraveSearchResult | undefined => {
    if (!entry || typeof entry !== 'object') {
        return undefined;
    }

    const record = entry as Record<string, unknown>;
    const url = toTrimmedString(record.url ?? record.link);
    if (!url) {
        return undefined;
    }

    const title = toTrimmedString(record.title) ?? url;
    const description = toTrimmedString(record.description ?? record.snippet ?? record.content);

    return {
        ...record,
        title,
        url,
        description,
        snippet: description,
    };
};

const normalizeWebResults = (input: unknown) => {
    if (!Array.isArray(input)) {
        return [];
    }

    const results: BraveSearchResult[] = [];
    for (const entry of input) {
        const normalized = normalizeBraveResult(entry);
        if (normalized) {
            results.push(normalized);
        }
    }

    return results;
};

const normalizeHeaders = (headers?: WebSearchOptionalHeaderOptions) => {
    if (!headers) {
        return undefined;
    }

    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (typeof value === 'string') {
            output[key] = value;
        }
    }

    return Object.keys(output).length > 0 ? output : undefined;
};

const getHeaderValue = (headers: Record<string, string> | undefined, key: string) => {
    if (!headers) {
        return undefined;
    }

    const lowerTarget = key.toLowerCase();
    for (const [headerName, value] of Object.entries(headers)) {
        if (headerName.toLowerCase() === lowerTarget) {
            return value;
        }
    }

    return undefined;
};

const toErrorString = (value: unknown) => {
    if (typeof value === 'string') {
        return value;
    }

    if (value === undefined) {
        return '';
    }

    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
};

const inferStatus = (err: Error) => {
    const match = /API error \((\d+)\):/i.exec(err.message);
    if (match?.[1]) {
        return Number(match[1]);
    }

    if (/rate limit exceeded/i.test(err.message)) {
        return 429;
    }

    if (/authentication error/i.test(err.message)) {
        return 401;
    }

    return undefined;
};

const normalizeBraveError = (err: unknown) => {
    if (err instanceof Error) {
        const normalized = err as Error & { status?: number; body?: string; responseData?: unknown };
        const status = inferStatus(err);
        if (status) {
            normalized.status = status;
        }

        if (normalized.responseData !== undefined) {
            normalized.body = toErrorString(normalized.responseData);
        }

        return normalized;
    }

    const message = typeof err === 'string' ? err : 'Unknown Brave search error';
    const wrapped = new Error(message) as Error & { status?: number; body?: string };
    wrapped.body = toErrorString(err);
    return wrapped;
};

const toBraveOptions = (query: WebSearchQueryParams, headers: Record<string, string> | undefined) => {
    const searchLang = toTrimmedString(query.searchLang ?? query.search_lang ?? getHeaderValue(headers, 'Accept-Language'));
    const country = toTrimmedString(query.country ?? getHeaderValue(headers, 'X-Loc-Country'));

    const options: BraveSearchOptions = {};
    if (typeof query.count === 'number' && Number.isFinite(query.count)) {
        options.count = query.count;
    }
    if (searchLang) {
        options.search_lang = searchLang;
    }
    if (country) {
        options.country = country;
    }
    if (query.safesearch && typeof query.safesearch === 'string') {
        options.safesearch = query.safesearch as BraveSearchOptions['safesearch'];
    }
    if (typeof query.spellcheck === 'boolean') {
        options.spellcheck = query.spellcheck;
    }

    return options;
};

export class BraveSearchHTTP {
    constructor(private readonly apiKey?: string) {}

    private async request(query: WebSearchQueryParams, opts?: { headers?: WebSearchOptionalHeaderOptions }) {
        const q = toTrimmedString(query.q) ?? '';
        if (!q) {
            return { web: { results: [] } } satisfies BraveRawResponse;
        }

        if (!this.apiKey) {
            return {
                web: {
                    results: [
                        {
                            title: q,
                            url: `https://example.com/search?q=${encodeURIComponent(q)}`,
                            description: `Mock Brave search result for ${q}`,
                        }
                    ]
                }
            } satisfies BraveRawResponse;
        }

        const normalizedHeaders = normalizeHeaders(opts?.headers);
        const options = toBraveOptions(query, normalizedHeaders);
        const client = new BraveSearch(this.apiKey);
        const clientWithPrivate = client as any;
        const originalGetHeaders = typeof clientWithPrivate.getHeaders === 'function'
            ? clientWithPrivate.getHeaders.bind(clientWithPrivate)
            : undefined;

        if (normalizedHeaders && originalGetHeaders) {
            clientWithPrivate.getHeaders = () => ({ ...originalGetHeaders(), ...normalizedHeaders });
        }

        try {
            return await client.webSearch(q, options) as WebSearchApiResponse;
        } catch (err) {
            throw normalizeBraveError(err);
        } finally {
            if (originalGetHeaders) {
                clientWithPrivate.getHeaders = originalGetHeaders;
            }
        }
    }

    async webSearch(query: WebSearchQueryParams, opts?: { headers?: WebSearchOptionalHeaderOptions }) {
        const payload = await this.request(query, opts);
        const results = normalizeWebResults(payload.web?.results ?? []);
        return { parsed: { web: { results } } as BraveWebSearchParsed };
    }
}
