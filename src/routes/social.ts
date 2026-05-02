// ══════════════════════════════════════════════════════════════════════════════
// Social Routes — OpenAPI (stars, invocations, cooccurrence)
// ══════════════════════════════════════════════════════════════════════════════

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Env, InvocationBatch } from '../types';
import { createPool } from '../components';
import { SkillIdParam } from '../schemas/common';
import {
  StarResultSchema,
  StarStatusSchema,
  InvocationAcceptedSchema,
  CoOccurrenceResponseSchema,
  ErrorResponseSchema,
} from '../schemas/responses';
import { starSkill, unstarSkill, getStarStatus, RateLimitError } from '../social/stars';
import { recordInvocations } from '../social/invocations';
import { getCoOccurrence } from '../social/cooccurrence';

const app = new OpenAPIHono<{ Bindings: Env }>();

const StarInputSchema = z
  .object({
    userId: z.string().uuid(),
  })
  .openapi('StarInput');

// ── POST /v1/skills/:id/star ──

const starRoute = createRoute({
  method: 'post',
  path: '/v1/skills/{id}/star',
  tags: ['Social'],
  summary: 'Star a skill',
  request: {
    params: z.object({ id: SkillIdParam }),
    body: { content: { 'application/json': { schema: StarInputSchema } }, required: true },
  },
  responses: {
    200: { content: { 'application/json': { schema: StarResultSchema } }, description: 'Star result' },
    429: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Rate limited' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

// @ts-expect-error response type validated at runtime by Zod
app.openapi(starRoute, async (c) => {
  const skillId = c.req.valid('param').id;
  const { userId } = c.req.valid('json');
  const pool = createPool(c.env);

  try {
    const result = await starSkill(skillId, userId, pool);
    return c.json(result as any, 200);
  } catch (error) {
    if (error instanceof RateLimitError) return c.json({ error: error.message }, 429);
    console.error('[SOCIAL] Star error:', error);
    return c.json({ error: 'Failed to star skill' }, 500);
  }
});

// ── DELETE /v1/skills/:id/star ──

const unstarRoute = createRoute({
  method: 'delete',
  path: '/v1/skills/{id}/star',
  tags: ['Social'],
  summary: 'Unstar a skill',
  request: {
    params: z.object({ id: SkillIdParam }),
    body: { content: { 'application/json': { schema: StarInputSchema } }, required: true },
  },
  responses: {
    200: { content: { 'application/json': { schema: StarResultSchema } }, description: 'Unstar result' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Validation error' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

// @ts-expect-error response type validated at runtime by Zod
app.openapi(unstarRoute, async (c) => {
  const skillId = c.req.valid('param').id;
  const { userId } = c.req.valid('json');
  const pool = createPool(c.env);

  try {
    const result = await unstarSkill(skillId, userId, pool);
    return c.json(result as any, 200);
  } catch (error) {
    console.error('[SOCIAL] Unstar error:', error);
    return c.json({ error: 'Failed to unstar skill' }, 500);
  }
});

// ── GET /v1/skills/:id/stars ──

const starsRoute = createRoute({
  method: 'get',
  path: '/v1/skills/{id}/stars',
  tags: ['Social'],
  summary: 'Get star count and user status',
  request: {
    params: z.object({ id: SkillIdParam }),
    query: z.object({
      userId: z.string().optional().openapi({ param: { name: 'userId', in: 'query' } }),
    }),
  },
  responses: {
    200: { content: { 'application/json': { schema: StarStatusSchema } }, description: 'Star status' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

// @ts-expect-error response type validated at runtime by Zod
app.openapi(starsRoute, async (c) => {
  const skillId = c.req.valid('param').id;
  const userId = c.req.valid('query').userId || null;
  const pool = createPool(c.env);

  try {
    const result = await getStarStatus(skillId, userId, pool);
    return c.json(result as any, 200);
  } catch (error) {
    console.error('[SOCIAL] Stars error:', error);
    return c.json({ error: 'Failed to get star status' }, 500);
  }
});

// ── POST /v1/invocations ──

const InvocationBatchSchema = z
  .object({
    invocations: z.array(z.object({
      skillId: z.string().uuid(),
      compositionId: z.string().uuid().optional(),
      tenantId: z.string(),
      callerType: z.enum(['agent', 'human']),
      durationMs: z.number().int().optional(),
      succeeded: z.boolean(),
    })).min(1).max(500),
  })
  .openapi('InvocationBatch');

const invocationsRoute = createRoute({
  method: 'post',
  path: '/v1/invocations',
  tags: ['Social'],
  summary: 'Record skill invocations (batch)',
  request: {
    body: { content: { 'application/json': { schema: InvocationBatchSchema } }, required: true },
  },
  responses: {
    202: { content: { 'application/json': { schema: InvocationAcceptedSchema } }, description: 'Accepted' },
  },
});

app.openapi(invocationsRoute, async (c) => {
  const batch = c.req.valid('json') as InvocationBatch;
  const pool = createPool(c.env);

  c.executionCtx.waitUntil(
    recordInvocations(batch, pool).catch((e) =>
      console.error('[INVOCATIONS] Record error:', e.message)
    )
  );

  return c.json({ accepted: true, count: batch.invocations.length }, 202);
});

// ── GET /v1/skills/:id/cooccurrence ──

const cooccurrenceRoute = createRoute({
  method: 'get',
  path: '/v1/skills/{id}/cooccurrence',
  tags: ['Social'],
  summary: 'Get co-occurrence data for a skill',
  request: {
    params: z.object({ id: SkillIdParam }),
    query: z.object({
      limit: z.string().optional().openapi({ param: { name: 'limit', in: 'query' } }),
    }),
  },
  responses: {
    200: { content: { 'application/json': { schema: CoOccurrenceResponseSchema } }, description: 'Co-occurrence' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

app.openapi(cooccurrenceRoute, async (c) => {
  const skillId = c.req.valid('param').id;
  const limit = parseInt(c.req.valid('query').limit || '5');
  const pool = createPool(c.env);

  try {
    const results = await getCoOccurrence(skillId, limit, pool);
    return c.json({ cooccurrence: results }, 200);
  } catch (error) {
    console.error('[SOCIAL] Cooccurrence error:', error);
    return c.json({ error: 'Failed to get co-occurrence' }, 500);
  }
});

export { app as socialRoutes };
