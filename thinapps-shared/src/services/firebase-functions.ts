import { getFunctions as getAdminFunctions } from 'firebase-admin/functions';

type TaskQueueAdapter = {
    enqueue: (payload: unknown, opts?: unknown) => Promise<void>;
};

type FunctionsAdapter = {
    taskQueue: (name: string, extensionId?: string) => TaskQueueAdapter;
};

const buildFallbackQueue = (name: string): TaskQueueAdapter => ({
    enqueue: async () => {
        console.warn('[firebase-functions shim] TaskQueue fallback invoked', { name });
    },
});

const wrapAdminQueue = (queue: any): TaskQueueAdapter => ({
    enqueue: async (payload: unknown, opts?: unknown) => {
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
            taskQueue: (name: string, extensionId?: string) => {
                const queue = extensionId
                    ? admin.taskQueue(name, extensionId)
                    : admin.taskQueue(name);
                return wrapAdminQueue(queue);
            },
        };
    } catch (err) {
        if (!fallbackLogged) {
            const message = err instanceof Error ? err.message : 'unknown error';
            console.warn(
                '[firebase-functions shim] Falling back to no-op taskQueue because firebase-admin/functions is not configured.',
                { message },
            );
            fallbackLogged = true;
        }

        cachedAdapter = {
            taskQueue: (name: string) => buildFallbackQueue(name),
        };
    }

    return cachedAdapter;
};
