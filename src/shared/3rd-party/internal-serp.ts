import { SerperGoogleHTTP, SerperSearchQueryParams, SerperWebSearchResponse } from './serper-search';
import { BraveSearchHTTP } from './brave-search';

type NormalizedResult = {
    title: string;
    url: string;
    link: string;
    snippet: string;
};

const buildMockEntry = (q: string): NormalizedResult => {
    const safeQuery = q || 'Result';
    const url = `https://example.com/search?q=${encodeURIComponent(safeQuery)}`;
    return {
        title: safeQuery,
        url,
        link: url,
        snippet: `Internal Jina SERP mock result for ${safeQuery}`,
    };
};

const normalizeEntry = (entry: unknown, fallbackTitle: string): NormalizedResult | undefined => {
    if (entry === null || entry === undefined || typeof entry !== 'object') {
        return undefined;
    }
    const record = entry as Record<string, unknown>;
    const rawLink = record.link ?? record.url;
    const link = typeof rawLink === 'string' && rawLink.trim() ? rawLink.trim() : '';
    if (!link) {
        return undefined;
    }
    const titleSource = record.title;
    const title = typeof titleSource === 'string' && titleSource.trim() ? titleSource.trim() : (fallbackTitle || link);
    const snippetSource = record.snippet ?? record.content;
    const snippet = typeof snippetSource === 'string' ? snippetSource : '';

    return {
        title,
        url: link,
        link,
        snippet,
    };
};

const normalizeList = (items: unknown, fallbackTitle: string): NormalizedResult[] => {
    if (!Array.isArray(items)) {
        return [];
    }
    const normalized: NormalizedResult[] = [];
    for (const item of items) {
        const mapped = normalizeEntry(item, fallbackTitle);
        if (mapped) {
            normalized.push(mapped);
        }
    }
    return normalized;
};

const dedupeByLink = (items: NormalizedResult[]) => {
    const seen = new Set<string>();
    const result: NormalizedResult[] = [];
    for (const item of items) {
        if (seen.has(item.link)) {
            continue;
        }
        seen.add(item.link);
        result.push(item);
    }
    return result;
};

const normalizeBraveEntry = (entry: unknown, fallbackTitle: string): NormalizedResult | undefined => {
    if (entry === null || entry === undefined || typeof entry !== 'object') {
        return undefined;
    }
    const record = entry as Record<string, unknown>;
    const rawLink = record.url ?? record.link;
    const link = typeof rawLink === 'string' && rawLink.trim().length > 0 ? rawLink.trim() : '';
    if (!link) {
        return undefined;
    }
    const titleSource = record.title;
    const title = typeof titleSource === 'string' && titleSource.trim().length > 0 ? titleSource.trim() : (fallbackTitle || link);
    const snippetSource = record.snippet ?? record.description ?? record.content;
    const snippet = typeof snippetSource === 'string' ? snippetSource : '';

    return {
        title,
        url: link,
        link,
        snippet,
    };
};

export class JinaSerpApiHTTP {
    private client?: SerperGoogleHTTP;
    private braveClient?: BraveSearchHTTP;

    constructor(apiKey?: string, braveApiKey?: string) {
        const normalizedApiKey = apiKey?.trim() ?? '';
        if (normalizedApiKey.length > 0) {
            this.client = new SerperGoogleHTTP(normalizedApiKey);
        }

        const resolvedBraveKey = (braveApiKey ?? process.env.BRAVE_SEARCH_API_KEY ?? '').trim();
        if (resolvedBraveKey.length > 0) {
            this.braveClient = new BraveSearchHTTP(resolvedBraveKey);
        }
    }

    async webSearch(_query: SerperSearchQueryParams): Promise<SerperWebSearchResponse> {
        const q = (_query.q ?? '').trim();
        if (!q) {
            return { organic: [], parsed: { organic: [], results: [] } };
        }

        if (this.braveClient) {
            try {
                const response = await this.braveClient.webSearch({ ..._query, q });
                const results = response?.parsed?.web?.results ?? [];
                const normalized = dedupeByLink(
                    results
                        .map((entry: unknown) => normalizeBraveEntry(entry, q))
                        .filter((entry): entry is NormalizedResult => entry !== undefined)
                );
                const limited = typeof _query.num === 'number' ? normalized.slice(0, _query.num) : normalized;
                if (limited.length > 0) {
                    return { organic: limited, parsed: { organic: limited, results: limited } };
                }
            } catch (_err) {
                // Ignore Brave errors and fall back to other sources.
            }
        }

        if (this.client) {
            const response = await this.client.webSearch({ ..._query, q });
            const normalized = dedupeByLink([
                ...normalizeList(response.parsed?.results, q),
                ...normalizeList(response.parsed?.organic, q),
                ...normalizeList(response.organic, q),
            ]);

            const limited = typeof _query.num === 'number' ? normalized.slice(0, _query.num) : normalized;
            const organic = limited.length ? limited : [buildMockEntry(q)];
            return { organic, parsed: { organic, results: organic } };
        }

        const organic = [buildMockEntry(q)];
        return { organic, parsed: { organic, results: organic } };
    }
}
