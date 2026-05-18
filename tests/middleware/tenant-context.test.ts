import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { tenantContext } from '../../src/middleware/tenant-context';

// ── Tests ───────────────────────────────────────────────────────────────────

describe('tenantContext middleware', () => {
  function createApp() {
    const app = new Hono();
    app.use('*', tenantContext());
    app.get('/test', (c) => {
      return c.json({ tenantId: (c.get as any)('tenantId') });
    });
    return app;
  }

  it('should extract X-Tenant-Id from header', async () => {
    const app = createApp();
    const res = await app.request('/test', {
      headers: { 'X-Tenant-Id': 'acme-corp' },
    });
    const body = await res.json() as any;
    expect(body.tenantId).toBe('acme-corp');
  });

  it('should default to "default" when header is absent', async () => {
    const app = createApp();
    const res = await app.request('/test');
    const body = await res.json() as any;
    expect(body.tenantId).toBe('default');
  });

  it('should default to "default" when header is empty string', async () => {
    const app = createApp();
    const res = await app.request('/test', {
      headers: { 'X-Tenant-Id': '' },
    });
    const body = await res.json() as any;
    expect(body.tenantId).toBe('default');
  });

  it('should pass through to next middleware', async () => {
    const app = new Hono();
    app.use('*', tenantContext());
    app.get('/health', (c) => c.text('ok'));

    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});
