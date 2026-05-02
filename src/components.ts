// ══════════════════════════════════════════════════════════════════════════════
// Component Initialization — Shared factory for route modules
// ══════════════════════════════════════════════════════════════════════════════

import { createPool } from './db/connection';
import { PgVectorProvider } from './providers/pgvector-provider';
import { EmbedPipeline } from './ingestion/embed-pipeline';
import { SearchCache } from './cache/kv-cache';
import { SearchLogger } from './monitoring/search-logger';
import { QualityTracker } from './monitoring/quality-tracker';
import { ConfidenceGate } from './intelligence/confidence-gate';
import type { Env } from './types';

export { createPool } from './db/connection';

export function initComponents(env: Env) {
  const pool = createPool(env);

  const provider = new PgVectorProvider(env);
  const embedPipeline = new EmbedPipeline(env);
  const cache = new SearchCache(
    env.SEARCH_CACHE,
    parseInt(env.CACHE_TTL_SECONDS || '60')
  );
  const logger = new SearchLogger(pool);
  const qualityTracker = new QualityTracker(pool);

  // Embed function for the intelligence layer (with KV cache to skip ~1000ms AI call on repeat queries)
  const embedFn = async (text: string) => {
    const cached = await cache.getQueryEmbedding(text);
    if (cached) return cached;
    const embedding = await embedPipeline['embed'](text);
    cache.setQueryEmbedding(text, embedding).catch(() => {});
    return embedding;
  };

  const gate = new ConfidenceGate(
    env,
    provider,
    embedFn,
    cache,
    logger,
    pool
  );

  return { provider, embedPipeline, cache, logger, qualityTracker, pool, gate };
}
