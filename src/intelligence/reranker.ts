// ══════════════════════════════════════════════════════════════════════════════
// Reranker — Cross-Encoder Reranking via Workers AI
// ══════════════════════════════════════════════════════════════════════════════
//
// Uses bge-reranker-base to reorder search results using cross-encoder scoring.
// Cross-encoders see query + document together, so they can capture nuances
// that bi-encoders miss (at higher latency cost).
//
// Integration: runs AFTER provider search and confidence assessment, reorders only.
// Wrapped in circuit breaker — on failure, returns original ordering.
//
// ══════════════════════════════════════════════════════════════════════════════

import type { Env, ScoredSkill } from '../types';
import type { CircuitBreaker } from '../resilience/circuit-breaker';
import { Pool } from '@neondatabase/serverless';

export class Reranker {
  private topN: number;

  constructor(
    private env: Env,
    private pool: Pool,
    private circuitBreaker: CircuitBreaker
  ) {
    this.topN = parseInt(env.RERANKER_TOP_N || '20');
  }

  /**
   * Rerank search results using cross-encoder.
   * Returns reordered results (original scores preserved, only ordering changes).
   * On failure, returns original ordering unchanged.
   */
  async rerank(
    query: string,
    results: ScoredSkill[]
  ): Promise<{ results: ScoredSkill[]; applied: boolean }> {
    if (results.length <= 1) {
      return { results, applied: false };
    }

    // Take top N candidates for reranking
    const candidates = results.slice(0, this.topN);
    const passthrough = results.slice(this.topN);

    // Fetch agent_summary text for each candidate
    const summaryMap = await this.fetchSummaries(
      candidates.map((c) => c.skillId)
    );

    // Build text pairs for cross-encoder
    const texts: string[] = [];
    const validCandidates: ScoredSkill[] = [];

    for (const candidate of candidates) {
      const summary = summaryMap.get(candidate.skillId);
      if (summary) {
        texts.push(summary);
        validCandidates.push(candidate);
      } else {
        // No summary available — push to end of passthrough
        passthrough.push(candidate);
      }
    }

    if (validCandidates.length <= 1) {
      return { results, applied: false };
    }

    // Build contexts for Workers AI reranker API
    const contexts = texts.map((text) => ({ text }));

    // Call cross-encoder via circuit breaker
    const { result: ranked, degraded } = await this.circuitBreaker.execute(
      async () => {
        const response = await this.env.AI.run(
          this.env.RERANKER_MODEL as any,
          {
            query,
            contexts,
          }
        );

        // Workers AI reranker returns {response: [{id, score}]}
        const data = (response as any).response;
        if (!Array.isArray(data) || data.length === 0) {
          throw new Error(
            `Reranker returned invalid response: ${JSON.stringify(response).slice(0, 200)}`
          );
        }
        return data as Array<{ id: number; score: number }>;
      },
      null
    );

    if (degraded || !ranked) {
      return { results, applied: false };
    }

    // Build score lookup from id -> cross-encoder score
    const scoreById = new Map(
      ranked.map((r) => [r.id, r.score])
    );

    // Sort candidates by cross-encoder score, but preserve original fusedScore
    const reranked = validCandidates
      .map((candidate, i) => ({
        candidate,
        crossEncoderScore: scoreById.get(i) ?? 0,
      }))
      .sort((a, b) => b.crossEncoderScore - a.crossEncoderScore)
      .map(({ candidate }) => candidate);

    return {
      results: [...reranked, ...passthrough],
      applied: true,
    };
  }

  private async fetchSummaries(
    skillIds: string[]
  ): Promise<Map<string, string>> {
    if (skillIds.length === 0) return new Map();

    const sql = `
      SELECT id, agent_summary
      FROM skills
      WHERE id = ANY($1::uuid[])
        AND agent_summary IS NOT NULL
    `;

    try {
      const result = await this.pool.query(sql, [skillIds]);
      return new Map(
        result.rows.map((row: any) => [row.id, row.agent_summary])
      );
    } catch (error) {
      console.error('Failed to fetch summaries for reranking:', error);
      return new Map();
    }
  }
}
