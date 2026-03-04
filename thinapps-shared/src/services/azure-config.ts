import { DefaultAzureCredential } from '@azure/identity';

type CosmosConfig = {
    endpoint: string;
    credential: unknown;
    databaseId: string;
    authMode: 'aad';
};

type BlobConfig = {
    enabled: boolean;
    accountName?: string;
    managedIdentityClientId?: string;
    containerName: string;
    endpoint?: string;
};

const isTruthy = (value?: string) => {
    if (!value) {
        return false;
    }

    const normalized = value.trim().toLowerCase();
    return normalized !== 'false' && normalized !== '0';
};

const buildCosmosCredential = () => {
    const clientId = (
        process.env.COSMOS_CLIENT_ID
        ?? process.env.AZURE_CLIENT_ID
        ?? process.env.MANAGED_IDENTITY_CLIENT_ID
    )?.trim() || undefined;

    return new DefaultAzureCredential({ managedIdentityClientId: clientId });
};

export const getCosmosConfig = (): CosmosConfig => {
    const endpoint = process.env.COSMOS_ENDPOINT;
    const databaseId = process.env.COSMOS_DB || 'reader';

    if (!endpoint) {
        throw new Error('COSMOS_ENDPOINT is required.');
    }

    return {
        endpoint,
        credential: buildCosmosCredential(),
        databaseId,
        authMode: 'aad',
    };
};

export const getBlobConfig = (): BlobConfig => {
    const accountName = process.env.BLOB_ACCOUNT;
    const managedIdentityClientId = process.env.BLOB_CLIENT_ID?.trim();
    const containerName = process.env.BLOB_CONTAINER || 'reader-cache';
    const endpoint = process.env.BLOB_ENDPOINT
        || (accountName ? `https://${accountName}.blob.core.windows.net` : undefined);
    const enabledFlag = process.env.BLOB_ENABLED;
    const enabled = enabledFlag !== undefined ? isTruthy(enabledFlag) : Boolean(accountName);

    if (!enabled) {
        return {
            enabled: false,
            containerName,
            accountName,
            managedIdentityClientId,
            endpoint,
        };
    }

    if (!accountName) {
        throw new Error('Blob storage is enabled but BLOB_ACCOUNT is missing.');
    }

    if (!managedIdentityClientId) {
        throw new Error('Blob storage is enabled but BLOB_CLIENT_ID is missing.');
    }

    return {
        enabled: true,
        accountName,
        managedIdentityClientId,
        containerName,
        endpoint,
    };
};
