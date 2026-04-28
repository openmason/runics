// ══════════════════════════════════════════════════════════════════════════════
// Runics Search — Cloudflare Workers Entry Point
// ══════════════════════════════════════════════════════════════════════════════

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createPool } from './db/connection';
import { PgVectorProvider } from './providers/pgvector-provider';
import { EmbedPipeline } from './ingestion/embed-pipeline';
import { SearchCache } from './cache/kv-cache';
import { SearchLogger } from './monitoring/search-logger';
import { QualityTracker } from './monitoring/quality-tracker';
import { PerfMonitor } from './monitoring/perf-monitor';
import { ConfidenceGate } from './intelligence/confidence-gate';
import { rateLimiter } from './middleware/rate-limiter';
import { adminAuth } from './middleware/admin-auth';
import { publicGuard } from './middleware/public-guard';
import { publishRoutes } from './publish/handler';
// Sync adapters + queue consumers are lazy-loaded via dynamic import()
// to avoid parsing their modules on search-path cold starts.
// Composition & Social layer (v4)
import { forkSkill, NotFoundError } from './composition/fork';
import { copySkill } from './composition/copy';
import { createComposition, ValidationError } from './composition/compose';
import { extendComposition } from './composition/extend';
import { getAncestry, getForks, getDependents } from './composition/lineage';
import { publishComposition } from './composition/publish';
import {
  forkInputSchema,
  copyInputSchema,
  compositionInputSchema,
  extendInputSchema,
} from './composition/schema';
import { starSkill, unstarSkill, getStarStatus, RateLimitError } from './social/stars';
import { recordInvocations } from './social/invocations';
import { getCoOccurrence } from './social/cooccurrence';
import {
  getHumanLeaderboard,
  getAgentLeaderboard,
  getTrendingLeaderboard,
  getMostComposedLeaderboard,
  getMostForkedLeaderboard,
} from './social/leaderboards';
import { authorRoutes } from './authors/handler';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type {
  Env,
  FindSkillRequest,
  SkillInput,
  QualityFeedback,
  SkillResult,
  Appetite,
  EmbedQueueMessage,
  CogniumSubmitMessage,
  CogniumPollMessage,
  AnalysisEndpoint,
  AnalysisSubmitMessage,
  AnalysisPollMessage,
  InvocationBatch,
  LeaderboardFilters,
} from './types';

// ──────────────────────────────────────────────────────────────────────────────
// App Initialization
// ──────────────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

// Enable CORS for all routes
app.use('*', cors());

// Block write/admin endpoints on the public domain (api.runics.net)
app.use('*', publicGuard());

// ──────────────────────────────────────────────────────────────────────────────
// Component Initialization Helper
// ──────────────────────────────────────────────────────────────────────────────

function initComponents(env: Env) {
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

// ──────────────────────────────────────────────────────────────────────────────
// Health Check
// ──────────────────────────────────────────────────────────────────────────────

app.get('/health', async (c) => {
  const { provider, pool } = initComponents(c.env);

  const healthCheck = await provider.healthCheck();

  // Test Workers AI
  let aiStatus = 'untested';
  let aiError = null;
  try {
    const testResult = await c.env.AI.run(c.env.EMBEDDING_MODEL as any, {
      text: ['test'],
    });
    aiStatus = testResult ? 'ok' : 'failed';
  } catch (error) {
    aiStatus = 'error';
    aiError = (error as Error).message;
  }

  // Check if required tables exist
  let tables: string[] = [];
  let dbError: string | null = null;
  try {
    const result = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    tables = result.rows.map((row: any) => row.table_name);
  } catch (error) {
    dbError = (error as Error).message;
  }

  const requiredTables = ['skills', 'skill_embeddings', 'search_logs', 'quality_feedback'];
  const missingTables = requiredTables.filter((t) => !tables.includes(t));

  return c.json({
    ok: healthCheck.ok && aiStatus === 'ok' && missingTables.length === 0,
    service: 'runics',
    version: '1.0.0',
    environment: c.env.ENVIRONMENT,
    dbStatus: healthCheck.ok ? 'ok' : 'error',
    dbLatencyMs: healthCheck.latencyMs,
    dbError,
    tables,
    missingTables,
    aiStatus,
    aiError,
    timestamp: new Date().toISOString(),
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Search Endpoint
// ──────────────────────────────────────────────────────────────────────────────

// Rate limiting on search endpoint
app.use('/v1/search', rateLimiter());

// Admin endpoints: authentication + rate limiting
app.use('/v1/admin/*', adminAuth());
app.use('/v1/admin/*', rateLimiter());

/**
 * POST /v1/search
 * Main search endpoint — findSkill
 *
 * Phase 2: Routes through ConfidenceGate for three-tier routing.
 * Tier 1: Return immediately (~50ms)
 * Tier 2: Return + async LLM enrichment
 * Tier 3: Full LLM deep search before responding (~500-1000ms)
 */
app.post('/v1/search', async (c) => {
  try {
    const body = await c.req.json<FindSkillRequest>();

    // Validate required fields
    if (!body.query || !body.tenantId) {
      return c.json({ error: 'Missing required fields: query, tenantId' }, 400);
    }

    const { gate } = initComponents(c.env);

    const response = await gate.findSkill(
      body.query,
      body.tenantId,
      {
        limit: body.limit,
        appetite: body.appetite as Appetite,
        tags: body.tags,
        category: body.category,
        runtimeEnv: body.runtimeEnv,
        visibility: body.visibility,
      },
      c.executionCtx
    );

    return c.json(response);
  } catch (error) {
    console.error('Search error:', error);
    return c.json(
      {
        error: 'Search failed',
        message: (error as Error).message,
      },
      500
    );
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Feedback Endpoint
// ──────────────────────────────────────────────────────────────────────────────

/**
 * POST /v1/search/feedback
 * Record quality feedback for a search result
 */
app.post('/v1/search/feedback', async (c) => {
  try {
    const body = await c.req.json<QualityFeedback>();

    // Validate required fields
    if (
      !body.searchEventId ||
      !body.skillId ||
      !body.feedbackType ||
      body.position === undefined
    ) {
      return c.json(
        {
          error:
            'Missing required fields: searchEventId, skillId, feedbackType, position',
        },
        400
      );
    }

    const { qualityTracker } = initComponents(c.env);

    // Record feedback (non-blocking)
    c.executionCtx.waitUntil(qualityTracker.recordFeedback(body));

    return c.json({ success: true });
  } catch (error) {
    console.error('Feedback error:', error);
    return c.json({ error: 'Failed to record feedback' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Ingestion Endpoints
// ──────────────────────────────────────────────────────────────────────────────

/**
 * POST /v1/skills/:skillId/index
 * Index a skill (Phase 1: single embedding)
 */
app.post('/v1/skills/:skillId/index', adminAuth(), async (c) => {
  try {
    const skillId = c.req.param('skillId');
    const skill = await c.req.json<SkillInput>();

    console.log(`[INDEX] Starting indexing for skill: ${skillId}`);

    // Validate skill ID matches
    if (skill.id !== skillId) {
      return c.json({ error: 'Skill ID mismatch' }, 400);
    }

    const { provider, embedPipeline } = initComponents(c.env);

    // ── 1. Content Safety Check (skipped for admin-submitted skills) ──
    // Admin requests are trusted — content safety is enforced on public publish paths only.

    // ── 2. Generate Embeddings ──
    const useMultiVector = c.env.MULTI_VECTOR_ENABLED === 'true';
    const embeddings = useMultiVector
      ? await embedPipeline.processSkillMultiVector(skill)
      : await embedPipeline.processSkill(skill);

    // ── 3. Index Skill ──
    console.log(`[INDEX] Step 3: Index in database`);
    await provider.index(skill, embeddings);
    console.log(`[INDEX] Successfully indexed ${skillId}`);

    return c.json({
      success: true,
      skillId,
      indexed: true,
      contentSafe: true,
      agentSummary: embeddings.agentSummary.text,
      alternateCount: embeddings.alternates?.length ?? 0,
      alternateQueries: embeddings.alternates?.map((a) => a.text),
    });
  } catch (error) {
    console.error('[INDEX] Error occurred:', error);
    console.error('[INDEX] Error stack:', (error as Error).stack);
    console.error('[INDEX] Error name:', (error as Error).name);
    console.error('[INDEX] Error message:', (error as Error).message);
    return c.json(
      {
        error: 'Failed to index skill',
        message: (error as Error).message,
      },
      500
    );
  }
});

/**
 * DELETE /v1/skills/:skillId
 * Remove a draft skill. Published skills must be deprecated via PATCH status.
 */
app.delete('/v1/skills/:skillId', async (c) => {
  try {
    const skillId = c.req.param('skillId');

    const pool = createPool(c.env);
    const skillResult = await pool.query(
      `SELECT id, status FROM skills WHERE id = $1`,
      [skillId]
    );

    if (skillResult.rows.length === 0) {
      return c.json({ error: 'not found' }, 404);
    }

    if (skillResult.rows[0].status !== 'draft') {
      return c.json(
        { error: 'only draft skills can be deleted — use PATCH /v1/skills/:id/status to deprecate published skills' },
        400
      );
    }

    // Remove from search index, then delete embeddings + skill row
    const { provider } = initComponents(c.env);
    await provider.delete(skillId);
    await pool.query(`DELETE FROM skill_embeddings WHERE skill_id = $1`, [skillId]);
    await pool.query(`DELETE FROM skills WHERE id = $1`, [skillId]);

    return c.json({ id: skillId, status: 'deleted' });
  } catch (error) {
    console.error('Delete error:', error);
    return c.json({ error: 'Failed to delete skill', message: (error as Error).message }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Analytics Endpoints
// ──────────────────────────────────────────────────────────────────────────────

app.get('/v1/analytics/tiers', async (c) => {
  try {
    const hours = parseInt(c.req.query('hours') || '24');
    const { qualityTracker } = initComponents(c.env);

    const distribution = await qualityTracker.getTierDistribution(hours);
    return c.json(distribution);
  } catch (error) {
    console.error('Analytics error:', error);
    return c.json({ error: 'Failed to get tier distribution' }, 500);
  }
});

app.get('/v1/analytics/match-sources', async (c) => {
  try {
    const hours = parseInt(c.req.query('hours') || '24');
    const { qualityTracker } = initComponents(c.env);

    const stats = await qualityTracker.getMatchSourceStats(hours);
    return c.json({ matchSources: stats });
  } catch (error) {
    console.error('Analytics error:', error);
    return c.json({ error: 'Failed to get match source stats' }, 500);
  }
});

app.get('/v1/analytics/latency', async (c) => {
  try {
    const hours = parseInt(c.req.query('hours') || '24');
    const { qualityTracker } = initComponents(c.env);

    const percentiles = await qualityTracker.getLatencyPercentiles(hours);
    return c.json(percentiles);
  } catch (error) {
    console.error('Analytics error:', error);
    return c.json({ error: 'Failed to get latency percentiles' }, 500);
  }
});

app.get('/v1/analytics/cost', async (c) => {
  try {
    const hours = parseInt(c.req.query('hours') || '24');
    const { qualityTracker } = initComponents(c.env);

    const breakdown = await qualityTracker.getCostBreakdown(hours);
    return c.json(breakdown);
  } catch (error) {
    console.error('Analytics error:', error);
    return c.json({ error: 'Failed to get cost breakdown' }, 500);
  }
});

app.get('/v1/analytics/failed-queries', async (c) => {
  try {
    const hours = parseInt(c.req.query('hours') || '24');
    const limit = parseInt(c.req.query('limit') || '100');
    const { qualityTracker } = initComponents(c.env);

    const queries = await qualityTracker.getFailedQueries(hours, limit);
    return c.json({ queries });
  } catch (error) {
    console.error('Analytics error:', error);
    return c.json({ error: 'Failed to get failed queries' }, 500);
  }
});

app.get('/v1/analytics/tier3-patterns', async (c) => {
  try {
    const hours = parseInt(c.req.query('hours') || '24');
    const { qualityTracker } = initComponents(c.env);

    const patterns = await qualityTracker.getTier3Patterns(hours);
    return c.json({ patterns });
  } catch (error) {
    console.error('Analytics error:', error);
    return c.json({ error: 'Failed to get tier 3 patterns' }, 500);
  }
});

app.get('/v1/analytics/revoked-impact', async (c) => {
  try {
    const pool = createPool(c.env);
    const [revokedResult, searchImpact] = await Promise.all([
      pool.query(
        `SELECT count(*)::int AS cnt,
                array_agg(json_build_object(
                  'slug', slug, 'name', name, 'source', source,
                  'revokedReason', revoked_reason,
                  'revokedAt', revoked_at,
                  'remediationMessage', remediation_message,
                  'replacementSkillId', replacement_skill_id
                ) ORDER BY revoked_at DESC NULLS LAST) AS skills
         FROM skills WHERE status = 'revoked'`
      ),
      pool.query(
        `SELECT count(*)::int AS cnt
         FROM search_logs
         WHERE timestamp > NOW() - INTERVAL '30 days'
           AND result_skill_ids && (SELECT array_agg(id) FROM skills WHERE status = 'revoked')`
      ).catch(() => ({ rows: [{ cnt: 0 }] })),
    ]);

    return c.json({
      revokedCount: revokedResult.rows[0].cnt,
      revokedSkills: (revokedResult.rows[0].skills ?? []).slice(0, 50),
      affectedSearches30d: searchImpact.rows[0].cnt,
    });
  } catch (error) {
    console.error('[ANALYTICS] Revoked impact error:', error);
    return c.json({ error: 'Failed to get revoked impact' }, 500);
  }
});

app.get('/v1/analytics/vulnerable-usage', async (c) => {
  try {
    const pool = createPool(c.env);
    const [vulnerableResult, searchImpact] = await Promise.all([
      pool.query(
        `SELECT count(*)::int AS cnt,
                array_agg(json_build_object(
                  'slug', slug, 'name', name, 'source', source,
                  'trustScore', trust_score,
                  'verificationTier', verification_tier,
                  'runCount', run_count,
                  'cogniumScannedAt', cognium_scanned_at
                ) ORDER BY run_count DESC) AS skills
         FROM skills WHERE status = 'vulnerable'`
      ),
      pool.query(
        `SELECT count(*)::int AS cnt
         FROM search_logs
         WHERE timestamp > NOW() - INTERVAL '30 days'
           AND result_skill_ids && (SELECT array_agg(id) FROM skills WHERE status = 'vulnerable')`
      ).catch(() => ({ rows: [{ cnt: 0 }] })),
    ]);

    return c.json({
      vulnerableCount: vulnerableResult.rows[0].cnt,
      vulnerableSkills: (vulnerableResult.rows[0].skills ?? []).slice(0, 50),
      appearedInSearch30d: searchImpact.rows[0].cnt,
    });
  } catch (error) {
    console.error('[ANALYTICS] Vulnerable usage error:', error);
    return c.json({ error: 'Failed to get vulnerable usage' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Eval Endpoints
// ──────────────────────────────────────────────────────────────────────────────

/**
 * POST /v1/eval/run
 * Run the eval suite against the live search endpoint
 *
 * Request body (optional):
 * {
 *   "tenantId": "tenant-123",  // optional, default "eval-tenant"
 *   "limit": 10,               // optional, results per query
 *   "verbose": false           // optional, log progress
 * }
 */
app.post('/v1/eval/run', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));

    const tenantId = body.tenantId || 'eval-tenant';
    const limit = body.limit || 10;
    const verbose = body.verbose || false;

    // Dynamically import eval runner (not needed at runtime, only for eval)
    const { runEvalSuite, formatSummary } = await import('./eval/runner');

    // Construct search endpoint URL
    const protocol = c.req.header('x-forwarded-proto') || 'http';
    const host = c.req.header('host') || 'localhost:8787';
    const searchEndpoint = `${protocol}://${host}/v1/search`;

    // Run eval suite
    const result = await runEvalSuite(searchEndpoint, tenantId, {
      limit,
      verbose,
    });

    // Persist to KV for cross-phase comparison (store metrics + summary, not full results)
    const persistedRun = {
      runId: result.runId,
      timestamp: result.timestamp,
      metrics: result.metrics,
      summary: {
        fixtureCount: result.fixtureCount,
        passed: result.passed,
        failed: result.failed,
      },
      errors: result.errors,
    };

    const env = c.env as Env;
    c.executionCtx.waitUntil(
      (async () => {
        try {
          // Store individual run (TTL: 90 days)
          await env.SEARCH_CACHE.put(
            `eval:run:${result.runId}`,
            JSON.stringify(persistedRun),
            { expirationTtl: 90 * 24 * 60 * 60 }
          );

          // Maintain a list of recent run IDs (last 50)
          const indexRaw = await env.SEARCH_CACHE.get('eval:index');
          const index: string[] = indexRaw ? JSON.parse(indexRaw) : [];
          index.unshift(result.runId);
          if (index.length > 50) index.length = 50;
          await env.SEARCH_CACHE.put('eval:index', JSON.stringify(index), {
            expirationTtl: 90 * 24 * 60 * 60,
          });
        } catch (err) {
          console.error('Failed to persist eval results:', err);
        }
      })()
    );

    // Return results
    return c.json({ success: true, ...persistedRun });
  } catch (error) {
    console.error('Eval run error:', error);
    return c.json(
      {
        error: 'Failed to run eval suite',
        message: (error as Error).message,
      },
      500
    );
  }
});

/**
 * GET /v1/eval/results
 * List recent eval runs (from KV index)
 */
app.get('/v1/eval/results', async (c) => {
  const env = c.env as Env;
  const indexRaw = await env.SEARCH_CACHE.get('eval:index');
  const index: string[] = indexRaw ? JSON.parse(indexRaw) : [];

  if (index.length === 0) {
    return c.json({ runs: [], message: 'No eval runs found. Run POST /v1/eval/run first.' });
  }

  // Fetch summaries for all indexed runs
  const runs = await Promise.all(
    index.map(async (runId) => {
      const raw = await env.SEARCH_CACHE.get(`eval:run:${runId}`);
      if (!raw) return null;
      const run = JSON.parse(raw);
      return {
        runId: run.runId,
        timestamp: run.timestamp,
        recall1: run.metrics.recall1,
        recall5: run.metrics.recall5,
        mrr: run.metrics.mrr,
        passed: run.summary.passed,
        failed: run.summary.failed,
        fixtureCount: run.summary.fixtureCount,
      };
    })
  );

  return c.json({ runs: runs.filter(Boolean) });
});

/**
 * GET /v1/eval/results/:runId
 * Get full eval run results from KV
 */
app.get('/v1/eval/results/:runId', async (c) => {
  const env = c.env as Env;
  const runId = c.req.param('runId');
  const raw = await env.SEARCH_CACHE.get(`eval:run:${runId}`);

  if (!raw) {
    return c.json({ error: 'Eval run not found', runId }, 404);
  }

  return c.json(JSON.parse(raw));
});

/**
 * GET /v1/eval/compare
 * Compare two eval runs side-by-side (deltas for every metric)
 * Query params: ?runA=...&runB=...
 */
app.get('/v1/eval/compare', async (c) => {
  const env = c.env as Env;
  const runA = c.req.query('runA');
  const runB = c.req.query('runB');

  if (!runA || !runB) {
    return c.json({ error: 'Both runA and runB query params are required' }, 400);
  }

  const [rawA, rawB] = await Promise.all([
    env.SEARCH_CACHE.get(`eval:run:${runA}`),
    env.SEARCH_CACHE.get(`eval:run:${runB}`),
  ]);

  if (!rawA) return c.json({ error: `Run not found: ${runA}` }, 404);
  if (!rawB) return c.json({ error: `Run not found: ${runB}` }, 404);

  const a = JSON.parse(rawA);
  const b = JSON.parse(rawB);

  const delta = (valB: number, valA: number) => {
    const d = valB - valA;
    return { value: parseFloat(d.toFixed(4)), improved: d > 0 };
  };

  return c.json({
    runA: { runId: a.runId, timestamp: a.timestamp },
    runB: { runId: b.runId, timestamp: b.timestamp },
    metrics: {
      recall1: { a: a.metrics.recall1, b: b.metrics.recall1, delta: delta(b.metrics.recall1, a.metrics.recall1) },
      recall5: { a: a.metrics.recall5, b: b.metrics.recall5, delta: delta(b.metrics.recall5, a.metrics.recall5) },
      mrr: { a: a.metrics.mrr, b: b.metrics.mrr, delta: delta(b.metrics.mrr, a.metrics.mrr) },
      avgTopScore: { a: a.metrics.avgTopScore, b: b.metrics.avgTopScore, delta: delta(b.metrics.avgTopScore, a.metrics.avgTopScore) },
    },
    summary: {
      a: a.summary,
      b: b.summary,
    },
    tierDistribution: {
      a: a.metrics.tierDistribution,
      b: b.metrics.tierDistribution,
    },
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Skill Versions (must be before :slug catch-all)
// ──────────────────────────────────────────────────────────────────────────────

app.get('/v1/skills/:slug/versions', async (c) => {
  const slug = c.req.param('slug');
  const pool = createPool(c.env);

  try {
    const result = await pool.query(
      `SELECT id, name, slug, version, status, trust_score, verification_tier,
              run_count, execution_layer, source, skill_type,
              runtime_env, visibility, cognium_scanned_at,
              created_at, updated_at, published_at
       FROM skills
       WHERE slug = $1
       ORDER BY
         (trust_score::float * 0.7 + LEAST(run_count, 100)::float / 100.0 * 0.3) DESC,
         created_at DESC`,
      [slug]
    );

    if (result.rows.length === 0) {
      return c.json({ error: 'No skills found with this slug' }, 404);
    }

    return c.json({
      slug,
      totalVersions: result.rows.length,
      versions: result.rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        version: r.version,
        status: r.status,
        trustScore: parseFloat(r.trust_score),
        verificationTier: r.verification_tier ?? 'unverified',
        runCount: parseInt(r.run_count) || 0,
        executionLayer: r.execution_layer,
        source: r.source,
        skillType: r.skill_type ?? 'atomic',
        runtimeEnv: r.runtime_env ?? 'api',
        visibility: r.visibility ?? 'public',
        cogniumScanned: !!r.cognium_scanned_at,
        cogniumScannedAt: r.cognium_scanned_at?.toISOString() ?? null,
        createdAt: r.created_at?.toISOString() ?? null,
        updatedAt: r.updated_at?.toISOString() ?? null,
        publishedAt: r.published_at?.toISOString() ?? null,
      })),
    });
  } catch (error) {
    console.error('[SKILL VERSIONS] Error:', error);
    return c.json({ error: 'Failed to fetch versions', message: (error as Error).message }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Skill Detail (read)
// ──────────────────────────────────────────────────────────────────────────────

app.get('/v1/skills/:slug', async (c) => {
  const slug = c.req.param('slug');
  const pool = createPool(c.env);

  try {
    const result = await pool.query(
      `SELECT
        s.id, s.name, s.slug, s.version, s.description, s.agent_summary,
        s.trust_score, s.verification_tier, s.trust_badge, s.status,
        s.execution_layer, s.mcp_url, s.skill_md, s.capabilities_required,
        s.skill_type, s.schema_json, s.source, s.source_url,
        s.tags, s.category, s.categories, s.ecosystem, s.language, s.license,
        s.readme, s.r2_bundle_key, s.auth_requirements, s.install_method,
        s.forked_from, s.run_count, s.last_run_at,
        s.author_id, s.author_type, s.tenant_id,
        s.revoked_reason, s.remediation_message, s.remediation_url,
        s.replacement_skill_id, rs.slug AS replacement_slug,
        s.avg_execution_time_ms, s.error_rate,
        s.human_star_count, s.human_fork_count, s.agent_invocation_count,
        s.runtime_env, s.visibility, s.environment_variables,
        s.cognium_scanned_at, s.content_safety_passed,
        s.quality_score, s.quality_tier, s.quality_results, s.quality_analyzed_at,
        s.trust_score_v2, s.trust_tier, s.trust_results, s.trust_analyzed_at,
        s.understand_results, s.understand_analyzed_at,
        s.spec_alignment_score, s.spec_gaps, s.spec_analyzed_at,
        s.created_at, s.updated_at, s.published_at
      FROM skills s
      LEFT JOIN skills rs ON rs.id = s.replacement_skill_id
      WHERE s.slug = $1
      ORDER BY s.created_at DESC
      LIMIT 1`,
      [slug]
    );

    if (result.rows.length === 0) {
      return c.json({ error: 'Skill not found' }, 404);
    }

    const row = result.rows[0];

    return c.json({
      id: row.id,
      name: row.name,
      slug: row.slug,
      version: row.version,
      description: row.description,
      agentSummary: row.agent_summary,
      trustScore: parseFloat(row.trust_score),
      verificationTier: row.verification_tier ?? 'unverified',
      trustBadge: row.trust_badge ?? null,
      status: row.status,
      executionLayer: row.execution_layer,
      mcpUrl: row.mcp_url ?? null,
      skillMd: row.skill_md ?? null,
      capabilitiesRequired: row.capabilities_required ?? [],
      skillType: row.skill_type ?? 'atomic',
      schemaJson: row.schema_json ?? null,
      source: row.source,
      sourceUrl: row.source_url ?? null,
      tags: row.tags ?? [],
      category: row.category ?? null,
      categories: row.categories ?? [],
      ecosystem: row.ecosystem ?? null,
      language: row.language ?? null,
      license: row.license ?? null,
      readme: row.readme ?? null,
      r2BundleKey: row.r2_bundle_key ?? null,
      authRequirements: row.auth_requirements ?? null,
      installMethod: row.install_method ?? null,
      forkedFrom: row.forked_from ?? null,
      runCount: parseInt(row.run_count) || 0,
      lastRunAt: row.last_run_at?.toISOString() ?? null,
      authorId: row.author_id ?? null,
      authorType: row.author_type,
      tenantId: row.tenant_id ?? null,
      revokedReason: row.revoked_reason ?? null,
      remediationMessage: row.remediation_message ?? null,
      remediationUrl: row.remediation_url ?? null,
      replacementSkillId: row.replacement_skill_id ?? null,
      replacementSlug: row.replacement_slug ?? null,
      shareUrl: `https://runics.net/skills/${row.slug}`,
      avgExecutionTimeMs: row.avg_execution_time_ms ?? null,
      errorRate: row.error_rate ?? null,
      humanStarCount: parseInt(row.human_star_count) || 0,
      humanForkCount: parseInt(row.human_fork_count) || 0,
      agentInvocationCount: parseInt(row.agent_invocation_count) || 0,
      runtimeEnv: row.runtime_env ?? 'api',
      visibility: row.visibility ?? 'public',
      environmentVariables: row.environment_variables ?? [],
      cogniumScanned: !!row.cognium_scanned_at,
      cogniumScannedAt: row.cognium_scanned_at?.toISOString() ?? null,
      contentSafetyPassed: row.content_safety_passed ?? null,
      qualityScore: row.quality_score ?? null,
      qualityTier: row.quality_tier ?? null,
      qualityResults: row.quality_results ?? null,
      qualityAnalyzedAt: row.quality_analyzed_at?.toISOString() ?? null,
      trustScoreV2: row.trust_score_v2 ?? null,
      trustTier: row.trust_tier ?? null,
      trustResults: row.trust_results ?? null,
      trustAnalyzedAt: row.trust_analyzed_at?.toISOString() ?? null,
      understandResults: row.understand_results ?? null,
      understandAnalyzedAt: row.understand_analyzed_at?.toISOString() ?? null,
      specAlignmentScore: row.spec_alignment_score ?? null,
      specGaps: row.spec_gaps ?? null,
      specAnalyzedAt: row.spec_analyzed_at?.toISOString() ?? null,
      createdAt: row.created_at?.toISOString() ?? null,
      updatedAt: row.updated_at?.toISOString() ?? null,
      publishedAt: row.published_at?.toISOString() ?? null,
    });
  } catch (error) {
    console.error('[SKILL DETAIL] Error:', error);
    return c.json({ error: 'Failed to fetch skill', message: (error as Error).message }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Publish API (Phase 5)
// ──────────────────────────────────────────────────────────────────────────────

// Mount publish routes at /v1/skills
// Note: Existing DELETE /v1/skills/:skillId and POST /v1/skills/:skillId/index
// are defined above and take priority (Hono matches routes in order)
app.route('/v1/skills', publishRoutes);

// ──────────────────────────────────────────────────────────────────────────────
// Composition Routes (v4)
// ──────────────────────────────────────────────────────────────────────────────

app.post('/v1/skills/:id/fork', zValidator('json', forkInputSchema), async (c) => {
  const sourceId = c.req.param('id');
  const { authorId, authorType } = c.req.valid('json');
  const pool = createPool(c.env);

  try {
    const result = await forkSkill(sourceId, authorId, authorType, pool, c.env);
    return c.json(result, 201);
  } catch (error) {
    if (error instanceof NotFoundError) return c.json({ error: error.message }, 404);
    console.error('[COMPOSITION] Fork error:', error);
    return c.json({ error: 'Failed to fork skill' }, 500);
  }
});

app.post('/v1/skills/:id/copy', zValidator('json', copyInputSchema), async (c) => {
  const sourceId = c.req.param('id');
  const { authorId, authorType } = c.req.valid('json');
  const pool = createPool(c.env);

  try {
    const result = await copySkill(sourceId, authorId, authorType, pool, c.env);
    return c.json(result, 201);
  } catch (error) {
    if (error instanceof NotFoundError) return c.json({ error: error.message }, 404);
    console.error('[COMPOSITION] Copy error:', error);
    return c.json({ error: 'Failed to copy skill' }, 500);
  }
});

app.post('/v1/skills/:id/extend', zValidator('json', extendInputSchema), async (c) => {
  const compositionId = c.req.param('id');
  const { authorId, authorType, steps } = c.req.valid('json');
  const pool = createPool(c.env);

  try {
    const result = await extendComposition(
      compositionId, steps, authorId, authorType, pool, c.env
    );
    return c.json(result, 201);
  } catch (error) {
    if (error instanceof NotFoundError) return c.json({ error: error.message }, 404);
    if (error instanceof ValidationError) return c.json({ error: error.message }, 400);
    console.error('[COMPOSITION] Extend error:', error);
    return c.json({ error: 'Failed to extend composition' }, 500);
  }
});

app.post('/v1/compositions', zValidator('json', compositionInputSchema), async (c) => {
  const input = c.req.valid('json');
  const pool = createPool(c.env);

  try {
    const result = await createComposition(input, pool, c.env);
    return c.json(result, 201);
  } catch (error) {
    if (error instanceof ValidationError) return c.json({ error: error.message }, 400);
    console.error('[COMPOSITION] Create error:', error);
    return c.json({ error: 'Failed to create composition' }, 500);
  }
});

app.get('/v1/compositions/:id', async (c) => {
  const compositionId = c.req.param('id');
  const pool = createPool(c.env);

  try {
    const skill = await pool.query(
      `SELECT * FROM skills WHERE id = $1 AND skill_type IN ('auto-composite', 'human-composite', 'composition', 'pipeline')`,
      [compositionId]
    );
    if (skill.rows.length === 0) return c.json({ error: 'Composition not found' }, 404);

    const steps = await pool.query(
      `SELECT cs.*, s.name AS skill_name, s.slug AS skill_slug
       FROM composition_steps cs
       JOIN skills s ON s.id = cs.skill_id
       WHERE cs.composition_id = $1
       ORDER BY cs.step_order`,
      [compositionId]
    );

    return c.json({
      ...skill.rows[0],
      steps: steps.rows.map((r: any) => ({
        id: r.id,
        stepOrder: r.step_order,
        skillId: r.skill_id,
        skillName: r.skill_name,
        skillSlug: r.skill_slug,
        stepName: r.step_name,
        inputMapping: r.input_mapping,
        onError: r.on_error,
      })),
    });
  } catch (error) {
    console.error('[COMPOSITION] Get error:', error);
    return c.json({ error: 'Failed to get composition' }, 500);
  }
});

app.put('/v1/compositions/:id/steps', async (c) => {
  const compositionId = c.req.param('id');
  const pool = createPool(c.env);

  try {
    const body = await c.req.json();
    const steps = body.steps;
    if (!Array.isArray(steps) || steps.length < 2) {
      return c.json({ error: 'At least 2 steps required' }, 400);
    }

    // Verify composition exists and is a draft
    const skill = await pool.query(
      `SELECT status, skill_type FROM skills WHERE id = $1`,
      [compositionId]
    );
    if (skill.rows.length === 0) return c.json({ error: 'Composition not found' }, 404);
    if (skill.rows[0].status !== 'draft') {
      return c.json({ error: 'Can only modify steps on draft compositions' }, 400);
    }

    // Replace all steps
    await pool.query(`DELETE FROM composition_steps WHERE composition_id = $1`, [compositionId]);

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      await pool.query(
        `INSERT INTO composition_steps (composition_id, step_order, skill_id, step_name, input_mapping, on_error)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          compositionId, i + 1, step.skillId,
          step.stepName || null,
          step.inputMapping ? JSON.stringify(step.inputMapping) : null,
          step.onError || 'fail',
        ]
      );
    }

    return c.json({ id: compositionId, status: 'steps_updated' });
  } catch (error) {
    console.error('[COMPOSITION] Replace steps error:', error);
    return c.json({ error: 'Failed to replace steps' }, 500);
  }
});

app.post('/v1/compositions/:id/publish', async (c) => {
  const compositionId = c.req.param('id');
  const pool = createPool(c.env);

  try {
    const result = await publishComposition(compositionId, pool);
    return c.json(result);
  } catch (error) {
    if (error instanceof NotFoundError) return c.json({ error: error.message }, 404);
    if (error instanceof ValidationError) return c.json({ error: error.message }, 400);
    console.error('[COMPOSITION] Publish error:', error);
    return c.json({ error: 'Failed to publish composition' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Lineage Routes (v4)
// ──────────────────────────────────────────────────────────────────────────────

app.get('/v1/skills/:id/lineage', async (c) => {
  const skillId = c.req.param('id');
  const pool = createPool(c.env);
  try {
    const ancestry = await getAncestry(skillId, pool);
    return c.json({ ancestry });
  } catch (error) {
    console.error('[LINEAGE] Error:', error);
    return c.json({ error: 'Failed to get lineage' }, 500);
  }
});

app.get('/v1/skills/:id/forks', async (c) => {
  const skillId = c.req.param('id');
  const pool = createPool(c.env);
  try {
    const forks = await getForks(skillId, pool);
    return c.json({ forks });
  } catch (error) {
    console.error('[LINEAGE] Error:', error);
    return c.json({ error: 'Failed to get forks' }, 500);
  }
});

app.get('/v1/skills/:id/dependents', async (c) => {
  const skillId = c.req.param('id');
  const pool = createPool(c.env);
  try {
    const dependents = await getDependents(skillId, pool);
    return c.json({ dependents });
  } catch (error) {
    console.error('[LINEAGE] Error:', error);
    return c.json({ error: 'Failed to get dependents' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Social Routes — Human Only (v4)
// ──────────────────────────────────────────────────────────────────────────────

const starInputSchema = z.object({
  userId: z.string().uuid(),
});

app.post('/v1/skills/:id/star', zValidator('json', starInputSchema), async (c) => {
  const skillId = c.req.param('id');
  const { userId } = c.req.valid('json');
  const pool = createPool(c.env);

  try {
    const result = await starSkill(skillId, userId, pool);
    return c.json(result);
  } catch (error) {
    if (error instanceof RateLimitError) return c.json({ error: error.message }, 429);
    console.error('[SOCIAL] Star error:', error);
    return c.json({ error: 'Failed to star skill' }, 500);
  }
});

app.delete('/v1/skills/:id/star', async (c) => {
  const skillId = c.req.param('id');
  const body = await c.req.json();
  const userId = body.userId;
  if (!userId) return c.json({ error: 'userId required' }, 400);
  const pool = createPool(c.env);

  try {
    const result = await unstarSkill(skillId, userId, pool);
    return c.json(result);
  } catch (error) {
    console.error('[SOCIAL] Unstar error:', error);
    return c.json({ error: 'Failed to unstar skill' }, 500);
  }
});

app.get('/v1/skills/:id/stars', async (c) => {
  const skillId = c.req.param('id');
  const userId = c.req.query('userId') || null;
  const pool = createPool(c.env);

  try {
    const result = await getStarStatus(skillId, userId, pool);
    return c.json(result);
  } catch (error) {
    console.error('[SOCIAL] Stars error:', error);
    return c.json({ error: 'Failed to get star status' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Agent Signal Routes (v4)
// ──────────────────────────────────────────────────────────────────────────────

const invocationBatchSchema = z.object({
  invocations: z.array(z.object({
    skillId: z.string().uuid(),
    compositionId: z.string().uuid().optional(),
    tenantId: z.string(),
    callerType: z.enum(['agent', 'human']),
    durationMs: z.number().int().optional(),
    succeeded: z.boolean(),
  })).min(1).max(500),
});

app.post('/v1/invocations', zValidator('json', invocationBatchSchema), async (c) => {
  const batch = c.req.valid('json') as InvocationBatch;
  const pool = createPool(c.env);

  // Non-blocking: wrap in waitUntil
  c.executionCtx.waitUntil(
    recordInvocations(batch, pool).catch((e) =>
      console.error('[INVOCATIONS] Record error:', e.message)
    )
  );

  return c.json({ accepted: true, count: batch.invocations.length }, 202);
});

app.get('/v1/skills/:id/cooccurrence', async (c) => {
  const skillId = c.req.param('id');
  const limit = parseInt(c.req.query('limit') || '5');
  const pool = createPool(c.env);

  try {
    const results = await getCoOccurrence(skillId, limit, pool);
    return c.json({ cooccurrence: results });
  } catch (error) {
    console.error('[SOCIAL] Cooccurrence error:', error);
    return c.json({ error: 'Failed to get co-occurrence' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Skill Version Detail (after literal sub-routes to avoid :version matching "forks" etc.)
// ──────────────────────────────────────────────────────────────────────────────

app.get('/v1/skills/:slug/:version', async (c) => {
  const slug = c.req.param('slug');
  const version = c.req.param('version');
  const pool = createPool(c.env);

  try {
    const result = await pool.query(
      `SELECT
        s.id, s.name, s.slug, s.version, s.description, s.agent_summary,
        s.trust_score, s.verification_tier, s.trust_badge, s.status,
        s.execution_layer, s.mcp_url, s.skill_md, s.capabilities_required,
        s.skill_type, s.schema_json, s.source, s.source_url,
        s.tags, s.category, s.categories, s.ecosystem, s.language, s.license,
        s.readme, s.r2_bundle_key, s.auth_requirements, s.install_method,
        s.forked_from, s.run_count, s.last_run_at,
        s.author_id, s.author_type, s.tenant_id,
        s.revoked_reason, s.remediation_message, s.remediation_url,
        s.replacement_skill_id, rs.slug AS replacement_slug,
        s.avg_execution_time_ms, s.error_rate,
        s.human_star_count, s.human_fork_count, s.agent_invocation_count,
        s.runtime_env, s.visibility, s.environment_variables,
        s.cognium_scanned_at, s.content_safety_passed,
        s.created_at, s.updated_at, s.published_at
      FROM skills s
      LEFT JOIN skills rs ON rs.id = s.replacement_skill_id
      WHERE s.slug = $1 AND s.version = $2
      LIMIT 1`,
      [slug, version]
    );

    if (result.rows.length === 0) {
      return c.json({ error: `Version ${version} not found for skill ${slug}` }, 404);
    }

    const row = result.rows[0];

    return c.json({
      id: row.id,
      name: row.name,
      slug: row.slug,
      version: row.version,
      description: row.description,
      agentSummary: row.agent_summary,
      trustScore: parseFloat(row.trust_score),
      verificationTier: row.verification_tier ?? 'unverified',
      trustBadge: row.trust_badge ?? null,
      status: row.status,
      executionLayer: row.execution_layer,
      mcpUrl: row.mcp_url ?? null,
      skillMd: row.skill_md ?? null,
      capabilitiesRequired: row.capabilities_required ?? [],
      skillType: row.skill_type ?? 'atomic',
      schemaJson: row.schema_json ?? null,
      source: row.source,
      sourceUrl: row.source_url ?? null,
      tags: row.tags ?? [],
      category: row.category ?? null,
      categories: row.categories ?? [],
      ecosystem: row.ecosystem ?? null,
      language: row.language ?? null,
      license: row.license ?? null,
      readme: row.readme ?? null,
      r2BundleKey: row.r2_bundle_key ?? null,
      authRequirements: row.auth_requirements ?? null,
      installMethod: row.install_method ?? null,
      forkedFrom: row.forked_from ?? null,
      runCount: parseInt(row.run_count) || 0,
      lastRunAt: row.last_run_at?.toISOString() ?? null,
      authorId: row.author_id ?? null,
      authorType: row.author_type,
      tenantId: row.tenant_id ?? null,
      revokedReason: row.revoked_reason ?? null,
      remediationMessage: row.remediation_message ?? null,
      remediationUrl: row.remediation_url ?? null,
      replacementSkillId: row.replacement_skill_id ?? null,
      replacementSlug: row.replacement_slug ?? null,
      shareUrl: `https://runics.net/skills/${row.slug}`,
      avgExecutionTimeMs: row.avg_execution_time_ms ?? null,
      errorRate: row.error_rate ?? null,
      humanStarCount: parseInt(row.human_star_count) || 0,
      humanForkCount: parseInt(row.human_fork_count) || 0,
      agentInvocationCount: parseInt(row.agent_invocation_count) || 0,
      runtimeEnv: row.runtime_env ?? 'api',
      visibility: row.visibility ?? 'public',
      environmentVariables: row.environment_variables ?? [],
      cogniumScanned: !!row.cognium_scanned_at,
      cogniumScannedAt: row.cognium_scanned_at?.toISOString() ?? null,
      contentSafetyPassed: row.content_safety_passed ?? null,
      createdAt: row.created_at?.toISOString() ?? null,
      updatedAt: row.updated_at?.toISOString() ?? null,
      publishedAt: row.published_at?.toISOString() ?? null,
    });
  } catch (error) {
    console.error('[SKILL VERSION DETAIL] Error:', error);
    return c.json({ error: 'Failed to fetch skill version', message: (error as Error).message }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Leaderboard Routes (v4)
// ──────────────────────────────────────────────────────────────────────────────

function parseLeaderboardFilters(c: any): LeaderboardFilters {
  return {
    skillType: c.req.query('type') as LeaderboardFilters['skillType'],
    category: c.req.query('category'),
    ecosystem: c.req.query('ecosystem'),
    limit: c.req.query('limit') ? parseInt(c.req.query('limit')) : undefined,
    offset: c.req.query('offset') ? parseInt(c.req.query('offset')) : undefined,
  };
}

app.get('/v1/leaderboards/human', async (c) => {
  const pool = createPool(c.env);
  try {
    const results = await getHumanLeaderboard(parseLeaderboardFilters(c), pool);
    return c.json({ leaderboard: results });
  } catch (error) {
    console.error('[LEADERBOARD] Human error:', error);
    return c.json({ error: 'Failed to get leaderboard' }, 500);
  }
});

app.get('/v1/leaderboards/agents', async (c) => {
  const pool = createPool(c.env);
  try {
    const results = await getAgentLeaderboard(parseLeaderboardFilters(c), pool);
    return c.json({ leaderboard: results });
  } catch (error) {
    console.error('[LEADERBOARD] Agent error:', error);
    return c.json({ error: 'Failed to get leaderboard' }, 500);
  }
});

app.get('/v1/leaderboards/trending', async (c) => {
  const pool = createPool(c.env);
  try {
    const results = await getTrendingLeaderboard(parseLeaderboardFilters(c), pool);
    return c.json({ leaderboard: results });
  } catch (error) {
    console.error('[LEADERBOARD] Trending error:', error);
    return c.json({ error: 'Failed to get leaderboard' }, 500);
  }
});

app.get('/v1/leaderboards/most-composed', async (c) => {
  const pool = createPool(c.env);
  try {
    const results = await getMostComposedLeaderboard(parseLeaderboardFilters(c), pool);
    return c.json({ leaderboard: results });
  } catch (error) {
    console.error('[LEADERBOARD] Most-composed error:', error);
    return c.json({ error: 'Failed to get leaderboard' }, 500);
  }
});

app.get('/v1/leaderboards/most-forked', async (c) => {
  const pool = createPool(c.env);
  try {
    const results = await getMostForkedLeaderboard(parseLeaderboardFilters(c), pool);
    return c.json({ leaderboard: results });
  } catch (error) {
    console.error('[LEADERBOARD] Most-forked error:', error);
    return c.json({ error: 'Failed to get leaderboard' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Author Routes (v4)
// ──────────────────────────────────────────────────────────────────────────────

app.route('/v1/authors', authorRoutes);

// ──────────────────────────────────────────────────────────────────────────────
// Admin: trigger Cognium scan for a skill
// ──────────────────────────────────────────────────────────────────────────────

app.post('/v1/admin/scan/:skillId', async (c) => {
  const skillId = c.req.param('skillId');
  const mode = c.req.query('mode') ?? 'inline'; // 'inline' (direct) or 'queue' (async)
  try {
    const pool = createPool(c.env);

    // Fetch skill
    const skillRes = await pool.query(
      `SELECT id, slug, version, name, description, source, status,
              execution_layer AS "executionLayer",
              skill_md AS "skillMd",
              r2_bundle_key AS "r2BundleKey",
              root_source AS "rootSource",
              skill_type AS "skillType",
              source_url AS "sourceUrl",
              repository_url AS "repositoryUrl",
              schema_json AS "schemaJson",
              capabilities_required AS "capabilitiesRequired",
              cognium_job_id AS "cogniumJobId",
              agent_summary AS "agentSummary",
              changelog::text AS "changelog"
       FROM skills WHERE id = $1`, [skillId]
    );
    if (skillRes.rows.length === 0) return c.json({ error: 'Skill not found' }, 404);
    const skill = skillRes.rows[0];

    // Deduplication: reject if a scan job is already in flight (unless force=true)
    const force = c.req.query('force') === 'true';
    if (!force && skill.cogniumJobId) {
      return c.json({ error: 'Scan already in progress', jobId: skill.cogniumJobId, hint: 'Use ?force=true to override' }, 409);
    }

    // Queue mode: just enqueue and return immediately (better for GitHub/slow repos)
    if (mode === 'queue') {
      try {
        await c.env.COGNIUM_QUEUE.send({
          skillId: skill.id,
          priority: 'high' as const,
          timestamp: Date.now(),
        });
      } catch (qErr) {
        return c.json({ error: `Queue send failed: ${(qErr as Error).message}`, skillId, queueError: true }, 503);
      }
      return c.json({ success: true, skillId, mode: 'queue', message: 'Enqueued for async scanning' });
    }

    // Inline mode: submit to Circle-IR Skills API, poll, apply report
    const cogniumUrl = c.env.COGNIUM_URL ?? 'https://circle.cognium.net';
    const apiKey = c.env.COGNIUM_API_KEY ?? '';
    const authHeaders = { 'Authorization': `Bearer ${apiKey}` };

    const { buildCircleIRRequest } = await import('./cognium/request-builder');
    // buildCircleIRRequest includes bundle_url for clawhub skills —
    // Circle-IR downloads + extracts the zip bundle directly
    const submitRes = await fetch(`${cogniumUrl}/api/analyze/skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(buildCircleIRRequest(skill)),
    });
    if (!submitRes.ok) return c.json({ error: `Circle-IR submit failed: ${submitRes.status}` }, 502);
    const { job_id } = await submitRes.json() as { job_id: string };

    // Poll until done (max 120s = 30 × 4s — bundle downloads can take 60-90s)
    let jobStatus: any;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 4000));
      const statusRes = await fetch(`${cogniumUrl}/api/analyze/${job_id}/status`, {
        headers: authHeaders,
      });
      jobStatus = await statusRes.json();
      if (jobStatus.status === 'completed' || jobStatus.status === 'failed') break;
    }

    if (jobStatus.status !== 'completed') {
      return c.json({ error: `Job ${job_id} ended with status: ${jobStatus.status}`, jobStatus }, 502);
    }

    // Fetch findings, skill-result, and results (for files_detail/bundle_metadata) in parallel
    const [findingsRes, skillResultRes, resultsRes] = await Promise.all([
      fetch(`${cogniumUrl}/api/analyze/${job_id}/findings`, { headers: authHeaders }),
      fetch(`${cogniumUrl}/api/analyze/${job_id}/skill-result`, { headers: authHeaders }),
      fetch(`${cogniumUrl}/api/analyze/${job_id}/results`, { headers: authHeaders }),
    ]);
    const { findings: raw } = await findingsRes.json() as { findings: any[] };
    const skillResult = skillResultRes.ok ? await skillResultRes.json() as any : null;

    // Enrich jobStatus with files_detail and bundle_metadata from /results
    if (resultsRes.ok) {
      const resultsBody = await resultsRes.json() as any;
      if (resultsBody.files_detail) jobStatus.files_detail = resultsBody.files_detail;
      if (resultsBody.bundle_metadata) jobStatus.bundle_metadata = resultsBody.bundle_metadata;
      if (resultsBody.metrics) jobStatus.metrics = resultsBody.metrics;
    }

    const { normalizeFindings } = await import('./cognium/finding-mapper');
    const { applyScanReport } = await import('./cognium/scan-report-handler');
    const findings = normalizeFindings(raw);
    await applyScanReport(c.env, pool, skill, findings, jobStatus, skillResult);

    return c.json({
      success: true, skillId, jobId: job_id,
      findingsCount: findings.length,
      trustScore: skillResult?.trust_score,
      verdict: skillResult?.verdict,
      bundleMetadata: jobStatus.bundle_metadata ?? null,
      filesDetail: jobStatus.files_detail ?? null,
      metrics: jobStatus.metrics ?? null,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message, skillId }, 500);
  }
});

// Admin: apply results from an existing Circle-IR job to a skill
app.post('/v1/admin/apply-job/:skillId', async (c) => {
  const skillId = c.req.param('skillId');
  const jobId = c.req.query('job_id');
  if (!jobId) return c.json({ error: 'Missing job_id query parameter' }, 400);

  try {
    const pool = createPool(c.env);
    const cogniumUrl = c.env.COGNIUM_URL ?? 'https://circle.cognium.net';
    const apiKey = c.env.COGNIUM_API_KEY ?? '';
    const authHeaders = { 'Authorization': `Bearer ${apiKey}` };

    const skillRes = await pool.query(
      `SELECT id, slug, version, name, description, source, status,
              execution_layer AS "executionLayer",
              skill_md AS "skillMd",
              r2_bundle_key AS "r2BundleKey",
              root_source AS "rootSource", skill_type AS "skillType",
              source_url AS "sourceUrl",
              repository_url AS "repositoryUrl",
              schema_json AS "schemaJson",
              capabilities_required AS "capabilitiesRequired",
              agent_summary AS "agentSummary",
              changelog::text AS "changelog"
       FROM skills WHERE id = $1`, [skillId]
    );
    if (skillRes.rows.length === 0) return c.json({ error: 'Skill not found' }, 404);
    const skill = skillRes.rows[0];

    // Fetch status, findings, skill-result, and results from Circle-IR
    const [statusRes, findingsRes, skillResultRes, resultsRes] = await Promise.all([
      fetch(`${cogniumUrl}/api/analyze/${jobId}/status`, { headers: authHeaders }),
      fetch(`${cogniumUrl}/api/analyze/${jobId}/findings`, { headers: authHeaders }),
      fetch(`${cogniumUrl}/api/analyze/${jobId}/skill-result`, { headers: authHeaders }),
      fetch(`${cogniumUrl}/api/analyze/${jobId}/results`, { headers: authHeaders }),
    ]);

    const jobStatus = await statusRes.json() as any;
    if (jobStatus.status !== 'completed') {
      return c.json({ error: `Job not completed: ${jobStatus.status}` }, 400);
    }

    const { findings: raw } = await findingsRes.json() as { findings: any[] };
    const skillResult = skillResultRes.ok ? await skillResultRes.json() as any : null;

    // Enrich jobStatus with files_detail and bundle_metadata from /results
    if (resultsRes.ok) {
      const resultsBody = await resultsRes.json() as any;
      if (resultsBody.files_detail) jobStatus.files_detail = resultsBody.files_detail;
      if (resultsBody.bundle_metadata) jobStatus.bundle_metadata = resultsBody.bundle_metadata;
      if (resultsBody.metrics) jobStatus.metrics = resultsBody.metrics;
    }

    const { normalizeFindings } = await import('./cognium/finding-mapper');
    const { applyScanReport } = await import('./cognium/scan-report-handler');
    const findings = normalizeFindings(raw);
    await applyScanReport(c.env, pool, skill, findings, jobStatus, skillResult);

    return c.json({
      success: true, skillId, jobId,
      findingsCount: findings.length,
      trustScore: skillResult?.trust_score,
      verdict: skillResult?.verdict,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message, skillId }, 500);
  }
});

// Admin: test scoring with synthetic findings (no Circle-IR call)
app.post('/v1/admin/scan-test/:skillId', async (c) => {
  const skillId = c.req.param('skillId');
  try {
    const pool = createPool(c.env);
    const skillRes = await pool.query(
      `SELECT id, slug, version, name, description, source, status,
              execution_layer AS "executionLayer",
              root_source AS "rootSource", skill_type AS "skillType"
       FROM skills WHERE id = $1`, [skillId]
    );
    if (skillRes.rows.length === 0) return c.json({ error: 'Skill not found' }, 404);
    const skill = skillRes.rows[0];

    const body = await c.req.json() as { findings?: Array<{ severity: string; cweId: string }> };
    const { computeTrustScore, deriveStatus, deriveTier } = await import('./cognium/scoring-policy');
    const { deriveWorstSeverity, isContentUnsafe } = await import('./cognium/finding-mapper');
    const { applyScanReport } = await import('./cognium/scan-report-handler');

    const findings = (body.findings ?? []).map((f, i) => ({
      severity: f.severity.toUpperCase() as any,
      cweId: f.cweId,
      tool: 'test-harness',
      title: `Test finding ${i}`,
      description: `Synthetic ${f.severity} ${f.cweId}`,
      confidence: 0.9,
      verdict: 'VULNERABLE' as const,
      llmVerified: f.severity === 'CRITICAL',
    }));

    const trustScore = computeTrustScore(skill, findings);
    const worstSeverity = deriveWorstSeverity(findings);
    const status = deriveStatus(worstSeverity);
    const tier = deriveTier(worstSeverity, trustScore);
    const contentUnsafe = isContentUnsafe(findings);

    // Apply to DB
    const fakeJob = { job_id: 'test', status: 'completed' as const, progress: 100, metrics: { files_total: 1, files_analyzed: 1, files_failed: 0, files_skipped: 0 } };
    await applyScanReport(c.env, pool, skill, findings, fakeJob);

    // Read back from DB
    const after = await pool.query(
      `SELECT trust_score, verification_tier, status, scan_coverage, remediation_message FROM skills WHERE id = $1`, [skillId]
    );

    return c.json({
      skillId, slug: skill.slug, source: skill.rootSource ?? skill.source,
      computed: { trustScore, worstSeverity, status, tier, contentUnsafe, findingsCount: findings.length },
      dbAfter: after.rows[0],
    });
  } catch (err) {
    return c.json({ error: (err as Error).message, skillId }, 500);
  }
});

// Admin: backfill — scan unverified skills via Skills API
// mode=queue (default): enqueue to COGNIUM_QUEUE for async processing (supports large batches)
// mode=inline: direct inline scan + poll (limited to small batches by CF subrequest limits)
app.get('/v1/admin/scan-stats', async (c) => {
  try {
    const pool = createPool(c.env);

    const [statusBreakdown, tierBreakdown, sourceBreakdown, trustDistribution, trustHistogram, topFindings, scanCoverage] = await Promise.all([
      pool.query(`SELECT status, count(*)::int AS cnt FROM skills WHERE cognium_scanned_at IS NOT NULL GROUP BY status ORDER BY cnt DESC`),
      pool.query(`SELECT verification_tier, count(*)::int AS cnt FROM skills WHERE cognium_scanned_at IS NOT NULL GROUP BY verification_tier ORDER BY cnt DESC`),
      pool.query(`SELECT source, status, count(*)::int AS cnt FROM skills WHERE cognium_scanned_at IS NOT NULL GROUP BY source, status ORDER BY source, cnt DESC`),
      pool.query(`SELECT
        count(*) FILTER (WHERE trust_score >= 0.9)::int AS high,
        count(*) FILTER (WHERE trust_score >= 0.5 AND trust_score < 0.9)::int AS medium,
        count(*) FILTER (WHERE trust_score > 0 AND trust_score < 0.5)::int AS low,
        count(*) FILTER (WHERE trust_score = 0)::int AS zero,
        count(*) FILTER (WHERE trust_score IS NULL)::int AS unscored
      FROM skills WHERE cognium_scanned_at IS NOT NULL`),
      pool.query(`SELECT
        CASE
          WHEN trust_score = 1.0 THEN '1.00'
          WHEN trust_score >= 0.95 THEN '0.95-0.99'
          WHEN trust_score >= 0.90 THEN '0.90-0.94'
          WHEN trust_score >= 0.80 THEN '0.80-0.89'
          WHEN trust_score >= 0.70 THEN '0.70-0.79'
          WHEN trust_score >= 0.60 THEN '0.60-0.69'
          WHEN trust_score >= 0.50 THEN '0.50-0.59'
          WHEN trust_score >= 0.30 THEN '0.30-0.49'
          WHEN trust_score > 0 THEN '0.01-0.29'
          ELSE '0.00'
        END AS bucket,
        count(*)::int AS cnt
      FROM skills
      GROUP BY bucket
      ORDER BY bucket DESC`),
      pool.query(`SELECT
        f->>'severity' AS severity,
        f->>'cweId' AS cwe_id,
        f->>'title' AS title,
        count(*)::int AS cnt
      FROM skills, jsonb_array_elements(cognium_findings::jsonb) AS f
      WHERE cognium_scanned_at IS NOT NULL AND cognium_findings IS NOT NULL AND cognium_findings != '[]'
      GROUP BY f->>'severity', f->>'cweId', f->>'title'
      ORDER BY
        CASE f->>'severity' WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
        cnt DESC
      LIMIT 30`),
      pool.query(`SELECT scan_coverage, count(*)::int AS cnt FROM skills WHERE cognium_scanned_at IS NOT NULL AND scan_coverage IS NOT NULL GROUP BY scan_coverage ORDER BY cnt DESC`),
    ]);

    const totalScanned = await pool.query(`SELECT count(*)::int AS cnt FROM skills WHERE cognium_scanned_at IS NOT NULL`);
    const totalSkills = await pool.query(`SELECT count(*)::int AS cnt FROM skills`);
    const inFlight = await pool.query(`SELECT count(*)::int AS cnt FROM skills WHERE cognium_job_id IS NOT NULL`);
    const remaining = await pool.query(`SELECT count(*)::int AS cnt FROM skills WHERE cognium_scanned_at IS NULL AND verification_tier = 'unverified' AND status = 'published' AND cognium_job_id IS NULL`);

    return c.json({
      total: totalSkills.rows[0].cnt,
      scanned: totalScanned.rows[0].cnt,
      inFlight: inFlight.rows[0].cnt,
      remaining: remaining.rows[0].cnt,
      byStatus: Object.fromEntries(statusBreakdown.rows.map((r: any) => [r.status, r.cnt])),
      byTier: Object.fromEntries(tierBreakdown.rows.map((r: any) => [r.verification_tier, r.cnt])),
      bySource: sourceBreakdown.rows.reduce((acc: any, r: any) => {
        if (!acc[r.source]) acc[r.source] = {};
        acc[r.source][r.status] = r.cnt;
        return acc;
      }, {}),
      trustDistribution: trustDistribution.rows[0],
      trustHistogram: Object.fromEntries(trustHistogram.rows.map((r: any) => [r.bucket, r.cnt])),
      scanCoverage: Object.fromEntries(scanCoverage.rows.map((r: any) => [r.scan_coverage, r.cnt])),
      topFindings: topFindings.rows,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Admin: debug — show what we'd send to Circle-IR for a skill (dry run)
app.get('/v1/admin/scan-preview', async (c) => {
  try {
    const slug = c.req.query('slug');
    const source = c.req.query('source');
    const pool = createPool(c.env);
    const { buildCircleIRRequest } = await import('./cognium/request-builder');

    let query: string;
    let params: any[];
    if (slug) {
      query = `SELECT id, slug, version, name, description, source, status,
                execution_layer AS "executionLayer",
                skill_md AS "skillMd",
                r2_bundle_key AS "r2BundleKey",
                root_source AS "rootSource", skill_type AS "skillType",
                source_url AS "sourceUrl",
                repository_url AS "repositoryUrl",
                schema_json AS "schemaJson",
                capabilities_required AS "capabilitiesRequired",
                agent_summary AS "agentSummary",
                changelog::text AS "changelog",
                length(coalesce(description,''))::int AS description_len,
                length(coalesce(skill_md,''))::int AS skill_md_len,
                length(coalesce(agent_summary,''))::int AS agent_summary_len,
                length(coalesce(changelog::text,''))::int AS changelog_len,
                trust_score, verification_tier, scan_coverage, cognium_scanned_at,
                analyzer_summary::text AS "analyzerSummary"
         FROM skills WHERE slug = $1 LIMIT 1`;
      params = [slug];
    } else {
      query = `SELECT id, slug, version, name, description, source, status,
                execution_layer AS "executionLayer",
                skill_md AS "skillMd",
                r2_bundle_key AS "r2BundleKey",
                root_source AS "rootSource", skill_type AS "skillType",
                source_url AS "sourceUrl",
                repository_url AS "repositoryUrl",
                schema_json AS "schemaJson",
                capabilities_required AS "capabilitiesRequired",
                agent_summary AS "agentSummary",
                changelog::text AS "changelog",
                length(coalesce(description,''))::int AS description_len,
                length(coalesce(skill_md,''))::int AS skill_md_len,
                length(coalesce(agent_summary,''))::int AS agent_summary_len,
                length(coalesce(changelog::text,''))::int AS changelog_len
         FROM skills WHERE status = 'published' ${source ? 'AND source = $1' : ''} ORDER BY random() LIMIT 3`;
      params = source ? [source] : [];
    }

    const result = await pool.query(query, params);
    const previews = result.rows.map((skill: any) => {
      const request = buildCircleIRRequest(skill);
      return {
        id: skill.id,
        slug: skill.slug,
        source: skill.source,
        dbContent: {
          description: skill.description?.slice(0, 200),
          description_len: skill.description_len,
          skill_md_len: skill.skill_md_len,
          agent_summary_len: skill.agent_summary_len,
          changelog_len: skill.changelog_len,
          sourceUrl: skill.sourceUrl,
          repositoryUrl: skill.repositoryUrl,
          r2BundleKey: skill.r2BundleKey,
          schemaJson: skill.schemaJson ? 'present' : null,
        },
        circleIRRequest: {
          repo_url: request.repo_url ?? null,
          bundle_url: request.bundle_url ?? null,
          files: request.files
            ? Object.fromEntries(
                Object.entries(request.files).map(([k, v]) => [k, { length: v.length, preview: v.slice(0, 300) }])
              )
            : null,
          skill_context: request.skill_context,
          options: request.options,
        },
        scanResult: skill.cognium_scanned_at ? {
          trustScore: skill.trust_score,
          tier: skill.verification_tier,
          coverage: skill.scan_coverage,
          analyzerSummary: skill.analyzerSummary ? JSON.parse(skill.analyzerSummary) : null,
        } : null,
      };
    });
    return c.json(previews);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Admin: run extended analysis (quality, trust, understand, spec-diff) for a skill
app.post('/v1/admin/analyze/:skillId', async (c) => {
  const skillId = c.req.param('skillId');
  try {
    const pool = createPool(c.env);
    const skillRes = await pool.query(
      `SELECT id, slug, version, name, description, source, status,
              execution_layer AS "executionLayer",
              skill_md AS "skillMd",
              r2_bundle_key AS "r2BundleKey",
              root_source AS "rootSource", skill_type AS "skillType",
              source_url AS "sourceUrl",
              repository_url AS "repositoryUrl",
              schema_json AS "schemaJson",
              capabilities_required AS "capabilitiesRequired",
              agent_summary AS "agentSummary",
              changelog::text AS "changelog"
       FROM skills WHERE id = $1`, [skillId]
    );
    if (skillRes.rows.length === 0) return c.json({ error: 'Skill not found' }, 404);
    const skill = skillRes.rows[0];

    // Queue mode: enqueue for async processing instead of inline
    const mode = c.req.query('mode') ?? 'inline';
    if (mode === 'queue') {
      await c.env.ANALYSIS_QUEUE.send({
        skillId,
        priority: 'high',
        timestamp: Date.now(),
      } as AnalysisSubmitMessage);
      return c.json({ success: true, mode: 'queue', skillId, slug: skill.slug });
    }

    const cogniumUrl = c.env.COGNIUM_URL ?? 'https://circle.cognium.net';
    const apiKey = c.env.COGNIUM_API_KEY ?? '';
    const authHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };

    const { buildAnalysisRequests } = await import('./cognium/analysis-request-builder');
    const requests = buildAnalysisRequests(skill);

    // Submit all 4 endpoints in parallel
    const endpoints = [
      { key: 'quality', path: '/api/quality', body: requests.quality },
      { key: 'trust', path: '/api/trust', body: requests.trust },
      { key: 'understand', path: '/api/understand', body: requests.understand },
      { key: 'specDiff', path: '/api/spec-diff', body: requests.specDiff },
    ] as const;

    const submitResults = await Promise.allSettled(
      endpoints.map(async (ep) => {
        const res = await fetch(`${cogniumUrl}${ep.path}`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(ep.body),
        });
        if (!res.ok) throw new Error(`${ep.path} submit failed: ${res.status}`);
        const { job_id } = await res.json() as { job_id: string };
        return { key: ep.key, jobId: job_id, path: ep.path };
      })
    );

    const jobs: Record<string, { jobId: string; path: string }> = {};
    const errors: Record<string, string> = {};
    for (const r of submitResults) {
      if (r.status === 'fulfilled') {
        jobs[r.value.key] = { jobId: r.value.jobId, path: r.value.path };
      } else {
        const key = endpoints[submitResults.indexOf(r)].key;
        errors[key] = r.reason?.message ?? 'Unknown submit error';
      }
    }

    if (Object.keys(jobs).length === 0) {
      return c.json({ error: 'All submissions failed', errors, skillId }, 502);
    }

    // Poll all submitted jobs (max 30 × 4s = 120s)
    const results: Record<string, any> = {};

    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 4000));
      const pendingKeys = Object.keys(jobs).filter(k => !results[k] && !errors[k]);
      if (pendingKeys.length === 0) break;

      await Promise.allSettled(
        pendingKeys.map(async (key) => {
          const { jobId, path } = jobs[key];
          const statusRes = await fetch(`${cogniumUrl}${path}/${jobId}/status`, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
          });
          if (!statusRes.ok) return;
          const status = await statusRes.json() as { status: string };
          if (status.status === 'completed') {
            const resultRes = await fetch(`${cogniumUrl}${path}/${jobId}/results`, {
              headers: { 'Authorization': `Bearer ${apiKey}` },
            });
            if (resultRes.ok) {
              results[key] = await resultRes.json();
            } else {
              errors[key] = `Results fetch failed: ${resultRes.status}`;
            }
          } else if (status.status === 'failed' || status.status === 'cancelled') {
            errors[key] = `Job ${status.status}`;
          }
        })
      );
    }

    // Mark timed-out jobs
    for (const key of Object.keys(jobs)) {
      if (!results[key] && !errors[key]) {
        errors[key] = 'Timed out (120s)';
      }
    }

    // Apply collected results to DB
    const { applyAnalysisResults } = await import('./cognium/analysis-report-handler');
    await applyAnalysisResults(pool, skillId, {
      quality: results.quality ?? null,
      trust: results.trust ?? null,
      understand: results.understand ?? null,
      specDiff: results.specDiff ?? null,
    });

    return c.json({
      success: true,
      skillId,
      slug: skill.slug,
      completed: Object.keys(results),
      errors: Object.keys(errors).length > 0 ? errors : undefined,
      quality: results.quality ? { score: results.quality.score, tier: results.quality.tier } : null,
      trust: results.trust ? { score: results.trust.score, tier: results.trust.tier } : null,
      understand: results.understand ? { modules: results.understand.modules?.length ?? 0, functions: results.understand.functions?.length ?? 0 } : null,
      specDiff: results.specDiff ? { alignmentScore: results.specDiff.alignmentScore, gaps: results.specDiff.gaps?.length ?? 0 } : null,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message, skillId }, 500);
  }
});

// Admin: batch-enqueue skills for analysis via queue pipeline
app.post('/v1/admin/analyze-batch', async (c) => {
  try {
    const body = await c.req.json() as {
      skillIds?: string[];
      source?: string;
      limit?: number;
      endpoints?: AnalysisEndpoint[];
    };

    const pool = createPool(c.env);
    let skillIds: string[];

    if (body.skillIds && body.skillIds.length > 0) {
      skillIds = body.skillIds.slice(0, 500);
    } else if (body.source) {
      const limit = Math.min(body.limit ?? 100, 500);
      const res = await pool.query(
        `SELECT id FROM skills WHERE source = $1 AND quality_analyzed_at IS NULL ORDER BY created_at DESC LIMIT $2`,
        [body.source, limit]
      );
      skillIds = res.rows.map((r: { id: string }) => r.id);
    } else {
      return c.json({ error: 'Provide skillIds or source' }, 400);
    }

    if (skillIds.length === 0) {
      return c.json({ success: true, enqueued: 0, endpoints: body.endpoints ?? ['quality', 'trust', 'understand', 'specDiff'] });
    }

    // Send in batches of 25 with 200ms delay between batches
    const CHUNK_SIZE = 25;
    for (let i = 0; i < skillIds.length; i += CHUNK_SIZE) {
      const chunk = skillIds.slice(i, i + CHUNK_SIZE);
      await c.env.ANALYSIS_QUEUE.sendBatch(
        chunk.map((skillId) => ({
          body: {
            skillId,
            endpoints: body.endpoints,
            priority: 'normal' as const,
            timestamp: Date.now(),
          } as AnalysisSubmitMessage,
        }))
      );
      if (i + CHUNK_SIZE < skillIds.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    const endpoints = body.endpoints ?? ['quality', 'trust', 'understand', 'specDiff'];
    return c.json({ success: true, enqueued: skillIds.length, endpoints });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Admin: clear stale in-flight jobs
app.post('/v1/admin/clear-stale', async (c) => {
  try {
    const pool = createPool(c.env);
    const result = await pool.query(
      `UPDATE skills
       SET cognium_job_id = NULL, cognium_job_submitted_at = NULL
       WHERE cognium_job_id IS NOT NULL
       RETURNING id, slug, source`
    );
    return c.json({ cleared: result.rows.length, skills: result.rows.map((r: any) => r.slug).slice(0, 20) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Admin: deprecate skills whose scans failed with a specific reason
app.post('/v1/admin/deprecate-failed', async (c) => {
  try {
    const pool = createPool(c.env);
    const body = await c.req.json().catch(() => ({})) as { reason?: string; dryRun?: boolean };
    const reason = body.reason ?? 'Status check returned 404';
    const dryRun = body.dryRun ?? true;

    if (dryRun) {
      const preview = await pool.query(
        `SELECT count(*)::int AS cnt FROM skills
         WHERE scan_failure_reason = $1 AND status = 'published'`,
        [reason]
      );
      const sample = await pool.query(
        `SELECT slug, source, name FROM skills
         WHERE scan_failure_reason = $1 AND status = 'published'
         ORDER BY created_at ASC LIMIT 10`,
        [reason]
      );
      return c.json({ dryRun: true, reason, count: preview.rows[0].cnt, sample: sample.rows });
    }

    const result = await pool.query(
      `UPDATE skills SET
        status = 'deprecated',
        deprecated_at = NOW(),
        deprecated_reason = $2,
        updated_at = NOW()
       WHERE scan_failure_reason = $1 AND status = 'published'
       RETURNING id, slug, source`,
      [reason, `Scan failed: ${reason}`]
    );
    return c.json({ deprecated: result.rows.length, reason, sample: result.rows.slice(0, 20).map((r: any) => r.slug) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Admin: inventory of skills by content type
app.get('/v1/admin/skill-inventory', async (c) => {
  try {
    const pool = createPool(c.env);
    const [total, bySource, byStatus, byContent, byScanStatus, failureReasons, embeddingCoverage] = await Promise.all([
      pool.query(`SELECT count(*)::int AS cnt FROM skills WHERE status = 'published'`),
      pool.query(`SELECT source, count(*)::int AS cnt FROM skills WHERE status = 'published' GROUP BY source ORDER BY cnt DESC`),
      pool.query(`SELECT status, count(*)::int AS cnt FROM skills GROUP BY status ORDER BY cnt DESC`),
      pool.query(`SELECT
        count(*) FILTER (WHERE source = 'github' OR repository_url IS NOT NULL)::int AS has_repo,
        count(*) FILTER (WHERE skill_md IS NOT NULL AND length(skill_md) > 100)::int AS has_skill_md,
        count(*) FILTER (WHERE schema_json IS NOT NULL)::int AS has_schema,
        count(*) FILTER (WHERE agent_summary IS NOT NULL AND length(agent_summary) > 50)::int AS has_agent_summary,
        count(*) FILTER (WHERE r2_bundle_key IS NOT NULL)::int AS has_bundle,
        count(*) FILTER (WHERE skill_md IS NULL AND schema_json IS NULL AND (source != 'github' AND repository_url IS NULL))::int AS metadata_only
      FROM skills WHERE status = 'published'`),
      pool.query(`SELECT
        count(*) FILTER (WHERE cognium_scanned_at IS NULL)::int AS never_scanned,
        count(*) FILTER (WHERE cognium_scanned_at IS NOT NULL AND verification_tier = 'unverified')::int AS scan_failed,
        count(*) FILTER (WHERE cognium_scanned_at IS NOT NULL AND verification_tier != 'unverified')::int AS scan_completed,
        count(*) FILTER (WHERE cognium_job_id IS NOT NULL)::int AS in_flight,
        count(*) FILTER (WHERE cognium_scanned_at IS NULL AND (skill_md IS NOT NULL AND length(skill_md) > 100))::int AS unscanned_with_instructions,
        count(*) FILTER (WHERE cognium_scanned_at IS NULL AND (source = 'github' OR repository_url IS NOT NULL))::int AS unscanned_with_repo,
        count(*) FILTER (WHERE cognium_scanned_at IS NOT NULL AND verification_tier = 'unverified' AND (skill_md IS NOT NULL AND length(skill_md) > 100))::int AS failed_with_instructions
      FROM skills WHERE status = 'published'`),
      pool.query(`SELECT
        COALESCE(scan_failure_reason, 'unknown (pre-tracking)') AS reason,
        count(*)::int AS cnt
      FROM skills
      WHERE cognium_scanned_at IS NOT NULL AND verification_tier = 'unverified'
      GROUP BY scan_failure_reason
      ORDER BY cnt DESC
      LIMIT 20`),
      pool.query(`SELECT
        count(DISTINCT s.id)::int AS total_published,
        count(DISTINCT se.skill_id)::int AS has_embedding,
        (count(DISTINCT s.id) - count(DISTINCT se.skill_id))::int AS missing_embedding
      FROM skills s
      LEFT JOIN skill_embeddings se ON s.id = se.skill_id
      WHERE s.status = 'published' AND s.content_safety_passed = true`),
    ]);
    return c.json({
      totalPublished: total.rows[0].cnt,
      byStatus: Object.fromEntries(byStatus.rows.map((r: any) => [r.status, r.cnt])),
      bySource: Object.fromEntries(bySource.rows.map((r: any) => [r.source, r.cnt])),
      content: byContent.rows[0],
      scanStatus: byScanStatus.rows[0],
      failureReasons: Object.fromEntries(failureReasons.rows.map((r: any) => [r.reason, r.cnt])),
      embeddings: embeddingCoverage.rows[0],
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Admin: bulk embed skills missing embeddings
app.post('/v1/admin/embed-backfill', async (c) => {
  try {
    const limit = Math.min(parseInt(c.req.query('limit') ?? '200', 10), 500);
    const source = c.req.query('source');
    const pool = createPool(c.env);
    const embedPipeline = new EmbedPipeline(c.env);
    const provider = new PgVectorProvider(c.env);
    const useMultiVector = c.env.MULTI_VECTOR_ENABLED === 'true';

    const params: unknown[] = [];
    let paramIdx = 1;
    let sourceFilter = '';
    if (source) {
      sourceFilter = `AND s.source = $${paramIdx++}`;
      params.push(source);
    }
    params.push(limit);
    const result = await pool.query(
      `SELECT s.id, s.name, s.slug, s.version, s.source, s.description,
              s.agent_summary, s.tags, s.category, s.schema_json,
              s.trust_score, s.capabilities_required, s.execution_layer, s.tenant_id
       FROM skills s
       LEFT JOIN skill_embeddings se ON s.id = se.skill_id
       WHERE se.skill_id IS NULL
       AND s.content_safety_passed = true
       AND s.status = 'published'
       ${sourceFilter}
       LIMIT $${paramIdx}`,
      params
    );

    let embedded = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const row of result.rows) {
      try {
        const skill: SkillInput = {
          id: row.id, name: row.name, slug: row.slug,
          version: row.version, source: row.source,
          description: row.description ?? '',
          agentSummary: row.agent_summary,
          tags: row.tags ?? [], category: row.category,
          schemaJson: row.schema_json,
          trustScore: parseFloat(row.trust_score ?? '0.5'),
          capabilitiesRequired: row.capabilities_required ?? [],
          executionLayer: row.execution_layer,
          tenantId: row.tenant_id ?? 'default',
        };
        const embeddings = useMultiVector
          ? await embedPipeline.processSkillMultiVector(skill)
          : await embedPipeline.processSkill(skill);
        skill.agentSummary = embeddings.agentSummary.text;
        await provider.index(skill, embeddings);
        embedded++;
      } catch (e: any) {
        failed++;
        if (errors.length < 5) errors.push(`${row.slug}: ${e.message}`);
      }
    }

    // Count remaining
    const remaining = await pool.query(
      `SELECT count(*)::int AS cnt FROM skills s
       LEFT JOIN skill_embeddings se ON s.id = se.skill_id
       WHERE se.skill_id IS NULL AND s.content_safety_passed = true AND s.status = 'published'`
    );

    return c.json({
      embedded,
      failed,
      remaining: remaining.rows[0].cnt,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Admin: queue-based backfill — enqueues skills missing embeddings to EMBED_QUEUE
app.post('/v1/admin/embed-queue-backfill', async (c) => {
  try {
    const limit = Math.min(parseInt(c.req.query('limit') ?? '500', 10), 5000);
    const source = c.req.query('source');
    const pool = createPool(c.env);

    const params: unknown[] = [];
    let paramIdx = 1;
    let sourceFilter = '';
    if (source) {
      sourceFilter = `AND s.source = $${paramIdx++}`;
      params.push(source);
    }
    params.push(limit);

    const result = await pool.query(
      `SELECT s.id FROM skills s
       LEFT JOIN skill_embeddings se ON s.id = se.skill_id
       WHERE se.skill_id IS NULL
       AND s.content_safety_passed = true
       AND s.status = 'published'
       ${sourceFilter}
       LIMIT $${paramIdx}`,
      params
    );

    let queued = 0;
    for (const row of result.rows) {
      await c.env.EMBED_QUEUE.send({ skillId: row.id, action: 'embed', source: 'backfill' });
      queued++;
    }

    const remaining = await pool.query(
      `SELECT count(*)::int AS cnt FROM skills s
       LEFT JOIN skill_embeddings se ON s.id = se.skill_id
       WHERE se.skill_id IS NULL AND s.content_safety_passed = true AND s.status = 'published'`
    );

    return c.json({ queued, remaining: remaining.rows[0].cnt - queued });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Admin: cross-source deduplication analysis
app.get('/v1/admin/dedup-analysis', async (c) => {
  try {
    const pool = createPool(c.env);
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);

    const [byRepoUrl, byName, summary] = await Promise.all([
      // Skills sharing the same repository_url across different sources
      pool.query(
        `SELECT repository_url, array_agg(DISTINCT source) AS sources,
                count(*)::int AS cnt, min(name) AS sample_name
         FROM skills
         WHERE repository_url IS NOT NULL AND status = 'published'
         GROUP BY repository_url
         HAVING count(DISTINCT source) > 1
         ORDER BY cnt DESC
         LIMIT $1`,
        [limit]
      ),
      // Skills with exact same name across different sources
      pool.query(
        `SELECT lower(name) AS name_lower, array_agg(DISTINCT source) AS sources,
                count(*)::int AS cnt
         FROM skills
         WHERE status = 'published'
         GROUP BY lower(name)
         HAVING count(DISTINCT source) > 1
         ORDER BY cnt DESC
         LIMIT $1`,
        [limit]
      ),
      // Summary: total dupes by overlap type
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM (
             SELECT repository_url FROM skills
             WHERE repository_url IS NOT NULL AND status = 'published'
             GROUP BY repository_url HAVING count(DISTINCT source) > 1
           ) t) AS repo_url_overlaps,
           (SELECT count(*)::int FROM (
             SELECT lower(name) FROM skills
             WHERE status = 'published'
             GROUP BY lower(name) HAVING count(DISTINCT source) > 1
           ) t) AS name_overlaps`
      ),
    ]);

    return c.json({
      summary: {
        repoUrlOverlaps: summary.rows[0].repo_url_overlaps,
        nameOverlaps: summary.rows[0].name_overlaps,
      },
      byRepoUrl: byRepoUrl.rows.map((r: any) => ({
        repositoryUrl: r.repository_url,
        sources: r.sources,
        count: r.cnt,
        sampleName: r.sample_name,
      })),
      byName: byName.rows.map((r: any) => ({
        name: r.name_lower,
        sources: r.sources,
        count: r.cnt,
      })),
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Admin: cross-source deduplication by repository_url ──────────────────────
app.post('/v1/admin/dedup-repo-url', async (c) => {
  try {
    const pool = createPool(c.env);
    const execute = c.req.query('execute') === 'true';
    const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10), 1000);

    // Single CTE: partition by repository_url, rank by source priority then freshness.
    // Only process groups where every member is status='published' (idempotent).
    const analysisSql = `
      WITH source_ranked AS (
        SELECT
          id, slug, source, repository_url, trust_score, status, updated_at, name,
          CASE source
            WHEN 'mcp-registry' THEN 1
            WHEN 'smithery'     THEN 2
            WHEN 'pulsemcp'     THEN 3
            WHEN 'glama'        THEN 4
            WHEN 'clawhub'      THEN 5
            WHEN 'openclaw'     THEN 6
            WHEN 'github'       THEN 7
            ELSE 8
          END AS source_priority,
          ROW_NUMBER() OVER (
            PARTITION BY repository_url
            ORDER BY
              CASE source
                WHEN 'mcp-registry' THEN 1
                WHEN 'smithery'     THEN 2
                WHEN 'pulsemcp'     THEN 3
                WHEN 'glama'        THEN 4
                WHEN 'clawhub'      THEN 5
                WHEN 'openclaw'     THEN 6
                WHEN 'github'       THEN 7
                ELSE 8
              END ASC,
              updated_at DESC NULLS LAST
          ) AS rn,
          COUNT(*) OVER (PARTITION BY repository_url) AS group_size
        FROM skills
        WHERE repository_url IS NOT NULL
          AND status = 'published'
      ),
      eligible_groups AS (
        SELECT DISTINCT repository_url
        FROM source_ranked
        WHERE group_size = (
          SELECT COUNT(*)
          FROM skills s2
          WHERE s2.repository_url = source_ranked.repository_url
        )
        AND group_size > 1
      ),
      ranked AS (
        SELECT sr.*
        FROM source_ranked sr
        INNER JOIN eligible_groups eg ON eg.repository_url = sr.repository_url
      )
      SELECT
        id, slug, source, repository_url, trust_score, name,
        rn, group_size,
        CASE WHEN rn = 1 THEN 'winner' ELSE 'deprecate' END AS action
      FROM ranked
      ORDER BY repository_url, rn
      LIMIT $1`;

    const analysis = await pool.query(analysisSql, [limit * 10]);

    // Group results by repository_url
    const groups: Array<{
      repositoryUrl: string;
      winner: { id: string; slug: string; source: string; trustScore: string; name: string };
      toDeprecate: Array<{ id: string; slug: string; source: string; trustScore: string; name: string }>;
    }> = [];
    const groupIndex = new Map<string, number>();

    for (const row of analysis.rows as any[]) {
      const key = row.repository_url;
      let idx = groupIndex.get(key);
      if (idx === undefined) {
        idx = groups.length;
        groupIndex.set(key, idx);
        groups.push({ repositoryUrl: key, winner: null as any, toDeprecate: [] });
      }
      const entry = {
        id: row.id,
        slug: row.slug,
        source: row.source,
        trustScore: row.trust_score,
        name: row.name,
      };
      if (row.action === 'winner') {
        groups[idx].winner = entry;
      } else {
        groups[idx].toDeprecate.push(entry);
      }
    }

    // Apply the limit to groups
    const limitedGroups = groups.slice(0, limit);
    const totalToDeprecate = limitedGroups.reduce((sum, g) => sum + g.toDeprecate.length, 0);

    // Execute if requested
    if (execute && limitedGroups.length > 0) {
      const updates: Array<{ loserId: string; winnerId: string; loserSlug: string }> = [];
      for (const g of limitedGroups) {
        for (const loser of g.toDeprecate) {
          updates.push({ loserId: loser.id, winnerId: g.winner.id, loserSlug: loser.slug });
        }
      }

      if (updates.length > 0) {
        // Single UPDATE using a VALUES CTE — no N+1
        const valuesClauses: string[] = [];
        const params: any[] = [];
        for (let i = 0; i < updates.length; i++) {
          const offset = i * 2;
          valuesClauses.push(`($${offset + 1}::uuid, $${offset + 2}::uuid)`);
          params.push(updates[i].loserId, updates[i].winnerId);
        }

        const updateSql = `
          WITH dedup_pairs(loser_id, winner_id) AS (
            VALUES ${valuesClauses.join(', ')}
          )
          UPDATE skills s
          SET
            status = 'deprecated',
            deprecated_at = NOW(),
            deprecated_reason = 'Superseded by cross-source dedup',
            replacement_skill_id = dp.winner_id,
            updated_at = NOW()
          FROM dedup_pairs dp
          WHERE s.id = dp.loser_id
            AND s.status = 'published'`;

        await pool.query(updateSql, params);

        // Cache invalidation: add deprecated slugs to revoked set
        const cache = new SearchCache(c.env.SEARCH_CACHE, parseInt(c.env.CACHE_TTL_SECONDS || '120'));
        for (const u of updates) {
          await cache.addRevokedSlug(u.loserSlug);
        }
      }
    }

    return c.json({
      mode: execute ? 'execute' : 'dry-run',
      groupsProcessed: limitedGroups.length,
      skillsDeprecated: totalToDeprecate,
      skillsKept: limitedGroups.length,
      groups: limitedGroups.slice(0, 50).map(g => ({
        repositoryUrl: g.repositoryUrl,
        winner: g.winner,
        deprecated: g.toDeprecate,
      })),
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Admin: cross-source dedup by name + embedding similarity ─────────────────
// Groups published skills by lower(name), then within each group compares
// embedding vectors. Pairs with cosine similarity >= threshold are treated as
// true duplicates. The higher-priority source wins (same priority order as
// dedup-repo-url). Dry-run by default.
app.post('/v1/admin/dedup-name', async (c) => {
  try {
    const pool = createPool(c.env);
    const execute = c.req.query('execute') === 'true';
    const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10), 1000);
    const threshold = Math.min(Math.max(parseFloat(c.req.query('threshold') ?? '0.95'), 0.8), 1.0);
    const minGroupSize = Math.max(parseInt(c.req.query('minGroupSize') ?? '2', 10), 2);

    // Find name-overlap groups where all members are published and have embeddings.
    // Compare embedding similarity within each group. Return pairs above threshold.
    const analysisSql = `
      WITH name_groups AS (
        SELECT lower(name) AS name_lower, array_agg(id) AS skill_ids, count(*)::int AS cnt
        FROM skills
        WHERE status = 'published'
        GROUP BY lower(name)
        HAVING count(DISTINCT source) > 1 AND count(*) >= $2
        ORDER BY count(*) DESC
        LIMIT $1
      ),
      pairs AS (
        SELECT
          s1.id AS id1, s1.name AS name1, s1.slug AS slug1, s1.source AS source1,
          s1.trust_score AS trust1, s1.updated_at AS updated1,
          s2.id AS id2, s2.name AS name2, s2.slug AS slug2, s2.source AS source2,
          s2.trust_score AS trust2, s2.updated_at AS updated2,
          1 - (e1.embedding <=> e2.embedding) AS similarity,
          ng.name_lower,
          CASE s1.source
            WHEN 'mcp-registry' THEN 1 WHEN 'smithery' THEN 2 WHEN 'pulsemcp' THEN 3
            WHEN 'glama' THEN 4 WHEN 'clawhub' THEN 5 WHEN 'openclaw' THEN 6
            WHEN 'github' THEN 7 ELSE 8
          END AS prio1,
          CASE s2.source
            WHEN 'mcp-registry' THEN 1 WHEN 'smithery' THEN 2 WHEN 'pulsemcp' THEN 3
            WHEN 'glama' THEN 4 WHEN 'clawhub' THEN 5 WHEN 'openclaw' THEN 6
            WHEN 'github' THEN 7 ELSE 8
          END AS prio2
        FROM name_groups ng
        JOIN skills s1 ON s1.id = ANY(ng.skill_ids) AND s1.status = 'published'
        JOIN skills s2 ON s2.id = ANY(ng.skill_ids) AND s2.status = 'published' AND s2.id > s1.id
        JOIN skill_embeddings e1 ON e1.skill_id = s1.id AND e1.source = 'agent_summary'
        JOIN skill_embeddings e2 ON e2.skill_id = s2.id AND e2.source = 'agent_summary'
        WHERE s1.source != s2.source
        AND 1 - (e1.embedding <=> e2.embedding) >= $3
      )
      SELECT * FROM pairs ORDER BY similarity DESC`;

    const pairsResult = await pool.query(analysisSql, [limit, minGroupSize, threshold]);

    // Deduplicate: for each pair, loser is the lower-priority source.
    // Use a set to avoid deprecating the same skill twice.
    const updates: Array<{ loserId: string; winnerId: string; loserSlug: string; winnerSlug: string; similarity: number; loserSource: string; winnerSource: string; name: string }> = [];
    const deprecated = new Set<string>();
    const kept = new Set<string>();

    for (const row of pairsResult.rows as any[]) {
      // Skip if either side already marked for deprecation in this run
      if (deprecated.has(row.id1) || deprecated.has(row.id2)) continue;

      // Winner = lower priority number (higher source rank), tie-break by updated_at
      let winnerId: string, winnerSlug: string, winnerSource: string;
      let loserId: string, loserSlug: string, loserSource: string;

      if (row.prio1 < row.prio2 || (row.prio1 === row.prio2 && row.updated1 >= row.updated2)) {
        winnerId = row.id1; winnerSlug = row.slug1; winnerSource = row.source1;
        loserId = row.id2; loserSlug = row.slug2; loserSource = row.source2;
      } else {
        winnerId = row.id2; winnerSlug = row.slug2; winnerSource = row.source2;
        loserId = row.id1; loserSlug = row.slug1; loserSource = row.source1;
      }

      // Don't deprecate a skill that's already a winner from a previous pair
      if (kept.has(loserId)) continue;

      deprecated.add(loserId);
      kept.add(winnerId);
      updates.push({ loserId, winnerId, loserSlug, winnerSlug, similarity: parseFloat(row.similarity), loserSource, winnerSource, name: row.name_lower });
    }

    // Execute if requested
    if (execute && updates.length > 0) {
      const valuesClauses: string[] = [];
      const params: any[] = [];
      for (let i = 0; i < updates.length; i++) {
        const offset = i * 2;
        valuesClauses.push(`($${offset + 1}::uuid, $${offset + 2}::uuid)`);
        params.push(updates[i].loserId, updates[i].winnerId);
      }

      const updateSql = `
        WITH dedup_pairs(loser_id, winner_id) AS (
          VALUES ${valuesClauses.join(', ')}
        )
        UPDATE skills s
        SET
          status = 'deprecated',
          deprecated_at = NOW(),
          deprecated_reason = 'Superseded by name+embedding dedup',
          replacement_skill_id = dp.winner_id,
          updated_at = NOW()
        FROM dedup_pairs dp
        WHERE s.id = dp.loser_id
          AND s.status = 'published'`;

      await pool.query(updateSql, params);

      // Cache invalidation
      const cache = new SearchCache(c.env.SEARCH_CACHE, parseInt(c.env.CACHE_TTL_SECONDS || '120'));
      for (const u of updates) {
        await cache.addRevokedSlug(u.loserSlug);
      }
    }

    return c.json({
      mode: execute ? 'execute' : 'dry-run',
      threshold,
      pairsFound: pairsResult.rows.length,
      skillsDeprecated: updates.length,
      sample: updates.slice(0, 50).map(u => ({
        name: u.name,
        similarity: u.similarity.toFixed(4),
        winner: { slug: u.winnerSlug, source: u.winnerSource },
        loser: { slug: u.loserSlug, source: u.loserSource },
      })),
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Admin: reset trust scores for a source to its BASE_TRUST value (unscanned skills only)
app.post('/v1/admin/reset-trust', async (c) => {
  try {
    const pool = createPool(c.env);
    const source = c.req.query('source');
    const trustScore = parseFloat(c.req.query('trust') ?? '0');
    const execute = c.req.query('execute') === 'true';

    if (!source || !trustScore) {
      return c.json({ error: 'Required: ?source=pulsemcp&trust=0.50' }, 400);
    }

    // Only reset unscanned skills (cognium_scanned_at IS NULL)
    const countResult = await pool.query(
      `SELECT count(*)::int AS cnt FROM skills
       WHERE source = $1 AND status = 'published'
       AND verification_tier = 'unverified' AND cognium_scanned_at IS NULL`,
      [source]
    );
    const count = countResult.rows[0].cnt;

    if (execute && count > 0) {
      await pool.query(
        `UPDATE skills SET trust_score = $1, updated_at = NOW()
         WHERE source = $2 AND status = 'published'
         AND verification_tier = 'unverified' AND cognium_scanned_at IS NULL`,
        [trustScore, source]
      );
    }

    return c.json({
      mode: execute ? 'execute' : 'dry-run',
      source,
      trustScore,
      skillsAffected: count,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post('/v1/admin/backfill', async (c) => {
  try {
    const mode = c.req.query('mode') ?? 'queue';
    const maxLimit = mode === 'inline' ? 10 : 500;
    const defaultLimit = mode === 'inline' ? '3' : '100';
    const limit = Math.min(parseInt(c.req.query('limit') ?? defaultLimit, 10), maxLimit);
    const source = c.req.query('source'); // optional: filter by source
    const content = c.req.query('content'); // optional: 'instructions' | 'repo' | 'metadata'
    const retry = c.req.query('retry') === 'true'; // retry previously failed scans
    const pool = createPool(c.env);

    let baseWhere = retry
      ? `WHERE verification_tier = 'unverified' AND status = 'published' AND cognium_job_id IS NULL AND cognium_scanned_at IS NOT NULL`
      : `WHERE verification_tier = 'unverified' AND status = 'published' AND cognium_job_id IS NULL AND cognium_scanned_at IS NULL`;

    const extraFilters: string[] = [];
    const params: any[] = [limit];
    if (source) {
      params.push(source);
      extraFilters.push(`source = $${params.length}`);
    }
    if (content === 'instructions') extraFilters.push(`(skill_md IS NOT NULL AND length(skill_md) > 100)`);
    if (content === 'repo') extraFilters.push(`(source = 'github' OR repository_url IS NOT NULL)`);
    if (content === 'metadata') extraFilters.push(`skill_md IS NULL AND schema_json IS NULL AND source != 'github' AND repository_url IS NULL`);
    const whereClause = extraFilters.length > 0
      ? `${baseWhere} AND ${extraFilters.join(' AND ')}`
      : baseWhere;

    const result = await pool.query(
      `SELECT id, slug, version, name, description, source, status,
              execution_layer AS "executionLayer",
              skill_md AS "skillMd",
              r2_bundle_key AS "r2BundleKey",
              root_source AS "rootSource", skill_type AS "skillType",
              source_url AS "sourceUrl",
              repository_url AS "repositoryUrl",
              schema_json AS "schemaJson",
              capabilities_required AS "capabilitiesRequired",
              agent_summary AS "agentSummary",
              changelog::text AS "changelog"
       FROM skills
       ${whereClause}
       ORDER BY created_at ASC LIMIT $1`,
      params
    );

    // Queue mode: enqueue all skills to COGNIUM_QUEUE for async processing
    if (mode === 'queue') {
      let enqueued = 0;
      let queueErrors = 0;
      const errorSlugs: string[] = [];

      const firstError: string[] = [];

      // Use sendBatch for efficiency (CF Queues supports up to 100 per batch)
      const BATCH_SIZE = 25;
      for (let i = 0; i < result.rows.length; i += BATCH_SIZE) {
        const chunk = result.rows.slice(i, i + BATCH_SIZE);
        const messages = chunk.map((skill: any) => ({
          body: {
            skillId: skill.id,
            priority: 'normal' as const,
            timestamp: Date.now(),
          },
        }));
        try {
          await c.env.COGNIUM_QUEUE.sendBatch(messages);
          enqueued += chunk.length;
        } catch (err) {
          queueErrors += chunk.length;
          for (const skill of chunk) errorSlugs.push(skill.slug);
          if (firstError.length < 3) firstError.push((err as Error).message);
        }
        // Small delay between batches to avoid rate limits
        if (i + BATCH_SIZE < result.rows.length) {
          await new Promise(r => setTimeout(r, 200));
        }
      }

      const remaining = await pool.query(
        `SELECT count(*)::int AS cnt FROM skills WHERE verification_tier = 'unverified' AND status = 'published' AND cognium_scanned_at IS NULL`
      );

      return c.json({
        mode: 'queue',
        enqueued,
        queueErrors,
        remaining: remaining.rows[0].cnt,
        errorSlugs: errorSlugs.slice(0, 10),
        firstErrors: firstError,
        sources: result.rows.reduce((acc: Record<string, number>, r: any) => {
          acc[r.source] = (acc[r.source] ?? 0) + 1;
          return acc;
        }, {}),
      });
    }

    // Submit mode: submit to Circle-IR, store job_id in DB, cron Phase 1 polls results
    // No queue needed — cron checks cognium_job_id IS NOT NULL every minute
    if (mode === 'submit') {
      const cogniumUrl = c.env.COGNIUM_URL ?? 'https://circle.cognium.net';
      const apiKey = c.env.COGNIUM_API_KEY ?? '';
      const authHeaders = { 'Authorization': `Bearer ${apiKey}` };
      const { buildCircleIRRequest } = await import('./cognium/request-builder');

      let submitted = 0;
      let submitFailed = 0;
      let skipped = 0;
      const submitErrors: string[] = [];

      for (const skill of result.rows) {
        try {
          const submitRes = await fetch(`${cogniumUrl}/api/analyze/skill`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify(buildCircleIRRequest(skill)),
          });
          if (!submitRes.ok) { submitFailed++; submitErrors.push(`${skill.slug}: submit ${submitRes.status}`); continue; }
          const { job_id } = await submitRes.json() as { job_id: string };

          // Store job ID in DB — cron Phase 1 polls skills with cognium_job_id IS NOT NULL
          await pool.query(
            `UPDATE skills SET cognium_job_id = $1, cognium_job_submitted_at = NOW() WHERE id = $2`,
            [job_id, skill.id]
          );

          submitted++;
        } catch (err) {
          submitFailed++;
          submitErrors.push(`${skill.slug}: ${(err as Error).message}`);
        }
      }

      const remaining = await pool.query(
        `SELECT count(*)::int AS cnt FROM skills WHERE verification_tier = 'unverified' AND status = 'published' AND cognium_job_id IS NULL AND cognium_scanned_at IS NULL`
      );
      const inFlight = await pool.query(
        `SELECT count(*)::int AS cnt FROM skills WHERE cognium_job_id IS NOT NULL`
      );
      const scannedCount = await pool.query(
        `SELECT count(*)::int AS cnt FROM skills WHERE cognium_scanned_at IS NOT NULL`
      );

      return c.json({
        mode: 'submit',
        submitted,
        submitFailed,
        skipped,
        scanned: scannedCount.rows[0].cnt,
        inFlight: inFlight.rows[0].cnt,
        remaining: remaining.rows[0].cnt,
        errors: submitErrors.slice(0, 20),
        sources: result.rows.reduce((acc: Record<string, number>, r: any) => {
          acc[r.source] = (acc[r.source] ?? 0) + 1;
          return acc;
        }, {}),
      });
    }

    // Inline mode: direct scan + poll (original behavior, small batches only)
    const cogniumUrl = c.env.COGNIUM_URL ?? 'https://circle.cognium.net';
    const apiKey = c.env.COGNIUM_API_KEY ?? '';
    const authHeaders = { 'Authorization': `Bearer ${apiKey}` };

    const { buildCircleIRRequest } = await import('./cognium/request-builder');
    const { normalizeFindings } = await import('./cognium/finding-mapper');
    const { applyScanReport } = await import('./cognium/scan-report-handler');

    let scanned = 0;
    let failed = 0;
    const errors: string[] = [];
    const details: { slug: string; findings: number; trustScore?: number; verdict?: string }[] = [];

    for (const skill of result.rows) {
      try {
        const submitRes = await fetch(`${cogniumUrl}/api/analyze/skill`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify(buildCircleIRRequest(skill)),
        });
        if (!submitRes.ok) { failed++; errors.push(`${skill.slug}: submit ${submitRes.status}`); continue; }
        const { job_id } = await submitRes.json() as { job_id: string };

        let jobStatus: any;
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 4000));
          const statusRes = await fetch(`${cogniumUrl}/api/analyze/${job_id}/status`, {
            headers: authHeaders,
          });
          jobStatus = await statusRes.json();
          if (jobStatus.status === 'completed' || jobStatus.status === 'failed') break;
        }
        if (jobStatus.status !== 'completed') { failed++; errors.push(`${skill.slug}: ${jobStatus.status}`); continue; }

        const [findingsRes, skillResultRes, resultsRes] = await Promise.all([
          fetch(`${cogniumUrl}/api/analyze/${job_id}/findings`, { headers: authHeaders }),
          fetch(`${cogniumUrl}/api/analyze/${job_id}/skill-result`, { headers: authHeaders }),
          fetch(`${cogniumUrl}/api/analyze/${job_id}/results`, { headers: authHeaders }),
        ]);
        const { findings: raw } = await findingsRes.json() as { findings: any[] };
        const skillResult = skillResultRes.ok
          ? await skillResultRes.json() as any
          : null;

        if (resultsRes.ok) {
          const resultsBody = await resultsRes.json() as any;
          if (resultsBody.files_detail) jobStatus.files_detail = resultsBody.files_detail;
          if (resultsBody.bundle_metadata) jobStatus.bundle_metadata = resultsBody.bundle_metadata;
          if (resultsBody.metrics) jobStatus.metrics = resultsBody.metrics;
        }

        await applyScanReport(c.env, pool, skill, normalizeFindings(raw), jobStatus, skillResult);
        scanned++;
        details.push({
          slug: skill.slug,
          findings: raw.length,
          trustScore: skillResult?.trust_score,
          verdict: skillResult?.verdict,
        });
      } catch (err) {
        failed++;
        errors.push(`${skill.slug}: ${(err as Error).message}`);
      }
    }

    const remaining = await pool.query(
      `SELECT count(*)::int AS cnt FROM skills WHERE verification_tier = 'unverified' AND status = 'published' AND cognium_scanned_at IS NULL`
    );

    return c.json({ scanned, failed, remaining: remaining.rows[0].cnt, details, errors: errors.slice(0, 10) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Admin: Full ClawHub Sync (one-time backfill for missing skills)
// ──────────────────────────────────────────────────────────────────────────────

app.post('/v1/admin/sync-clawhub', async (c) => {
  try {
    const maxPages = Math.min(parseInt(c.req.query('pages') ?? '30', 10), 150);
    const cursorKey = 'sync:clawhub:backfill-cursor';
    const reset = c.req.query('reset') === 'true';

    if (reset) {
      await c.env.SEARCH_CACHE.delete(cursorKey);
      return c.json({ message: 'Backfill cursor reset. Next call starts from the beginning.' });
    }

    const savedCursor = await c.env.SEARCH_CACHE.get(cursorKey) ?? undefined;
    const { ClawHubSync } = await import("./sync/clawhub");
    const sync = new ClawHubSync(c.env);
    const r = await sync.run({ maxPages, startCursor: savedCursor });

    if (r.lastCursor) {
      await c.env.SEARCH_CACHE.put(cursorKey, r.lastCursor, { expirationTtl: 86400 });
    } else {
      await c.env.SEARCH_CACHE.delete(cursorKey);
    }

    const pool = createPool(c.env);
    const totalResult = await pool.query(
      `SELECT count(*)::int AS cnt FROM skills WHERE source = 'clawhub'`
    );

    return c.json({
      synced: r.synced,
      skipped: r.skipped,
      errors: r.errors,
      durationMs: r.durationMs,
      pagesProcessed: maxPages,
      complete: !r.lastCursor,
      totalClawHubSkills: totalResult.rows[0].cnt,
      message: r.lastCursor
        ? `Processed ${maxPages} pages. More pages available — call again to continue.`
        : 'All pages processed. Backfill complete.',
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Admin: sync Glama registry
app.post('/v1/admin/sync-glama', async (c) => {
  try {
    const maxPages = Math.min(parseInt(c.req.query('pages') ?? '50', 10), 500);
    const cursorKey = 'sync:glama:backfill-cursor';
    const reset = c.req.query('reset') === 'true';

    if (reset) {
      await c.env.SEARCH_CACHE.delete(cursorKey);
      return c.json({ message: 'Glama cursor reset. Next call starts from the beginning.' });
    }

    const savedCursor = await c.env.SEARCH_CACHE.get(cursorKey) ?? undefined;
    const { GlamaSync } = await import("./sync/glama");
    const sync = new GlamaSync(c.env);
    const r = await sync.run({ maxPages, startCursor: savedCursor });

    if (r.lastCursor) {
      await c.env.SEARCH_CACHE.put(cursorKey, r.lastCursor, { expirationTtl: 86400 });
    } else {
      await c.env.SEARCH_CACHE.delete(cursorKey);
    }

    const pool = createPool(c.env);
    const totalResult = await pool.query(
      `SELECT count(*)::int AS cnt FROM skills WHERE source = 'glama'`
    );

    return c.json({
      synced: r.synced, skipped: r.skipped, errors: r.errors,
      durationMs: r.durationMs, pagesProcessed: maxPages,
      complete: !r.lastCursor, totalSkills: totalResult.rows[0].cnt,
      message: r.lastCursor
        ? `Processed ${maxPages} pages. More pages available — call again to continue.`
        : 'All pages processed. Backfill complete.',
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Admin: sync Smithery registry
app.post('/v1/admin/sync-smithery', async (c) => {
  try {
    const maxPages = Math.min(parseInt(c.req.query('pages') ?? '30', 10), 100);
    const cursorKey = 'sync:smithery:backfill-cursor';
    const reset = c.req.query('reset') === 'true';

    if (reset) {
      await c.env.SEARCH_CACHE.delete(cursorKey);
      return c.json({ message: 'Smithery cursor reset. Next call starts from the beginning.' });
    }

    const savedCursor = await c.env.SEARCH_CACHE.get(cursorKey) ?? undefined;
    const { SmitherySync } = await import("./sync/smithery");
    const sync = new SmitherySync(c.env);
    const r = await sync.run({ maxPages, startCursor: savedCursor });

    if (r.lastCursor) {
      await c.env.SEARCH_CACHE.put(cursorKey, r.lastCursor, { expirationTtl: 86400 });
    } else {
      await c.env.SEARCH_CACHE.delete(cursorKey);
    }

    const pool = createPool(c.env);
    const totalResult = await pool.query(
      `SELECT count(*)::int AS cnt FROM skills WHERE source = 'smithery'`
    );

    return c.json({
      synced: r.synced, skipped: r.skipped, errors: r.errors,
      durationMs: r.durationMs, pagesProcessed: maxPages,
      complete: !r.lastCursor, totalSkills: totalResult.rows[0].cnt,
      message: r.lastCursor
        ? `Processed ${maxPages} pages. More pages available — call again to continue.`
        : 'All pages processed. Backfill complete.',
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Admin: sync PulseMCP directory (manual backfill with cursor persistence)
app.post('/v1/admin/sync-pulsemcp', async (c) => {
  try {
    const maxPages = Math.min(parseInt(c.req.query('pages') ?? '30', 10), 100);
    const cursorKey = 'sync:pulsemcp:backfill-cursor';
    const reset = c.req.query('reset') === 'true';

    if (reset) {
      await c.env.SEARCH_CACHE.delete(cursorKey);
      return c.json({ message: 'PulseMCP cursor reset. Next call starts from the beginning.' });
    }

    const savedCursor = await c.env.SEARCH_CACHE.get(cursorKey) ?? undefined;
    const { PulseMCPSync } = await import("./sync/pulsemcp");
    const sync = new PulseMCPSync(c.env);
    const r = await sync.run({ maxPages, startCursor: savedCursor });

    if (r.lastCursor) {
      await c.env.SEARCH_CACHE.put(cursorKey, r.lastCursor, { expirationTtl: 86400 });
    } else {
      await c.env.SEARCH_CACHE.delete(cursorKey);
    }

    const pool = createPool(c.env);
    const totalResult = await pool.query(
      `SELECT count(*)::int AS cnt FROM skills WHERE source = 'pulsemcp'`
    );

    return c.json({
      synced: r.synced, skipped: r.skipped, errors: r.errors,
      durationMs: r.durationMs, pagesProcessed: maxPages,
      complete: !r.lastCursor, totalSkills: totalResult.rows[0].cnt,
      message: r.lastCursor
        ? `Processed ${maxPages} pages. More pages available — call again to continue.`
        : 'All pages processed. Backfill complete.',
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Admin: sync OpenClaw skills repo (full repo, paginated by offset)
app.post('/v1/admin/sync-openclaw', async (c) => {
  try {
    const maxPages = Math.min(parseInt(c.req.query('pages') ?? '30', 10), 500);
    const cursorKey = 'sync:openclaw:backfill-cursor';
    const reset = c.req.query('reset') === 'true';

    if (reset) {
      await c.env.SEARCH_CACHE.delete(cursorKey);
      return c.json({ message: 'OpenClaw cursor reset. Next call starts from the beginning.' });
    }

    const savedCursor = await c.env.SEARCH_CACHE.get(cursorKey) ?? undefined;
    const { OpenClawSync } = await import("./sync/openclaw");
    const sync = new OpenClawSync(c.env);
    const r = await sync.run({ maxPages, startCursor: savedCursor });

    if (r.lastCursor) {
      await c.env.SEARCH_CACHE.put(cursorKey, r.lastCursor, { expirationTtl: 86400 });
    } else {
      await c.env.SEARCH_CACHE.delete(cursorKey);
    }

    const pool = createPool(c.env);
    const totalResult = await pool.query(
      `SELECT count(*)::int AS cnt FROM skills WHERE source = 'openclaw'`
    );

    return c.json({
      synced: r.synced, skipped: r.skipped, errors: r.errors,
      durationMs: r.durationMs, pagesProcessed: maxPages,
      complete: !r.lastCursor, totalSkills: totalResult.rows[0].cnt,
      message: r.lastCursor
        ? `Processed ${maxPages} pages. More pages available — call again to continue.`
        : 'All pages processed. Backfill complete.',
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Admin: regenerate agent summaries (force LLM re-generation + re-embed)
app.post('/v1/admin/regenerate-summaries', async (c) => {
  try {
    const source = c.req.query('source');
    const ids = c.req.query('ids');
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);
    const dryRun = c.req.query('dry_run') === 'true';

    if (!source && !ids) {
      return c.json({ error: 'Provide ?source= or ?ids= parameter' }, 400);
    }

    const pool = createPool(c.env);
    const embedPipeline = new EmbedPipeline(c.env);
    const provider = new PgVectorProvider(c.env);
    const useMultiVector = c.env.MULTI_VECTOR_ENABLED === 'true';

    // Build query based on filters
    const params: unknown[] = [];
    let paramIdx = 1;
    const conditions: string[] = ["s.status = 'published'"];

    if (ids) {
      const idList = ids.split(',').map((id) => id.trim()).filter(Boolean);
      conditions.push(`s.id = ANY($${paramIdx++})`);
      params.push(idList);
    }
    if (source) {
      conditions.push(`s.source = $${paramIdx++}`);
      params.push(source);
    }

    params.push(limit);
    const result = await pool.query(
      `SELECT s.id, s.name, s.slug, s.version, s.source, s.description,
              s.agent_summary, s.tags, s.category, s.schema_json,
              s.trust_score, s.capabilities_required, s.execution_layer,
              s.tenant_id, s.skill_md
       FROM skills s
       WHERE ${conditions.join(' AND ')}
       LIMIT $${paramIdx}`,
      params
    );

    const results: Array<{
      id: string;
      name: string;
      oldSummary: string | null;
      newSummary: string;
    }> = [];
    let regenerated = 0;
    let failed = 0;

    for (const row of result.rows) {
      try {
        const skill: SkillInput = {
          id: row.id, name: row.name, slug: row.slug,
          version: row.version, source: row.source,
          description: row.description ?? '',
          tags: row.tags ?? [], category: row.category,
          schemaJson: row.schema_json,
          trustScore: parseFloat(row.trust_score ?? '0.5'),
          capabilitiesRequired: row.capabilities_required ?? [],
          executionLayer: row.execution_layer,
          tenantId: row.tenant_id ?? 'default',
        };

        // Force LLM regeneration (pass no agentSummary so it generates fresh)
        const newSummary = await (await import('./ingestion/agent-summary')).generateAgentSummary(c.env, skill);

        if (dryRun) {
          results.push({
            id: row.id, name: row.name,
            oldSummary: row.agent_summary, newSummary,
          });
          regenerated++;
          continue;
        }

        // Update agent_summary in DB
        await pool.query(
          'UPDATE skills SET agent_summary = $1, updated_at = NOW() WHERE id = $2',
          [newSummary, row.id]
        );

        // Delete old embeddings
        await pool.query('DELETE FROM skill_embeddings WHERE skill_id = $1', [row.id]);

        // Re-embed with the new summary
        skill.agentSummary = newSummary;
        const embeddings = useMultiVector
          ? await embedPipeline.processSkillMultiVector(skill)
          : await embedPipeline.processSkill(skill);
        await provider.index(skill, embeddings);

        results.push({
          id: row.id, name: row.name,
          oldSummary: row.agent_summary, newSummary,
        });
        regenerated++;
      } catch (e: any) {
        failed++;
        results.push({
          id: row.id, name: row.name,
          oldSummary: row.agent_summary,
          newSummary: `ERROR: ${e.message}`,
        });
      }
    }

    return c.json({
      regenerated, failed, dryRun,
      total: result.rows.length,
      results: results.slice(0, 20), // Cap output to avoid huge responses
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 404 Handler
// ──────────────────────────────────────────────────────────────────────────────

app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// ──────────────────────────────────────────────────────────────────────────────
// Export (fetch + scheduled + queue handlers)
// ──────────────────────────────────────────────────────────────────────────────

export default {
  fetch: app.fetch,

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const minute = new Date(event.scheduledTime).getMinutes();

    // Hourly: materialized view refresh (minute 0)
    if (minute === 0) {
      const { qualityTracker } = initComponents(env);
      ctx.waitUntil(
        qualityTracker
          .refreshSummary()
          .then(() => console.log('[CRON] Materialized view refreshed'))
          .catch((e: Error) =>
            console.error('[CRON] Refresh failed:', e.message)
          )
      );

      // Refresh social materialized views (v4)
      ctx.waitUntil(
        (async () => {
          const pool = createPool(env);
          try {
            await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY skill_cooccurrence');
            await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_human');
            await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_agent');
            console.log('[CRON] Social materialized views refreshed');
          } catch (e: any) {
            console.error('[CRON] Social view refresh failed:', e.message);
          }
        })()
      );
    }

    // Daily at midnight: reset weekly_agent_invocation_count (v4)
    const hour = new Date(event.scheduledTime).getHours();
    if (hour === 0 && minute === 0) {
      ctx.waitUntil(
        (async () => {
          const pool = createPool(env);
          try {
            await pool.query(
              'UPDATE skills SET weekly_agent_invocation_count = 0 WHERE weekly_agent_invocation_count > 0'
            );
            console.log('[CRON] Weekly invocation counts reset');
          } catch (e: any) {
            console.error('[CRON] Weekly reset failed:', e.message);
          }
        })()
      );
    }

    // Every 5 minutes: MCP Registry sync
    if (minute % 5 === 0 && env.SYNC_MCP_ENABLED !== 'false') {
      ctx.waitUntil(
        import('./sync/mcp-registry').then(({ McpRegistrySync }) =>
          new McpRegistrySync(env).run()
        )
          .then((r) =>
            console.log(
              `[CRON] MCP sync: synced=${r.synced} skipped=${r.skipped} errors=${r.errors}`
            )
          )
          .catch((e: Error) =>
            console.error('[CRON] MCP sync failed:', e.message)
          )
      );
    }

    // Every 10 minutes: ClawHub sync (paginated — 20 pages per invocation with persistent cursor)
    if (minute % 10 === 0 && env.SYNC_CLAWHUB_ENABLED !== 'false') {
      ctx.waitUntil(
        (async () => {
          const cursorKey = 'sync:clawhub:cursor';
          const savedCursor = await env.SEARCH_CACHE.get(cursorKey) ?? undefined;
          const { ClawHubSync } = await import("./sync/clawhub");
          const sync = new ClawHubSync(env);
          const r = await sync.run({ maxPages: 20, startCursor: savedCursor });

          if (r.lastCursor) {
            // More pages — save cursor for next invocation (TTL 24h as safety net)
            await env.SEARCH_CACHE.put(cursorKey, r.lastCursor, { expirationTtl: 86400 });
          } else {
            // Reached the end — delete cursor so next run starts fresh
            await env.SEARCH_CACHE.delete(cursorKey);
          }

          console.log(
            `[CRON] ClawHub sync: synced=${r.synced} skipped=${r.skipped} errors=${r.errors}` +
            (r.lastCursor ? ' (more pages pending)' : ' (complete)')
          );
        })().catch((e: Error) =>
          console.error('[CRON] ClawHub sync failed:', e.message)
        )
      );
    }

    // Every 5 minutes: directly embed skills missing embeddings (bypasses queue)
    if (minute % 5 === 0) {
      ctx.waitUntil(
        (async () => {
          const pool = createPool(env);
          const embedPipeline = new EmbedPipeline(env);
          const provider = new PgVectorProvider(env);
          const useMultiVector = env.MULTI_VECTOR_ENABLED === 'true';
          try {
            const result = await pool.query(
              `SELECT s.id, s.name, s.slug, s.version, s.source, s.description,
                      s.agent_summary, s.tags, s.category, s.schema_json,
                      s.trust_score, s.capabilities_required, s.execution_layer, s.tenant_id
               FROM skills s
               LEFT JOIN skill_embeddings se ON s.id = se.skill_id
               WHERE se.skill_id IS NULL
               AND s.content_safety_passed = true
               LIMIT 100`
            );
            let embedded = 0;
            for (const row of result.rows) {
              try {
                const skill: SkillInput = {
                  id: row.id, name: row.name, slug: row.slug,
                  version: row.version, source: row.source,
                  description: row.description ?? '',
                  agentSummary: row.agent_summary,
                  tags: row.tags ?? [], category: row.category,
                  schemaJson: row.schema_json,
                  trustScore: parseFloat(row.trust_score ?? '0.5'),
                  capabilitiesRequired: row.capabilities_required ?? [],
                  executionLayer: row.execution_layer,
                  tenantId: row.tenant_id ?? 'default',
                };
                const embeddings = useMultiVector
                  ? await embedPipeline.processSkillMultiVector(skill)
                  : await embedPipeline.processSkill(skill);
                skill.agentSummary = embeddings.agentSummary.text;
                await provider.index(skill, embeddings);
                embedded++;
              } catch (e: any) {
                console.error(`[BACKFILL] Error embedding ${row.id}:`, e.message);
              }
            }
            if (embedded > 0) {
              console.log(`[CRON] Backfill: embedded ${embedded} skills directly`);
            }
          } catch (e: any) {
            console.error('[CRON] Backfill failed:', e.message);
          }
        })()
      );
    }

    // Every minute: two-phase Cognium scan backfill (bypasses queues)
    // Phase 1: Poll up to 50 pending jobs (submitted via backfill or previous cycles)
    // Phase 2: Submit new skills for scanning (every 5 min via minute%5 guard)
    ctx.waitUntil(
      (async () => {
        // Hard kill switch — when COGNIUM_ENABLED=false, skip all cron-driven cognium work.
        if (env.COGNIUM_ENABLED === 'false') return;
        const pool = createPool(env);
        const cogniumUrl = env.COGNIUM_URL ?? 'https://circle.cognium.net';
        const apiKey = env.COGNIUM_API_KEY ?? '';
        if (!apiKey) return;
        const authHeaders = { 'Authorization': `Bearer ${apiKey}` };

        try {
          const { buildCircleIRRequest } = await import('./cognium/request-builder');
          const { normalizeFindings } = await import('./cognium/finding-mapper');
          const { applyScanReport, markScanFailed } = await import('./cognium/scan-report-handler');

          // ── Phase 1: Poll pending jobs ────────────────────────────────────
          // Check skills with cognium_job_id set (submitted via backfill or prior cron cycles)
          const pendingJobs = await pool.query(
            `SELECT id, slug, version, name, description, source, status,
                    execution_layer AS "executionLayer",
                    skill_md AS "skillMd",
                    r2_bundle_key AS "r2BundleKey",
                    root_source AS "rootSource", skill_type AS "skillType",
                    source_url AS "sourceUrl",
                    repository_url AS "repositoryUrl",
                    schema_json AS "schemaJson",
                    capabilities_required AS "capabilitiesRequired",
                    cognium_job_id AS "cogniumJobId",
                    cognium_job_submitted_at AS "cogniumJobSubmittedAt",
                    agent_summary AS "agentSummary",
                    changelog::text AS "changelog"
             FROM skills
             WHERE cognium_job_id IS NOT NULL
             ORDER BY cognium_job_submitted_at ASC
             LIMIT 10`
          );

          let polled = 0;

          // Batch status checks (6 concurrent to respect CF Workers connection limit)
          const STATUS_BATCH = 6;
          const statusChecks: { skill: any; status: string; jobStatus?: any }[] = [];
          for (let i = 0; i < pendingJobs.rows.length; i += STATUS_BATCH) {
            const batch = pendingJobs.rows.slice(i, i + STATUS_BATCH);
            const results = await Promise.all(
              batch.map(async (skill: any) => {
                try {
                  const res = await fetch(`${cogniumUrl}/api/analyze/${skill.cogniumJobId}/status`, {
                    headers: authHeaders,
                  });
                  if (!res.ok) return { skill, status: 'error' };
                  const body = await res.json() as any;
                  return { skill, status: body.status as string, jobStatus: body };
                } catch (e: any) {
                  return { skill, status: 'error' };
                }
              })
            );
            statusChecks.push(...results);
          }

          // Process completed jobs (fetch results in batches of 3, each uses 3 connections)
          const completed = statusChecks.filter(c => c.status === 'completed');
          const RESULT_BATCH = 3;
          for (let i = 0; i < completed.length; i += RESULT_BATCH) {
            const batch = completed.slice(i, i + RESULT_BATCH);
            await Promise.all(batch.map(async ({ skill, jobStatus }) => {
              try {
                const [findingsRes, skillResultRes, resultsRes] = await Promise.all([
                  fetch(`${cogniumUrl}/api/analyze/${skill.cogniumJobId}/findings`, { headers: authHeaders }),
                  fetch(`${cogniumUrl}/api/analyze/${skill.cogniumJobId}/skill-result`, { headers: authHeaders }),
                  fetch(`${cogniumUrl}/api/analyze/${skill.cogniumJobId}/results`, { headers: authHeaders }),
                ]);
                const { findings: raw } = await findingsRes.json() as { findings: any[] };
                const skillResult = skillResultRes.ok ? await skillResultRes.json() as any : null;

                if (resultsRes.ok) {
                  const resultsBody = await resultsRes.json() as any;
                  if (resultsBody.files_detail) jobStatus.files_detail = resultsBody.files_detail;
                  if (resultsBody.bundle_metadata) jobStatus.bundle_metadata = resultsBody.bundle_metadata;
                  if (resultsBody.metrics) jobStatus.metrics = resultsBody.metrics;
                }

                await applyScanReport(env, pool, skill, normalizeFindings(raw), jobStatus, skillResult);
                await pool.query(
                  `UPDATE skills SET cognium_job_id = NULL, cognium_job_submitted_at = NULL WHERE id = $1`,
                  [skill.id]
                );
                polled++;
                console.log(`[CRON-POLL] Applied results for ${skill.slug} (${raw.length} findings)`);
              } catch (e: any) {
                console.error(`[CRON-POLL] Error fetching results for ${skill.slug}:`, e.message);
              }
            }));
          }

          // Process failed/cancelled jobs
          for (const { skill, status } of statusChecks.filter(c => c.status === 'failed' || c.status === 'cancelled')) {
            await markScanFailed(pool, skill.id, `Circle-IR job ${status}`);
            await pool.query(
              `UPDATE skills SET cognium_job_id = NULL, cognium_job_submitted_at = NULL WHERE id = $1`,
              [skill.id]
            );
            console.warn(`[CRON-POLL] Job ${status} for ${skill.slug}`);
          }

          // Handle stale/error status checks (60 min timeout for GitHub repos)
          for (const check of statusChecks.filter(c => c.status === 'error' || (c.status !== 'completed' && c.status !== 'failed' && c.status !== 'cancelled'))) {
            const ageMs = Date.now() - new Date(check.skill.cogniumJobSubmittedAt).getTime();
            if (ageMs > 3600_000) {
              await markScanFailed(pool, check.skill.id, `Poll timeout after ${Math.round(ageMs / 60000)}min`);
              await pool.query(
                `UPDATE skills SET cognium_job_id = NULL, cognium_job_submitted_at = NULL WHERE id = $1`,
                [check.skill.id]
              );
              console.warn(`[CRON-POLL] Timeout for ${check.skill.slug} after ${Math.round(ageMs / 60000)}min`);
            }
          }

          if (polled > 0) {
            console.log(`[CRON] Poll phase: applied ${polled} scan results`);
          }

          // ── Phase 2: Submit new skills (every 2 min) ──────────────────────
          // Fast path: skills without repo URL (Mode B inline, ~2s each)
          // Repo path: GitHub source OR has repository_url (Mode A, deferred)
          if (minute % 2 !== 0) {
            // Skip submit phase on odd-minute cycles (only poll above)
          } else {

          // ── Backpressure: skip submissions if too many jobs in-flight ──
          const maxInflight = parseInt(env.COGNIUM_MAX_INFLIGHT ?? '20', 10);
          const inflightCount = await pool.query(
            `SELECT count(*)::int AS cnt FROM skills WHERE cognium_job_id IS NOT NULL`
          );
          if (inflightCount.rows[0].cnt >= maxInflight) {
            console.log(`[CRON] Phase 2 skipped: ${inflightCount.rows[0].cnt} jobs in-flight (max ${maxInflight})`);
          } else {

          const fastBatchSize = parseInt(env.COGNIUM_FAST_BATCH_SIZE ?? '10', 10);
          const repoBatchSize = parseInt(env.COGNIUM_REPO_BATCH_SIZE ?? '3', 10);

          const fastSkills = await pool.query(
            `SELECT id, slug, version, name, description, source, status,
                    execution_layer AS "executionLayer",
                    skill_md AS "skillMd",
                    r2_bundle_key AS "r2BundleKey",
                    root_source AS "rootSource", skill_type AS "skillType",
                    source_url AS "sourceUrl",
                    repository_url AS "repositoryUrl",
                    schema_json AS "schemaJson",
                    capabilities_required AS "capabilitiesRequired",
                    agent_summary AS "agentSummary",
                    changelog::text AS "changelog"
             FROM skills
             WHERE cognium_scanned_at IS NULL AND status = 'published'
               AND cognium_job_id IS NULL
               AND source != 'github' AND repository_url IS NULL
             ORDER BY created_at ASC
             LIMIT $1`,
            [fastBatchSize]
          );

          const repoSkills = await pool.query(
            `SELECT id, slug, version, name, description, source, status,
                    execution_layer AS "executionLayer",
                    skill_md AS "skillMd",
                    r2_bundle_key AS "r2BundleKey",
                    root_source AS "rootSource", skill_type AS "skillType",
                    source_url AS "sourceUrl",
                    repository_url AS "repositoryUrl",
                    schema_json AS "schemaJson",
                    capabilities_required AS "capabilitiesRequired",
                    agent_summary AS "agentSummary",
                    changelog::text AS "changelog"
             FROM skills
             WHERE cognium_scanned_at IS NULL AND status = 'published'
               AND cognium_job_id IS NULL
               AND (source = 'github' OR repository_url IS NOT NULL)
             ORDER BY created_at ASC
             LIMIT $1`,
            [repoBatchSize]
          );

          let submitted = 0;

          // Fast path: submit all non-GitHub skills in parallel, then poll
          const FAST_CONCURRENCY = 5;
          for (let i = 0; i < fastSkills.rows.length; i += FAST_CONCURRENCY) {
            const batch = fastSkills.rows.slice(i, i + FAST_CONCURRENCY);
            const results = await Promise.allSettled(batch.map(async (skill: any) => {
              const submitRes = await fetch(`${cogniumUrl}/api/analyze/skill`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify(buildCircleIRRequest(skill)),
              });
              if (!submitRes.ok) {
                console.error(`[CRON-SUBMIT] Submit failed for ${skill.slug}: ${submitRes.status}`);
                return null;
              }
              const { job_id } = await submitRes.json() as { job_id: string };

              // Quick inline poll (3 attempts × 2s)
              let jobStatus: any;
              for (let p = 0; p < 3; p++) {
                await new Promise(r => setTimeout(r, 2000));
                const statusRes = await fetch(`${cogniumUrl}/api/analyze/${job_id}/status`, {
                  headers: authHeaders,
                });
                jobStatus = await statusRes.json();
                if (jobStatus.status === 'completed' || jobStatus.status === 'failed') break;
              }

              if (jobStatus?.status === 'completed') {
                const [findingsRes, skillResultRes, resultsRes] = await Promise.all([
                  fetch(`${cogniumUrl}/api/analyze/${job_id}/findings`, { headers: authHeaders }),
                  fetch(`${cogniumUrl}/api/analyze/${job_id}/skill-result`, { headers: authHeaders }),
                  fetch(`${cogniumUrl}/api/analyze/${job_id}/results`, { headers: authHeaders }),
                ]);
                const { findings: raw } = await findingsRes.json() as { findings: any[] };
                const skillResult = skillResultRes.ok ? await skillResultRes.json() as any : null;

                if (resultsRes.ok) {
                  const resultsBody = await resultsRes.json() as any;
                  if (resultsBody.files_detail) jobStatus.files_detail = resultsBody.files_detail;
                  if (resultsBody.bundle_metadata) jobStatus.bundle_metadata = resultsBody.bundle_metadata;
                  if (resultsBody.metrics) jobStatus.metrics = resultsBody.metrics;
                }

                await applyScanReport(env, pool, skill, normalizeFindings(raw), jobStatus, skillResult);
                return 'completed';
              } else {
                // Defer for later poll
                await pool.query(
                  `UPDATE skills SET cognium_job_id = $1, cognium_job_submitted_at = NOW() WHERE id = $2`,
                  [job_id, skill.id]
                );
                console.log(`[CRON-SUBMIT] ${skill.slug} slow, deferred → job ${job_id}`);
                return 'deferred';
              }
            }));
            for (const r of results) {
              if (r.status === 'fulfilled' && r.value) submitted++;
            }
          }

          // Repo path: submit in parallel (all deferred — repo scans take >10s)
          const REPO_CONCURRENCY = 5;
          for (let i = 0; i < repoSkills.rows.length; i += REPO_CONCURRENCY) {
            const batch = repoSkills.rows.slice(i, i + REPO_CONCURRENCY);
            const results = await Promise.allSettled(batch.map(async (skill: any) => {
              const submitRes = await fetch(`${cogniumUrl}/api/analyze/skill`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify(buildCircleIRRequest(skill)),
              });
              if (!submitRes.ok) {
                console.error(`[CRON-SUBMIT] Submit failed for ${skill.slug}: ${submitRes.status}`);
                return null;
              }
              const { job_id } = await submitRes.json() as { job_id: string };

              await pool.query(
                `UPDATE skills SET cognium_job_id = $1, cognium_job_submitted_at = NOW() WHERE id = $2`,
                [job_id, skill.id]
              );
              console.log(`[CRON-SUBMIT] Repo ${skill.slug} → job ${job_id} (deferred poll)`);
              return 'deferred';
            }));
            for (const r of results) {
              if (r.status === 'fulfilled' && r.value) submitted++;
            }
          }

          if (submitted > 0) {
            console.log(`[CRON] Submit phase: submitted ${submitted} skills (${fastSkills.rows.length} fast + ${repoSkills.rows.length} repo)`);
          }

          } // end backpressure check
          } // end Phase 2 (minute % 2 guard)

          // ── Phase 3: Garbage collect orphaned job state ──────────────────
          // Clean up skills stuck with cognium_job_id for >2h (KV TTL is 1h,
          // so these are already expired in KV but orphaned in DB)
          const orphaned = await pool.query(
            `UPDATE skills
             SET cognium_job_id = NULL, cognium_job_submitted_at = NULL
             WHERE cognium_job_id IS NOT NULL
               AND cognium_job_submitted_at < NOW() - INTERVAL '2 hours'
             RETURNING id, slug`
          );
          if (orphaned.rows.length > 0) {
            console.log(`[CRON] GC: cleared ${orphaned.rows.length} orphaned job(s): ${orphaned.rows.map((r: any) => r.slug).join(', ')}`);
          }
        } catch (e: any) {
          console.error('[CRON] Scan backfill failed:', e.message);
        }
      })()
    );

    // Every 15 minutes: GitHub sync
    if (minute % 15 === 0 && env.SYNC_GITHUB_ENABLED !== 'false') {
      ctx.waitUntil(
        import('./sync/github').then(({ GitHubSync }) =>
          new GitHubSync(env).run()
        )
          .then((r) =>
            console.log(
              `[CRON] GitHub sync: synced=${r.synced} skipped=${r.skipped} errors=${r.errors}`
            )
          )
          .catch((e: Error) =>
            console.error('[CRON] GitHub sync failed:', e.message)
          )
      );
    }

    // Every 10 minutes: Glama sync (paginated — 30 pages per invocation with persistent cursor)
    if (minute % 10 === 0 && env.SYNC_GLAMA_ENABLED !== 'false') {
      ctx.waitUntil(
        (async () => {
          const cursorKey = 'sync:glama:cursor';
          const savedCursor = await env.SEARCH_CACHE.get(cursorKey) ?? undefined;
          const { GlamaSync } = await import("./sync/glama");
          const sync = new GlamaSync(env);
          const r = await sync.run({ maxPages: 30, startCursor: savedCursor });

          if (r.lastCursor) {
            await env.SEARCH_CACHE.put(cursorKey, r.lastCursor, { expirationTtl: 86400 });
          } else {
            await env.SEARCH_CACHE.delete(cursorKey);
          }

          console.log(
            `[CRON] Glama sync: synced=${r.synced} skipped=${r.skipped} errors=${r.errors}` +
            (r.lastCursor ? ' (more pages pending)' : ' (complete)')
          );
        })().catch((e: Error) =>
          console.error('[CRON] Glama sync failed:', e.message)
        )
      );
    }

    // Every 15 minutes: Smithery sync
    if (minute % 15 === 0 && env.SYNC_SMITHERY_ENABLED !== 'false') {
      ctx.waitUntil(
        import('./sync/smithery').then(({ SmitherySync }) =>
          new SmitherySync(env).run()
        )
          .then((r) =>
            console.log(
              `[CRON] Smithery sync: synced=${r.synced} skipped=${r.skipped} errors=${r.errors}`
            )
          )
          .catch((e: Error) =>
            console.error('[CRON] Smithery sync failed:', e.message)
          )
      );
    }

    // Every 15 minutes: PulseMCP sync (disabled by default — Cloudflare-blocked)
    if (minute % 15 === 0 && env.SYNC_PULSEMCP_ENABLED === 'true') {
      ctx.waitUntil(
        import('./sync/pulsemcp').then(({ PulseMCPSync }) =>
          new PulseMCPSync(env).run()
        )
          .then((r) =>
            console.log(
              `[CRON] PulseMCP sync: synced=${r.synced} skipped=${r.skipped} errors=${r.errors}`
            )
          )
          .catch((e: Error) =>
            console.error('[CRON] PulseMCP sync failed:', e.message)
          )
      );
    }

    // Every 10 minutes (offset by 2): OpenClaw full repo sync (paginated — 50 skills per page)
    if (minute % 10 === 2 && env.SYNC_OPENCLAW_ENABLED !== 'false') {
      ctx.waitUntil(
        (async () => {
          const cursorKey = 'sync:openclaw:cursor';
          const savedCursor = await env.SEARCH_CACHE.get(cursorKey) ?? undefined;
          const { OpenClawSync } = await import("./sync/openclaw");
          const sync = new OpenClawSync(env);
          const r = await sync.run({ maxPages: 20, startCursor: savedCursor });

          if (r.lastCursor) {
            await env.SEARCH_CACHE.put(cursorKey, r.lastCursor, { expirationTtl: 86400 });
          } else {
            await env.SEARCH_CACHE.delete(cursorKey);
          }

          console.log(
            `[CRON] OpenClaw sync: synced=${r.synced} skipped=${r.skipped} errors=${r.errors}` +
            (r.lastCursor ? ' (more pages pending)' : ' (complete)')
          );
        })().catch((e: Error) =>
          console.error('[CRON] OpenClaw sync failed:', e.message)
        )
      );
    }
  },

  async queue(
    batch: MessageBatch,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    switch (batch.queue) {
      case 'runics-embed': {
        const { handleEmbedQueue } = await import('./queues/embed-consumer');
        await handleEmbedQueue(batch as MessageBatch<EmbedQueueMessage>, env);
        break;
      }
      case 'runics-cognium':
      case 'runics-cognium-v2': {
        const { handleCogniumSubmitQueue } = await import('./cognium/submit-consumer');
        await handleCogniumSubmitQueue(batch as MessageBatch<CogniumSubmitMessage>, env);
        break;
      }
      case 'runics-cognium-poll':
      case 'runics-cognium-poll-v2': {
        const { handleCogniumPollQueue } = await import('./cognium/poll-consumer');
        await handleCogniumPollQueue(batch as MessageBatch<CogniumPollMessage>, env);
        break;
      }
      case 'runics-analysis-submit': {
        const { handleAnalysisSubmitQueue } = await import('./cognium/analysis-submit-consumer');
        await handleAnalysisSubmitQueue(batch as MessageBatch<AnalysisSubmitMessage>, env);
        break;
      }
      case 'runics-analysis-poll': {
        const { handleAnalysisPollQueue } = await import('./cognium/analysis-poll-consumer');
        await handleAnalysisPollQueue(batch as MessageBatch<AnalysisPollMessage>, env);
        break;
      }
      default:
        console.error(`[QUEUE] Unknown queue: ${batch.queue}`);
        break;
    }
  },
};
