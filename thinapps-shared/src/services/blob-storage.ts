import { Readable } from 'stream';
import { DefaultAzureCredential } from '@azure/identity';
import { getBlobConfig } from './azure-config';

type BlobSdk = any;

type BlobMetadata = Record<string, unknown> | undefined;

type NormalizedUploadOptions = {
    metadata?: Record<string, string>;
    contentType?: string;
};

const loadBlobSdk = (): BlobSdk => {
    try {
        return require('@azure/storage-blob') as BlobSdk;
    } catch {
        throw new Error('Azure Blob SDK "@azure/storage-blob" is required when BLOB_ENABLED is true.');
    }
};

const streamToBuffer = async (readable: Readable | ReadableStream<Uint8Array>) => {
    const nodeStream = typeof (readable as any)?.getReader === 'function'
        ? Readable.fromWeb(readable as any)
        : readable as Readable;

    const chunks: Uint8Array[] = [];
    for await (const chunk of nodeStream) {
        let normalized: Buffer;
        if (Buffer.isBuffer(chunk)) {
            normalized = chunk;
        } else if (typeof chunk === 'string') {
            normalized = Buffer.from(chunk);
        } else if (chunk instanceof Uint8Array) {
            normalized = Buffer.from(chunk);
        } else if (chunk instanceof ArrayBuffer) {
            normalized = Buffer.from(chunk);
        } else {
            normalized = Buffer.from(Uint8Array.from(chunk as ArrayLike<number>));
        }

        chunks.push(Uint8Array.from(normalized));
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return Buffer.from(merged.buffer, merged.byteOffset, merged.byteLength);
};

const toContentType = (value: unknown) => {
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const resolveUploadOptions = (metadata?: BlobMetadata): NormalizedUploadOptions => {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return {};
    }

    const source = metadata as Record<string, unknown>;
    const nested = source.metadata;
    const flattened: Record<string, unknown> = {};

    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        Object.assign(flattened, nested as Record<string, unknown>);
    }

    for (const [key, value] of Object.entries(source)) {
        if (key === 'metadata') {
            continue;
        }

        flattened[key] = value;
    }

    const contentType = toContentType(
        flattened.contentType
        ?? flattened.blobContentType
        ?? flattened['content-type']
    );
    delete flattened.contentType;
    delete flattened.blobContentType;
    delete flattened['content-type'];

    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(flattened)) {
        if (value === undefined || value === null) {
            continue;
        }

        normalized[key] = typeof value === 'string' ? value : String(value);
    }

    return {
        metadata: Object.keys(normalized).length > 0 ? normalized : undefined,
        contentType,
    };
};

export class BlobStorageControl {
    private readonly enabled: boolean;
    private readonly blobSdk?: BlobSdk;
    private readonly credential?: any;
    private readonly accountName?: string;
    private readonly serviceClient?: any;
    private readonly containerClient?: any;
    private readonly ready?: Promise<void>;

    constructor() {
        const cfg = getBlobConfig();
        this.enabled = cfg.enabled;

        if (!cfg.enabled) {
            this.ready = Promise.resolve();
            return;
        }

        const blobSdk = loadBlobSdk();
        this.blobSdk = blobSdk;

        if (!cfg.endpoint || !cfg.accountName) {
            throw new Error('Blob storage endpoint or account is missing.');
        }

        if (!cfg.managedIdentityClientId) {
            throw new Error('Blob storage requires BLOB_CLIENT_ID for managed identity authentication.');
        }

        this.credential = new DefaultAzureCredential({
            managedIdentityClientId: cfg.managedIdentityClientId,
        });
        this.accountName = cfg.accountName;
        const serviceClient = new blobSdk.BlobServiceClient(cfg.endpoint, this.credential);
        this.serviceClient = serviceClient;

        this.containerClient = serviceClient.getContainerClient(cfg.containerName);
        this.ready = this.containerClient.createIfNotExists().then(() => undefined);
    }

    private async ensureReady() {
        if (!this.enabled) {
            throw new Error('Blob storage is disabled. Enable it or set BLOB_ENABLED=false to skip blob operations.');
        }

        if (!this.ready) {
            throw new Error('Blob storage is not configured.');
        }

        await this.ready;
    }

    private getContainerClient() {
        if (!this.enabled) {
            throw new Error('Blob storage is disabled. Enable it or set BLOB_ENABLED=false to skip blob operations.');
        }

        if (!this.containerClient) {
            throw new Error('Blob storage is not configured.');
        }

        return this.containerClient;
    }

    async downloadFile(filePath: string) {
        await this.ensureReady();

        const blob = this.getContainerClient().getBlobClient(filePath);
        const response = await blob.download();
        if (!response.readableStreamBody) {
            throw new Error(`Unable to read blob stream for ${filePath}`);
        }

        return streamToBuffer(response.readableStreamBody as unknown as Readable);
    }

    async signDownloadUrl(filePath: string, expires?: number | Date) {
        await this.ensureReady();

        const blobSdk = this.blobSdk;
        const containerClient = this.getContainerClient();
        const blob = containerClient.getBlobClient(filePath);

        if (!this.credential || !blobSdk || !this.serviceClient || !this.accountName) {
            throw new Error('Blob storage managed identity client is not fully configured.');
        }

        const startsOn = new Date(Date.now() - 5 * 60 * 1000);
        const expiresOn = expires ? new Date(expires) : new Date(Date.now() + 3600 * 1000);
        const delegationKey = await this.serviceClient.getUserDelegationKey(startsOn, expiresOn);
        const sas = blobSdk.generateBlobSASQueryParameters({
            containerName: containerClient.containerName,
            blobName: filePath,
            permissions: blobSdk.BlobSASPermissions.parse('r'),
            protocol: blobSdk.SASProtocol.Https,
            startsOn,
            expiresOn,
        }, delegationKey, this.accountName).toString();

        return `${blob.url}?${sas}`;
    }

    async saveFile(filePath: string, content: unknown, metadata?: BlobMetadata) {
        await this.ensureReady();

        const { metadata: normalizedMetadata, contentType } = resolveUploadOptions(metadata);

        const blob = this.getContainerClient().getBlockBlobClient(filePath);

        if (typeof content === 'string' || Buffer.isBuffer(content)) {
            const buffer = typeof content === 'string' ? Buffer.from(content) : content;
            await blob.uploadData(buffer, {
                blobHTTPHeaders: contentType ? { blobContentType: contentType } : undefined,
                metadata: normalizedMetadata,
            });
            return blob;
        }

        const maybeWebStream = content as { getReader?: () => unknown; };
        const nodeStream = typeof maybeWebStream?.getReader === 'function'
            ? Readable.fromWeb(content as any)
            : content as Readable;

        await blob.uploadStream(nodeStream, undefined, undefined, {
            blobHTTPHeaders: contentType ? { blobContentType: contentType } : undefined,
            metadata: normalizedMetadata,
        });

        return blob;
    }

    async exists(filePath: string) {
        await this.ensureReady();
        const blob = this.getContainerClient().getBlobClient(filePath);
        return blob.exists();
    }
}
