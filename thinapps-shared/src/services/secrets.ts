import { singleton } from 'tsyringe';
import { z } from 'zod';

const optionalSecret = z.string().optional().transform((value) => {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
});

const secretSchema = z.object({
    SERPER_SEARCH_API_KEY: optionalSecret,
    BRAVE_SEARCH_API_KEY: optionalSecret,
    CLOUD_FLARE_API_KEY: optionalSecret,
    JINA_EMBEDDINGS_DASHBOARD_API_KEY: optionalSecret,
    JINA_EMBEDDINGS_DASHBOARD_BASE_URL: optionalSecret,
    JINA_EMBEDDINGS_DASHBOARD_AUDIENCE: optionalSecret,
    JINA_EMBEDDINGS_DASHBOARD_MI_CLIENT_ID: optionalSecret,
    JINA_SERP_API_KEY: optionalSecret,
});

type SecretName = keyof z.infer<typeof secretSchema>;

@singleton()
export class SecretExposer {
    private readonly secrets = secretSchema.parse(process.env);

    resolveSecret(key: SecretName | string) {
        const safeKey = key as SecretName;
        const value = this.secrets[safeKey];
        if (value !== undefined) {
            return value;
        }

        return '';
    }

    get SERPER_SEARCH_API_KEY() {
        return this.resolveSecret('SERPER_SEARCH_API_KEY');
    }

    get BRAVE_SEARCH_API_KEY() {
        return this.resolveSecret('BRAVE_SEARCH_API_KEY');
    }

    get CLOUD_FLARE_API_KEY() {
        return this.resolveSecret('CLOUD_FLARE_API_KEY');
    }

    get JINA_EMBEDDINGS_DASHBOARD_API_KEY() {
        return this.resolveSecret('JINA_EMBEDDINGS_DASHBOARD_API_KEY');
    }

    get JINA_EMBEDDINGS_DASHBOARD_BASE_URL() {
        return this.resolveSecret('JINA_EMBEDDINGS_DASHBOARD_BASE_URL');
    }

    get JINA_EMBEDDINGS_DASHBOARD_AUDIENCE() {
        return this.resolveSecret('JINA_EMBEDDINGS_DASHBOARD_AUDIENCE');
    }

    get JINA_EMBEDDINGS_DASHBOARD_MI_CLIENT_ID() {
        return this.resolveSecret('JINA_EMBEDDINGS_DASHBOARD_MI_CLIENT_ID');
    }

    get JINA_SERP_API_KEY() {
        return this.resolveSecret('JINA_SERP_API_KEY');
    }
}

const secretExposer = new SecretExposer();
export default secretExposer;
