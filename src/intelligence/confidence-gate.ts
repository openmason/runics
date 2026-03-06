// ══════════════════════════════════════════════════════════════════════════════
// ConfidenceGate — Three-Tier Routing Orchestrator
// ══════════════════════════════════════════════════════════════════════════════
//
// Wraps the SearchProvider and implements confidence-gated routing:
//
// Tier 1 (HIGH):   Return immediately. Log + cache. No LLM. ~50ms.
// Tier 2 (MEDIUM): Return immediately + fire async LLM enrichment.
//                   Enriched result cached for next hit.
// Tier 3 (LOW):    Full LLM deep search before responding. ~500-1000ms.
//
// Confidence assessment uses multiple signals:
// - Top score vs thresholds
// - Score gap between #1 and #2
// - Full-text keyword hits
// - Cluster density
//
// ══════════════════════════════════════════════════════════════════════════════

import type { SearchProvider } from '../providers/search-provider';
import type {
  Env,
  SearchFilters,
  SearchOptions,
  SearchResult,
  ScoredSkill,
  FindSkillResponse,
  SkillResult,
  Appetite,
} from '../types';
import { appetiteToTrustThreshold } from '../types';
import type { SearchCache } from '../cache/kv-cache';
import type { SearchLogger } from '../monitoring/search-logger';
import { DeepSearch } from './deep-search';
import { CompositionDetector } from './composition-detector';
import { Reranker } from './reranker';
import { CircuitBreaker } from '../resilience/circuit-breaker';
import { Pool } from '@neondatabase/serverless';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

interface FindSkillOptions {
  limit?: number;
  appetite?: Appetite;
  tags?: string[];
  category?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// ConfidenceGate
// ──────────────────────────────────────────────────────────────────────────────

export class ConfidenceGate {
  private tier1Threshold: number;
  private tier2Threshold: number;
  private gapThreshold: number;
  private clusterDensityThreshold: number;
  private deepSearchEnabled: boolean;
  private deepSearch: DeepSearch;
  private compositionDetector: CompositionDetector;
  private reranker: Reranker;
  private rerankerEnabled: boolean;
  private circuitBreaker: CircuitBreaker;

  constructor(
    private env: Env,
    private provider: SearchProvider,
    private embedFn: (text: string) => Promise<number[]>,
    private cache: SearchCache,
    private logger: SearchLogger,
    private pool: Pool
  ) {
    this.tier1Threshold = parseFloat(env.CONFIDENCE_TIER1_THRESHOLD || '0.40');
    this.tier2Threshold = parseFloat(env.CONFIDENCE_TIER2_THRESHOLD || '0.35');
    this.gapThreshold = parseFloat(env.SCORE_GAP_THRESHOLD || '0.05');
    this.clusterDensityThreshold = parseFloat(
      env.CLUSTER_DENSITY_THRESHOLD || '0.05'
    );
    this.deepSearchEnabled = env.DEEP_SEARCH_ENABLED !== 'false';

    this.circuitBreaker = new CircuitBreaker(
      parseInt(env.CIRCUIT_BREAKER_THRESHOLD || '3'),
      parseInt(env.CIRCUIT_BREAKER_COOLDOWN_MS || '30000')
    );

    this.rerankerEnabled = env.RERANKER_ENABLED === 'true';
    this.reranker = new Reranker(env, pool, this.circuitBreaker);

    this.deepSearch = new DeepSearch(env, provider, embedFn, this.circuitBreaker);
    this.compositionDetector = new CompositionDetector(
      env,
      provider,
      embedFn,
      this.circuitBreaker
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Main findSkill orchestrator
  // ──────────────────────────────────────────────────────────────────────────

  async findSkill(
    query: string,
    tenantId: string,
    options: FindSkillOptions,
    ctx: ExecutionContext
  ): Promise<FindSkillResponse> {
    const startTime = Date.now();

    const appetite = options.appetite || (this.env.DEFAULT_APPETITE as Appetite) || 'balanced';
    const limit = options.limit || 10;

    // ── 1. Cache Check ──
    const cached = await this.cache.get(query, tenantId, appetite);
    if (cached) {
      cached.meta.latencyMs = Date.now() - startTime;
      return cached;
    }

    // ── 2. Embed Query ──
    const embedding = await this.embedFn(query);

    // ── 3. Build Filters ──
    const filters: SearchFilters = {
      tenantId,
      tags: options.tags,
      category: options.category,
      minTrustScore: appetiteToTrustThreshold(appetite),
      contentSafetyRequired: true,
    };

    // ── 4. Provider Search ──
    const searchResult = await this.provider.search(query, embedding, filters, {
      limit,
    });

    // ── 5. Assess Confidence (multi-signal) ──
    // Assess BEFORE reranking — confidence thresholds are calibrated for bi-encoder scores
    const assessedTier = this.assessConfidence(searchResult);

    // ── 5b. Cross-Encoder Reranking (optional) ──
    // Reranker only reorders results; confidence tier is already determined
    let reranked = false;
    if (this.rerankerEnabled && searchResult.results.length > 1) {
      const rerankerResult = await this.reranker.rerank(
        query,
        searchResult.results
      );
      if (rerankerResult.applied) {
        searchResult.results = rerankerResult.results;
        reranked = true;
      }
    }

    // If circuit breaker is open, force Tier 1 (skip LLM calls)
    const degraded = this.circuitBreaker.isOpen && assessedTier > 1;
    const tier = degraded ? 1 : assessedTier;

    // ── 6. Route by Tier ──
    let response: FindSkillResponse;

    switch (tier) {
      case 1:
        response = await this.handleTier1(
          query,
          searchResult,
          startTime,
          degraded,
          reranked
        );
        break;

      case 2:
        response = await this.handleTier2(
          query,
          embedding,
          searchResult,
          filters,
          startTime,
          ctx,
          reranked
        );
        break;

      case 3:
        response = await this.handleTier3(
          query,
          embedding,
          searchResult,
          filters,
          tenantId,
          startTime,
          reranked
        );
        break;
    }

    // ── 7. Log Event (Non-Blocking) ──
    const logEntry = this.logger.buildLogEntry({
      query,
      tenantId,
      appetite,
      tier,
      cacheHit: false,
      topScore: searchResult.confidence.topScore,
      gapToSecond: searchResult.confidence.gapToSecond,
      clusterDensity: searchResult.confidence.clusterDensity,
      keywordHits: searchResult.confidence.keywordHits,
      resultCount: response.results.length,
      matchSource: searchResult.results[0]?.matchSource,
      resultSkillIds: response.results.map((r) => r.id),
      totalLatencyMs: Date.now() - startTime,
      vectorSearchMs: searchResult.meta.vectorSearchMs,
      fullTextSearchMs: searchResult.meta.fullTextSearchMs,
      fusionStrategy: searchResult.meta.fusionStrategy,
      llmInvoked: tier >= 2 && this.deepSearchEnabled,
      llmModel: tier >= 2 ? this.env.LLM_MODEL : undefined,
      embeddingCost: this.logger.estimateEmbeddingCost(query.length),
      llmCost: tier === 3 ? 0.0003 : tier === 2 ? 0.0001 : 0,
      alternateQueriesUsed: response.searchTrace?.alternateQueries,
      compositionDetected: response.composition?.detected ?? false,
      generationHintReturned: !!response.generationHints,
    });

    ctx.waitUntil(this.logger.log(logEntry));

    // ── 8. Cache Result (Non-Blocking) ──
    ctx.waitUntil(
      this.cache.set(query, tenantId, appetite, response, tier)
    );

    return response;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Confidence Assessment (Multi-Signal)
  // ──────────────────────────────────────────────────────────────────────────

  private assessConfidence(result: SearchResult): 1 | 2 | 3 {
    if (result.results.length === 0) {
      return 3;
    }

    const topScore = result.confidence.topScore;
    const gap = result.confidence.gapToSecond;
    const keywordHits = result.confidence.keywordHits;

    // HIGH: top_score > tier1 AND (gap > gapThreshold OR keywordHits > 0)
    if (
      topScore >= this.tier1Threshold &&
      (gap >= this.gapThreshold || keywordHits > 0)
    ) {
      return 1;
    }

    // MEDIUM: top_score > tier2
    if (topScore >= this.tier2Threshold) {
      return 2;
    }

    // LOW: everything else
    return 3;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Tier Handlers
  // ──────────────────────────────────────────────────────────────────────────

  private async handleTier1(
    query: string,
    result: SearchResult,
    startTime: number,
    degraded: boolean = false,
    reranked: boolean = false
  ): Promise<FindSkillResponse> {
    const skillResults = await this.buildSkillResults(result.results);

    return {
      results: skillResults,
      confidence: 'high',
      enriched: false,
      meta: {
        matchSources: result.results.slice(0, 3).map((r) => r.matchSource),
        latencyMs: Date.now() - startTime,
        tier: 1,
        cacheHit: false,
        llmInvoked: false,
        ...(degraded ? { degraded: true } : {}),
        ...(reranked ? { reranked: true } : {}),
      },
    };
  }

  private async handleTier2(
    query: string,
    embedding: number[],
    result: SearchResult,
    filters: SearchFilters,
    startTime: number,
    ctx: ExecutionContext,
    reranked: boolean = false
  ): Promise<FindSkillResponse> {
    const skillResults = await this.buildSkillResults(result.results);

    const response: FindSkillResponse = {
      results: skillResults,
      confidence: 'medium',
      enriched: false,
      meta: {
        matchSources: result.results.slice(0, 3).map((r) => r.matchSource),
        latencyMs: Date.now() - startTime,
        tier: 2,
        cacheHit: false,
        llmInvoked: false,
        ...(reranked ? { reranked: true } : {}),
      },
    };

    // Fire async enrichment via waitUntil
    if (this.deepSearchEnabled) {
      ctx.waitUntil(
        this.asyncEnrich(query, result, filters).catch((error) =>
          console.error('Async enrichment error:', error)
        )
      );
    }

    return response;
  }

  private async handleTier3(
    query: string,
    embedding: number[],
    result: SearchResult,
    filters: SearchFilters,
    tenantId: string,
    startTime: number,
    reranked: boolean = false
  ): Promise<FindSkillResponse> {
    if (!this.deepSearchEnabled) {
      // Deep search disabled — return raw results
      const skillResults = await this.buildSkillResults(result.results);
      return {
        results: skillResults,
        confidence: 'low_enriched',
        enriched: false,
        meta: {
          matchSources: result.results.slice(0, 3).map((r) => r.matchSource),
          latencyMs: Date.now() - startTime,
          tier: 3,
          cacheHit: false,
          llmInvoked: false,
          ...(reranked ? { reranked: true } : {}),
        },
      };
    }

    // Full LLM deep search (blocking)
    const deepResult = await this.deepSearch.deepSearch(
      query,
      embedding,
      result,
      filters
    );

    // Run composition detection if deep search flagged it
    let composition = deepResult.composition;
    if (!composition && deepResult.trace.alternateQueries.length > 0) {
      // Check if the merged results suggest composition
      composition = await this.compositionDetector.detect(
        query,
        deepResult.result.results,
        { tenantId }
      );
      if (!composition.detected) {
        composition = undefined;
      }
    }

    const skillResults = await this.buildSkillResults(
      deepResult.result.results
    );

    const confidence: FindSkillResponse['confidence'] = deepResult.noMatch
      ? 'no_match'
      : 'low_enriched';

    return {
      results: skillResults,
      confidence,
      enriched: true,
      composition,
      searchTrace: {
        originalQuery: deepResult.trace.originalQuery,
        alternateQueries: deepResult.trace.alternateQueries,
        terminologyMap: deepResult.trace.terminologyMap,
        reasoning: deepResult.trace.reasoning,
      },
      generationHints: deepResult.generationHints,
      meta: {
        matchSources: deepResult.result.results
          .slice(0, 3)
          .map((r) => r.matchSource),
        latencyMs: Date.now() - startTime,
        tier: 3,
        cacheHit: false,
        llmInvoked: true,
        ...(reranked ? { reranked: true } : {}),
      },
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Async Enrichment (Tier 2)
  // ──────────────────────────────────────────────────────────────────────────

  private async asyncEnrich(
    query: string,
    initialResult: SearchResult,
    filters: SearchFilters
  ): Promise<void> {
    const enrichedResult = await this.deepSearch.expandAndReSearch(
      query,
      initialResult,
      filters
    );

    // Build enriched response
    const skillResults = await this.buildSkillResults(enrichedResult.results);

    const enrichedResponse: FindSkillResponse = {
      results: skillResults,
      confidence: 'medium',
      enriched: true,
      meta: {
        matchSources: enrichedResult.results
          .slice(0, 3)
          .map((r) => r.matchSource),
        latencyMs: 0, // Not meaningful for async
        tier: 2,
        cacheHit: false,
        llmInvoked: true,
      },
    };

    // Update cache with enriched result (replaces initial)
    const appetite = (this.env.DEFAULT_APPETITE as Appetite) || 'balanced';
    await this.cache.set(
      query,
      filters.tenantId,
      appetite,
      enrichedResponse,
      2
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Build SkillResult[] from ScoredSkill[]
  // ──────────────────────────────────────────────────────────────────────────

  private async buildSkillResults(
    scoredSkills: ScoredSkill[]
  ): Promise<SkillResult[]> {
    if (scoredSkills.length === 0) {
      return [];
    }

    const skillIds = scoredSkills.map((s) => s.skillId);

    const sql = `
      SELECT
        s.id,
        s.name,
        s.slug,
        s.agent_summary,
        s.trust_score,
        s.execution_layer,
        s.capabilities_required,
        s.type,
        s.status,
        s.replacement_skill_id,
        rs.slug AS replacement_slug,
        s.tags,
        s.avg_execution_time_ms,
        s.error_rate
      FROM skills s
      LEFT JOIN skills rs ON rs.id = s.replacement_skill_id
      WHERE s.id = ANY($1::uuid[])
    `;

    const result = await this.pool.query(sql, [skillIds]);

    const skillMap = new Map(
      result.rows.map((row: any) => [
        row.id,
        {
          id: row.id,
          name: row.name,
          slug: row.slug,
          agentSummary: row.agent_summary,
          trustScore: parseFloat(row.trust_score),
          executionLayer: row.execution_layer,
          capabilitiesRequired: row.capabilities_required ?? [],
          type: row.type,
          status: row.status,
          replacementSkillId: row.replacement_skill_id ?? undefined,
          replacementSlug: row.replacement_slug ?? undefined,
          tags: row.tags ?? undefined,
          avgExecutionTimeMs: row.avg_execution_time_ms ?? undefined,
          errorRate: row.error_rate ?? undefined,
        },
      ])
    );

    const results: SkillResult[] = [];
    for (const ss of scoredSkills) {
      const skill = skillMap.get(ss.skillId);
      if (!skill) continue;

      results.push({
        ...skill,
        score: ss.fusedScore,
        matchSource: ss.matchSource,
        matchText: ss.matchText,
      });
    }

    return results;
  }
}
