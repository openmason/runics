import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { publicGuard } from './public-guard';
import type { Env } from '../types';

describe('publicGuard', () => {
  let app: Hono<{ Bindings: Env }>;

  function setup() {
    app = new Hono<{ Bindings: Env }>();
    app.use('*', publicGuard());

    // Read-only routes
    app.get('/health', (c) => c.json({ ok: true }));
    app.post('/v1/search', (c) => c.json({ results: [] }));
    app.get('/v1/skills/:slug', (c) => c.json({ slug: c.req.param('slug') }));
    app.get('/v1/skills/:slug/versions', (c) => c.json({ versions: [] }));
    app.get('/v1/skills/:id/lineage', (c) => c.json({ lineage: [] }));
    app.get('/v1/skills/:id/forks', (c) => c.json({ forks: [] }));
    app.get('/v1/skills/:id/stars', (c) => c.json({ stars: 0 }));
    app.get('/v1/compositions/:id', (c) => c.json({ id: c.req.param('id') }));
    app.get('/v1/leaderboards/human', (c) => c.json({ entries: [] }));
    app.get('/v1/authors/:handle', (c) => c.json({ handle: c.req.param('handle') }));
    app.get('/v1/eval/results', (c) => c.json({ runs: [] }));
    app.get('/v1/eval/compare', (c) => c.json({ comparison: {} }));

    // Write routes (should be blocked on public)
    app.post('/v1/skills', (c) => c.json({ created: true }));
    app.post('/v1/skills/:id/fork', (c) => c.json({ forked: true }));
    app.post('/v1/skills/:id/star', (c) => c.json({ starred: true }));
    app.delete('/v1/skills/:id', (c) => c.json({ deleted: true }));
    app.post('/v1/invocations', (c) => c.json({ ok: true }));
    app.post('/v1/compositions', (c) => c.json({ created: true }));
    app.get('/v1/admin/scan-stats', (c) => c.json({ stats: {} }));
    app.get('/v1/analytics/tiers', (c) => c.json({ tiers: {} }));
    app.post('/v1/eval/run', (c) => c.json({ running: true }));
    app.post('/v1/search/feedback', (c) => c.json({ ok: true }));
  }

  const PUBLIC = 'https://api.runics.net';
  const INTERNAL = 'https://runics.phantoms.workers.dev';

  describe('public domain (api.runics.net)', () => {
    it('should allow GET /health', async () => {
      setup();
      const res = await app.request(`${PUBLIC}/health`);
      expect(res.status).toBe(200);
    });

    it('should allow POST /v1/search', async () => {
      setup();
      const res = await app.request(`${PUBLIC}/v1/search`, { method: 'POST' });
      expect(res.status).toBe(200);
    });

    it('should allow GET /v1/skills/:slug', async () => {
      setup();
      const res = await app.request(`${PUBLIC}/v1/skills/my-skill`);
      expect(res.status).toBe(200);
    });

    it('should allow GET /v1/skills/:slug/versions', async () => {
      setup();
      const res = await app.request(`${PUBLIC}/v1/skills/my-skill/versions`);
      expect(res.status).toBe(200);
    });

    it('should allow GET /v1/skills/:id/lineage', async () => {
      setup();
      const res = await app.request(`${PUBLIC}/v1/skills/abc/lineage`);
      expect(res.status).toBe(200);
    });

    it('should allow GET /v1/leaderboards/human', async () => {
      setup();
      const res = await app.request(`${PUBLIC}/v1/leaderboards/human`);
      expect(res.status).toBe(200);
    });

    it('should allow GET /v1/authors/:handle', async () => {
      setup();
      const res = await app.request(`${PUBLIC}/v1/authors/testuser`);
      expect(res.status).toBe(200);
    });

    it('should allow GET /v1/eval/results', async () => {
      setup();
      const res = await app.request(`${PUBLIC}/v1/eval/results`);
      expect(res.status).toBe(200);
    });

    it('should allow GET /v1/eval/compare', async () => {
      setup();
      const res = await app.request(`${PUBLIC}/v1/eval/compare`);
      expect(res.status).toBe(200);
    });

    it('should allow GET /v1/compositions/:id', async () => {
      setup();
      const res = await app.request(`${PUBLIC}/v1/compositions/comp-1`);
      expect(res.status).toBe(200);
    });

    it('should block POST /v1/skills (publish)', async () => {
      setup();
      const res = await app.request(`${PUBLIC}/v1/skills`, { method: 'POST' });
      expect(res.status).toBe(404);
    });

    it('should block POST /v1/skills/:id/fork', async () => {
      setup();
      const res = await app.request(`${PUBLIC}/v1/skills/abc/fork`, { method: 'POST' });
      expect(res.status).toBe(404);
    });

    it('should block POST /v1/skills/:id/star', async () => {
      setup();
      const res = await app.request(`${PUBLIC}/v1/skills/abc/star`, { method: 'POST' });
      expect(res.status).toBe(404);
    });

    it('should block DELETE /v1/skills/:id', async () => {
      setup();
      const res = await app.request(`${PUBLIC}/v1/skills/abc`, { method: 'DELETE' });
      expect(res.status).toBe(404);
    });

    it('should block POST /v1/invocations', async () => {
      setup();
      const res = await app.request(`${PUBLIC}/v1/invocations`, { method: 'POST' });
      expect(res.status).toBe(404);
    });

    it('should block POST /v1/compositions (create)', async () => {
      setup();
      const res = await app.request(`${PUBLIC}/v1/compositions`, { method: 'POST' });
      expect(res.status).toBe(404);
    });

    it('should block GET /v1/admin/*', async () => {
      setup();
      const res = await app.request(`${PUBLIC}/v1/admin/scan-stats`);
      expect(res.status).toBe(404);
    });

    it('should block GET /v1/analytics/*', async () => {
      setup();
      const res = await app.request(`${PUBLIC}/v1/analytics/tiers`);
      expect(res.status).toBe(404);
    });

    it('should block POST /v1/eval/run', async () => {
      setup();
      const res = await app.request(`${PUBLIC}/v1/eval/run`, { method: 'POST' });
      expect(res.status).toBe(404);
    });

    it('should block POST /v1/search/feedback', async () => {
      setup();
      const res = await app.request(`${PUBLIC}/v1/search/feedback`, { method: 'POST' });
      expect(res.status).toBe(404);
    });

    it('should return 404 body with error message', async () => {
      setup();
      const res = await app.request(`${PUBLIC}/v1/admin/scan-stats`);
      const body = await res.json() as any;
      expect(body.error).toBe('Not found');
    });
  });

  describe('internal domain (workers.dev)', () => {
    it('should allow all routes on internal domain', async () => {
      setup();

      const res1 = await app.request(`${INTERNAL}/v1/admin/scan-stats`);
      expect(res1.status).toBe(200);

      const res2 = await app.request(`${INTERNAL}/v1/skills`, { method: 'POST' });
      expect(res2.status).toBe(200);

      const res3 = await app.request(`${INTERNAL}/v1/analytics/tiers`);
      expect(res3.status).toBe(200);

      const res4 = await app.request(`${INTERNAL}/v1/eval/run`, { method: 'POST' });
      expect(res4.status).toBe(200);
    });
  });

  describe('localhost', () => {
    it('should allow all routes on localhost', async () => {
      setup();

      const res = await app.request('http://localhost:8787/v1/admin/scan-stats');
      expect(res.status).toBe(200);
    });
  });
});
