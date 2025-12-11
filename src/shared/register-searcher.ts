import 'reflect-metadata';
/**
 * Preload the search RPC host when this module is pulled in via NODE_OPTIONS.
 * This keeps route registration decoupled from the entrypoints.
 */
import { container } from 'tsyringe';
import { SearcherHost } from '../api/searcher';

// Instantiating the host triggers route registration via the shared RPC registry.
container.resolve(SearcherHost);
