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
import { publishRoutes } from './publish/handler';
import { McpRegistrySync } from './sync/mcp-registry';
import { ClawHubSync } from './sync/clawhub';
import { GitHubSync } from './sync/github';
import { handleEmbedQueue } from './queues/embed-consumer';
import { handleCogniumQueue } from './queues/cognium-consumer';
import type {
  Env,
  FindSkillRequest,
  SkillInput,
  QualityFeedback,
  SkillResult,
  Appetite,
  EmbedQueueMessage,
  CogniumQueueMessage,
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

// Rate limiting on search endpoint
app.use('/v1/search', rateLimiter());

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
// Publish API (Phase 5)
// ──────────────────────────────────────────────────────────────────────────────

// Mount publish routes at /v1/skills
// Note: Existing DELETE /v1/skills/:skillId and POST /v1/skills/:skillId/index
// are defined above and take priority (Hono matches routes in order)
app.route('/v1/skills', publishRoutes);

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

    // Every 10 minutes: ClawHub sync
    if (minute % 10 === 0 && env.SYNC_CLAWHUB_ENABLED !== 'false') {
      ctx.waitUntil(
        new ClawHubSync(env)
          .run()
          .then((r) =>
            console.log(
              `[CRON] ClawHub sync: synced=${r.synced} skipped=${r.skipped} errors=${r.errors}`
            )
          )
          .catch((e: Error) =>
            console.error('[CRON] ClawHub sync failed:', e.message)
          )
      );
    }

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
        await handleCogniumQueue(
          batch as MessageBatch<CogniumQueueMessage>,
          env
        );
        break;
      default:
        console.error(`[QUEUE] Unknown queue: ${batch.queue}`);
        break;
    }
  },
};
