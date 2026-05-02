// ══════════════════════════════════════════════════════════════════════════════
// Eval Routes — OpenAPI
// ══════════════════════════════════════════════════════════════════════════════

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Env } from '../types';
import {
  EvalRunResponseSchema,
  EvalResultsListSchema,
  EvalCompareResponseSchema,
  ErrorResponseSchema,
} from '../schemas/responses';

const app = new OpenAPIHono<{ Bindings: Env }>();

// ── POST /v1/eval/run ──

const EvalRunRequestSchema = z
  .object({
    tenantId: z.string().optional(),
    limit: z.number().int().optional(),
    verbose: z.boolean().optional(),
  })
  .openapi('EvalRunRequest');

const evalRunRoute = createRoute({
  method: 'post',
  path: '/v1/eval/run',
  tags: ['Eval'],
  summary: 'Run the eval suite against the live search endpoint',
  request: {
    body: {
      content: { 'application/json': { schema: EvalRunRequestSchema } },
      required: false,
    },
  },
  responses: {
    200: { content: { 'application/json': { schema: EvalRunResponseSchema } }, description: 'Eval results' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

app.openapi(evalRunRoute, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));

    const tenantId = body.tenantId || 'eval-tenant';
    const limit = body.limit || 10;
    const verbose = body.verbose || false;

    const { runEvalSuite, formatSummary } = await import('../eval/runner');

    const protocol = c.req.header('x-forwarded-proto') || 'http';
    const host = c.req.header('host') || 'localhost:8787';
    const searchEndpoint = `${protocol}://${host}/v1/search`;

    const result = await runEvalSuite(searchEndpoint, tenantId, {
      limit,
      verbose,
    });

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
          await env.SEARCH_CACHE.put(
            `eval:run:${result.runId}`,
            JSON.stringify(persistedRun),
            { expirationTtl: 90 * 24 * 60 * 60 }
          );

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

    return c.json({ success: true, ...persistedRun } as any, 200);
  } catch (error) {
    console.error('Eval run error:', error);
    return c.json({ error: 'Failed to run eval suite' }, 500);
  }
});

// ── GET /v1/eval/results ──

const evalResultsRoute = createRoute({
  method: 'get',
  path: '/v1/eval/results',
  tags: ['Eval'],
  summary: 'List recent eval runs',
  responses: {
    200: { content: { 'application/json': { schema: EvalResultsListSchema } }, description: 'Eval run list' },
  },
});

app.openapi(evalResultsRoute, async (c) => {
  const env = c.env as Env;
  const indexRaw = await env.SEARCH_CACHE.get('eval:index');
  const index: string[] = indexRaw ? JSON.parse(indexRaw) : [];

  if (index.length === 0) {
    return c.json({ runs: [], message: 'No eval runs found. Run POST /v1/eval/run first.' } as any, 200);
  }

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

  return c.json({ runs: runs.filter(Boolean) }, 200);
});

// ── GET /v1/eval/results/:runId ──

const evalResultDetailRoute = createRoute({
  method: 'get',
  path: '/v1/eval/results/{runId}',
  tags: ['Eval'],
  summary: 'Get full eval run results',
  request: {
    params: z.object({
      runId: z.string().openapi({ param: { name: 'runId', in: 'path' }, example: 'eval-abc123' }),
    }),
  },
  responses: {
    200: { content: { 'application/json': { schema: EvalRunResponseSchema } }, description: 'Eval run detail' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
  },
});

app.openapi(evalResultDetailRoute, async (c) => {
  const env = c.env as Env;
  const runId = c.req.valid('param').runId;
  const raw = await env.SEARCH_CACHE.get(`eval:run:${runId}`);

  if (!raw) {
    return c.json({ error: 'Eval run not found', runId } as any, 404);
  }

  return c.json(JSON.parse(raw), 200);
});

// ── GET /v1/eval/compare ──

const evalCompareRoute = createRoute({
  method: 'get',
  path: '/v1/eval/compare',
  tags: ['Eval'],
  summary: 'Compare two eval runs side-by-side',
  request: {
    query: z.object({
      runA: z.string().openapi({ param: { name: 'runA', in: 'query' } }),
      runB: z.string().openapi({ param: { name: 'runB', in: 'query' } }),
    }),
  },
  responses: {
    200: { content: { 'application/json': { schema: EvalCompareResponseSchema } }, description: 'Comparison' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Missing params' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Run not found' },
  },
});

app.openapi(evalCompareRoute, async (c) => {
  const env = c.env as Env;
  const { runA, runB } = c.req.valid('query');

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
  }, 200);
});

export { app as evalRoutes };
