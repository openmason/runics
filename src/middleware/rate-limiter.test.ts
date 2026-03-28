import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { rateLimiter } from './rate-limiter';
import type { Env } from '../types';

describe('rateLimiter', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockKV: any;
  let mockExecCtx: any;

  beforeEach(() => {
    mockKV = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    };
    mockExecCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    };

    app = new Hono<{ Bindings: Env }>();
    app.use('/*', rateLimiter());
    app.get('/test', (c) => c.json({ ok: true }));
  });

  function makeRequest(overrides: Record<string, string> = {}) {
    return app.request(
      '/test',
      { headers: { 'cf-connecting-ip': '1.2.3.4', ...overrides } },
      { SEARCH_CACHE: mockKV, RATE_LIMIT_RPM: '10' } as any,
      mockExecCtx
    );
  }

  it('should allow requests under the limit', async () => {
    mockKV.get.mockResolvedValue('5');

    const res = await makeRequest();

    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('10');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('4');
  });

  it('should block requests at the limit with 429', async () => {
    mockKV.get.mockResolvedValue('10');

    const res = await makeRequest();

    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.error).toBe('Rate limit exceeded');
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('should block requests over the limit', async () => {
    mockKV.get.mockResolvedValue('15');

    const res = await makeRequest();

    expect(res.status).toBe(429);
  });

  it('should use cf-connecting-ip for identification', async () => {
    await makeRequest({ 'cf-connecting-ip': '10.0.0.1' });

    const key = mockKV.get.mock.calls[0][0];
    expect(key).toContain('10.0.0.1');
  });

  it('should fall back to x-forwarded-for', async () => {
    await makeRequest({
      'cf-connecting-ip': '',
      'x-forwarded-for': '192.168.1.1, 10.0.0.1',
    });

    const key = mockKV.get.mock.calls[0][0];
    expect(key).toContain('192.168.1.1');
  });

  it('should default to 100 RPM when env var not set', async () => {
    const app2 = new Hono<{ Bindings: Env }>();
    app2.use('/*', rateLimiter());
    app2.get('/test', (c) => c.json({ ok: true }));

    mockKV.get.mockResolvedValue('50');

    const res = await app2.request(
      '/test',
      { headers: { 'cf-connecting-ip': '1.1.1.1' } },
      { SEARCH_CACHE: mockKV } as any,
      mockExecCtx
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('100');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('49');
  });

  it('should set remaining to 0 when at limit minus 1', async () => {
    mockKV.get.mockResolvedValue('9');

    const res = await makeRequest();

    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
  });

  it('should increment counter via waitUntil with KV put', async () => {
    mockKV.get.mockResolvedValue('3');

    await makeRequest();

    // waitUntil is called with the KV put promise
    expect(mockExecCtx.waitUntil).toHaveBeenCalledTimes(1);
    // Await the promise to trigger the KV put
    await mockExecCtx.waitUntil.mock.calls[0][0];
    expect(mockKV.put).toHaveBeenCalledWith(
      expect.stringContaining('ratelimit:'),
      '4',
      { expirationTtl: 120 }
    );
  });

  it('should use minute-based sliding window key', async () => {
    await makeRequest();

    const key = mockKV.get.mock.calls[0][0];
    const minute = Math.floor(Date.now() / 60000);
    expect(key).toBe(`ratelimit:1.2.3.4:${minute}`);
  });

  it('should not call waitUntil when rate limited', async () => {
    mockKV.get.mockResolvedValue('10');

    const res = await makeRequest();

    expect(res.status).toBe(429);
    // waitUntil should NOT be called (no increment when blocked)
    expect(mockExecCtx.waitUntil).not.toHaveBeenCalled();
  });
});
