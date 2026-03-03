// ══════════════════════════════════════════════════════════════════════════════
// SearchLogger — Non-Blocking Search Event Logging
// ══════════════════════════════════════════════════════════════════════════════
//
// Every search event is logged to search_logs for quality learning and cost tracking.
// CRITICAL: All writes must be non-blocking via executionCtx.waitUntil()
//
// ══════════════════════════════════════════════════════════════════════════════

import { Pool } from '@neondatabase/serverless';
import type { SearchLogEntry } from '../types';

export class SearchLogger {
  constructor(private pool: Pool) {}

  // ────────────────────────────────────────────────────────────────────────────
  // Log Search Event (Non-Blocking)
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Log a search event to search_logs table.
   *
   * @param event - Search event to log
   * @returns Promise<string> - Event ID for feedback correlation
   *
   * IMPORTANT: Caller must wrap this in executionCtx.waitUntil() to make it non-blocking
   */
  async log(event: SearchLogEntry): Promise<string> {
    const sql = `
      INSERT INTO search_logs (
        query,
        tenant_id,
        appetite,
        tier,
        cache_hit,
        top_score,
        gap_to_second,
        cluster_density,
        keyword_hits,
        result_count,
        match_source,
        result_skill_ids,
        total_latency_ms,
        vector_search_ms,
        full_text_search_ms,
        fusion_strategy,
        llm_invoked,
        llm_latency_ms,
        llm_model,
        llm_tokens_used,
        embedding_cost,
        llm_cost,
        alternate_queries_used,
        composition_detected,
        generation_hint_returned
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25
      )
      RETURNING id
    `;

    const params = [
      event.query,
      event.tenantId,
      event.appetite ?? null,
      event.tier,
      event.cacheHit,
      event.topScore ?? null,
      event.gapToSecond ?? null,
      event.clusterDensity ?? null,
      event.keywordHits ?? null,
      event.resultCount,
      event.matchSource ?? null,
      event.resultSkillIds,
      event.totalLatencyMs,
      event.vectorSearchMs ?? null,
      event.fullTextSearchMs ?? null,
      event.fusionStrategy ?? null,
      event.llmInvoked,
      event.llmLatencyMs ?? null,
      event.llmModel ?? null,
      event.llmTokensUsed ?? null,
      event.embeddingCost,
      event.llmCost,
      event.alternateQueriesUsed ?? null,
      event.compositionDetected,
      event.generationHintReturned,
    ];

    try {
      const result = await this.pool.query(sql, params);
      return result.rows[0].id;
    } catch (error) {
      // Log error but don't throw — logging failures should not break search
      console.error('Failed to log search event:', error);
      // Return a placeholder ID
      return 'log-failed';
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Convenience: Log from SearchResult
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Build SearchLogEntry from search result components.
   * Helper to simplify logging from the search endpoint.
   */
  buildLogEntry(params: {
    query: string;
    tenantId: string;
    appetite?: string;
    tier: 1 | 2 | 3;
    cacheHit: boolean;
    topScore?: number;
    gapToSecond?: number;
    clusterDensity?: number;
    keywordHits?: number;
    resultCount: number;
    matchSource?: string;
    resultSkillIds: string[];
    totalLatencyMs: number;
    vectorSearchMs?: number;
    fullTextSearchMs?: number;
    fusionStrategy?: string;
    llmInvoked: boolean;
    llmLatencyMs?: number;
    llmModel?: string;
    llmTokensUsed?: number;
    embeddingCost: number;
    llmCost: number;
    alternateQueriesUsed?: string[];
    compositionDetected: boolean;
    generationHintReturned: boolean;
  }): SearchLogEntry {
    return {
      query: params.query,
      tenantId: params.tenantId,
      appetite: params.appetite,
      tier: params.tier,
      cacheHit: params.cacheHit,
      topScore: params.topScore,
      gapToSecond: params.gapToSecond,
      clusterDensity: params.clusterDensity,
      keywordHits: params.keywordHits,
      resultCount: params.resultCount,
      matchSource: params.matchSource,
      resultSkillIds: params.resultSkillIds,
      totalLatencyMs: params.totalLatencyMs,
      vectorSearchMs: params.vectorSearchMs,
      fullTextSearchMs: params.fullTextSearchMs,
      fusionStrategy: params.fusionStrategy,
      llmInvoked: params.llmInvoked,
      llmLatencyMs: params.llmLatencyMs,
      llmModel: params.llmModel,
      llmTokensUsed: params.llmTokensUsed,
      embeddingCost: params.embeddingCost,
      llmCost: params.llmCost,
      alternateQueriesUsed: params.alternateQueriesUsed,
      compositionDetected: params.compositionDetected,
      generationHintReturned: params.generationHintReturned,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Cost Estimation
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Estimate cost for embedding generation.
   * Workers AI pricing: ~$0.004 per 1M tokens (embeddings)
   * bge-small-en-v1.5: ~100 tokens per query avg
   */
  estimateEmbeddingCost(textLength: number): number {
    const tokensEstimate = Math.ceil(textLength / 4); // rough estimate
    return (tokensEstimate / 1_000_000) * 0.004;
  }

  /**
   * Estimate cost for LLM generation.
   * Workers AI pricing for Llama 3.3 70B: ~$0.01 per 1M tokens
   */
  estimateLLMCost(tokensUsed: number): number {
    return (tokensUsed / 1_000_000) * 0.01;
  }
}
