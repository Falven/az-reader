import {
    BlobSASPermissions,
    BlobServiceClient,
    SASProtocol,
    StorageSharedKeyCredential,
    generateBlobSASQueryParameters,
    type ContainerClient,
} from '@azure/storage-blob';
import { Readable } from 'stream';
import { ReadableStream as NodeReadableStream } from 'stream/web';
import { getBlobConfig } from './azure-config';

type NormalizedMetadata = Record<string, string>;
export type FileContent = Buffer | string | Readable | NodeReadableStream | NodeJS.ReadableStream;

const streamToBuffer = async (readable: NodeJS.ReadableStream | NodeReadableStream): Promise<Buffer> => {
    const nodeStream: NodeJS.ReadableStream = typeof (readable as NodeReadableStream)?.getReader === 'function' ?
        Readable.fromWeb(readable as NodeReadableStream) as unknown as NodeJS.ReadableStream :
        readable as NodeJS.ReadableStream;
    const chunks: Buffer[] = [];

    for await (const chunk of nodeStream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
};

const normalizeMetadata = (metadata?: Record<string, unknown>): NormalizedMetadata | undefined => {
    if (!metadata) {
        return undefined;
    }

    const normalized: NormalizedMetadata = {};
    for (const [key, value] of Object.entries(metadata)) {
        if (value === undefined || value === null) {
            continue;
        }
        normalized[key] = typeof value === 'string' ? value : String(value);
    }

    return normalized;
};

export class BlobStorageControl {
    private enabled: boolean;
    private containerClient?: ContainerClient;
    private credential?: StorageSharedKeyCredential;
    private sasToken?: string;
    private ready?: Promise<void>;

    constructor() {
        const cfg = getBlobConfig();
        this.enabled = cfg.enabled;
        if (!cfg.enabled) {
            this.ready = Promise.resolve();
            return;
        }
        if (!cfg.endpoint || !cfg.accountName) {
            throw new Error('Blob storage endpoint or account is missing.');
        }

        if (cfg.accountKey) {
            this.credential = new StorageSharedKeyCredential(cfg.accountName, cfg.accountKey);
        } else {
            this.sasToken = cfg.sasToken?.startsWith('?') ? cfg.sasToken : cfg.sasToken ? `?${cfg.sasToken}` : undefined;
        }

        const serviceClient = this.credential ?
            new BlobServiceClient(cfg.endpoint, this.credential) :
            new BlobServiceClient(`${cfg.endpoint}${this.sasToken ?? ''}`);

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

    async downloadFile(filePath: string): Promise<Buffer> {
        await this.ensureReady();
        const blob = this.getContainerClient().getBlobClient(filePath);
        const response = await blob.download();
        if (!response.readableStreamBody) {
            throw new Error(`Unable to read blob stream for ${filePath}`);
        }

        return streamToBuffer(response.readableStreamBody);
    }

    async signDownloadUrl(filePath: string, expires?: number): Promise<string> {
        await this.ensureReady();
        const containerClient = this.getContainerClient();
        const blob = containerClient.getBlobClient(filePath);
        if (this.sasToken) {
            return `${blob.url}${this.sasToken}`;
        }
        if (!this.credential) {
            throw new Error('Cannot sign download URL without either a SAS token or an account key.');
        }

        const expiresOn = expires ? new Date(expires) : new Date(Date.now() + 3600 * 1000);
        const sas = generateBlobSASQueryParameters({
            containerName: containerClient.containerName,
            blobName: filePath,
            permissions: BlobSASPermissions.parse('r'),
            protocol: SASProtocol.Https,
            startsOn: new Date(),
            expiresOn,
        }, this.credential).toString();

        return `${blob.url}?${sas}`;
    }

    async saveFile(filePath: string, content: FileContent, metadata?: Record<string, unknown>) {
        await this.ensureReady();
        const normalizedMetadata = normalizeMetadata(metadata);
        const contentType = normalizedMetadata?.contentType;

        if (normalizedMetadata && contentType) {
            delete normalizedMetadata.contentType;
        }

        const blob = this.getContainerClient().getBlockBlobClient(filePath);

        if (typeof content === 'string' || Buffer.isBuffer(content)) {
            const buffer = typeof content === 'string' ? Buffer.from(content) : content;
            await blob.uploadData(buffer, {
                blobHTTPHeaders: contentType ? { blobContentType: contentType } : undefined,
                metadata: normalizedMetadata,
            });
            return blob;
        }

        const nodeStream: Readable = typeof (content as NodeReadableStream)?.getReader === 'function' ?
            Readable.fromWeb(content as NodeReadableStream) :
            content as Readable;

        await blob.uploadStream(nodeStream, undefined, undefined, {
            blobHTTPHeaders: contentType ? { blobContentType: contentType } : undefined,
            metadata: normalizedMetadata,
        });

        return blob;
    }

    async exists(filePath: string): Promise<boolean> {
        await this.ensureReady();
        const blob = this.getContainerClient().getBlobClient(filePath);
        return blob.exists();
    }
}
