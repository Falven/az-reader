import { randomUUID } from 'crypto';
import OpenAI from 'openai';
import type { ChatCompletionContentPart, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { singleton } from 'tsyringe';

import { BlobStorageControl } from './blob-storage';

type ModelSpecificTuning = {
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
    repetition_penalty?: number;
    top_k?: number;
};

type LLMRunOptions = {
    prompt: unknown;
    options?: {
        system?: string;
        stream?: boolean;
        timeoutMs?: number;
        modelSpecific?: ModelSpecificTuning;
    };
    maxTry?: number;
};

type AzureOpenAIConfig = {
    endpoint: string;
    apiKey: string;
    apiVersion: string;
    defaultDeployment?: string;
};

type PromptSegment =
    | { kind: 'text'; value: string; }
    | { kind: 'image-buffer'; data: Buffer; mime: string; }
    | { kind: 'image-url'; url: string; }
    | { kind: 'unknown'; value: string; };

const DEFAULT_API_VERSION = '2024-07-01-preview';
const DEFAULT_MAX_TRY = 2;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_IMAGE_TTL_MS = 60 * 60 * 1000;

class LLMConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LLMConfigurationError';
    }
}

class LLMRequestError extends Error {
    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = 'LLMRequestError';
        if (cause !== undefined) {
            (this as Error & { cause?: unknown; }).cause = cause;
        }
    }
}

const toStringValue = (input: unknown): string => {
    if (input === undefined || input === null) {
        return '';
    }
    if (typeof input === 'string') {
        return input;
    }
    if (typeof input === 'number' || typeof input === 'boolean') {
        return String(input);
    }
    try {
        return JSON.stringify(input);
    } catch (_err) {
        return String(input);
    }
};

const normalizeAzureConfig = (): AzureOpenAIConfig => {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || DEFAULT_API_VERSION;
    const defaultDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;

    if (!endpoint) {
        throw new LLMConfigurationError('AZURE_OPENAI_ENDPOINT is required.');
    }
    if (!apiKey) {
        throw new LLMConfigurationError('AZURE_OPENAI_API_KEY is required.');
    }

    const normalizedEndpoint = endpoint.replace(/\/+$/, '');

    return {
        endpoint: normalizedEndpoint,
        apiKey,
        apiVersion,
        defaultDeployment,
    };
};

const resolveDeployment = (model: string, cfg: AzureOpenAIConfig): string => {
    const envKey = `AZURE_OPENAI_DEPLOYMENT_${model.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
    const mapped = process.env[envKey];
    if (mapped && mapped.trim().length > 0) {
        return mapped.trim();
    }
    if (cfg.defaultDeployment && cfg.defaultDeployment.trim().length > 0) {
        return cfg.defaultDeployment.trim();
    }
    return model;
};

const toImageMime = (input: unknown): string => {
    if (typeof input === 'string' && input.trim().length > 0) {
        return input.trim();
    }
    return 'image/png';
};

const isHttpUrl = (value: string): boolean => {
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (_err) {
        return false;
    }
};

const isLikelyImageUrl = (value: string): boolean => {
    if (!isHttpUrl(value)) {
        return false;
    }
    return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(value.split('?')[0] ?? '');
};

const flattenPrompt = (input: unknown): PromptSegment[] => {
    if (input === undefined || input === null) {
        return [];
    }

    if (Array.isArray(input)) {
        const segments: PromptSegment[] = [];
        for (const item of input) {
            segments.push(...flattenPrompt(item));
        }
        return segments;
    }

    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (trimmed.length === 0) {
            return [];
        }
        if (isLikelyImageUrl(trimmed)) {
            return [{ kind: 'image-url', url: trimmed }];
        }
        return [{ kind: 'text', value: trimmed }];
    }

    if (input instanceof URL) {
        const urlTxt = input.toString();
        if (isLikelyImageUrl(urlTxt)) {
            return [{ kind: 'image-url', url: urlTxt }];
        }
        return [{ kind: 'text', value: urlTxt }];
    }

    if (Buffer.isBuffer(input)) {
        return [{ kind: 'image-buffer', data: input, mime: 'image/png' }];
    }

    if (input instanceof ArrayBuffer) {
        return [{ kind: 'image-buffer', data: Buffer.from(input), mime: 'image/png' }];
    }

    if (input instanceof Uint8Array) {
        return [{ kind: 'image-buffer', data: Buffer.from(input), mime: 'image/png' }];
    }

    return [{ kind: 'unknown', value: toStringValue(input) }];
};

const buildTuningParams = (tuning?: ModelSpecificTuning) => {
    if (!tuning) {
        return {};
    }
    const params: Record<string, number> = {};
    if (typeof tuning.temperature === 'number') {
        params.temperature = tuning.temperature;
    }
    if (typeof tuning.top_p === 'number') {
        params.top_p = tuning.top_p;
    }
    if (typeof tuning.max_tokens === 'number') {
        params.max_tokens = tuning.max_tokens;
    }
    if (typeof tuning.presence_penalty === 'number') {
        params.presence_penalty = tuning.presence_penalty;
    }
    if (typeof tuning.frequency_penalty === 'number') {
        params.frequency_penalty = tuning.frequency_penalty;
    } else if (typeof tuning.repetition_penalty === 'number') {
        params.frequency_penalty = tuning.repetition_penalty;
    }
    return params;
};

const buildStreamDelay = (attempt: number) => {
    const base = 200;
    return base * Math.max(1, attempt);
};

const delay = (ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
});

@singleton()
export class LLMManager {
    private cfg?: AzureOpenAIConfig;
    private readonly clientMap = new Map<string, OpenAI>();
    private blobStorage?: BlobStorageControl;
    private blobInitAttempted = false;
    constructor() { }

    private getConfig(): AzureOpenAIConfig {
        if (!this.cfg) {
            this.cfg = normalizeAzureConfig();
        }
        return this.cfg;
    }

    private getClient(deployment: string): OpenAI {
        const cached = this.clientMap.get(deployment);
        if (cached) {
            return cached;
        }
        const cfg = this.getConfig();
        const baseURL = `${cfg.endpoint}/openai/deployments/${deployment}`;
        const client = new OpenAI({
            apiKey: cfg.apiKey,
            baseURL,
            defaultHeaders: { 'api-key': cfg.apiKey },
            defaultQuery: { 'api-version': cfg.apiVersion },
        });
        this.clientMap.set(deployment, client);
        return client;
    }

    private ensureBlobStorage(): BlobStorageControl | undefined {
        if (this.blobStorage || this.blobInitAttempted) {
            return this.blobStorage;
        }
        this.blobInitAttempted = true;
        try {
            this.blobStorage = new BlobStorageControl();
        } catch (_err) {
            this.blobStorage = undefined;
        }
        return this.blobStorage;
    }

    private async materializeImage(segment: PromptSegment): Promise<string | undefined> {
        if (segment.kind === 'image-url') {
            return segment.url;
        }
        if (segment.kind !== 'image-buffer') {
            return undefined;
        }

        const storage = this.ensureBlobStorage();
        if (storage) {
            const key = `lm-input/${randomUUID()}.png`;
            await storage.saveFile(key, segment.data, { contentType: toImageMime(segment.mime) });
            const expires = Date.now() + DEFAULT_IMAGE_TTL_MS;
            return storage.signDownloadUrl(key, expires);
        }

        const base64 = segment.data.toString('base64');
        return `data:${toImageMime(segment.mime)};base64,${base64}`;
    }

    private async buildMessages(prompt: unknown, system?: string): Promise<ChatCompletionMessageParam[]> {
        const segments = flattenPrompt(prompt);
        const textChunks: string[] = [];
        const imageUrls: string[] = [];

        const imagePromises: Promise<string | undefined>[] = [];

        for (const segment of segments) {
            if (segment.kind === 'text') {
                if (segment.value.length > 0) {
                    textChunks.push(segment.value);
                }
                continue;
            }
            if (segment.kind === 'unknown') {
                if (segment.value.length > 0) {
                    textChunks.push(segment.value);
                }
                continue;
            }
            imagePromises.push(this.materializeImage(segment));
        }

        if (imagePromises.length > 0) {
            const urls = await Promise.all(imagePromises);
            for (const url of urls) {
                if (url) {
                    imageUrls.push(url);
                }
            }
        }

        const contentParts: ChatCompletionContentPart[] = [];
        const text = textChunks.join('\n\n').trim();
        if (text.length > 0) {
            contentParts.push({ type: 'text', text });
        }
        for (const url of imageUrls) {
            contentParts.push({
                type: 'image_url',
                image_url: { url, detail: 'high' },
            });
        }

        if (contentParts.length === 0) {
            throw new LLMRequestError('Prompt is empty after normalization.');
        }

        const messages: ChatCompletionMessageParam[] = [];
        if (system && system.trim().length > 0) {
            messages.push({ role: 'system', content: system.trim() });
        }
        messages.push({ role: 'user', content: contentParts });
        return messages;
    }

    private async streamCompletion(client: OpenAI, deployment: string, messages: ChatCompletionMessageParam[], tuning?: ModelSpecificTuning, timeoutMs?: number): Promise<AsyncGenerator<string, void, void>> {
        const params = {
            model: deployment,
            messages,
            stream: true as const,
            ...buildTuningParams(tuning),
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const iterable = client.chat.completions.create(params, { signal: controller.signal });

        const generator = (async function* () {
            try {
                for await (const chunk of iterable) {
                    const delta = chunk.choices[0]?.delta?.content;
                    if (!delta) {
                        continue;
                    }
                    if (typeof delta === 'string') {
                        yield delta;
                        continue;
                    }
                    if (Array.isArray(delta)) {
                        for (const part of delta) {
                            if (part.type === 'text' && part.text) {
                                yield part.text;
                            }
                        }
                    }
                }
            } finally {
                clearTimeout(timer);
            }
        })();

        return generator;
    }

    private async singleCompletion(client: OpenAI, deployment: string, messages: ChatCompletionMessageParam[], tuning?: ModelSpecificTuning, timeoutMs?: number): Promise<string> {
        const params = {
            model: deployment,
            messages,
            ...buildTuningParams(tuning),
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
        try {
            const result = await client.chat.completions.create(params, { signal: controller.signal });
            const content = result.choices[0]?.message?.content;
            if (typeof content === 'string') {
                return content;
            }
            if (Array.isArray(content)) {
                const parts: string[] = [];
                for (const part of content) {
                    if (part.type === 'text' && part.text) {
                        parts.push(part.text);
                    }
                }
                return parts.join('');
            }
            return '';
        } finally {
            clearTimeout(timer);
        }
    }

    async *iterRun(model: string, options: LLMRunOptions): AsyncGenerator<string, void, void> {
        const cfg = this.getConfig();
        const deployment = resolveDeployment(model, cfg);
        const client = this.getClient(deployment);
        const system = options.options?.system;
        const tuning = options.options?.modelSpecific;
        const timeoutMs = options.options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const messages = await this.buildMessages(options.prompt, system);
        const maxTry = options.maxTry ?? DEFAULT_MAX_TRY;
        const stream = options.options?.stream !== false;

        let lastError: unknown;
        for (let attempt = 0; attempt < maxTry; attempt += 1) {
            try {
                if (stream) {
                    const generator = await this.streamCompletion(client, deployment, messages, tuning, timeoutMs);
                    for await (const chunk of generator) {
                        yield chunk;
                    }
                    return;
                }
                const text = await this.singleCompletion(client, deployment, messages, tuning, timeoutMs);
                if (text.length > 0) {
                    yield text;
                }
                return;
            } catch (err) {
                lastError = err;
                if (attempt < maxTry - 1) {
                    await delay(buildStreamDelay(attempt + 1));
                    continue;
                }
                throw new LLMRequestError('LLM request failed after retries.', err);
            }
        }
        if (lastError) {
            throw new LLMRequestError('LLM request failed.', lastError);
        }
    }
}
