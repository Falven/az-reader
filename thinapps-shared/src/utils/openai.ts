import { encoding_for_model, get_encoding } from 'tiktoken';

class TokenizerUnavailableError extends Error {
    override cause?: unknown;

    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = 'TokenizerUnavailableError';
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}

const DEFAULT_MODEL = process.env.OPENAI_TOKEN_MODEL ?? 'gpt-4o-mini';
const FALLBACK_ENCODING = 'cl100k_base';

const encodingCache = new Map<string, ReturnType<typeof get_encoding>>();

const resolveModel = (model?: string) => {
    if (model !== undefined && model.trim().length > 0) {
        return model.trim();
    }

    return DEFAULT_MODEL;
};

const getEncodingForModel = (model?: string) => {
    const resolvedModel = resolveModel(model);
    const cached = encodingCache.get(resolvedModel);
    if (cached) {
        return cached;
    }

    try {
        const enc = encoding_for_model(resolvedModel as any);
        encodingCache.set(resolvedModel, enc);
        return enc;
    } catch {
        try {
            const fallback = get_encoding(FALLBACK_ENCODING);
            encodingCache.set(resolvedModel, fallback);
            return fallback;
        } catch (fallbackErr) {
            throw new TokenizerUnavailableError('Failed to initialize tokenizer for model.', fallbackErr);
        }
    }
};

export const countGPTToken = (text?: string | null, model?: string) => {
    if (text === undefined || text === null || text.length === 0) {
        return 0;
    }

    try {
        const encoding = getEncodingForModel(model);
        return encoding.encode(text).length;
    } catch {
        // Deterministic fallback approximation to avoid hard failures.
        return Math.ceil(text.length / 4);
    }
};
