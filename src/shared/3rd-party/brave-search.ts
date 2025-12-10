import { WebSearchOptionalHeaderOptions } from './brave-types';

export type WebSearchQueryParams = {
    q?: string;
    count?: number;
    searchLang?: string;
    safesearch?: string;
    spellcheck?: string;
};

export class BraveSearchHTTP {
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    private buildSearchUrl(query: WebSearchQueryParams) {
        const url = new URL('https://api.search.brave.com/res/v1/web/search');
        const paramMap: Record<keyof WebSearchQueryParams, string> = {
            q: 'q',
            count: 'count',
            searchLang: 'search_lang',
            safesearch: 'safesearch',
            spellcheck: 'spellcheck',
        };

        for (const [key, value] of Object.entries(query) as Array<[
            keyof WebSearchQueryParams,
            WebSearchQueryParams[keyof WebSearchQueryParams],
        ]>) {
            if (value === undefined || value === null) {
                continue;
            }
            const paramName = paramMap[key];
            if (!paramName) {
                continue;
            }
            url.searchParams.set(paramName, String(value));
        }

        return url;
    }

    private async request(query: WebSearchQueryParams, opts?: { headers?: WebSearchOptionalHeaderOptions; }) {
        if (!query.q) {
            return { web: { results: [] } };
        }
        if (!this.apiKey) {
            return {
                web: {
                    results: [
                        {
                            title: query.q,
                            url: `https://example.com/search?q=${encodeURIComponent(query.q)}`,
                            description: `Mock Brave search result for ${query.q}`,
                        }
                    ]
                }
            };
        }
        const url = this.buildSearchUrl(query);
        const headers: Record<string, string> = {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': this.apiKey,
        };

        for (const [key, value] of Object.entries(opts?.headers ?? {})) {
            if (value !== undefined && value !== null) {
                headers[key] = value;
            }
        }

        if (query.searchLang && !headers['Accept-Language']) {
            headers['Accept-Language'] = query.searchLang;
        }

        const res = await fetch(url, {
            method: 'GET',
            headers,
            // Brave expects query params; construct url manually
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            type BraveSearchError = Error & { status?: number; body?: string; };
            const error: BraveSearchError = new Error(`Brave search failed: ${res.status} ${res.statusText}`);
            error.status = res.status;
            error.body = text;
            throw error;
        }
        const json = await res.json();
        return json;
    }

    async webSearch(_query: WebSearchQueryParams, _opts?: { headers?: WebSearchOptionalHeaderOptions; }): Promise<{ parsed: any; }> {
        const payload = await this.request(_query, _opts);
        const results = payload?.web?.results ?? [];
        return { parsed: { web: { results } } };
    }
}
