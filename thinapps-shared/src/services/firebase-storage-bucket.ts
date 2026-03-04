import { singleton } from 'tsyringe';
import { BlobStorageControl } from './blob-storage';

type SaveOptions = {
    metadata?: Record<string, string>;
    contentType?: string;
};

type SignedUrlOptions = {
    action: string;
    expires: number | Date;
};

class BucketFile {
    constructor(
        private readonly path: string,
        private readonly blob: BlobStorageControl,
    ) {}

    async save(content: unknown, options?: SaveOptions) {
        const metadata = options
            ? { ...options.metadata, contentType: options.contentType }
            : undefined;
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
    constructor(private readonly blob: BlobStorageControl) {}

    file(path: string) {
        return new BucketFile(path, this.blob);
    }
}

@singleton()
export class FirebaseStorageBucketControl {
    readonly blob = new BlobStorageControl();
    readonly bucket = new Bucket(this.blob);

    async downloadFile(filePath: any) {
        return this.blob.downloadFile(filePath);
    }

    async signDownloadUrl(filePath: any, expires: number | Date) {
        return this.blob.signDownloadUrl(filePath, expires);
    }

    async saveFile(filePath: any, content: unknown, metadata?: any) {
        await this.blob.saveFile(filePath, content, metadata);
        return filePath;
    }
}
