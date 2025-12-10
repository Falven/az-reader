import { DefaultAzureCredential } from '@azure/identity';
import type { TokenCredential } from '@azure/core-auth';

type CosmosAuthMode = 'key' | 'aad';

type CosmosConfig = {
    enabled: boolean;
    endpoint?: string;
    key?: string;
    credential?: TokenCredential;
    databaseId: string;
    authMode: CosmosAuthMode;
};

type BlobConfig = {
    enabled: boolean;
    accountName?: string;
    accountKey?: string;
    sasToken?: string;
    containerName: string;
    endpoint?: string;
};

const isTruthy = (value: string | undefined) => {
    if (!value) {
        return false;
    }

    const normalized = value.trim().toLowerCase();

    return normalized !== 'false' && normalized !== '0';
};

const parseAuthMode = (value: string | undefined): CosmosAuthMode | undefined => {
    const normalized = value?.trim().toLowerCase();
    if (normalized === 'aad' || normalized === 'msi' || normalized === 'managedidentity') {
        return 'aad';
    }
    if (normalized === 'key') {
        return 'key';
    }
    return undefined;
};

const shouldUseAad = (key: string | undefined): boolean => {
    const explicit = parseAuthMode(process.env.COSMOS_AUTH_MODE);
    if (explicit) {
        return explicit === 'aad';
    }
    if (isTruthy(process.env.COSMOS_USE_MSI) || isTruthy(process.env.COSMOS_USE_MANAGED_IDENTITY)) {
        return true;
    }
    return !key;
};

const buildCosmosCredential = (): TokenCredential => {
    const clientId = (process.env.COSMOS_CLIENT_ID ?? process.env.AZURE_CLIENT_ID ?? process.env.MANAGED_IDENTITY_CLIENT_ID)?.trim() || undefined;
    return new DefaultAzureCredential({
        managedIdentityClientId: clientId,
    });
};

export const getCosmosConfig = (): CosmosConfig => {
    const endpoint = process.env.COSMOS_ENDPOINT;
    const key = process.env.COSMOS_KEY;
    const databaseId = process.env.COSMOS_DB || 'reader';

    const useAad = shouldUseAad(key);
    const hasCredentials = Boolean(endpoint && (key || useAad));
    const enabled = process.env.COSMOS_ENABLED !== undefined ? isTruthy(process.env.COSMOS_ENABLED) : hasCredentials;

    if (!enabled) {
        return {
            enabled: false,
            databaseId,
            authMode: useAad ? 'aad' : 'key',
        };
    }

    if (!endpoint) {
        throw new Error('COSMOS_ENABLED is true but COSMOS_ENDPOINT is missing.');
    }

    if (useAad) {
        return {
            enabled: true,
            endpoint,
            credential: buildCosmosCredential(),
            databaseId,
            authMode: 'aad',
        };
    }

    if (!key) {
        throw new Error('COSMOS_ENABLED is true but neither COSMOS_KEY nor COSMOS_AUTH_MODE=aad is configured.');
    }

    return {
        enabled: true,
        endpoint,
        key,
        databaseId,
        authMode: 'key',
    };
};

export const getBlobConfig = (): BlobConfig => {
    const accountName = process.env.BLOB_ACCOUNT;
    const accountKey = process.env.BLOB_KEY;
    const sasToken = process.env.BLOB_SAS;
    const containerName = process.env.BLOB_CONTAINER || 'reader-cache';
    const endpoint = process.env.BLOB_ENDPOINT || (accountName ? `https://${accountName}.blob.core.windows.net` : undefined);

    const hasCredentials = Boolean(accountName && (accountKey || sasToken));
    const enabledFlag = process.env.BLOB_ENABLED ?? process.env.COSMOS_ENABLED;
    const enabled = enabledFlag !== undefined ? isTruthy(enabledFlag) : hasCredentials;

    if (!enabled) {
        return {
            enabled: false,
            containerName,
            accountName,
            accountKey,
            sasToken,
            endpoint,
        };
    }

    if (!accountName || (!accountKey && !sasToken)) {
        throw new Error('Blob storage is enabled but BLOB_ACCOUNT or BLOB_KEY/BLOB_SAS is missing.');
    }

    return {
        enabled: true,
        accountName,
        accountKey,
        sasToken,
        containerName,
        endpoint,
    };
};
