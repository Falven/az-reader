import { GlobalLogger } from '../services/logger';
import { TempFileManager } from '../services/temp-file';
import { FirebaseStorageBucketControl } from './services/firebase-storage-bucket';

type Decorator = (...args: any[]) => any;

const attachMetadata = (key: string, value: unknown) => {
    return (target: any, propertyKey?: string | symbol) => {
        if (!propertyKey) {
            return;
        }
        const existingRaw = Reflect.getMetadata?.(key, target[propertyKey]);
        const existing = (existingRaw && typeof existingRaw === 'object') ? existingRaw as Record<string, unknown> : {};
        if (typeof Reflect !== 'undefined' && typeof Reflect.defineMetadata === 'function') {
            Reflect.defineMetadata(key, { ...existing, ...(value as Record<string, unknown>) }, target[propertyKey]);
        }
    };
};

const passthroughDecorator = (...factoryArgs: any[]): Decorator => {
    return (..._args: any[]) => {
        const meta = factoryArgs[0] ?? {};
        const target = _args[0];
        const propertyKey = _args[1];
        if (typeof Reflect !== 'undefined' && typeof Reflect.defineMetadata === 'function' && propertyKey) {
            attachMetadata('cloud:config', meta)(target, propertyKey);
        }
        return;
    };
};

export const CloudHTTPv2 = passthroughDecorator;
export const CloudTaskV2 = passthroughDecorator;
export const Param = passthroughDecorator;
export const Ctx = passthroughDecorator;
export const RPCReflect = passthroughDecorator;

export { ServiceBadAttemptError } from '../services/errors';
export { FirebaseStorageBucketControl, GlobalLogger as Logger, TempFileManager };
