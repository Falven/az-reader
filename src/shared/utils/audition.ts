import type { Context, Middleware, Next } from 'koa';

type AuditionLogger = Pick<Console, 'warn'>;

type AuditionOptions = {
    slowThresholdMs?: number;
    logger?: AuditionLogger;
};

const DEFAULT_SLOW_THRESHOLD_MS = 10_000;

const resolveThreshold = (candidate?: number): number => {
    if (candidate === undefined) {
        return DEFAULT_SLOW_THRESHOLD_MS;
    }
    if (Number.isFinite(candidate) && candidate > 0) {
        return candidate;
    }
    return DEFAULT_SLOW_THRESHOLD_MS;
};

const computeDurationMs = (started: bigint): number => {
    const ended = process.hrtime.bigint();
    const nanos = Number(ended - started);
    return nanos / 1_000_000;
};

const warnSlow = (ctx: Context, durationMs: number, logger: AuditionLogger): void => {
    const method = ctx.method;
    const path = ctx.path;
    const status = ctx.status;
    logger.warn(`[audition] slow request`, { method, path, status, durationMs });
};

export const getAuditionMiddleware = (options?: AuditionOptions): Middleware => {
    const logger = options?.logger ?? console;
    const slowThresholdMs = resolveThreshold(options?.slowThresholdMs);

    return async (ctx: Context, next: Next) => {
        const started = process.hrtime.bigint();
        try {
            await next();
        } finally {
            const durationMs = computeDurationMs(started);
            ctx.set('x-response-time-ms', durationMs.toFixed(2));
            if (durationMs >= slowThresholdMs) {
                warnSlow(ctx, durationMs, logger);
            }
        }
    };
};
