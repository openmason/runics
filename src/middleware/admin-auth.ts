// ══════════════════════════════════════════════════════════════════════════════
// Admin Auth — Bearer Token Authentication for Admin Endpoints
// ══════════════════════════════════════════════════════════════════════════════
//
// Validates `Authorization: Bearer <key>` against ADMIN_API_KEY env var.
// If ADMIN_API_KEY is not configured, all admin requests are rejected
// (fail-closed).
//
// Set the secret via: wrangler secret put ADMIN_API_KEY
//
// ══════════════════════════════════════════════════════════════════════════════

import { createMiddleware } from 'hono/factory';
import type { Env } from '../types';

export function adminAuth() {
  return createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const adminKey = c.env.ADMIN_API_KEY;

    // Fail-closed: if no key configured, reject all admin requests
    if (!adminKey) {
      return c.json({ error: 'Admin API not configured' }, 503);
    }

    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
      return c.json({ error: 'Missing Authorization header' }, 401);
    }

    const [scheme, token] = authHeader.split(' ', 2);
    if (scheme !== 'Bearer' || !token) {
      return c.json({ error: 'Invalid Authorization format. Expected: Bearer <token>' }, 401);
    }

    // Constant-time comparison to prevent timing attacks
    if (!timingSafeEqual(token, adminKey)) {
      return c.json({ error: 'Invalid admin API key' }, 403);
    }

    await next();
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);
  let result = 0;
  for (let i = 0; i < aBuf.length; i++) {
    result |= aBuf[i] ^ bBuf[i];
  }
  return result === 0;
}
