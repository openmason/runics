// ══════════════════════════════════════════════════════════════════════════════
// Public Guard — Hostname-Based Route Filtering
// ══════════════════════════════════════════════════════════════════════════════
//
// On the public domain (api.runics.net), only read-only endpoints are exposed.
// Internal/staging domains pass through with all 57 endpoints available.
//
// Returns 404 (not 403) for blocked routes to avoid revealing internal surface.
//
// ══════════════════════════════════════════════════════════════════════════════

import { createMiddleware } from 'hono/factory';
import type { Env } from '../types';

const PUBLIC_HOSTNAME = 'api.runics.net';

// Routes allowed on the public domain (method + path prefix).
// Everything else returns 404.
const PUBLIC_ROUTES: Array<{ method: string; path: string; exact?: boolean }> = [
  // Health
  { method: 'GET', path: '/health' },
  // Search (exact — excludes /v1/search/feedback)
  { method: 'POST', path: '/v1/search', exact: true },
  // Skill detail (read-only GET — write methods are blocked)
  { method: 'GET', path: '/v1/skills/' },
  // Compositions (read-only GET)
  { method: 'GET', path: '/v1/compositions/' },
  // Leaderboards
  { method: 'GET', path: '/v1/leaderboards/' },
  // Authors (read-only)
  { method: 'GET', path: '/v1/authors/' },
  // Eval results (read-only)
  { method: 'GET', path: '/v1/eval/results' },
  { method: 'GET', path: '/v1/eval/compare' },
];

export function publicGuard() {
  return createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const hostname = new URL(c.req.url).hostname;

    if (hostname !== PUBLIC_HOSTNAME) {
      return next();
    }

    const method = c.req.method;
    const path = c.req.path;

    // CORS preflight must always pass through
    if (method === 'OPTIONS') {
      return next();
    }

    const allowed = PUBLIC_ROUTES.some(
      (r) =>
        method === r.method &&
        (r.exact ? path === r.path : path.startsWith(r.path)),
    );

    if (!allowed) {
      return c.json({ error: 'Not found' }, 404);
    }

    return next();
  });
}
