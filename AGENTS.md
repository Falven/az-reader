# az-reader Agent Notes

## Scope

- This file applies to `apps/az-reader/**`.
- Reader search behavior source of truth: `apps/az-reader/src/api/searcher.ts`.

## MCP Search Contract

- `/mcp/search` is the MCP-compat path (method `searchMcpCompat` in `src/api/searcher.ts`).
- For `/mcp/search`, the handler forces `crawlerOptions.respondWith = 'no-content'`.
- MCP-compat responses are returned as JSON with `{"results":[...]}` via `toMcpCompatResponse`.
- Keep this contract stable for `apps/az-jina-mcp` compatibility and lower-latency search responses.

## Multi-Replica Behavior

- Reader requests may hit any ACA replica; do not rely on in-memory state for correctness.
- Rate-limit counters are persisted through Cosmos (`thinapps-shared/src/services/rate-limit.ts` + `thinapps-shared/src/db/rate-limit-counter.ts`).
- Instance-local caches in `src/api/searcher.ts` (for example `highFreqKeyCache`) are performance optimizations, not shared state.

## Replica Verification Commands

- From repo root, list live replicas:
  - `az containerapp replica list -g <resource-group> -n <container-app>`
- To verify a specific replica directly, run an in-replica request (interactive terminal required):
  - `az containerapp exec -g <resource-group> -n <container-app> --replica <replica-name> --command "<command>"`
- If `az containerapp exec` reports `(19, 'Operation not supported by device')`, rerun from a TTY-enabled terminal/session.
