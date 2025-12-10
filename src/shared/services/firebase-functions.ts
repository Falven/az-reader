import { getFunctions as getAdminFunctions, type TaskQueue as AdminTaskQueue } from 'firebase-admin/functions';

type EnqueueOptions = {
    dispatchDeadlineSeconds?: number;
    uri?: string;
};

export type TaskQueue<T extends Record<string, unknown>> = {
    enqueue: (payload: T, opts?: EnqueueOptions) => Promise<void>;
};

type FunctionsAdapter = {
    taskQueue: <T extends Record<string, unknown>>(name: string, extensionId?: string) => TaskQueue<T>;
};

const buildFallbackQueue = <T extends Record<string, unknown>>(name: string): TaskQueue<T> => ({
    enqueue: async () => {
        console.warn('[firebase-functions shim] TaskQueue fallback invoked', { name });
    },
});

const wrapAdminQueue = <T extends Record<string, unknown>>(queue: AdminTaskQueue<T>): TaskQueue<T> => ({
    enqueue: async (payload, opts) => {
        await queue.enqueue(payload, opts);
    },
});

let cachedAdapter: FunctionsAdapter | undefined;
let fallbackLogged = false;

export const getFunctions = (): FunctionsAdapter => {
    if (cachedAdapter !== undefined) {
        return cachedAdapter;
    }

    try {
        const admin = getAdminFunctions();
        cachedAdapter = {
            taskQueue: <T extends Record<string, unknown>>(name: string, extensionId?: string) => {
                const queue = extensionId ? admin.taskQueue<T>(name, extensionId) : admin.taskQueue<T>(name);
                return wrapAdminQueue(queue);
            },
        };
    } catch (err) {
        if (!fallbackLogged) {
            const message = err instanceof Error ? err.message : 'unknown error';
            console.warn('[firebase-functions shim] Falling back to no-op taskQueue because firebase-admin/functions is not configured.', { message });
            fallbackLogged = true;
        }

        cachedAdapter = {
            taskQueue: <T extends Record<string, unknown>>(name: string) => buildFallbackQueue<T>(name),
        };
    }

    return cachedAdapter;
};
