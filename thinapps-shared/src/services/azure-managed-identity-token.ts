import { DefaultAzureCredential } from '@azure/identity';

const resolveScope = (resource: string): string => {
    const trimmed = resource.trim();
    if (trimmed.length === 0) {
        return '';
    }

    if (trimmed.endsWith('/.default') || trimmed.endsWith('.default')) {
        return trimmed;
    }

    if (trimmed.endsWith('/')) {
        return `${trimmed}.default`;
    }

    return `${trimmed}/.default`;
};

export const getManagedIdentityAccessToken = async (
    resource: string,
    managedIdentityClientId?: string,
): Promise<string | undefined> => {
    const scope = resolveScope(resource);
    if (!scope) {
        return undefined;
    }

    try {
        const credential = new DefaultAzureCredential({ managedIdentityClientId });
        const accessToken = await credential.getToken(scope);
        return accessToken?.token?.trim() || undefined;
    } catch {
        return undefined;
    }
};
