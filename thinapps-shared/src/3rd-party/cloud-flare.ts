import { HTTPServiceError } from 'civkit/http';

const toHttpServiceError = (
    method: string,
    url: string,
    status: number,
    statusText: string,
    body?: string,
) => {
    const cause = new Error(`Cloudflare request failed: ${status} ${statusText}`);
    const err = new HTTPServiceError(0, {
        err: cause,
        status,
        config: { method, url },
    }) as HTTPServiceError & { body?: string; };
    err.status = status;
    if (body) {
        err.body = body;
    }

    return err;
};

export class CloudFlareHTTP {
    constructor(
        private readonly account?: string,
        private readonly apiKey?: string,
    ) { }

    async fetchBrowserRenderedHTML(payload: { url?: string; }) {
        const targetUrl = payload.url;
        if (!targetUrl) {
            return { parsed: { result: '' } };
        }

        // If credentials are not configured, fall back to a direct fetch.
        if (!this.account || !this.apiKey) {
            const res = await fetch(targetUrl);
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                throw toHttpServiceError('GET', targetUrl, res.status, res.statusText, body);
            }

            const text = await res.text();
            return { parsed: { result: text } };
        }

        const endpoint = `https://api.cloudflare.com/client/v4/accounts/${this.account}/browser-rendering/content`;
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify({ url: targetUrl }),
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw toHttpServiceError('POST', endpoint, res.status, res.statusText, text);
        }

        const json = await res.json().catch(async () => ({ result: await res.text() }));
        const result = (json as any)?.result ?? (json as any)?.parsed?.result ?? json;
        return { parsed: { result } };
    }
}
