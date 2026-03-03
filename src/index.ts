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
import type {
  Env,
  FindSkillRequest,
  FindSkillResponse,
  SkillInput,
  SearchFilters,
  QualityFeedback,
  SkillResult,
} from './types';
import { appetiteToTrustThreshold as getAppetiteThreshold } from './types';

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
  // BYPASS Hyperdrive - connect directly to Neon using @neondatabase/serverless
  // Hyperdrive doesn't work with WebSocket-based drivers
  const directConnectionString = "postgresql://neondb_owner:npg_4P6BeXkZLcTA@ep-autumn-river-akx7s38p.c-3.us-west-2.aws.neon.tech/neondb?sslmode=require";
  const pool = new Pool({ connectionString: directConnectionString });

  const provider = new PgVectorProvider(directConnectionString, env);
  const embedPipeline = new EmbedPipeline(env);
  const cache = new SearchCache(
    env.SEARCH_CACHE,
    parseInt(env.CACHE_TTL_SECONDS || '60')
  );
  const logger = new SearchLogger(pool);
  const qualityTracker = new QualityTracker(pool);

  return { provider, embedPipeline, cache, logger, qualityTracker, pool };
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
    service: 'runics-search',
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

/**
 * POST /v1/search
 * Main search endpoint — findSkill
 *
 * Query flow (Section 10):
 * 1. Cache check → 2. Embed query → 3. Provider search →
 * 4. Log event (non-blocking) → 5. Cache result (non-blocking) → 6. Return
 */
app.post('/v1/search', async (c) => {
  const perf = new PerfMonitor();
  perf.mark('start');

  try {
    const body = await c.req.json<FindSkillRequest>();

    // Validate required fields
    if (!body.query || !body.tenantId) {
      return c.json({ error: 'Missing required fields: query, tenantId' }, 400);
    }

    const { provider, embedPipeline, cache, logger } = initComponents(c.env);

    const appetite = body.appetite || (c.env.DEFAULT_APPETITE as any) || 'balanced';
    const limit = body.limit || 10;

    // ── 1. Cache Check ──
    perf.mark('cache_check');
    const cached = await cache.get(body.query, body.tenantId, appetite);

    if (cached) {
      // Cache hit — return immediately
      const cacheLatencyMs = perf.total();

      // Update latency in cached response
      cached.meta.latencyMs = cacheLatencyMs;

      return c.json(cached);
    }

    // ── 2. Embed Query ──
    perf.mark('embed_query');
    const embedding = await embedPipeline['embed'](body.query);

    // ── 3. Provider Search ──
    perf.mark('provider_search');

    const filters: SearchFilters = {
      tenantId: body.tenantId,
      tags: body.tags,
      category: body.category,
      minTrustScore: getAppetiteThreshold(appetite as any),
      contentSafetyRequired: true,
    };

    const searchResult = await provider.search(body.query, embedding, filters, {
      limit,
    });

    // ── 4. Build Response ──
    perf.mark('build_response');

    // Fetch full skill metadata for results
    const skillResults = await buildSkillResults(
      searchResult.results,
      provider['pool']
    );

    const response: FindSkillResponse = {
      results: skillResults,
      confidence: tierToConfidence(searchResult.confidence.tier),
      enriched: false,
      meta: {
        matchSources: searchResult.results
          .slice(0, 3)
          .map((r) => r.matchSource),
        latencyMs: perf.total(),
        tier: searchResult.confidence.tier,
        cacheHit: false,
        llmInvoked: false,
      },
    };

    // ── 5. Log Event (Non-Blocking) ──
    const logEntry = logger.buildLogEntry({
      query: body.query,
      tenantId: body.tenantId,
      appetite,
      tier: searchResult.confidence.tier,
      cacheHit: false,
      topScore: searchResult.confidence.topScore,
      gapToSecond: searchResult.confidence.gapToSecond,
      clusterDensity: searchResult.confidence.clusterDensity,
      keywordHits: searchResult.confidence.keywordHits,
      resultCount: skillResults.length,
      matchSource: searchResult.results[0]?.matchSource,
      resultSkillIds: skillResults.map((r) => r.id),
      totalLatencyMs: perf.total(),
      vectorSearchMs: searchResult.meta.vectorSearchMs,
      fullTextSearchMs: searchResult.meta.fullTextSearchMs,
      fusionStrategy: searchResult.meta.fusionStrategy,
      llmInvoked: false,
      embeddingCost: logger.estimateEmbeddingCost(body.query.length),
      llmCost: 0,
      compositionDetected: false,
      generationHintReturned: false,
    });

    c.executionCtx.waitUntil(logger.log(logEntry));

    // ── 6. Cache Result (Non-Blocking) ──
    c.executionCtx.waitUntil(
      cache.set(
        body.query,
        body.tenantId,
        appetite,
        response,
        searchResult.confidence.tier
      )
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
    console.log(`[INDEX] Step 2: Generate embeddings`);
    const embeddings = await embedPipeline.processSkill(skill);
    console.log(`[INDEX] Embeddings generated: ${embeddings.agentSummary.embedding.length} dims`);

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
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

async function buildSkillResults(
  scoredSkills: any[],
  pool: Pool
): Promise<SkillResult[]> {
  if (scoredSkills.length === 0) {
    return [];
  }

  const skillIds = scoredSkills.map((s) => s.skillId);

  const sql = `
    SELECT
      id,
      name,
      slug,
      agent_summary,
      trust_score,
      execution_layer,
      capabilities_required
    FROM skills
    WHERE id = ANY($1::uuid[])
  `;

  const result = await pool.query(sql, [skillIds]);

  // Create lookup map
  const skillMap = new Map(
    result.rows.map((row) => [
      row.id,
      {
        id: row.id,
        name: row.name,
        slug: row.slug,
        agentSummary: row.agent_summary,
        trustScore: parseFloat(row.trust_score),
        executionLayer: row.execution_layer,
        capabilitiesRequired: row.capabilities_required ?? [],
      },
    ])
  );

  // Merge with scores
  const results: SkillResult[] = [];
  for (const ss of scoredSkills) {
    const skill = skillMap.get(ss.skillId);
    if (!skill) continue;

    const result: SkillResult = {
      ...skill,
      score: ss.fusedScore,
      matchSource: ss.matchSource,
    };

    if (ss.matchText) {
      result.matchText = ss.matchText;
    }

    results.push(result);
  }

  return results;
}

function tierToConfidence(tier: 1 | 2 | 3): FindSkillResponse['confidence'] {
  switch (tier) {
    case 1:
      return 'high';
    case 2:
      return 'medium';
    case 3:
      return 'low_enriched';
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 404 Handler
// ──────────────────────────────────────────────────────────────────────────────

app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// ──────────────────────────────────────────────────────────────────────────────
// Export
// ──────────────────────────────────────────────────────────────────────────────

export default app;
