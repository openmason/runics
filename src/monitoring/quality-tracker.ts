// ══════════════════════════════════════════════════════════════════════════════
// QualityTracker — Feedback Recording & Analytics
// ══════════════════════════════════════════════════════════════════════════════
//
// Records user feedback (clicks, usage, dismissals) and exposes analytics queries
// for quality learning loop.
//
// CRITICAL: recordFeedback() must be called via executionCtx.waitUntil() for non-blocking
//
// ══════════════════════════════════════════════════════════════════════════════

import { Pool } from '@neondatabase/serverless';
import type {
  QualityFeedback,
  TierDistribution,
  MatchSourceStats,
  LatencyPercentiles,
  CostBreakdown,
  FailedQuery,
  Tier3Pattern,
} from '../types';

export class QualityTracker {
  constructor(private pool: Pool) {}

  // ────────────────────────────────────────────────────────────────────────────
  // Record Feedback (Non-Blocking)
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Record user feedback for a search result.
   *
   * @param feedback - Feedback data
   *
   * IMPORTANT: Caller must wrap this in executionCtx.waitUntil() to make it non-blocking
   */
  async recordFeedback(feedback: QualityFeedback): Promise<void> {
    const sql = `
      INSERT INTO quality_feedback (
        search_event_id,
        skill_id,
        feedback_type,
        position
      ) VALUES ($1, $2, $3, $4)
    `;

    try {
      await this.pool.query(sql, [
        feedback.searchEventId,
        feedback.skillId,
        feedback.feedbackType,
        feedback.position,
      ]);
    } catch (error) {
      // Log error but don't throw — feedback failures should not break the API
      console.error('Failed to record feedback:', error);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Analytics: Tier Distribution
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Get tier distribution over time window.
   * Validates confidence thresholds — if Tier 3 > 15%, thresholds may be too high.
   *
   * @param hours - Time window in hours (default 24)
   */
  async getTierDistribution(hours: number = 24): Promise<TierDistribution> {
    const sql = `
      SELECT
        tier,
        COUNT(*) as count
      FROM search_logs
      WHERE timestamp > NOW() - INTERVAL '${hours} hours'
      GROUP BY tier
    `;

    try {
      const result = await this.pool.query(sql);

      const distribution: TierDistribution = {
        tier1: 0,
        tier2: 0,
        tier3: 0,
      };

      for (const row of result.rows) {
        const tier = parseInt(row.tier);
        const count = parseInt(row.count);

        if (tier === 1) distribution.tier1 = count;
        else if (tier === 2) distribution.tier2 = count;
        else if (tier === 3) distribution.tier3 = count;
      }

      return distribution;
    } catch (error) {
      console.error('Failed to get tier distribution:', error);
      return { tier1: 0, tier2: 0, tier3: 0 };
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Analytics: Match Source Stats
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Which embedding types drive actual usage (not just high scores).
   * Helps identify which alternate query types are effective in Phase 3.
   *
   * @param hours - Time window in hours (default 24)
   */
  async getMatchSourceStats(hours: number = 24): Promise<MatchSourceStats[]> {
    const sql = `
      SELECT
        sl.match_source,
        COUNT(*) as query_count,
        AVG(sl.top_score) as avg_top_score,
        COUNT(qf.id) FILTER (WHERE qf.feedback_type = 'use') as use_count
      FROM search_logs sl
      LEFT JOIN quality_feedback qf ON qf.search_event_id = sl.id
      WHERE sl.timestamp > NOW() - INTERVAL '${hours} hours'
        AND sl.match_source IS NOT NULL
      GROUP BY sl.match_source
      ORDER BY use_count DESC, avg_top_score DESC
    `;

    try {
      const result = await this.pool.query(sql);

      return result.rows.map((row) => ({
        matchSource: row.match_source,
        queryCount: parseInt(row.query_count),
        avgTopScore: parseFloat(row.avg_top_score),
        useCount: parseInt(row.use_count) || 0,
      }));
    } catch (error) {
      console.error('Failed to get match source stats:', error);
      return [];
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Analytics: Latency Percentiles
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Latency percentiles by time window.
   * SLOs: p50 < 60ms, p99 < 500ms, p999 < 1500ms
   *
   * @param hours - Time window in hours (default 24)
   */
  async getLatencyPercentiles(hours: number = 24): Promise<LatencyPercentiles> {
    const sql = `
      SELECT
        percentile_cont(0.50) WITHIN GROUP (ORDER BY total_latency_ms) as p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY total_latency_ms) as p95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY total_latency_ms) as p99,
        percentile_cont(0.999) WITHIN GROUP (ORDER BY total_latency_ms) as p999
      FROM search_logs
      WHERE timestamp > NOW() - INTERVAL '${hours} hours'
    `;

    try {
      const result = await this.pool.query(sql);
      const row = result.rows[0];

      return {
        p50: parseFloat(row.p50) || 0,
        p95: parseFloat(row.p95) || 0,
        p99: parseFloat(row.p99) || 0,
        p999: parseFloat(row.p999) || 0,
      };
    } catch (error) {
      console.error('Failed to get latency percentiles:', error);
      return { p50: 0, p95: 0, p99: 0, p999: 0 };
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Analytics: Cost Breakdown
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Cost breakdown by tier and component.
   * Monitors LLM spend to ensure it stays within budget.
   *
   * @param hours - Time window in hours (default 24)
   */
  async getCostBreakdown(hours: number = 24): Promise<CostBreakdown> {
    const sql = `
      SELECT
        tier,
        SUM(embedding_cost) as embedding_cost,
        SUM(llm_cost) as llm_cost
      FROM search_logs
      WHERE timestamp > NOW() - INTERVAL '${hours} hours'
      GROUP BY tier
    `;

    try {
      const result = await this.pool.query(sql);

      const breakdown: CostBreakdown = {
        totalCost: 0,
        embeddingCost: 0,
        llmCost: 0,
        byTier: {
          tier1: 0,
          tier2: 0,
          tier3: 0,
        },
      };

      for (const row of result.rows) {
        const tier = parseInt(row.tier);
        const embeddingCost = parseFloat(row.embedding_cost) || 0;
        const llmCost = parseFloat(row.llm_cost) || 0;
        const tierTotal = embeddingCost + llmCost;

        breakdown.embeddingCost += embeddingCost;
        breakdown.llmCost += llmCost;
        breakdown.totalCost += tierTotal;

        if (tier === 1) breakdown.byTier.tier1 = tierTotal;
        else if (tier === 2) breakdown.byTier.tier2 = tierTotal;
        else if (tier === 3) breakdown.byTier.tier3 = tierTotal;
      }

      return breakdown;
    } catch (error) {
      console.error('Failed to get cost breakdown:', error);
      return {
        totalCost: 0,
        embeddingCost: 0,
        llmCost: 0,
        byTier: { tier1: 0, tier2: 0, tier3: 0 },
      };
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Analytics: Failed Queries
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Queries where users dismissed all results.
   * Candidates for: new skill generation, alternate query tuning, new embedding category.
   *
   * @param hours - Time window in hours (default 24)
   * @param limit - Max results (default 100)
   */
  async getFailedQueries(
    hours: number = 24,
    limit: number = 100
  ): Promise<FailedQuery[]> {
    const sql = `
      SELECT
        sl.query,
        sl.timestamp,
        sl.tier,
        sl.top_score,
        COUNT(qf.id) FILTER (WHERE qf.feedback_type = 'dismiss') as dismiss_count
      FROM search_logs sl
      LEFT JOIN quality_feedback qf ON qf.search_event_id = sl.id
      WHERE sl.timestamp > NOW() - INTERVAL '${hours} hours'
      GROUP BY sl.id, sl.query, sl.timestamp, sl.tier, sl.top_score
      HAVING COUNT(qf.id) FILTER (WHERE qf.feedback_type = 'dismiss') > 0
        AND COUNT(qf.id) FILTER (WHERE qf.feedback_type IN ('use', 'click', 'explicit_good')) = 0
      ORDER BY dismiss_count DESC, sl.timestamp DESC
      LIMIT $1
    `;

    try {
      const result = await this.pool.query(sql, [limit]);

      return result.rows.map((row) => ({
        query: row.query,
        timestamp: new Date(row.timestamp),
        tier: parseInt(row.tier),
        topScore: row.top_score ? parseFloat(row.top_score) : undefined,
        dismissCount: parseInt(row.dismiss_count),
      }));
    } catch (error) {
      console.error('Failed to get failed queries:', error);
      return [];
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Analytics: Tier 3 Patterns
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Common Tier 3 query patterns.
   * These patterns suggest new alternate query categories for Layer A (Phase 3).
   *
   * @param hours - Time window in hours (default 24)
   */
  async getTier3Patterns(hours: number = 24): Promise<Tier3Pattern[]> {
    const sql = `
      SELECT
        query,
        COUNT(*) as frequency,
        AVG(top_score) as avg_top_score,
        alternate_queries_used
      FROM search_logs
      WHERE timestamp > NOW() - INTERVAL '${hours} hours'
        AND tier = 3
        AND alternate_queries_used IS NOT NULL
      GROUP BY query, alternate_queries_used
      HAVING COUNT(*) > 1
      ORDER BY frequency DESC
      LIMIT 50
    `;

    try {
      const result = await this.pool.query(sql);

      return result.rows.map((row) => ({
        pattern: row.query,
        frequency: parseInt(row.frequency),
        avgTopScore: parseFloat(row.avg_top_score),
        alternateQueriesUsed: row.alternate_queries_used || [],
      }));
    } catch (error) {
      console.error('Failed to get tier 3 patterns:', error);
      return [];
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Materialized View Refresh (Cron Trigger)
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Refresh the search_quality_summary materialized view.
   * Called hourly via cron trigger.
   */
  async refreshSummary(): Promise<void> {
    try {
      // CONCURRENTLY allows reads during refresh but requires at least one row
      await this.pool.query(
        'REFRESH MATERIALIZED VIEW CONCURRENTLY search_quality_summary'
      );
    } catch (error) {
      // Fallback to full refresh if CONCURRENTLY fails (e.g., empty view)
      console.warn(
        '[CRON] Concurrent refresh failed, trying full refresh:',
        (error as Error).message
      );
      await this.pool.query(
        'REFRESH MATERIALIZED VIEW search_quality_summary'
      );
    }
  }
}
