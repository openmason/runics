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
    if (!(await timingSafeEqual(token, adminKey))) {
      return c.json({ error: 'Invalid admin API key' }, 403);
    }

    await next();
  });
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  // Hash both values to fixed-length digests so comparison
  // never leaks the length of the actual key
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const aArr = new Uint8Array(aHash);
  const bArr = new Uint8Array(bHash);
  if (aArr.length !== bArr.length) return false;
  let result = 0;
  for (let i = 0; i < aArr.length; i++) {
    result |= aArr[i] ^ bArr[i];
  }
  return result === 0;
}
