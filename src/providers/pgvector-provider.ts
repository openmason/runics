// ══════════════════════════════════════════════════════════════════════════════
// PgVectorProvider — Postgres + pgvector Implementation
// ══════════════════════════════════════════════════════════════════════════════
//
// CRITICAL: This is the ONLY file that imports Postgres types.
// The intelligence layer talks only through the SearchProvider interface.
//
// Strategy:
// - Stores 1–6 rows per skill in skill_embeddings
// - Uses DISTINCT ON (skill_id) to return best match per skill
// - Multi-vector happens at index time (Phase 3)
// - Score fusion: weighted blend of vector similarity + full-text rank
//
// ══════════════════════════════════════════════════════════════════════════════

import { Pool } from '@neondatabase/serverless';
import type { SearchProvider } from './search-provider';
import type {
  SearchFilters,
  SearchOptions,
  SearchResult,
  SkillInput,
  EmbeddingSet,
  ScoredSkill,
  ConfidenceSignal,
  Env,
} from '../types';

export class PgVectorProvider implements SearchProvider {
  // Always-excluded statuses (never shown in search)
  private static readonly BLOCKED_STATUSES = ['revoked', 'draft', 'degraded'];

  private pool: Pool;

  // Configurable thresholds from env vars
  private tier1Threshold: number;
  private tier2Threshold: number;
  private vectorWeight: number;
  private fullTextWeight: number;
  private versionTrustWeight: number;
  private versionUsageWeight: number;
  private trustBoostWeight: number;

  constructor(connectionString: string, env: Env) {
    // Connect directly to Neon (NOT through Hyperdrive)
    // @neondatabase/serverless uses WebSockets which don't work with Hyperdrive
    this.pool = new Pool({ connectionString });

    // Parse configurable thresholds
    this.tier1Threshold = parseFloat(env.CONFIDENCE_TIER1_THRESHOLD || '0.85');
    this.tier2Threshold = parseFloat(env.CONFIDENCE_TIER2_THRESHOLD || '0.70');
    this.vectorWeight = parseFloat(env.VECTOR_WEIGHT || '0.7');
    this.fullTextWeight = parseFloat(env.FULLTEXT_WEIGHT || '0.3');
    this.versionTrustWeight = parseFloat(env.VERSION_TRUST_WEIGHT || '0.7');
    this.versionUsageWeight = parseFloat(env.VERSION_USAGE_WEIGHT || '0.3');
    this.trustBoostWeight = parseFloat(env.TRUST_BOOST_WEIGHT || '0.3');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Status Filter Builder
  // ────────────────────────────────────────────────────────────────────────────

  private buildStatusFilter(
    filters: SearchFilters,
    params: any[],
    paramCount: { value: number },
  ): string[] {
    const conditions: string[] = [];

    // Always exclude revoked, draft, degraded
    conditions.push(`s.status NOT IN (${PgVectorProvider.BLOCKED_STATUSES.map(() => `$${++paramCount.value}`).join(', ')})`);
    params.push(...PgVectorProvider.BLOCKED_STATUSES);

    // Conditionally exclude vulnerable/contains-vulnerable
    if (!filters.allowVulnerable) {
      conditions.push(`s.status NOT IN ($${++paramCount.value}, $${++paramCount.value})`);
      params.push('vulnerable', 'contains-vulnerable');
    }

    // Explicit status filter overrides the above (must still exclude BLOCKED)
    if (filters.statusFilter && filters.statusFilter.length > 0) {
      const allowed = filters.statusFilter.filter(
        s => !PgVectorProvider.BLOCKED_STATUSES.includes(s)
      );
      if (allowed.length > 0) {
        conditions.push(`s.status IN (${allowed.map(() => `$${++paramCount.value}`).join(', ')})`);
        params.push(...allowed);
      }
    }

    // Slug pin (best-version-per-slug)
    if (filters.slug) {
      conditions.push(`s.slug = $${++paramCount.value}`);
      params.push(filters.slug);
    }

    // Version pin
    if (filters.version) {
      conditions.push(`s.version = $${++paramCount.value}`);
      params.push(filters.version);
    }

    return conditions;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Search Implementation
  // ────────────────────────────────────────────────────────────────────────────

  async search(
    query: string,
    embedding: number[],
    filters: SearchFilters,
    options?: SearchOptions
  ): Promise<SearchResult> {
    const startTime = Date.now();
    const limit = options?.limit ?? 10;
    const offset = options?.offset ?? 0;
    const includeMatchText = options?.includeMatchText ?? false;

    // Start vector and full-text searches in parallel
    const vectorSearchStart = Date.now();
    const vectorResults = await this.vectorSearch(embedding, filters, limit + offset);
    const vectorSearchMs = Date.now() - vectorSearchStart;

    const fullTextSearchStart = Date.now();
    const fullTextResults = await this.fullTextSearch(query, filters, limit + offset);
    const fullTextSearchMs = Date.now() - fullTextSearchStart;

    // Merge and fuse scores
    const fusedResults = this.fuseScores(vectorResults, fullTextResults);

    // Apply pagination
    const paginatedResults = fusedResults.slice(offset, offset + limit);

    // Fetch full skill metadata (raw scores, no trust boost yet)
    const { scoredSkills, trustScores } = await this.enrichWithSkillMetadata(
      paginatedResults,
      includeMatchText
    );

    // Compute confidence signal BEFORE trust boost (thresholds calibrated for raw scores)
    const confidence = this.computeConfidence(scoredSkills);

    // Apply trust-score boost AFTER confidence assessment
    // boosted = fusedScore × (1 + weight × (trustScore - 0.5))
    if (this.trustBoostWeight > 0) {
      for (const skill of scoredSkills) {
        const ts = trustScores.get(skill.skillId) ?? 0.5;
        skill.fusedScore *= 1 + this.trustBoostWeight * (ts - 0.5);
      }
      // Re-sort by boosted fusedScore
      scoredSkills.sort((a, b) => b.fusedScore - a.fusedScore);
    }

    const totalLatencyMs = Date.now() - startTime;

    return {
      results: scoredSkills,
      confidence,
      meta: {
        latencyMs: totalLatencyMs,
        vectorSearchMs,
        fullTextSearchMs,
        fusionStrategy: 'score_blend',
        totalCandidates: fusedResults.length,
        cacheHit: false,
      },
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Vector Similarity Search
  // ────────────────────────────────────────────────────────────────────────────

  private async vectorSearch(
    embedding: number[],
    filters: SearchFilters,
    limit: number
  ): Promise<Array<{ skillId: string; score: number; matchSource: string; matchText: string }>> {
    const embeddingStr = `[${embedding.join(',')}]`;

    // Build WHERE clause — include tenant's own + public ('default') embeddings
    const conditions: string[] = ["se.tenant_id IN ($1, 'default')"];
    const params: any[] = [filters.tenantId, embeddingStr, limit];
    const paramCount = { value: 3 };

    // v5.0: Status filter (always exclude revoked/draft/degraded)
    conditions.push(...this.buildStatusFilter(filters, params, paramCount));

    if (filters.minTrustScore !== undefined) {
      conditions.push(`s.trust_score >= $${++paramCount.value}`);
      params.push(filters.minTrustScore);
    }

    if (filters.contentSafetyRequired !== false) {
      conditions.push('s.content_safety_passed = true');
    }

    if (filters.executionLayer) {
      conditions.push(`s.execution_layer = $${++paramCount.value}`);
      params.push(filters.executionLayer);
    }

    if (filters.category) {
      conditions.push(`s.category = $${++paramCount.value}`);
      params.push(filters.category);
    }

    if (filters.tags && filters.tags.length > 0) {
      conditions.push(`s.tags && $${++paramCount.value}::text[]`);
      params.push(filters.tags);
    }

    // v5.2: visibility filter — public by default, tenant can see own private/unlisted
    if (filters.visibility) {
      conditions.push(`s.visibility = $${++paramCount.value}`);
      params.push(filters.visibility);
    } else {
      conditions.push(`(s.visibility = 'public' OR (s.visibility IN ('private', 'unlisted') AND s.tenant_id = $1))`);
    }

    // v5.2: runtime environment filter
    if (filters.runtimeEnv && filters.runtimeEnv.length > 0) {
      conditions.push(`s.runtime_env = ANY($${++paramCount.value}::text[])`);
      params.push(filters.runtimeEnv);
    }

    const whereClause = conditions.join(' AND ');

    // v5.0: Version ranking — best version per slug using trust×weight + min(run_count/100, usage_weight)
    // DISTINCT ON (slug) picks the version with highest version_rank per slug
    const sql = `
      SELECT skill_id, score, match_source, match_text
      FROM (
        SELECT DISTINCT ON (s.slug)
          se.skill_id,
          1 - (se.embedding <=> $2::vector) AS score,
          se.source AS match_source,
          se.source_text AS match_text,
          (COALESCE(s.trust_score, 0.5) * ${this.versionTrustWeight}
           + LEAST(COALESCE(s.run_count, 0)::float / 100.0, ${this.versionUsageWeight})) AS version_rank
        FROM skill_embeddings se
        INNER JOIN skills s ON s.id = se.skill_id
        WHERE ${whereClause}
        ORDER BY s.slug, version_rank DESC, (se.embedding <=> $2::vector) ASC
      ) ranked
      ORDER BY score DESC
      LIMIT $3
    `;

    const result = await this.pool.query(sql, params);

    return result.rows.map((row) => ({
      skillId: row.skill_id,
      score: row.score,
      matchSource: row.match_source,
      matchText: row.match_text,
    }));
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Full-Text Search
  // ────────────────────────────────────────────────────────────────────────────

  private async fullTextSearch(
    query: string,
    filters: SearchFilters,
    limit: number
  ): Promise<Array<{ skillId: string; score: number; keywordHits: number }>> {
    // Build WHERE clause — include tenant's own + public ('default') embeddings
    const conditions: string[] = ["se.tenant_id IN ($1, 'default')"];
    const params: any[] = [filters.tenantId, limit];
    const paramCount = { value: 2 };

    // v5.0: Status filter (always exclude revoked/draft/degraded)
    conditions.push(...this.buildStatusFilter(filters, params, paramCount));

    if (filters.minTrustScore !== undefined) {
      conditions.push(`s.trust_score >= $${++paramCount.value}`);
      params.push(filters.minTrustScore);
    }

    if (filters.contentSafetyRequired !== false) {
      conditions.push('s.content_safety_passed = true');
    }

    if (filters.executionLayer) {
      conditions.push(`s.execution_layer = $${++paramCount.value}`);
      params.push(filters.executionLayer);
    }

    if (filters.category) {
      conditions.push(`s.category = $${++paramCount.value}`);
      params.push(filters.category);
    }

    if (filters.tags && filters.tags.length > 0) {
      conditions.push(`s.tags && $${++paramCount.value}::text[]`);
      params.push(filters.tags);
    }

    // v5.2: visibility filter — public by default, tenant can see own private/unlisted
    if (filters.visibility) {
      conditions.push(`s.visibility = $${++paramCount.value}`);
      params.push(filters.visibility);
    } else {
      conditions.push(`(s.visibility = 'public' OR (s.visibility IN ('private', 'unlisted') AND s.tenant_id = $1))`);
    }

    // v5.2: runtime environment filter
    if (filters.runtimeEnv && filters.runtimeEnv.length > 0) {
      conditions.push(`s.runtime_env = ANY($${++paramCount.value}::text[])`);
      params.push(filters.runtimeEnv);
    }

    const whereClause = conditions.join(' AND ');

    // Full-text search: best version per slug, then rank by score
    ++paramCount.value;
    const queryParam = paramCount.value;
    const sql = `
      SELECT skill_id, raw_score, normalized_score, keyword_hits
      FROM (
        SELECT DISTINCT ON (s.slug)
          se.skill_id,
          ts_rank_cd(se.tsv, plainto_tsquery('english', $${queryParam})) AS raw_score,
          ts_rank_cd(se.tsv, plainto_tsquery('english', $${queryParam}), 32) AS normalized_score,
          (
            SELECT COUNT(*)
            FROM unnest(tsvector_to_array(se.tsv)) AS term
            WHERE term = ANY(string_to_array(lower($${queryParam}), ' '))
          ) AS keyword_hits,
          (COALESCE(s.trust_score, 0.5) * ${this.versionTrustWeight}
           + LEAST(COALESCE(s.run_count, 0)::float / 100.0, ${this.versionUsageWeight})) AS version_rank
        FROM skill_embeddings se
        INNER JOIN skills s ON s.id = se.skill_id
        WHERE ${whereClause}
          AND se.tsv @@ plainto_tsquery('english', $${queryParam})
        ORDER BY s.slug, version_rank DESC, raw_score DESC
      ) ranked
      ORDER BY raw_score DESC
      LIMIT $2
    `;

    params.push(query);

    try {
      const result = await this.pool.query(sql, params);

      // Normalize scores to 0-1 range
      const maxScore = Math.max(...result.rows.map((r) => r.raw_score), 1);

      return result.rows.map((row) => ({
        skillId: row.skill_id,
        score: row.raw_score / maxScore,
        keywordHits: parseInt(row.keyword_hits) || 0,
      }));
    } catch (error) {
      // If full-text search fails (e.g., empty query), return empty results
      console.error('Full-text search error:', error);
      return [];
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Score Fusion
  // ────────────────────────────────────────────────────────────────────────────

  private fuseScores(
    vectorResults: Array<{ skillId: string; score: number; matchSource: string; matchText: string }>,
    fullTextResults: Array<{ skillId: string; score: number; keywordHits: number }>
  ): Array<{
    skillId: string;
    vectorScore: number;
    fullTextScore: number;
    fusedScore: number;
    matchSource: string;
    matchText: string;
    keywordHits: number;
  }> {
    // Create lookup map for full-text results
    const fullTextMap = new Map(
      fullTextResults.map((r) => [r.skillId, { score: r.score, keywordHits: r.keywordHits }])
    );

    // Merge results with weighted score fusion
    const merged = vectorResults.map((vr) => {
      const ft = fullTextMap.get(vr.skillId);
      const fullTextScore = ft?.score ?? 0;
      const fusedScore =
        this.vectorWeight * vr.score + this.fullTextWeight * fullTextScore;

      return {
        skillId: vr.skillId,
        vectorScore: vr.score,
        fullTextScore,
        fusedScore,
        matchSource: vr.matchSource,
        matchText: vr.matchText,
        keywordHits: ft?.keywordHits ?? 0,
      };
    });

    // Sort by fused score descending
    return merged.sort((a, b) => b.fusedScore - a.fusedScore);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Enrich with Skill Metadata
  // ────────────────────────────────────────────────────────────────────────────

  private async enrichWithSkillMetadata(
    fusedResults: Array<{
      skillId: string;
      vectorScore: number;
      fullTextScore: number;
      fusedScore: number;
      matchSource: string;
      matchText: string;
      keywordHits: number;
    }>,
    includeMatchText: boolean
  ): Promise<{ scoredSkills: ScoredSkill[]; trustScores: Map<string, number> }> {
    if (fusedResults.length === 0) {
      return { scoredSkills: [], trustScores: new Map() };
    }

    const skillIds = fusedResults.map((r) => r.skillId);

    const sql = `
      SELECT
        id, name, slug, version, agent_summary, trust_score,
        execution_layer, capabilities_required, status,
        skill_type, verification_tier, trust_badge,
        forked_from, run_count, last_run_at,
        revoked_reason, remediation_message, remediation_url,
        replacement_skill_id
      FROM skills
      WHERE id = ANY($1::uuid[])
    `;

    const result = await this.pool.query(sql, [skillIds]);

    // Create lookup map
    const skillMap = new Map(
      result.rows.map((row) => [
        row.id,
        {
          id: row.id,
          name: row.name,
          slug: row.slug,
          version: row.version ?? '1.0.0',
          agentSummary: row.agent_summary,
          trustScore: parseFloat(row.trust_score),
          executionLayer: row.execution_layer,
          capabilitiesRequired: row.capabilities_required ?? [],
          status: row.status ?? 'published',
          skillType: row.skill_type ?? 'atomic',
          verificationTier: row.verification_tier ?? 'unverified',
          trustBadge: row.trust_badge ?? null,
          forkedFrom: row.forked_from ?? undefined,
          runCount: parseInt(row.run_count) || 0,
          lastRunAt: row.last_run_at?.toISOString() ?? undefined,
          revokedReason: row.revoked_reason ?? undefined,
          remediationMessage: row.remediation_message ?? undefined,
          remediationUrl: row.remediation_url ?? undefined,
          replacementSkillId: row.replacement_skill_id ?? undefined,
        },
      ])
    );

    // Build trust score lookup for post-confidence boost
    const trustScores = new Map<string, number>();
    for (const [id, skill] of skillMap) {
      trustScores.set(id, skill.trustScore || 0.5);
    }

    // Merge with fused scores
    // Note: trust boost is applied AFTER confidence computation in search()
    const scoredSkills = fusedResults
      .map((fr) => {
        const skill = skillMap.get(fr.skillId);
        if (!skill) return null;

        const scoredSkill: ScoredSkill = {
          skillId: fr.skillId,
          score: fr.vectorScore,
          fullTextScore: fr.fullTextScore,
          fusedScore: fr.fusedScore,
          matchSource: fr.matchSource,
        };

        if (includeMatchText) {
          scoredSkill.matchText = fr.matchText;
        }

        return scoredSkill;
      })
      .filter((s): s is ScoredSkill => s !== null);

    return { scoredSkills, trustScores };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Confidence Signal Computation
  // ────────────────────────────────────────────────────────────────────────────

  private computeConfidence(results: ScoredSkill[]): ConfidenceSignal {
    if (results.length === 0) {
      return {
        topScore: 0,
        gapToSecond: 0,
        clusterDensity: 0,
        keywordHits: 0,
        tier: 3,
      };
    }

    const topScore = results[0].fusedScore;
    const gapToSecond = results.length > 1 ? topScore - results[1].fusedScore : 1.0;

    // Cluster density: count results above tier2 threshold
    const clusterDensity = results.filter(
      (r) => r.fusedScore >= this.tier2Threshold
    ).length;

    // Keyword hits from full-text search (approximate)
    const keywordHits = results[0].fullTextScore > 0 ? 1 : 0;

    // Determine tier based on top score
    let tier: 1 | 2 | 3;
    if (topScore >= this.tier1Threshold && gapToSecond >= 0.05) {
      tier = 1; // High confidence
    } else if (topScore >= this.tier2Threshold) {
      tier = 2; // Medium confidence
    } else {
      tier = 3; // Low confidence, needs LLM fallback
    }

    return {
      topScore,
      gapToSecond,
      clusterDensity,
      keywordHits,
      tier,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Index Implementation
  // ────────────────────────────────────────────────────────────────────────────

  async index(skill: SkillInput, embeddings: EmbeddingSet): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Insert or update skill record (required for foreign key constraint)
      await client.query(
        `INSERT INTO skills (
          id, name, slug, version, source, description, agent_summary,
          tags, category, trust_score, capabilities_required, execution_layer,
          content_safety_passed, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          agent_summary = EXCLUDED.agent_summary,
          updated_at = NOW()`,
        [
          skill.id,
          skill.name,
          skill.slug,
          skill.version,
          skill.source,
          skill.description,
          skill.agentSummary,
          skill.tags,
          skill.category,
          skill.trustScore,
          skill.capabilitiesRequired || [],
          skill.executionLayer,
          true, // content_safety_passed
        ]
      );

      // Delete existing embeddings for this skill
      await client.query(
        'DELETE FROM skill_embeddings WHERE skill_id = $1 AND tenant_id = $2',
        [skill.id, skill.tenantId]
      );

      // Insert agent_summary embedding
      const agentSummaryVector = `[${embeddings.agentSummary.embedding.join(',')}]`;
      await client.query(
        `INSERT INTO skill_embeddings (skill_id, tenant_id, embedding, source, source_text)
         VALUES ($1, $2, $3::vector, $4, $5)`,
        [
          skill.id,
          skill.tenantId,
          agentSummaryVector,
          'agent_summary',
          embeddings.agentSummary.text,
        ]
      );

      // Insert alternate query embeddings (Phase 3)
      if (embeddings.alternates) {
        for (const alt of embeddings.alternates) {
          const altVector = `[${alt.embedding.join(',')}]`;
          await client.query(
            `INSERT INTO skill_embeddings (skill_id, tenant_id, embedding, source, source_text)
             VALUES ($1, $2, $3::vector, $4, $5)`,
            [skill.id, skill.tenantId, altVector, alt.source, alt.text]
          );
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Delete Implementation
  // ────────────────────────────────────────────────────────────────────────────

  async delete(skillId: string): Promise<void> {
    // Embeddings are CASCADE deleted via FK constraint on skill_embeddings
    // This just ensures we clean up any orphaned records
    await this.pool.query('DELETE FROM skill_embeddings WHERE skill_id = $1', [
      skillId,
    ]);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Health Check Implementation
  // ────────────────────────────────────────────────────────────────────────────

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.pool.query('SELECT 1');
      const latencyMs = Date.now() - start;
      return { ok: true, latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - start;
      console.error('Health check failed:', error);
      return { ok: false, latencyMs };
    }
  }
}
