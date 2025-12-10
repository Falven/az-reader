import { singleton } from 'tsyringe';
import { z } from 'zod';

class MissingSecretError extends Error {
    constructor(secretName: string) {
        super(`Missing required secret: ${secretName}`);
        this.name = 'MissingSecretError';
    }
}

const optionalSecret = z.string().optional().transform((value) => {
    const trimmed = value?.trim();

    return trimmed && trimmed.length > 0 ? trimmed : undefined;
});

const secretSchema = z.object({
    SERPER_SEARCH_API_KEY: optionalSecret,
    BRAVE_SEARCH_API_KEY: optionalSecret,
    CLOUD_FLARE_API_KEY: optionalSecret,
    JINA_EMBEDDINGS_DASHBOARD_API_KEY: optionalSecret,
    JINA_SERP_API_KEY: optionalSecret,
});

type SecretValues = z.infer<typeof secretSchema>;

@singleton()
export class SecretExposer {
    private readonly secrets: SecretValues;

    constructor() {
        this.secrets = secretSchema.parse(process.env);
    }

    private resolveSecret<K extends keyof SecretValues>(key: K): string {
        const value = this.secrets[key];
        if (value !== undefined) {
            return value;
        }

        return '';
    }

    get SERPER_SEARCH_API_KEY(): string {
        return this.resolveSecret('SERPER_SEARCH_API_KEY');
    }

    get BRAVE_SEARCH_API_KEY(): string {
        return this.resolveSecret('BRAVE_SEARCH_API_KEY');
    }

    get CLOUD_FLARE_API_KEY(): string {
        return this.resolveSecret('CLOUD_FLARE_API_KEY');
    }

    get JINA_EMBEDDINGS_DASHBOARD_API_KEY(): string {
        return this.resolveSecret('JINA_EMBEDDINGS_DASHBOARD_API_KEY');
    }

    get JINA_SERP_API_KEY(): string {
        return this.resolveSecret('JINA_SERP_API_KEY');
    }
}

const secretExposer = new SecretExposer();

export default secretExposer;
