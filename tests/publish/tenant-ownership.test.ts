import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { publishRoutes } from '../../src/publish/handler';
import { tenantContext } from '../../src/middleware/tenant-context';

// ── Module mocks ────────────────────────────────────────────────────────────

const mockPoolQuery = vi.fn();

vi.mock('../../src/db/connection', () => ({
  createPool: vi.fn(() => ({
    query: mockPoolQuery,
  })),
}));

vi.mock('../../src/publish/dag-validator', () => ({
  validateWorkflowDefinition: vi.fn(() => ({ valid: true })),
}));

vi.mock('../../src/cognium/notification-trigger', () => ({
  emitSkillEvent: vi.fn(),
}));

// ── Mock helpers ────────────────────────────────────────────────────────────

const mockEnv = {
  NEON_CONNECTION_STRING: 'postgresql://test',
  EMBED_QUEUE: { send: vi.fn() },
  COGNIUM_QUEUE: { send: vi.fn() },
  SEARCH_CACHE: { put: vi.fn(), get: vi.fn(async () => null), delete: vi.fn(), list: vi.fn(async () => ({ keys: [] })) },
  CACHE_TTL_SECONDS: '120',
  R2_BUCKET: { put: vi.fn() },
};

const mockExecutionCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };

function createApp() {
  const app = new Hono<{ Bindings: any }>();
  app.use('*', tenantContext());
  app.route('/v1/skills', publishRoutes);
  return app;
}

function validSkillBody(overrides?: Record<string, any>) {
  return {
    name: 'Test Skill',
    slug: 'test-skill',
    description: 'A test skill for testing tenant ownership enforcement',
    executionLayer: 'mcp-remote',
    ...overrides,
  };
}

async function makeRequest(
  app: Hono<any>,
  path: string,
  options: { method: string; headers?: Record<string, string>; body?: string },
) {
  const url = `http://localhost${path}`;
  const req = new Request(url, {
    method: options.method,
    headers: options.headers,
    body: options.body,
  });
  return app.fetch(req, mockEnv, mockExecutionCtx as any);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('tenant ownership enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolQuery.mockReset();
  });

  describe('POST /v1/skills (tenant_id from header)', () => {
    it('should use X-Tenant-Id header as effective tenant', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'new-id', slug: 'test-skill', version: '1.0.0' }],
      });

      const app = createApp();
      const res = await makeRequest(app, '/v1/skills', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': 'acme-corp',
        },
        body: JSON.stringify(validSkillBody()),
      });

      expect(res.status).toBe(201);
      const insertParams = mockPoolQuery.mock.calls[0][1];
      expect(insertParams[12]).toBe('acme-corp');
    });

    it('should fall back to null when no tenant header and no body tenantId', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'new-id', slug: 'test-skill', version: '1.0.0' }],
      });

      const app = createApp();
      const res = await makeRequest(app, '/v1/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSkillBody()),
      });

      expect(res.status).toBe(201);
      const insertParams = mockPoolQuery.mock.calls[0][1];
      expect(insertParams[12]).toBeNull();
    });
  });

  describe('PUT /v1/skills/:id (tenant check)', () => {
    it('should allow update when tenant matches', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ status: 'draft', execution_layer: 'mcp-remote', tenant_id: 'acme-corp' }],
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'skill-1', slug: 'test-skill' }],
      });

      const app = createApp();
      const res = await makeRequest(app, '/v1/skills/skill-1', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': 'acme-corp',
        },
        body: JSON.stringify({ name: 'Updated Name' }),
      });

      expect(res.status).toBe(200);
    });

    it('should reject update when tenant does not match', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ status: 'draft', execution_layer: 'mcp-remote', tenant_id: 'acme-corp' }],
      });

      const app = createApp();
      const res = await makeRequest(app, '/v1/skills/skill-1', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': 'evil-corp',
        },
        body: JSON.stringify({ name: 'Hijacked Name' }),
      });

      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.error).toContain('forbidden');
    });

    it('should allow update when caller is default tenant', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ status: 'draft', execution_layer: 'mcp-remote', tenant_id: 'acme-corp' }],
      });
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'skill-1', slug: 'test-skill' }],
      });

      const app = createApp();
      const res = await makeRequest(app, '/v1/skills/skill-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Admin Update' }),
      });

      expect(res.status).toBe(200);
    });
  });

  describe('PATCH /v1/skills/:id/status (tenant check)', () => {
    it('should reject status change when tenant does not match', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ status: 'published', slug: 'test-skill', version: '1.0.0', tenant_id: 'acme-corp' }],
      });

      const app = createApp();
      const res = await makeRequest(app, '/v1/skills/skill-1/status', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': 'evil-corp',
        },
        body: JSON.stringify({ status: 'deprecated' }),
      });

      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.error).toContain('forbidden');
    });

    it('should allow status change when tenant matches', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ status: 'published', slug: 'test-skill', version: '1.0.0', tenant_id: 'acme-corp' }],
      });
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const app = createApp();
      const res = await makeRequest(app, '/v1/skills/skill-1/status', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': 'acme-corp',
        },
        body: JSON.stringify({ status: 'deprecated' }),
      });

      expect(res.status).toBe(200);
    });
  });
});
