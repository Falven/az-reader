import { encoding_for_model, get_encoding, type Tiktoken } from 'tiktoken';

class TokenizerUnavailableError extends Error {
    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = 'TokenizerUnavailableError';
        if (cause !== undefined) {
            (this as Error & { cause?: unknown; }).cause = cause;
        }
    }
}

const DEFAULT_MODEL = process.env.OPENAI_TOKEN_MODEL ?? 'gpt-4o-mini';
const FALLBACK_ENCODING = 'cl100k_base';

const encodingCache = new Map<string, Tiktoken>();

const resolveModel = (model?: string): string => {
    if (model !== undefined && model.trim().length > 0) {
        return model.trim();
    }
    return DEFAULT_MODEL;
};

const getEncodingForModel = (model?: string): Tiktoken => {
    const resolvedModel = resolveModel(model);
    const cached = encodingCache.get(resolvedModel);
    if (cached) {
        return cached;
    }

    try {
        const enc = encoding_for_model(resolvedModel);
        encodingCache.set(resolvedModel, enc);
        return enc;
    } catch (err) {
        try {
            const fallback = get_encoding(FALLBACK_ENCODING);
            encodingCache.set(resolvedModel, fallback);
            return fallback;
        } catch (fallbackErr) {
            throw new TokenizerUnavailableError('Failed to initialize tokenizer for model.', fallbackErr);
        }
    }
};

export const countGPTToken = (text?: string | null, model?: string): number => {
    if (text === undefined || text === null) {
        return 0;
    }
    if (text.length === 0) {
        return 0;
    }

    try {
        const encoding = getEncodingForModel(model);
        return encoding.encode(text).length;
    } catch (_err) {
        return Math.ceil(text.length / 4);
    }
};
