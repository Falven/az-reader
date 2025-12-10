export class CloudFlareHTTP {
    private account?: string;
    private apiKey?: string;

    constructor(account?: string, apiKey?: string) {
        this.account = account;
        this.apiKey = apiKey;
    }

    async fetchBrowserRenderedHTML(_payload: { url: string; }): Promise<{ parsed: { result: any; }; }> {
        const targetUrl = _payload.url;
        if (!targetUrl) {
            return { parsed: { result: '' } };
        }

        // If Cloudflare credentials are unavailable, fallback to a direct fetch.
        if (!this.account || !this.apiKey) {
            const res = await fetch(targetUrl);
            if (!res.ok) {
                const err: any = new Error(`Failed to fetch ${targetUrl}: ${res.status} ${res.statusText}`);
                err.status = res.status;
                throw err;
            }
            const text = await res.text();
            return { parsed: { result: text } };
        }

        const endpoint = `https://api.cloudflare.com/client/v4/accounts/${this.account}/browser-rendering/content`;
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify({ url: targetUrl }),
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            const err: any = new Error(`Cloudflare render failed: ${res.status} ${res.statusText}`);
            err.status = res.status;
            err.body = text;
            throw err;
        }

        const json = await res.json().catch(async () => ({ result: await res.text() }));
        const result = (json as any)?.result ?? (json as any)?.parsed?.result ?? json;
        return { parsed: { result } };
    }
}
