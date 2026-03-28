import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../types';

/**
 * Tests for eval persistence endpoints:
 * - GET /v1/eval/results (list recent runs)
 * - GET /v1/eval/results/:runId (get single run)
 * - GET /v1/eval/compare (compare two runs)
 *
 * These endpoints are defined inline in index.ts, so we create
 * minimal Hono apps that mirror the endpoint logic for unit testing.
 */

const MOCK_RUN_A = {
  runId: 'run-a-001',
  timestamp: '2025-01-15T10:00:00Z',
  metrics: {
    recall1: 0.65,
    recall5: 0.90,
    mrr: 0.75,
    avgTopScore: 0.52,
    tierDistribution: { tier1: 60, tier2: 25, tier3: 15 },
  },
  summary: { fixtureCount: 40, passed: 36, failed: 4 },
  errors: [],
};

const MOCK_RUN_B = {
  runId: 'run-b-002',
  timestamp: '2025-01-16T10:00:00Z',
  metrics: {
    recall1: 0.70,
    recall5: 0.93,
    mrr: 0.80,
    avgTopScore: 0.55,
    tierDistribution: { tier1: 65, tier2: 25, tier3: 10 },
  },
  summary: { fixtureCount: 40, passed: 38, failed: 2 },
  errors: [],
};

describe('GET /v1/eval/results', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockKV: any;

  beforeEach(() => {
    mockKV = {
      get: vi.fn(),
      put: vi.fn(),
    };

    app = new Hono<{ Bindings: Env }>();

    // Mirror the endpoint logic from index.ts
    app.get('/v1/eval/results', async (c) => {
      const env = c.env as Env;
      const indexRaw = await env.SEARCH_CACHE.get('eval:index');
      const index: string[] = indexRaw ? JSON.parse(indexRaw) : [];

      if (index.length === 0) {
        return c.json({ runs: [], message: 'No eval runs found. Run POST /v1/eval/run first.' });
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

      return c.json({ runs: runs.filter(Boolean) });
    });
  });

  it('should return empty list with message when no runs exist', async () => {
    mockKV.get.mockResolvedValue(null);

    const res = await app.request('/v1/eval/results', {}, { SEARCH_CACHE: mockKV } as any);
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.runs).toEqual([]);
    expect(body.message).toContain('No eval runs found');
  });

  it('should return run summaries from KV index', async () => {
    mockKV.get.mockImplementation(async (key: string) => {
      if (key === 'eval:index') return JSON.stringify(['run-a-001', 'run-b-002']);
      if (key === 'eval:run:run-a-001') return JSON.stringify(MOCK_RUN_A);
      if (key === 'eval:run:run-b-002') return JSON.stringify(MOCK_RUN_B);
      return null;
    });

    const res = await app.request('/v1/eval/results', {}, { SEARCH_CACHE: mockKV } as any);
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect((body as any).runs).toHaveLength(2);
    expect((body as any).runs[0].runId).toBe('run-a-001');
    expect((body as any).runs[0].recall1).toBe(0.65);
    expect((body as any).runs[0].passed).toBe(36);
    expect((body as any).runs[1].runId).toBe('run-b-002');
  });

  it('should filter out null entries when a run is missing from KV', async () => {
    mockKV.get.mockImplementation(async (key: string) => {
      if (key === 'eval:index') return JSON.stringify(['run-a-001', 'deleted-run']);
      if (key === 'eval:run:run-a-001') return JSON.stringify(MOCK_RUN_A);
      return null; // deleted-run not found
    });

    const res = await app.request('/v1/eval/results', {}, { SEARCH_CACHE: mockKV } as any);
    const body = await res.json() as any;

    expect((body as any).runs).toHaveLength(1);
    expect((body as any).runs[0].runId).toBe('run-a-001');
  });
});

describe('GET /v1/eval/results/:runId', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockKV: any;

  beforeEach(() => {
    mockKV = { get: vi.fn() };
    app = new Hono<{ Bindings: Env }>();

    app.get('/v1/eval/results/:runId', async (c) => {
      const env = c.env as Env;
      const runId = c.req.param('runId');
      const raw = await env.SEARCH_CACHE.get(`eval:run:${runId}`);
      if (!raw) return c.json({ error: 'Eval run not found', runId }, 404);
      return c.json(JSON.parse(raw));
    });
  });

  it('should return 404 for non-existent run', async () => {
    mockKV.get.mockResolvedValue(null);

    const res = await app.request('/v1/eval/results/missing-id', {}, { SEARCH_CACHE: mockKV } as any);
    const body = await res.json() as any;

    expect(res.status).toBe(404);
    expect(body.error).toBe('Eval run not found');
    expect(body.runId).toBe('missing-id');
  });

  it('should return full run data for existing run', async () => {
    mockKV.get.mockResolvedValue(JSON.stringify(MOCK_RUN_A));

    const res = await app.request('/v1/eval/results/run-a-001', {}, { SEARCH_CACHE: mockKV } as any);
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.runId).toBe('run-a-001');
    expect(body.metrics.recall1).toBe(0.65);
    expect(body.summary.passed).toBe(36);
    expect(body.errors).toEqual([]);
  });

  it('should fetch by the correct KV key', async () => {
    mockKV.get.mockResolvedValue(null);

    await app.request('/v1/eval/results/my-run-123', {}, { SEARCH_CACHE: mockKV } as any);

    expect(mockKV.get).toHaveBeenCalledWith('eval:run:my-run-123');
  });
});

describe('GET /v1/eval/compare', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockKV: any;

  beforeEach(() => {
    mockKV = { get: vi.fn() };
    app = new Hono<{ Bindings: Env }>();

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
        summary: { a: a.summary, b: b.summary },
        tierDistribution: { a: a.metrics.tierDistribution, b: b.metrics.tierDistribution },
      });
    });
  });

  it('should return 400 when runA is missing', async () => {
    const res = await app.request('/v1/eval/compare?runB=b', {}, { SEARCH_CACHE: mockKV } as any);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('Both runA and runB');
  });

  it('should return 400 when runB is missing', async () => {
    const res = await app.request('/v1/eval/compare?runA=a', {}, { SEARCH_CACHE: mockKV } as any);
    expect(res.status).toBe(400);
  });

  it('should return 400 when both params are missing', async () => {
    const res = await app.request('/v1/eval/compare', {}, { SEARCH_CACHE: mockKV } as any);
    expect(res.status).toBe(400);
  });

  it('should return 404 when runA not found', async () => {
    mockKV.get.mockResolvedValue(null);

    const res = await app.request('/v1/eval/compare?runA=missing&runB=b', {}, { SEARCH_CACHE: mockKV } as any);
    const body = await res.json() as any;

    expect(res.status).toBe(404);
    expect(body.error).toContain('missing');
  });

  it('should return 404 when runB not found', async () => {
    mockKV.get.mockImplementation(async (key: string) => {
      if (key === 'eval:run:a') return JSON.stringify(MOCK_RUN_A);
      return null;
    });

    const res = await app.request('/v1/eval/compare?runA=a&runB=missing', {}, { SEARCH_CACHE: mockKV } as any);
    const body = await res.json() as any;

    expect(res.status).toBe(404);
    expect(body.error).toContain('missing');
  });

  it('should compute correct deltas between two runs', async () => {
    mockKV.get.mockImplementation(async (key: string) => {
      if (key === 'eval:run:a') return JSON.stringify(MOCK_RUN_A);
      if (key === 'eval:run:b') return JSON.stringify(MOCK_RUN_B);
      return null;
    });

    const res = await app.request('/v1/eval/compare?runA=a&runB=b', {}, { SEARCH_CACHE: mockKV } as any);
    const body = await res.json() as any;

    expect(res.status).toBe(200);

    // Run metadata
    expect(body.runA.runId).toBe('run-a-001');
    expect(body.runB.runId).toBe('run-b-002');

    // recall1: 0.65 → 0.70 = +0.05, improved
    expect(body.metrics.recall1.a).toBe(0.65);
    expect(body.metrics.recall1.b).toBe(0.70);
    expect(body.metrics.recall1.delta.value).toBe(0.05);
    expect(body.metrics.recall1.delta.improved).toBe(true);

    // recall5: 0.90 → 0.93 = +0.03, improved
    expect(body.metrics.recall5.delta.value).toBe(0.03);
    expect(body.metrics.recall5.delta.improved).toBe(true);

    // mrr: 0.75 → 0.80 = +0.05, improved
    expect(body.metrics.mrr.delta.value).toBe(0.05);
    expect(body.metrics.mrr.delta.improved).toBe(true);

    // Summaries
    expect(body.summary.a.passed).toBe(36);
    expect(body.summary.b.passed).toBe(38);

    // Tier distributions
    expect(body.tierDistribution.a.tier1).toBe(60);
    expect(body.tierDistribution.b.tier1).toBe(65);
  });

  it('should mark delta as not improved when metrics regress', async () => {
    const worsened = {
      ...MOCK_RUN_B,
      runId: 'run-worse',
      metrics: { ...MOCK_RUN_B.metrics, recall1: 0.50 },
    };

    mockKV.get.mockImplementation(async (key: string) => {
      if (key === 'eval:run:a') return JSON.stringify(MOCK_RUN_A);
      if (key === 'eval:run:b') return JSON.stringify(worsened);
      return null;
    });

    const res = await app.request('/v1/eval/compare?runA=a&runB=b', {}, { SEARCH_CACHE: mockKV } as any);
    const body = await res.json() as any;

    // recall1: 0.65 → 0.50 = -0.15, NOT improved
    expect(body.metrics.recall1.delta.value).toBe(-0.15);
    expect(body.metrics.recall1.delta.improved).toBe(false);
  });
});
