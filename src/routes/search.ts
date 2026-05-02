// ══════════════════════════════════════════════════════════════════════════════
// Search Routes — OpenAPI
// ══════════════════════════════════════════════════════════════════════════════

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Env, FindSkillRequest, QualityFeedback, Appetite } from '../types';
import { initComponents } from '../components';
import {
  HealthResponseSchema,
  SearchResponseSchema,
  ErrorResponseSchema,
  SuccessResponseSchema,
} from '../schemas/responses';

const app = new OpenAPIHono<{ Bindings: Env }>();

// ── GET /health ──

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['Health'],
  summary: 'Service health check',
  responses: {
    200: {
      content: { 'application/json': { schema: HealthResponseSchema } },
      description: 'Health status',
    },
  },
});

app.openapi(healthRoute, async (c) => {
  const { provider, pool } = initComponents(c.env);

  const healthCheck = await provider.healthCheck();

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
  }, 200);
});

// ── POST /v1/search ──

const SearchRequestSchema = z
  .object({
    query: z.string().min(1).max(500).openapi({ example: 'format code with prettier' }),
    tenantId: z.string().openapi({ example: 'public' }),
    limit: z.number().int().min(1).max(50).optional(),
    appetite: z.string().optional(),
    tags: z.array(z.string()).optional(),
    category: z.string().optional(),
    runtimeEnv: z.string().optional(),
    visibility: z.string().optional(),
  })
  .openapi('SearchRequest');

const searchRoute = createRoute({
  method: 'post',
  path: '/v1/search',
  tags: ['Search'],
  summary: 'Semantic skill search',
  request: {
    body: {
      content: { 'application/json': { schema: SearchRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: SearchResponseSchema } },
      description: 'Search results',
    },
    400: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Validation error',
    },
    500: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Server error',
    },
  },
});

app.openapi(searchRoute, async (c) => {
  try {
    const body = c.req.valid('json');

    const query = String(body.query).trim();
    if (query.length === 0) {
      return c.json({ error: 'query must not be empty' }, 400);
    }
    if (query.length > 500) {
      return c.json({ error: 'query exceeds maximum length of 500 characters' }, 400);
    }
    const limit = body.limit !== undefined ? Math.min(Math.max(1, Number(body.limit) || 10), 50) : undefined;

    const { gate } = initComponents(c.env);

    const response = await gate.findSkill(
      query,
      body.tenantId,
      {
        limit,
        appetite: body.appetite as Appetite,
        tags: body.tags,
        category: body.category,
        runtimeEnv: body.runtimeEnv ? [body.runtimeEnv] : undefined,
        visibility: body.visibility as FindSkillRequest['visibility'],
      },
      c.executionCtx
    );

    return c.json(response as any, 200);
  } catch (error) {
    console.error('Search error:', error);
    return c.json({ error: 'Search failed' }, 500);
  }
});

// ── POST /v1/search/feedback ──

const FeedbackRequestSchema = z
  .object({
    searchEventId: z.string(),
    skillId: z.string(),
    feedbackType: z.string(),
    position: z.number(),
  })
  .openapi('FeedbackRequest');

const feedbackRoute = createRoute({
  method: 'post',
  path: '/v1/search/feedback',
  tags: ['Search'],
  summary: 'Record quality feedback for a search result',
  request: {
    body: {
      content: { 'application/json': { schema: FeedbackRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: SuccessResponseSchema } },
      description: 'Feedback recorded',
    },
    400: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Validation error',
    },
    500: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Server error',
    },
  },
});

app.openapi(feedbackRoute, async (c) => {
  try {
    const body = c.req.valid('json') as QualityFeedback;

    const { qualityTracker } = initComponents(c.env);
    c.executionCtx.waitUntil(qualityTracker.recordFeedback(body));

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error('Feedback error:', error);
    return c.json({ error: 'Failed to record feedback' }, 500);
  }
});

export { app as searchRoutes };
