// ══════════════════════════════════════════════════════════════════════════════
// Runics Search — Cloudflare Workers Entry Point
// ══════════════════════════════════════════════════════════════════════════════

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Pool } from '@neondatabase/serverless';
import { PgVectorProvider } from './providers/pgvector-provider';
import { EmbedPipeline } from './ingestion/embed-pipeline';
import { SearchCache } from './cache/kv-cache';
import { SearchLogger } from './monitoring/search-logger';
import { QualityTracker } from './monitoring/quality-tracker';
import { PerfMonitor } from './monitoring/perf-monitor';
import { ConfidenceGate } from './intelligence/confidence-gate';
import { rateLimiter } from './middleware/rate-limiter';
import { adminAuth } from './middleware/admin-auth';
import { publishRoutes } from './publish/handler';
import { McpRegistrySync } from './sync/mcp-registry';
import { ClawHubSync } from './sync/clawhub';
import { GitHubSync } from './sync/github';
import { handleEmbedQueue } from './queues/embed-consumer';
import { handleCogniumSubmitQueue } from './cognium/submit-consumer';
import { handleCogniumPollQueue } from './cognium/poll-consumer';
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
  InvocationBatch,
  LeaderboardFilters,
} from './types';

// ──────────────────────────────────────────────────────────────────────────────
// App Initialization
// ──────────────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

// Enable CORS for all routes
app.use('*', cors());

// ──────────────────────────────────────────────────────────────────────────────
// Component Initialization Helper
// ──────────────────────────────────────────────────────────────────────────────

function initComponents(env: Env) {
  // Connect directly to Neon using @neondatabase/serverless (bypasses Hyperdrive)
  const connectionString = env.NEON_CONNECTION_STRING;
  const pool = new Pool({ connectionString });

  const provider = new PgVectorProvider(connectionString, env);
  const embedPipeline = new EmbedPipeline(env);
  const cache = new SearchCache(
    env.SEARCH_CACHE,
    parseInt(env.CACHE_TTL_SECONDS || '60')
  );
  const logger = new SearchLogger(pool);
  const qualityTracker = new QualityTracker(pool);

  // Embed function for the intelligence layer
  const embedFn = (text: string) => embedPipeline['embed'](text);

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
app.post('/v1/skills/:skillId/index', async (c) => {
  try {
    const skillId = c.req.param('skillId');
    const skill = await c.req.json<SkillInput>();

    console.log(`[INDEX] Starting indexing for skill: ${skillId}`);

    // Validate skill ID matches
    if (skill.id !== skillId) {
      return c.json({ error: 'Skill ID mismatch' }, 400);
    }

    const { provider, embedPipeline } = initComponents(c.env);

    // ── 1. Content Safety Check ──
    console.log(`[INDEX] Step 1: Content safety check`);
    const isSafe = await embedPipeline.checkContentSafety(skill);

    if (!isSafe) {
      console.log(`[INDEX] Content safety check failed for ${skillId}`);
      return c.json(
        {
          success: false,
          error: 'Content safety check failed',
          skillId,
          contentSafe: false,
        },
        400
      );
    }

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
 * Remove skill from search index
 */
app.delete('/v1/skills/:skillId', async (c) => {
  try {
    const skillId = c.req.param('skillId');
    const { provider } = initComponents(c.env);

    await provider.delete(skillId);

    return c.json({
      success: true,
      skillId,
      deleted: true,
    });
  } catch (error) {
    console.error('Delete error:', error);
    return c.json({ error: 'Failed to delete skill' }, 500);
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
    const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });
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
         WHERE created_at > NOW() - INTERVAL '30 days'
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
    const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });
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
         WHERE created_at > NOW() - INTERVAL '30 days'
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

    // Return results
    return c.json({
      success: true,
      runId: result.runId,
      timestamp: result.timestamp,
      metrics: result.metrics,
      summary: {
        fixtureCount: result.fixtureCount,
        passed: result.passed,
        failed: result.failed,
      },
      errors: result.errors,
    });
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
 * GET /v1/eval/results/:runId
 * Get eval run results (not persisted in Phase 1)
 */
app.get('/v1/eval/results/:runId', async (c) => {
  return c.json({
    error: 'Eval results are not persisted in Phase 1',
    message:
      'Run POST /v1/eval/run to execute the eval suite and get immediate results',
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Skill Versions (must be before :slug catch-all)
// ──────────────────────────────────────────────────────────────────────────────

app.get('/v1/skills/:slug/versions', async (c) => {
  const slug = c.req.param('slug');
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

  try {
    const result = await pool.query(
      `SELECT id, name, slug, version, status, trust_score, verification_tier,
              run_count, execution_layer, source, skill_type,
              cognium_scanned, cognium_scanned_at,
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
        cogniumScanned: r.cognium_scanned ?? false,
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
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

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
        s.cognium_scanned, s.cognium_scanned_at, s.content_safety_passed,
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
      avgExecutionTimeMs: row.avg_execution_time_ms ?? null,
      errorRate: row.error_rate ?? null,
      humanStarCount: parseInt(row.human_star_count) || 0,
      humanForkCount: parseInt(row.human_fork_count) || 0,
      agentInvocationCount: parseInt(row.agent_invocation_count) || 0,
      cogniumScanned: row.cognium_scanned ?? false,
      cogniumScannedAt: row.cognium_scanned_at?.toISOString() ?? null,
      contentSafetyPassed: row.content_safety_passed ?? null,
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
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

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
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

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
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

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
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

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
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

  try {
    const skill = await pool.query(
      `SELECT * FROM skills WHERE id = $1 AND COALESCE(skill_type, type) IN ('auto-composite', 'human-composite', 'composition', 'pipeline')`,
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
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

  try {
    const body = await c.req.json();
    const steps = body.steps;
    if (!Array.isArray(steps) || steps.length < 2) {
      return c.json({ error: 'At least 2 steps required' }, 400);
    }

    // Verify composition exists and is a draft
    const skill = await pool.query(
      `SELECT status, type FROM skills WHERE id = $1`,
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
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

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
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });
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
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });
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
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });
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
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

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
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

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
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

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
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

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
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

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
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

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
        s.cognium_scanned, s.cognium_scanned_at, s.content_safety_passed,
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
      avgExecutionTimeMs: row.avg_execution_time_ms ?? null,
      errorRate: row.error_rate ?? null,
      humanStarCount: parseInt(row.human_star_count) || 0,
      humanForkCount: parseInt(row.human_fork_count) || 0,
      agentInvocationCount: parseInt(row.agent_invocation_count) || 0,
      cogniumScanned: row.cognium_scanned ?? false,
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
    type: c.req.query('type') as LeaderboardFilters['type'],
    category: c.req.query('category'),
    ecosystem: c.req.query('ecosystem'),
    limit: c.req.query('limit') ? parseInt(c.req.query('limit')) : undefined,
    offset: c.req.query('offset') ? parseInt(c.req.query('offset')) : undefined,
  };
}

app.get('/v1/leaderboards/human', async (c) => {
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });
  try {
    const results = await getHumanLeaderboard(parseLeaderboardFilters(c), pool);
    return c.json({ leaderboard: results });
  } catch (error) {
    console.error('[LEADERBOARD] Human error:', error);
    return c.json({ error: 'Failed to get leaderboard' }, 500);
  }
});

app.get('/v1/leaderboards/agents', async (c) => {
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });
  try {
    const results = await getAgentLeaderboard(parseLeaderboardFilters(c), pool);
    return c.json({ leaderboard: results });
  } catch (error) {
    console.error('[LEADERBOARD] Agent error:', error);
    return c.json({ error: 'Failed to get leaderboard' }, 500);
  }
});

app.get('/v1/leaderboards/trending', async (c) => {
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });
  try {
    const results = await getTrendingLeaderboard(parseLeaderboardFilters(c), pool);
    return c.json({ leaderboard: results });
  } catch (error) {
    console.error('[LEADERBOARD] Trending error:', error);
    return c.json({ error: 'Failed to get leaderboard' }, 500);
  }
});

app.get('/v1/leaderboards/most-composed', async (c) => {
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });
  try {
    const results = await getMostComposedLeaderboard(parseLeaderboardFilters(c), pool);
    return c.json({ leaderboard: results });
  } catch (error) {
    console.error('[LEADERBOARD] Most-composed error:', error);
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
    const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

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
    const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });
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
    const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });
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
    const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

    const [statusBreakdown, tierBreakdown, sourceBreakdown, trustDistribution, trustHistogram, topFindings, scanCoverage] = await Promise.all([
      pool.query(`SELECT status, count(*)::int AS cnt FROM skills WHERE cognium_scanned = true GROUP BY status ORDER BY cnt DESC`),
      pool.query(`SELECT verification_tier, count(*)::int AS cnt FROM skills WHERE cognium_scanned = true GROUP BY verification_tier ORDER BY cnt DESC`),
      pool.query(`SELECT source, status, count(*)::int AS cnt FROM skills WHERE cognium_scanned = true GROUP BY source, status ORDER BY source, cnt DESC`),
      pool.query(`SELECT
        count(*) FILTER (WHERE trust_score >= 0.9)::int AS high,
        count(*) FILTER (WHERE trust_score >= 0.5 AND trust_score < 0.9)::int AS medium,
        count(*) FILTER (WHERE trust_score > 0 AND trust_score < 0.5)::int AS low,
        count(*) FILTER (WHERE trust_score = 0)::int AS zero,
        count(*) FILTER (WHERE trust_score IS NULL)::int AS unscored
      FROM skills WHERE cognium_scanned = true`),
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
      WHERE cognium_scanned = true AND cognium_findings IS NOT NULL AND cognium_findings != '[]'
      GROUP BY f->>'severity', f->>'cweId', f->>'title'
      ORDER BY
        CASE f->>'severity' WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
        cnt DESC
      LIMIT 30`),
      pool.query(`SELECT scan_coverage, count(*)::int AS cnt FROM skills WHERE cognium_scanned = true AND scan_coverage IS NOT NULL GROUP BY scan_coverage ORDER BY cnt DESC`),
    ]);

    const totalScanned = await pool.query(`SELECT count(*)::int AS cnt FROM skills WHERE cognium_scanned = true`);
    const totalSkills = await pool.query(`SELECT count(*)::int AS cnt FROM skills`);
    const inFlight = await pool.query(`SELECT count(*)::int AS cnt FROM skills WHERE cognium_job_id IS NOT NULL`);
    const remaining = await pool.query(`SELECT count(*)::int AS cnt FROM skills WHERE cognium_scanned = false AND verification_tier = 'unverified' AND status = 'published' AND cognium_job_id IS NULL`);

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
    const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });
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
                trust_score, verification_tier, scan_coverage, cognium_scanned,
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
         FROM skills WHERE status = 'published' ${source ? `AND source = '${source.replace(/'/g, "''")}'` : ''} ORDER BY random() LIMIT 3`;
      params = [];
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
        scanResult: skill.cognium_scanned ? {
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

// Admin: clear stale in-flight jobs
app.post('/v1/admin/clear-stale', async (c) => {
  try {
    const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });
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

// Admin: inventory of skills by content type
app.get('/v1/admin/skill-inventory', async (c) => {
  try {
    const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });
    const [total, bySource, byStatus, byContent, byScanStatus, failureReasons] = await Promise.all([
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
        count(*) FILTER (WHERE cognium_scanned = false)::int AS never_scanned,
        count(*) FILTER (WHERE cognium_scanned = true AND verification_tier = 'unverified')::int AS scan_failed,
        count(*) FILTER (WHERE cognium_scanned = true AND verification_tier != 'unverified')::int AS scan_completed,
        count(*) FILTER (WHERE cognium_job_id IS NOT NULL)::int AS in_flight,
        count(*) FILTER (WHERE cognium_scanned = false AND (skill_md IS NOT NULL AND length(skill_md) > 100))::int AS unscanned_with_instructions,
        count(*) FILTER (WHERE cognium_scanned = false AND (source = 'github' OR repository_url IS NOT NULL))::int AS unscanned_with_repo,
        count(*) FILTER (WHERE cognium_scanned = true AND verification_tier = 'unverified' AND (skill_md IS NOT NULL AND length(skill_md) > 100))::int AS failed_with_instructions
      FROM skills WHERE status = 'published'`),
      pool.query(`SELECT
        COALESCE(scan_failure_reason, 'unknown (pre-tracking)') AS reason,
        count(*)::int AS cnt
      FROM skills
      WHERE cognium_scanned = true AND verification_tier = 'unverified'
      GROUP BY scan_failure_reason
      ORDER BY cnt DESC
      LIMIT 20`),
    ]);
    return c.json({
      totalPublished: total.rows[0].cnt,
      byStatus: Object.fromEntries(byStatus.rows.map((r: any) => [r.status, r.cnt])),
      bySource: Object.fromEntries(bySource.rows.map((r: any) => [r.source, r.cnt])),
      content: byContent.rows[0],
      scanStatus: byScanStatus.rows[0],
      failureReasons: Object.fromEntries(failureReasons.rows.map((r: any) => [r.reason, r.cnt])),
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
    const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

    let baseWhere = retry
      ? `WHERE verification_tier = 'unverified' AND status = 'published' AND cognium_job_id IS NULL AND cognium_scanned = true`
      : `WHERE verification_tier = 'unverified' AND status = 'published' AND cognium_job_id IS NULL AND cognium_scanned = false`;

    const extraFilters: string[] = [];
    if (source) extraFilters.push(`source = '${source.replace(/'/g, "''")}'`);
    if (content === 'instructions') extraFilters.push(`(skill_md IS NOT NULL AND length(skill_md) > 100)`);
    if (content === 'repo') extraFilters.push(`(source = 'github' OR repository_url IS NOT NULL)`);
    if (content === 'metadata') extraFilters.push(`skill_md IS NULL AND schema_json IS NULL AND source != 'github' AND repository_url IS NULL`);
    const whereClause = extraFilters.length > 0
      ? `${baseWhere} AND ${extraFilters.join(' AND ')}`
      : baseWhere;
    const params = [limit];

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
        `SELECT count(*)::int AS cnt FROM skills WHERE verification_tier = 'unverified' AND status = 'published' AND cognium_scanned = false`
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
        `SELECT count(*)::int AS cnt FROM skills WHERE verification_tier = 'unverified' AND status = 'published' AND cognium_job_id IS NULL AND cognium_scanned = false`
      );
      const inFlight = await pool.query(
        `SELECT count(*)::int AS cnt FROM skills WHERE cognium_job_id IS NOT NULL`
      );
      const scannedCount = await pool.query(
        `SELECT count(*)::int AS cnt FROM skills WHERE cognium_scanned = true`
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
      `SELECT count(*)::int AS cnt FROM skills WHERE verification_tier = 'unverified' AND status = 'published' AND cognium_scanned = false`
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
    const sync = new ClawHubSync(c.env);
    const r = await sync.run({ maxPages, startCursor: savedCursor });

    if (r.lastCursor) {
      await c.env.SEARCH_CACHE.put(cursorKey, r.lastCursor, { expirationTtl: 86400 });
    } else {
      await c.env.SEARCH_CACHE.delete(cursorKey);
    }

    const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });
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
          const pool = new Pool({ connectionString: env.NEON_CONNECTION_STRING });
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
          const pool = new Pool({ connectionString: env.NEON_CONNECTION_STRING });
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
        new McpRegistrySync(env)
          .run()
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
          const pool = new Pool({ connectionString: env.NEON_CONNECTION_STRING });
          const embedPipeline = new EmbedPipeline(env);
          const provider = new PgVectorProvider(env.NEON_CONNECTION_STRING, env);
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
               LIMIT 30`
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
        const pool = new Pool({ connectionString: env.NEON_CONNECTION_STRING });
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

          // ── Phase 2: Submit new skills (every 5 min only) ─────────────────
          // Fast path: skills without repo URL (Mode B inline, ~2s each)
          // Repo path: GitHub source OR has repository_url (Mode A, deferred)
          if (minute % 5 !== 0) {
            // Skip submit phase on non-5min cycles (only poll above)
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
             WHERE cognium_scanned = false AND status = 'published'
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
             WHERE cognium_scanned = false AND status = 'published'
               AND cognium_job_id IS NULL
               AND (source = 'github' OR repository_url IS NOT NULL)
             ORDER BY created_at ASC
             LIMIT $1`,
            [repoBatchSize]
          );

          let submitted = 0;
          let consecutiveFailures = 0;
          const MAX_CONSECUTIVE_FAILURES = 3;

          // Fast path: non-GitHub skills (inline poll, ~2s each)
          for (const skill of fastSkills.rows) {
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              console.warn(`[CRON-SUBMIT] Aborting fast path: ${consecutiveFailures} consecutive Circle-IR failures`);
              break;
            }
            try {
              // buildCircleIRRequest includes bundle_url for clawhub skills
              const submitRes = await fetch(`${cogniumUrl}/api/analyze/skill`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify(buildCircleIRRequest(skill)),
              });
              if (!submitRes.ok) {
                console.error(`[CRON-SUBMIT] Submit failed for ${skill.slug}: ${submitRes.status}`);
                if (submitRes.status >= 500 || submitRes.status === 429) consecutiveFailures++;
                continue;
              }
              consecutiveFailures = 0;
              const { job_id } = await submitRes.json() as { job_id: string };

              let jobStatus: any;
              for (let i = 0; i < 5; i++) {
                await new Promise(r => setTimeout(r, 2000));
                const statusRes = await fetch(`${cogniumUrl}/api/analyze/${job_id}/status`, {
                  headers: authHeaders,
                });
                jobStatus = await statusRes.json();
                if (jobStatus.status === 'completed' || jobStatus.status === 'failed') break;
              }

              if (jobStatus.status === 'completed') {
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

                await applyScanReport(env, pool, skill, normalizeFindings(raw), jobStatus, skillResult);
                submitted++;
              } else {
                // Slow non-GitHub skill — store for deferred poll
                await pool.query(
                  `UPDATE skills SET cognium_job_id = $1, cognium_job_submitted_at = NOW() WHERE id = $2`,
                  [job_id, skill.id]
                );
                submitted++;
                console.log(`[CRON-SUBMIT] ${skill.slug} slow, deferred → job ${job_id}`);
              }
            } catch (e: any) {
              console.error(`[CRON-SUBMIT] Error submitting ${skill.slug}:`, e.message);
            }
          }

          // Repo path: skills with GitHub source or repository_url (submit + defer poll)
          for (const skill of repoSkills.rows) {
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              console.warn(`[CRON-SUBMIT] Aborting repo path: ${consecutiveFailures} consecutive Circle-IR failures`);
              break;
            }
            try {
              const submitRes = await fetch(`${cogniumUrl}/api/analyze/skill`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify(buildCircleIRRequest(skill)),
              });
              if (!submitRes.ok) {
                console.error(`[CRON-SUBMIT] Submit failed for ${skill.slug}: ${submitRes.status}`);
                if (submitRes.status >= 500 || submitRes.status === 429) consecutiveFailures++;
                continue;
              }
              consecutiveFailures = 0;
              const { job_id } = await submitRes.json() as { job_id: string };

              await pool.query(
                `UPDATE skills SET cognium_job_id = $1, cognium_job_submitted_at = NOW() WHERE id = $2`,
                [job_id, skill.id]
              );
              submitted++;
              console.log(`[CRON-SUBMIT] Repo ${skill.slug} → job ${job_id} (deferred poll)`);
            } catch (e: any) {
              console.error(`[CRON-SUBMIT] Error submitting ${skill.slug}:`, e.message);
            }
          }

          if (submitted > 0) {
            console.log(`[CRON] Submit phase: submitted ${submitted} skills (${fastSkills.rows.length} fast + ${repoSkills.rows.length} repo)`);
          }

          } // end backpressure check
          } // end Phase 2 (minute % 5 guard)

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
        new GitHubSync(env)
          .run()
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
  },

  async queue(
    batch: MessageBatch,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    switch (batch.queue) {
      case 'runics-embed':
        await handleEmbedQueue(
          batch as MessageBatch<EmbedQueueMessage>,
          env
        );
        break;
      case 'runics-cognium':
      case 'runics-cognium-v2':
        await handleCogniumSubmitQueue(
          batch as MessageBatch<CogniumSubmitMessage>,
          env
        );
        break;
      case 'runics-cognium-poll':
      case 'runics-cognium-poll-v2':
        await handleCogniumPollQueue(
          batch as MessageBatch<CogniumPollMessage>,
          env
        );
        break;
      default:
        console.error(`[QUEUE] Unknown queue: ${batch.queue}`);
        break;
    }
  },
};
