import { Serper } from 'serper';
import { z } from 'zod';

export class SerperRequestError extends Error {
    status?: number;
    body?: string;

    constructor(message: string, status?: number, body?: string) {
        super(message);
        this.name = 'SerperRequestError';
        this.status = status;
        this.body = body;
    }
}

export type SerperSearchQueryParams = {
    q: string;
    num?: number;
    gl?: string;
    hl?: string;
    location?: string;
    tbs?: string;
    page?: number;
    [key: string]: any;
};

export type SerperSiteLink = {
    link: string;
    title: string;
    snippet?: string;
};

export type SerperWebResult = {
    link: string;
    url: string;
    title: string;
    snippet: string;
    source?: string;
    date?: string;
    imageUrl?: string;
    imageWidth?: number;
    imageHeight?: number;
    siteLinks?: SerperSiteLink[];
};

export type SerperImageResult = {
    link: string;
    url: string;
    title: string;
    snippet?: string;
    source?: string;
    imageUrl?: string;
    imageWidth?: number;
    imageHeight?: number;
};

export type SerperNewsResult = {
    link: string;
    url: string;
    title: string;
    snippet: string;
    source?: string;
    date?: string;
    imageUrl?: string;
};

export type SerperWebSearchResponse = {
    organic: any[];
    results?: any[];
    [key: string]: any;
};

export type SerperImageSearchResponse = {
    images: any[];
    [key: string]: any;
};

export type SerperNewsSearchResponse = {
    news: any[];
    [key: string]: any;
};

const webResponseSchema = z.object({
    organic: z.array(z.unknown()).optional(),
    parsed: z.object({
        organic: z.array(z.unknown()).optional(),
        results: z.array(z.unknown()).optional(),
    }).optional(),
}).passthrough();

const imagesResponseSchema = z.object({
    images: z.array(z.unknown()).optional(),
    parsed: z.object({
        images: z.array(z.unknown()).optional(),
    }).optional(),
}).passthrough();

const newsResponseSchema = z.object({
    news: z.array(z.unknown()).optional(),
    parsed: z.object({
        news: z.array(z.unknown()).optional(),
    }).optional(),
}).passthrough();

const toTrimmedString = (value: unknown) => {
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
};

const toFiniteNumber = (value: unknown) => {
    if (typeof value !== 'number') {
        return undefined;
    }

    return Number.isFinite(value) ? value : undefined;
};

const toStatusCode = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === 'string') {
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return undefined;
};

const inferStatusFromMessage = (message: string) => {
    const statusMatch = /\b([45]\d{2})\b/.exec(message);
    if (statusMatch?.[1]) {
        return Number(statusMatch[1]);
    }

    if (/rate limit/i.test(message)) {
        return 429;
    }

    if (/unauthorized|invalid api key|authentication/i.test(message)) {
        return 401;
    }

    return undefined;
};

const normalizeSiteLinks = (value: unknown): SerperSiteLink[] => {
    if (!Array.isArray(value)) {
        return [];
    }

    const siteLinks: SerperSiteLink[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') {
            continue;
        }

        const record = item as Record<string, unknown>;
        const link = toTrimmedString(record.link ?? record.url);
        if (!link) {
            continue;
        }

        const title = toTrimmedString(record.title) ?? link;
        const snippet = toTrimmedString(record.snippet);
        siteLinks.push({ link, title, snippet });
    }

    return siteLinks;
};

const normalizeOrganic = (entry: unknown, fallbackTitle?: string): SerperWebResult | undefined => {
    if (!entry || typeof entry !== 'object') {
        return undefined;
    }

    const record = entry as Record<string, unknown>;
    const link = toTrimmedString(record.link ?? record.url);
    if (!link) {
        return undefined;
    }

    const title = toTrimmedString(record.title) ?? (fallbackTitle || link);
    const snippet = toTrimmedString(record.snippet ?? record.content) ?? '';
    const source = toTrimmedString(record.source);
    const date = toTrimmedString(record.date ?? record.datePublished);
    const imageUrl = toTrimmedString(record.imageUrl ?? record.thumbnailUrl);
    const imageWidth = toFiniteNumber(record.imageWidth);
    const imageHeight = toFiniteNumber(record.imageHeight);
    const siteLinksRaw = record.siteLinks ?? record.sitelinks;
    const siteLinks = normalizeSiteLinks(siteLinksRaw);

    return {
        link,
        url: link,
        title,
        snippet,
        source,
        date,
        imageUrl,
        imageWidth,
        imageHeight,
        siteLinks: siteLinks.length ? siteLinks : undefined,
    };
};

const normalizeImage = (entry: unknown): SerperImageResult | undefined => {
    if (!entry || typeof entry !== 'object') {
        return undefined;
    }

    const record = entry as Record<string, unknown>;
    const link = toTrimmedString(record.link ?? record.imageUrl ?? record.thumbnailUrl);
    if (!link) {
        return undefined;
    }

    const title = toTrimmedString(record.title) ?? link;
    const snippet = toTrimmedString(record.snippet);
    const source = toTrimmedString(record.source);
    const imageUrl = toTrimmedString(record.imageUrl ?? record.thumbnailUrl);
    const imageWidth = toFiniteNumber(record.imageWidth ?? record.width);
    const imageHeight = toFiniteNumber(record.imageHeight ?? record.height);

    return {
        link,
        url: link,
        title,
        snippet,
        source,
        imageUrl,
        imageWidth,
        imageHeight,
    };
};

const normalizeNews = (entry: unknown): SerperNewsResult | undefined => {
    if (!entry || typeof entry !== 'object') {
        return undefined;
    }

    const record = entry as Record<string, unknown>;
    const link = toTrimmedString(record.link ?? record.url);
    if (!link) {
        return undefined;
    }

    const title = toTrimmedString(record.title) ?? link;
    const snippet = toTrimmedString(record.snippet ?? record.content) ?? '';
    const source = toTrimmedString(record.source);
    const date = toTrimmedString(record.date ?? record.datePublished);
    const imageUrl = toTrimmedString(record.imageUrl ?? record.thumbnailUrl);

    return {
        link,
        url: link,
        title,
        snippet,
        source,
        date,
        imageUrl,
    };
};

const mapArray = <T>(
    value: unknown,
    normalize: (entry: unknown) => T | undefined,
): T[] => {
    if (!Array.isArray(value)) {
        return [];
    }

    const mapped: T[] = [];
    for (const entry of value) {
        const normalized = normalize(entry);
        if (normalized) {
            mapped.push(normalized);
        }
    }

    return mapped;
};

const dedupeByLink = <T extends { link: string; }>(items: T[]) => {
    const seen = new Set<string>();
    const deduped: T[] = [];

    for (const item of items) {
        if (seen.has(item.link)) {
            continue;
        }

        seen.add(item.link);
        deduped.push(item);
    }

    return deduped;
};

const buildMockEntry = (q: string): SerperWebResult => {
    const safeQuery = q.trim() || 'Result';
    const url = `https://example.com/search?q=${encodeURIComponent(safeQuery)}`;

    return {
        title: safeQuery,
        link: url,
        url,
        snippet: `Mock result for ${safeQuery}`,
    };
};

const extractDownstreamError = (result: unknown) => {
    if (!result || typeof result !== 'object') {
        return undefined;
    }

    const record = result as Record<string, unknown>;
    const message = toTrimmedString(record.message ?? record.error);
    const status = toFiniteNumber(record.statusCode ?? record.status);

    if (!message) {
        return undefined;
    }

    return { message, status };
};

export class SerperGoogleHTTP {
    protected readonly baseUrl = 'https://google.serper.dev';
    protected readonly apiKey: string;
    protected readonly client?: Serper;

    constructor(apiKey?: string) {
        this.apiKey = apiKey?.trim() ?? '';
        this.client = this.apiKey ? new Serper({ apiKey: this.apiKey, basePath: this.baseUrl, cache: false }) : undefined;
    }

    protected buildBody(query: SerperSearchQueryParams, extra?: Record<string, unknown>) {
        const body: Record<string, unknown> = { q: (query.q ?? '').trim() };
        const { num, gl, hl, location, page, tbs } = query;

        if (typeof num === 'number' && Number.isFinite(num)) {
            body.num = num;
        }

        if (gl !== undefined) {
            body.gl = gl;
        }

        if (hl !== undefined) {
            body.hl = hl;
        }

        if (location !== undefined) {
            body.location = location;
        }

        if (typeof page === 'number' && Number.isFinite(page)) {
            body.page = page;
        }

        if (tbs !== undefined) {
            body.tbs = tbs;
        }

        for (const [key, value] of Object.entries(extra ?? {})) {
            if (value !== undefined) {
                body[key] = value;
            }
        }

        return body;
    }

    protected async request(
        endpoint: 'search' | 'images' | 'news',
        body: Record<string, unknown>,
        mock: Record<string, unknown>,
    ) {
        if (!this.client) {
            return mock;
        }

        try {
            switch (endpoint) {
                case 'images':
                    return await this.client.images(body as any) as unknown as Record<string, unknown>;
                case 'news':
                    return await this.client.news(body as any) as unknown as Record<string, unknown>;
                case 'search':
                default:
                    return await this.client.search(body as any) as unknown as Record<string, unknown>;
            }
        } catch (error) {
            const err = error as Error;
            const errorRecord = (error && typeof error === 'object')
                ? error as Record<string, unknown>
                : undefined;
            const status = toStatusCode(
                errorRecord?.status
                ?? errorRecord?.statusCode
                ?? errorRecord?.code
            ) ?? inferStatusFromMessage(err.message);
            const body = typeof errorRecord?.body === 'string'
                ? errorRecord.body
                : (typeof errorRecord?.responseData === 'string' ? errorRecord.responseData : undefined);
            throw new SerperRequestError(
                `Serper request failed: ${err.message}`,
                status,
                body,
            );
        }
    }

    async webSearch(query: SerperSearchQueryParams) {
        const q = (query.q ?? '').trim();
        if (!q) {
            return { organic: [], parsed: { organic: [], results: [] } };
        }

        const body = this.buildBody({ ...query, q });
        const json = webResponseSchema.parse(await this.request(
            'search',
            body,
            { organic: [buildMockEntry(q)], parsed: { organic: [buildMockEntry(q)], results: [buildMockEntry(q)] } },
        ));

        const downstreamError = extractDownstreamError(json);
        if (downstreamError && !Array.isArray(json.organic) && !Array.isArray(json.parsed?.organic)) {
            throw new SerperRequestError(
                `Serper request failed: ${downstreamError.message}`,
                downstreamError.status,
            );
        }

        const organic = dedupeByLink([
            ...mapArray(json.parsed?.results, (entry) => normalizeOrganic(entry, q)),
            ...mapArray(json.parsed?.organic, (entry) => normalizeOrganic(entry, q)),
            ...mapArray(json.organic, (entry) => normalizeOrganic(entry, q)),
        ]);

        const resolvedOrganic = organic.length ? organic : [buildMockEntry(q)];
        return { organic: resolvedOrganic, parsed: { organic: resolvedOrganic, results: resolvedOrganic } };
    }

    async imageSearch(query: SerperSearchQueryParams) {
        const q = (query.q ?? '').trim();
        if (!q) {
            return { images: [], parsed: { images: [] } };
        }

        const body = this.buildBody({ ...query, q });
        const json = imagesResponseSchema.parse(await this.request(
            'images',
            body,
            { images: [], parsed: { images: [] } },
        ));

        const downstreamError = extractDownstreamError(json);
        if (downstreamError && !Array.isArray(json.images)) {
            throw new SerperRequestError(
                `Serper request failed: ${downstreamError.message}`,
                downstreamError.status,
            );
        }

        const images = dedupeByLink([
            ...mapArray(json.parsed?.images, normalizeImage),
            ...mapArray(json.images, normalizeImage),
        ]);

        return { images, parsed: { images } };
    }

    async newsSearch(query: SerperSearchQueryParams) {
        const q = (query.q ?? '').trim();
        if (!q) {
            return { news: [], parsed: { news: [] } };
        }

        const body = this.buildBody({ ...query, q });
        const json = newsResponseSchema.parse(await this.request(
            'news',
            body,
            { news: [], parsed: { news: [] } },
        ));

        const downstreamError = extractDownstreamError(json);
        if (downstreamError && !Array.isArray(json.news)) {
            throw new SerperRequestError(
                `Serper request failed: ${downstreamError.message}`,
                downstreamError.status,
            );
        }

        const news = dedupeByLink([
            ...mapArray(json.parsed?.news, normalizeNews),
            ...mapArray(json.news, normalizeNews),
        ]);

        return { news, parsed: { news } };
    }
}

export class SerperBingHTTP extends SerperGoogleHTTP {
    constructor(apiKey?: string) {
        super(apiKey);
    }

    protected override buildBody(query: SerperSearchQueryParams, extra?: Record<string, unknown>) {
        return super.buildBody(query, { ...extra, engine: 'bing' });
    }
}

export const WORLD_COUNTRIES = {
    US: 'United States',
    GB: 'United Kingdom',
    CA: 'Canada',
    AU: 'Australia',
    DE: 'Germany',
    FR: 'France',
    IN: 'India',
    JP: 'Japan',
    KR: 'South Korea',
    BR: 'Brazil',
} as const;

export const WORLD_LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'es', name: 'Spanish' },
    { code: 'fr', name: 'French' },
    { code: 'de', name: 'German' },
    { code: 'pt', name: 'Portuguese' },
    { code: 'ja', name: 'Japanese' },
    { code: 'ko', name: 'Korean' },
    { code: 'zh', name: 'Chinese' },
] as const;
