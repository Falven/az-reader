import 'reflect-metadata';

export { FirebaseStorageBucketControl } from './services/firebase-storage-bucket';

type DecoratorFactory = (...factoryArgs: any[]) => (...args: any[]) => void;

const attachMetadata = (key: string, value: Record<string, unknown>) => {
    return (target: Record<string, any>, propertyKey?: string | symbol) => {
        if (!propertyKey) {
            return;
        }

        const existingRaw = Reflect.getMetadata?.(key, target[propertyKey as any]);
        const existing = (existingRaw && typeof existingRaw === 'object')
            ? existingRaw as Record<string, unknown>
            : {};

        if (typeof Reflect !== 'undefined' && typeof Reflect.defineMetadata === 'function') {
            Reflect.defineMetadata(key, { ...existing, ...value }, target[propertyKey as any]);
        }
    };
};

const passthroughDecorator: DecoratorFactory = (...factoryArgs) => {
    return (...args) => {
        const meta = (factoryArgs[0] ?? {}) as Record<string, unknown>;
        const target = args[0] as Record<string, any>;
        const propertyKey = args[1] as string | symbol | undefined;

        if (
            typeof Reflect !== 'undefined'
            && typeof Reflect.defineMetadata === 'function'
            && propertyKey
        ) {
            attachMetadata('cloud:config', meta)(target, propertyKey);
        }
    };
};

export const CloudHTTPv2 = passthroughDecorator;
export const CloudTaskV2 = passthroughDecorator;
export const Param = passthroughDecorator;
export const Ctx = passthroughDecorator;
export const RPCReflect = passthroughDecorator;
