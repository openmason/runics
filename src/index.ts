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
  CogniumQueueMessage,
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
  try {
    // Direct scan: submit to Circle-IR, poll inline, apply report
    const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });
    const cogniumUrl = c.env.COGNIUM_URL ?? 'https://circle.cognium.net';
    const apiKey = c.env.COGNIUM_API_KEY ?? '';

    // Fetch skill
    const skillRes = await pool.query(
      `SELECT id, slug, version, name, description, source, status,
              execution_layer AS "executionLayer",
              skill_md AS "skillMd",
              root_source AS "rootSource",
              skill_type AS "skillType"
       FROM skills WHERE id = $1`, [skillId]
    );
    if (skillRes.rows.length === 0) return c.json({ error: 'Skill not found' }, 404);
    const skill = skillRes.rows[0];

    // Submit to Circle-IR
    const { buildCircleIRRequest } = await import('./cognium/request-builder');
    const submitRes = await fetch(`${cogniumUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(buildCircleIRRequest(skill)),
    });
    if (!submitRes.ok) return c.json({ error: `Circle-IR submit failed: ${submitRes.status}` }, 502);
    const { job_id } = await submitRes.json() as { job_id: string };

    // Poll until done (max 30s)
    let jobStatus: any;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const statusRes = await fetch(`${cogniumUrl}/api/analyze/${job_id}/status`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      jobStatus = await statusRes.json();
      if (jobStatus.status === 'completed' || jobStatus.status === 'failed') break;
    }

    if (jobStatus.status !== 'completed') {
      return c.json({ error: `Job ${job_id} ended with status: ${jobStatus.status}`, jobStatus }, 502);
    }

    // Fetch findings
    const findingsRes = await fetch(`${cogniumUrl}/api/analyze/${job_id}/findings`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const { findings: raw } = await findingsRes.json() as { findings: any[] };

    // Normalize and apply
    const { normalizeFindings } = await import('./cognium/finding-mapper');
    const { applyScanReport } = await import('./cognium/scan-report-handler');
    const findings = normalizeFindings(raw);
    await applyScanReport(c.env, pool, skill, findings, jobStatus);

    return c.json({ success: true, skillId, jobId: job_id, findingsCount: findings.length, status: jobStatus.status });
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
        // v5.0: Route to new submit consumer (handles both old and new message formats)
        await handleCogniumSubmitQueue(
          batch as MessageBatch<CogniumSubmitMessage>,
          env
        );
        break;
      case 'runics-cognium-poll':
        // v5.0: Poll consumer for async Circle-IR job status
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
