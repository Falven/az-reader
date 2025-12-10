import { singleton } from 'tsyringe';
import { BlobStorageControl, type FileContent } from './blob-storage';

type SaveOptions = {
    contentType?: string;
    metadata?: Record<string, unknown>;
};

type SignedUrlOptions = {
    action: 'read';
    expires: number;
};

class BucketFile {
    private readonly path: string;
    private readonly blob: BlobStorageControl;

    constructor(path: string, blob: BlobStorageControl) {
        this.path = path;
        this.blob = blob;
    }

    async save(content: FileContent, options?: SaveOptions): Promise<BucketFile> {
        const metadata = options ? { ...options.metadata, contentType: options.contentType } : undefined;
        await this.blob.saveFile(this.path, content, metadata);
        return this;
    }

    async download(): Promise<[Buffer]> {
        const data = await this.blob.downloadFile(this.path);
        return [data];
    }

    async exists(): Promise<[boolean]> {
        const exists = await this.blob.exists(this.path);
        return [exists];
    }

    async getSignedUrl(options: SignedUrlOptions): Promise<[string]> {
        if (options.action !== 'read') {
            throw new Error('Only read action is supported for signed URLs.');
        }
        const url = await this.blob.signDownloadUrl(this.path, options.expires);
        return [url];
    }
}

class Bucket {
    private readonly blob: BlobStorageControl;

    constructor(blob: BlobStorageControl) {
        this.blob = blob;
    }

    file(path: string): BucketFile {
        return new BucketFile(path, this.blob);
    }
}

@singleton()
export class FirebaseStorageBucketControl {
    readonly blob: BlobStorageControl = new BlobStorageControl();
    readonly bucket: Bucket = new Bucket(this.blob);

    async downloadFile(filePath: string): Promise<Buffer> {
        return this.blob.downloadFile(filePath);
    }

    async signDownloadUrl(filePath: string, expires?: number): Promise<string> {
        return this.blob.signDownloadUrl(filePath, expires);
    }

    async saveFile(filePath: string, content: FileContent, metadata?: Record<string, unknown>): Promise<string> {
        await this.blob.saveFile(filePath, content, metadata);
        return filePath;
    }
}
