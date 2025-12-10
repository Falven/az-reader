import OpenAI from 'openai';
import type { ChatCompletionContentPart, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { z } from 'zod';

export type InterrogateOptions = {
    image: Buffer;
    prompt?: string;
    system?: string;
};

type AzureOpenAIConfig = {
    endpoint: string;
    apiKey: string;
    deployment: string;
    apiVersion: string;
};

const defaultAzureApiVersion = '2024-08-01-preview';
const interrogationTimeoutMs = 30_000;

class ImageInterrogationError extends Error {
    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = 'ImageInterrogationError';
        if (cause !== undefined) {
            Reflect.set(this, 'cause', cause);
        }
    }
}

const azureOpenAISchema = z.object({
    endpoint: z.string().url(),
    apiKey: z.string().min(1),
    deployment: z.string().min(1),
    apiVersion: z.string().min(1),
});

const resolveDeploymentName = (requestedModel: string): string => {
    const envDeployment = process.env.AZURE_OPENAI_VISION_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT;
    const fallbackDeployment = requestedModel.trim();
    const chosenDeployment = envDeployment !== undefined && envDeployment.trim().length > 0 ? envDeployment.trim() : fallbackDeployment;
    if (chosenDeployment.length === 0) {
        throw new ImageInterrogationError('Azure OpenAI deployment name is required.');
    }
    return chosenDeployment;
};

const loadAzureConfig = (requestedModel: string): AzureOpenAIConfig => {
    const deployment = resolveDeploymentName(requestedModel);
    const parsed = azureOpenAISchema.safeParse({
        endpoint: process.env.AZURE_OPENAI_ENDPOINT,
        apiKey: process.env.AZURE_OPENAI_API_KEY ?? process.env.AZURE_OPENAI_KEY,
        deployment,
        apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? defaultAzureApiVersion,
    });

    if (!parsed.success) {
        const fields = parsed.error.issues.map((issue) => issue.path.join('.') || 'value').join(', ');
        throw new ImageInterrogationError(`Azure OpenAI configuration is invalid or incomplete: ${fields}`);
    }

    return parsed.data;
};

const imageBufferToDataUrl = (buff: Buffer): string => {
    if (buff.length === 0) {
        throw new ImageInterrogationError('Image buffer is empty.');
    }
    const base64 = buff.toString('base64');
    return `data:image/png;base64,${base64}`;
};

const isTextPart = (part: ChatCompletionContentPart | undefined): part is Extract<ChatCompletionContentPart, { type: 'text'; text: string; }> => {
    if (part === undefined || part === null) {
        return false;
    }
    return part.type === 'text' && typeof part.text === 'string';
};

const extractText = (content: unknown): string => {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        const pieces = content
            .map((part) => (isTextPart(part as ChatCompletionContentPart) ? part.text : undefined))
            .filter((text): text is string => text !== undefined);
        return pieces.join(' ').trim();
    }
    return '';
};

const buildMessages = (imageDataUrl: string, prompt?: string, system?: string): ChatCompletionMessageParam[] => {
    const promptText = prompt?.trim();
    const systemText = system?.trim() ?? 'You are an image understanding model. Provide a concise description of the supplied image.';

    const contentParts: ChatCompletionContentPart[] = [];
    if (promptText !== undefined && promptText !== null && promptText.length > 0) {
        contentParts.push({ type: 'text', text: promptText });
    }
    contentParts.push({
        type: 'image_url',
        image_url: { url: imageDataUrl, detail: 'high' },
    });

    return [
        { role: 'system', content: systemText },
        { role: 'user', content: contentParts },
    ];
};

export class ImageInterrogationManager {
    private client?: OpenAI;
    private clientConfig?: AzureOpenAIConfig;

    private ensureClient(model: string): OpenAI {
        const config = loadAzureConfig(model);
        if (this.client !== undefined && this.clientConfig !== undefined
            && this.clientConfig.deployment === config.deployment
            && this.clientConfig.endpoint === config.endpoint) {
            return this.client;
        }

        this.clientConfig = config;
        this.client = new OpenAI({
            apiKey: config.apiKey,
            baseURL: `${config.endpoint}/openai/deployments/${config.deployment}`,
            defaultHeaders: { 'api-key': config.apiKey },
            defaultQuery: { 'api-version': config.apiVersion },
        });

        return this.client;
    }

    async interrogate(model: string, opts: InterrogateOptions): Promise<string> {
        if (opts.image === undefined || opts.image === null || opts.image.length === 0) {
            throw new ImageInterrogationError('Image buffer is required for interrogation.');
        }

        const client = this.ensureClient(model);
        const dataUrl = imageBufferToDataUrl(opts.image);
        const messages = buildMessages(dataUrl, opts.prompt, opts.system);

        try {
            const completion = await client.chat.completions.create({
                model: this.clientConfig?.deployment ?? resolveDeploymentName(model),
                messages,
                max_tokens: 160,
                temperature: 0.2,
                top_p: 0.95,
            }, { timeout: interrogationTimeoutMs });
            const choice = completion.choices.length > 0 ? completion.choices[0] : undefined;
            const content = choice?.message?.content ?? '';
            const text = extractText(content).trim();
            if (text.length === 0) {
                throw new ImageInterrogationError('Azure OpenAI returned an empty response for the provided image.');
            }
            return text;
        } catch (error) {
            throw new ImageInterrogationError('Failed to interrogate image with Azure OpenAI.', error);
        }
    }
}
