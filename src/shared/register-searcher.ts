import 'reflect-metadata';
/**
 * Preload the search RPC host so the crawl server also registers search routes.
 * This stays out of the main entrypoint to avoid modifying upstream application code.
 */
import { container } from 'tsyringe';
import { SearcherHost } from '../api/searcher';

// Instantiating the host triggers route registration via the shared RPC registry.
container.resolve(SearcherHost);
