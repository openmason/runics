// ══════════════════════════════════════════════════════════════════════════════
// Tenant Context — Extract X-Tenant-Id from Request Headers (v5.3)
// ══════════════════════════════════════════════════════════════════════════════
//
// Runics is trusted internal infrastructure. Cortex handles auth via Mandate
// and passes tenant_id as a trusted parameter via X-Tenant-Id header.
//
// Behavior:
// - If X-Tenant-Id header present → use it
// - If absent → default to 'default' (public-facing api.runics.net)
//
// The tenant context is available via c.get('tenantId') in route handlers.
//
// ══════════════════════════════════════════════════════════════════════════════

import { createMiddleware } from 'hono/factory';
import type { Env } from '../types';

export function tenantContext() {
  return createMiddleware<{ Bindings: Env; Variables: { tenantId: string } }>(async (c, next) => {
    const tenantId = c.req.header('X-Tenant-Id') || 'default';
    c.set('tenantId', tenantId);
    await next();
  });
}
