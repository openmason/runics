// ══════════════════════════════════════════════════════════════════════════════
// SearchCache — KV-Based Result Caching
// ══════════════════════════════════════════════════════════════════════════════
//
// Caches search results in Cloudflare KV with TTL-based expiry.
//
// Key: SHA-256 hash of normalized (tenantId + query + appetite)
// Value: Serialized FindSkillResponse
// TTL: 120s for Tier 1, 60s for Tier 2/3 (KV minimum: 60s)
//
// Why not prefix-delete: KV doesn't support it. TTL-based expiry is fine for V1.
// Future: Add tenant version counter for instant invalidation on skill publish.
//
// ══════════════════════════════════════════════════════════════════════════════

import type { FindSkillResponse } from '../types';

const REVOKED_SLUGS_KEY = 'revoked_slugs';

export class SearchCache {
  constructor(
    private kv: KVNamespace,
    private ttlSeconds: number
  ) {}

  // ────────────────────────────────────────────────────────────────────────────
  // Cache Key Generation
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Generate cache key from query parameters.
   * Uses SHA-256 hash of normalized input.
   *
   * @param query - Search query (lowercased and trimmed)
   * @param tenantId - Tenant ID
   * @param appetite - Risk appetite (default 'balanced')
   * @returns Cache key string
   */
  private async generateKey(
    query: string,
    tenantId: string,
    appetite: string
  ): Promise<string> {
    // Normalize query: lowercase, trim, collapse whitespace
    const normalizedQuery = query.toLowerCase().trim().replace(/\s+/g, ' ');

    // Create composite key
    const composite = `${tenantId}:${normalizedQuery}:${appetite}`;

    // Hash with SHA-256
    const encoder = new TextEncoder();
    const data = encoder.encode(composite);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    return `search:${hashHex}`;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Get from Cache
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Get cached search result.
   *
   * @param query - Search query
   * @param tenantId - Tenant ID
   * @param appetite - Risk appetite
   * @returns Cached result or null if not found
   */
  async get(
    query: string,
    tenantId: string,
    appetite: string
  ): Promise<FindSkillResponse | null> {
    try {
      const key = await this.generateKey(query, tenantId, appetite);
      const cached = await this.kv.get(key, 'text');

      if (!cached) {
        return null;
      }

      const parsed = JSON.parse(cached) as FindSkillResponse;

      // Filter out revoked slugs from cached results
      const revokedSlugs = await this.getRevokedSlugs();
      if (revokedSlugs.size > 0) {
        parsed.results = parsed.results.filter(
          (r) => !revokedSlugs.has(r.slug)
        );
      }

      // Mark as cache hit in metadata
      parsed.meta.cacheHit = true;

      return parsed;
    } catch (error) {
      console.error('Cache get error:', error);
      return null; // Cache errors should not break search
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Set in Cache
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Cache search result with TTL.
   *
   * @param query - Search query
   * @param tenantId - Tenant ID
   * @param appetite - Risk appetite
   * @param result - Search result to cache
   * @param tier - Result tier (affects TTL)
   */
  async set(
    query: string,
    tenantId: string,
    appetite: string,
    result: FindSkillResponse,
    tier?: 1 | 2 | 3
  ): Promise<void> {
    try {
      const key = await this.generateKey(query, tenantId, appetite);

      // Tier-based TTL:
      // Tier 1 (high confidence): 120s (stable, high confidence)
      // Tier 2/3 (lower confidence): 60s (may improve as new skills arrive; KV minimum)
      const ttl = tier === 1 ? this.ttlSeconds : Math.floor(this.ttlSeconds / 2);

      // Remove enrichmentPromise before caching (not serializable)
      const cacheableResult = { ...result };
      delete cacheableResult.enrichmentPromise;

      await this.kv.put(key, JSON.stringify(cacheableResult), {
        expirationTtl: ttl,
      });
    } catch (error) {
      console.error('Cache set error:', error);
      // Cache errors should not break search
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Invalidate (Future: Version-Based Invalidation)
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Invalidate cache for a specific query.
   * Currently not used — we rely on TTL expiry.
   * Future: Add tenant version counter for instant invalidation.
   *
   * @param query - Search query
   * @param tenantId - Tenant ID
   * @param appetite - Risk appetite
   */
  async invalidate(
    query: string,
    tenantId: string,
    appetite: string
  ): Promise<void> {
    try {
      const key = await this.generateKey(query, tenantId, appetite);
      await this.kv.delete(key);
    } catch (error) {
      console.error('Cache invalidate error:', error);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Revoked Slugs — Instant Cache Invalidation
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Add a slug to the revoked set. Cached search results containing
   * this slug will be filtered out on read.
   */
  async addRevokedSlug(slug: string): Promise<void> {
    try {
      const slugs = await this.getRevokedSlugs();
      slugs.add(slug);
      await this.kv.put(REVOKED_SLUGS_KEY, JSON.stringify([...slugs]));
    } catch (error) {
      console.error('[CACHE] addRevokedSlug error:', error);
    }
  }

  /**
   * Remove a slug from the revoked set (e.g., after re-scan clears the issue).
   */
  async removeRevokedSlug(slug: string): Promise<void> {
    try {
      const slugs = await this.getRevokedSlugs();
      slugs.delete(slug);
      if (slugs.size === 0) {
        await this.kv.delete(REVOKED_SLUGS_KEY);
      } else {
        await this.kv.put(REVOKED_SLUGS_KEY, JSON.stringify([...slugs]));
      }
    } catch (error) {
      console.error('[CACHE] removeRevokedSlug error:', error);
    }
  }

  /**
   * Get the current set of revoked slugs.
   */
  async getRevokedSlugs(): Promise<Set<string>> {
    try {
      const raw = await this.kv.get(REVOKED_SLUGS_KEY, 'text');
      if (!raw) return new Set();
      return new Set(JSON.parse(raw) as string[]);
    } catch {
      return new Set();
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Query Embedding Cache
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Get cached query embedding vector.
   * Embeddings are deterministic for a given model, so we cache aggressively (30min TTL).
   */
  async getQueryEmbedding(query: string): Promise<number[] | null> {
    try {
      const key = await this.generateEmbeddingKey(query);
      const cached = await this.kv.get(key, 'text');
      if (!cached) return null;
      return JSON.parse(cached) as number[];
    } catch {
      return null;
    }
  }

  /**
   * Cache a query embedding vector.
   * TTL: 1800s (30 minutes) — embeddings are deterministic for a given model.
   */
  async setQueryEmbedding(query: string, embedding: number[]): Promise<void> {
    try {
      const key = await this.generateEmbeddingKey(query);
      await this.kv.put(key, JSON.stringify(embedding), {
        expirationTtl: 1800,
      });
    } catch {
      // Cache errors should not break search
    }
  }

  private async generateEmbeddingKey(query: string): Promise<string> {
    const normalized = query.toLowerCase().trim().replace(/\s+/g, ' ');
    const encoder = new TextEncoder();
    const data = encoder.encode(normalized);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    return `qemb:${hashHex}`;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Clear All (Development/Testing)
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Clear all cached search results.
   * WARNING: This lists all keys with prefix "search:" and deletes them.
   * Use only in development/testing.
   */
  async clearAll(): Promise<void> {
    try {
      const list = await this.kv.list({ prefix: 'search:' });

      for (const key of list.keys) {
        await this.kv.delete(key.name);
      }
    } catch (error) {
      console.error('Cache clear error:', error);
    }
  }
}
