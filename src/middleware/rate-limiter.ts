// ══════════════════════════════════════════════════════════════════════════════
// Rate Limiter — KV-Based Per-IP Rate Limiting
// ══════════════════════════════════════════════════════════════════════════════
//
// Uses the SEARCH_CACHE KV namespace with a `ratelimit:` prefix.
// Sliding window per minute per IP. KV is eventually consistent,
// so this is approximate rate limiting (acceptable for Workers).
//
// ══════════════════════════════════════════════════════════════════════════════

import { createMiddleware } from 'hono/factory';
import type { Env } from '../types';

export function rateLimiter() {
  return createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const kv = c.env.SEARCH_CACHE;
    const rpm = parseInt(c.env.RATE_LIMIT_RPM || '100');

    const ip =
      c.req.header('cf-connecting-ip') ||
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      'unknown';

    const minute = Math.floor(Date.now() / 60000);
    const key = `ratelimit:${ip}:${minute}`;

    const current = parseInt((await kv.get(key)) || '0');

    if (current >= rpm) {
      const retryAfter = 60 - (Math.floor(Date.now() / 1000) % 60);
      c.header('Retry-After', String(retryAfter));
      return c.json(
        { error: 'Rate limit exceeded', retryAfterSeconds: retryAfter },
        429
      );
    }

    // Increment counter (non-blocking)
    c.executionCtx.waitUntil(
      kv.put(key, String(current + 1), { expirationTtl: 120 })
    );

    // Add rate limit headers
    c.header('X-RateLimit-Limit', String(rpm));
    c.header('X-RateLimit-Remaining', String(Math.max(0, rpm - current - 1)));

    await next();
  });
}
