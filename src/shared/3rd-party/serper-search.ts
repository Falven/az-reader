import { z } from 'zod';

export type SerperSearchQueryParams = {
    q: string;
    num?: number;
    gl?: string;
    hl?: string;
    location?: string;
    page?: number;
    variant?: string;
};

type SerperSiteLink = {
    link: string;
    title: string;
    snippet?: string;
};

type SerperWebResult = {
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

type SerperImageResult = {
    link: string;
    url: string;
    title?: string;
    snippet?: string;
    source?: string;
    imageUrl?: string;
    imageWidth?: number;
    imageHeight?: number;
};

type SerperNewsResult = {
    link: string;
    url: string;
    title: string;
    snippet: string;
    source?: string;
    date?: string;
    imageUrl?: string;
};

export type SerperWebSearchResponse = {
    organic: SerperWebResult[];
    parsed: {
        organic: SerperWebResult[];
        results: SerperWebResult[];
    };
};

export type SerperImageSearchResponse = {
    images: SerperImageResult[];
    parsed: {
        images: SerperImageResult[];
    };
};

export type SerperNewsSearchResponse = {
    news: SerperNewsResult[];
    parsed: {
        news: SerperNewsResult[];
    };
};

export class SerperRequestError extends Error {
    status?: number;
    body?: string;

    constructor(message: string, status?: number, body?: string) {
        super(message);
        this.status = status;
        this.body = body;
    }
}

const SERPER_BASE_URL = 'https://google.serper.dev';

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

const toTrimmedString = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
};

const toFiniteNumber = (value: unknown): number | undefined => {
    if (typeof value !== 'number') {
        return undefined;
    }
    return Number.isFinite(value) ? value : undefined;
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

const normalizeOrganic = (entry: unknown, fallbackTitle: string): SerperWebResult | undefined => {
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

const mapArray = <T>(value: unknown, normalize: (entry: unknown) => T | undefined): T[] => {
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

const dedupeByLink = <T extends { link: string; }>(items: T[]): T[] => {
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

const requestSerper = async <T extends z.ZodTypeAny>(opts: {
    apiKey: string;
    baseUrl: string;
    endpoint: string;
    body: Record<string, unknown>;
    schema: T;
    mock: z.infer<T>;
}): Promise<z.infer<T>> => {
    if (!opts.apiKey.trim()) {
        return opts.mock;
    }

    const res = await fetch(`${opts.baseUrl}/${opts.endpoint}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': opts.apiKey,
        },
        body: JSON.stringify(opts.body),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new SerperRequestError(`Serper request failed: ${res.status} ${res.statusText}`, res.status, text);
    }

    const json = await res.json().catch(() => {
        throw new SerperRequestError('Serper response was not valid JSON', res.status);
    });

    return opts.schema.parse(json);
};

export class SerperGoogleHTTP {
    protected readonly apiKey: string;
    protected readonly baseUrl = SERPER_BASE_URL;

    constructor(apiKey: string) {
        this.apiKey = apiKey?.trim() ?? '';
    }

    protected buildBody(query: SerperSearchQueryParams, extra?: Record<string, unknown>): Record<string, unknown> {
        const body: Record<string, unknown> = { q: (query.q ?? '').trim() };
        const { num, gl, hl, location, page } = query;
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

        for (const [key, value] of Object.entries(extra ?? {})) {
            if (value !== undefined) {
                body[key] = value;
            }
        }

        return body;
    }

    async webSearch(query: SerperSearchQueryParams): Promise<SerperWebSearchResponse> {
        const q = (query.q ?? '').trim();
        if (!q) {
            return { organic: [], parsed: { organic: [], results: [] } };
        }
        const body = this.buildBody({ ...query, q });
        const json = await requestSerper({
            apiKey: this.apiKey,
            baseUrl: this.baseUrl,
            endpoint: 'search',
            body,
            schema: webResponseSchema,
            mock: { organic: [buildMockEntry(q)], parsed: { organic: [buildMockEntry(q)], results: [buildMockEntry(q)] } },
        });

        const organic = dedupeByLink([
            ...mapArray(json.parsed?.results, (entry) => normalizeOrganic(entry, q)),
            ...mapArray(json.parsed?.organic, (entry) => normalizeOrganic(entry, q)),
            ...mapArray(json.organic, (entry) => normalizeOrganic(entry, q)),
        ]);
        const resolvedOrganic = organic.length ? organic : [buildMockEntry(q)];

        return { organic: resolvedOrganic, parsed: { organic: resolvedOrganic, results: resolvedOrganic } };
    }

    async imageSearch(query: SerperSearchQueryParams): Promise<SerperImageSearchResponse> {
        const q = (query.q ?? '').trim();
        if (!q) {
            return { images: [], parsed: { images: [] } };
        }
        const body = this.buildBody({ ...query, q });
        const json = await requestSerper({
            apiKey: this.apiKey,
            baseUrl: this.baseUrl,
            endpoint: 'images',
            body,
            schema: imagesResponseSchema,
            mock: { images: [], parsed: { images: [] } },
        });

        const images = dedupeByLink([
            ...mapArray(json.parsed?.images, normalizeImage),
            ...mapArray(json.images, normalizeImage),
        ]);

        return { images, parsed: { images } };
    }

    async newsSearch(query: SerperSearchQueryParams): Promise<SerperNewsSearchResponse> {
        const q = (query.q ?? '').trim();
        if (!q) {
            return { news: [], parsed: { news: [] } };
        }
        const body = this.buildBody({ ...query, q });
        const json = await requestSerper({
            apiKey: this.apiKey,
            baseUrl: this.baseUrl,
            endpoint: 'news',
            body,
            schema: newsResponseSchema,
            mock: { news: [], parsed: { news: [] } },
        });

        const news = dedupeByLink([
            ...mapArray(json.parsed?.news, normalizeNews),
            ...mapArray(json.news, normalizeNews),
        ]);

        return { news, parsed: { news } };
    }
}

export class SerperBingHTTP extends SerperGoogleHTTP {
    constructor(apiKey: string) {
        super(apiKey);
    }

    protected override buildBody(query: SerperSearchQueryParams, extra?: Record<string, unknown>): Record<string, unknown> {
        return super.buildBody(query, { ...extra, engine: 'bing' });
    }
}

export const WORLD_COUNTRIES: Record<string, string> = {
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
};
export type LanguageCode = { code: string; name?: string; };
export const WORLD_LANGUAGES: LanguageCode[] = [
    { code: 'en', name: 'English' },
    { code: 'es', name: 'Spanish' },
    { code: 'fr', name: 'French' },
    { code: 'de', name: 'German' },
    { code: 'pt', name: 'Portuguese' },
    { code: 'ja', name: 'Japanese' },
    { code: 'ko', name: 'Korean' },
    { code: 'zh', name: 'Chinese' },
];
