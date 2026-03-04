/**
 * Legacy compatibility entrypoint.
 *
 * The original upstream module preloaded the search RPC host via app-local imports.
 * In this extracted shared package we keep it as a no-op side-effect module.
 */
export {};
