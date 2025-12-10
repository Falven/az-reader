import { z } from 'zod';

export type ProxyAllocation = URL;

type ProxyDescriptor = {
    url: URL;
    countries: string[];
    weight: number;
};

class ProxyAllocationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ProxyAllocationError';
    }
}

const proxySourceSchema = z.object({
    url: z.string().url(),
    countries: z.array(z.string()).optional(),
    weight: z.number().int().positive().optional(),
});

const normalizeCountry = (country?: string | null): string | undefined => {
    if (!country) {
        return undefined;
    }
    const normalized = country.trim().toLowerCase();
    return normalized || undefined;
};

const toDescriptor = (data: z.infer<typeof proxySourceSchema>): ProxyDescriptor => {
    const countries: string[] = [];
    for (const raw of data.countries ?? []) {
        const normalized = normalizeCountry(raw);
        if (!normalized || normalized === 'auto' || normalized === 'any' || normalized === 'none') {
            continue;
        }
        countries.push(normalized);
    }

    return {
        url: new URL(data.url),
        countries,
        weight: data.weight ?? 1,
    };
};

const parseFromJson = (raw: string): ProxyDescriptor[] => {
    const parsed = JSON.parse(raw);
    const validated = z.array(proxySourceSchema).parse(parsed);
    return validated.map(toDescriptor);
};

const parseFromList = (raw: string): ProxyDescriptor[] => {
    const entries = raw.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
    return entries.map((entry) => {
        const [url, countriesChunk, weightChunk] = entry.split('|').map((x) => x?.trim());
        const countries = countriesChunk ? countriesChunk.split(/[;\s,]+/).filter((c) => c.length > 0) : undefined;
        const weight = weightChunk ? Number.parseInt(weightChunk, 10) : undefined;
        return toDescriptor(proxySourceSchema.parse({ url, countries, weight }));
    });
};

const loadPool = (): ProxyDescriptor[] => {
    if (process.env.PROXY_POOL_JSON) {
        return parseFromJson(process.env.PROXY_POOL_JSON);
    }

    if (process.env.PROXY_POOL) {
        return parseFromList(process.env.PROXY_POOL);
    }

    const fallback = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
    if (!fallback) {
        return [];
    }

    return [toDescriptor(proxySourceSchema.parse({ url: fallback }))];
};

export class ProxyProviderService {
    private readonly pool: ProxyDescriptor[];
    private readonly roundRobinCursor = new Map<string, number>();

    constructor() {
        this.pool = loadPool();
    }

    supports(country: string): boolean {
        const normalized = normalizeCountry(country);
        if (normalized === 'none') {
            return false;
        }

        if (normalized === undefined || normalized === 'auto' || normalized === 'any') {
            return this.pool.length > 0;
        }

        return this.pool.some((proxy) => proxy.countries.length === 0 || proxy.countries.includes(normalized));
    }

    async alloc(country: string = 'auto'): Promise<ProxyAllocation> {
        if (normalizeCountry(country) === 'none') {
            throw new ProxyAllocationError('Proxy allocation requested but country was "none".');
        }

        return this.allocSync(country);
    }

    *iterAlloc(country: string = 'auto'): Generator<ProxyAllocation, void, unknown> {
        if (normalizeCountry(country) === 'none') {
            throw new ProxyAllocationError('Proxy allocation requested but country was "none".');
        }

        while (true) {
            yield this.allocSync(country);
        }
    }

    private allocSync(country: string): ProxyAllocation {
        const candidate = this.pick(country);
        return new URL(candidate.url.href);
    }

    private pick(country: string): ProxyDescriptor {
        const candidates = this.candidatesFor(country);
        if (!candidates.length) {
            throw new ProxyAllocationError('No proxy available for the requested country.');
        }

        const key = normalizeCountry(country) ?? 'auto';
        const cursor = this.roundRobinCursor.get(key) ?? 0;
        const totalWeight = candidates.reduce((sum, proxy) => sum + proxy.weight, 0);
        const target = cursor % totalWeight;
        this.roundRobinCursor.set(key, cursor + 1);

        let acc = 0;
        for (const candidate of candidates) {
            acc += candidate.weight;
            if (target < acc) {
                return candidate;
            }
        }

        return candidates[candidates.length - 1];
    }

    private candidatesFor(country: string): ProxyDescriptor[] {
        if (!this.pool.length) {
            return [];
        }

        const normalized = normalizeCountry(country) ?? 'auto';
        if (normalized === 'auto' || normalized === 'any') {
            return this.pool;
        }

        const targeted = this.pool.filter((proxy) => proxy.countries.length === 0 || proxy.countries.includes(normalized));
        if (targeted.length) {
            return targeted;
        }

        return this.pool;
    }
}
