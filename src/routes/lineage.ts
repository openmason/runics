// ══════════════════════════════════════════════════════════════════════════════
// Lineage Routes — OpenAPI
// ══════════════════════════════════════════════════════════════════════════════

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Env } from '../types';
import { createPool } from '../components';
import { SkillIdParam } from '../schemas/common';
import {
  AncestryResponseSchema,
  ForksResponseSchema,
  DependentsResponseSchema,
  ErrorResponseSchema,
} from '../schemas/responses';
import { getAncestry, getForks, getDependents } from '../composition/lineage';

const app = new OpenAPIHono<{ Bindings: Env }>();

// ── GET /v1/skills/:id/lineage ──

const lineageRoute = createRoute({
  method: 'get',
  path: '/v1/skills/{id}/lineage',
  tags: ['Lineage'],
  summary: 'Get ancestry chain for a skill',
  request: {
    params: z.object({ id: SkillIdParam }),
  },
  responses: {
    200: { content: { 'application/json': { schema: AncestryResponseSchema } }, description: 'Ancestry' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

app.openapi(lineageRoute, async (c) => {
  const skillId = c.req.valid('param').id;
  const pool = createPool(c.env);
  try {
    const ancestry = await getAncestry(skillId, pool);
    return c.json({ ancestry }, 200);
  } catch (error) {
    console.error('[LINEAGE] Error:', error);
    return c.json({ error: 'Failed to get lineage' }, 500);
  }
});

// ── GET /v1/skills/:id/forks ──

const forksRoute = createRoute({
  method: 'get',
  path: '/v1/skills/{id}/forks',
  tags: ['Lineage'],
  summary: 'Get forks of a skill',
  request: {
    params: z.object({ id: SkillIdParam }),
  },
  responses: {
    200: { content: { 'application/json': { schema: ForksResponseSchema } }, description: 'Forks' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

app.openapi(forksRoute, async (c) => {
  const skillId = c.req.valid('param').id;
  const pool = createPool(c.env);
  try {
    const forks = await getForks(skillId, pool);
    return c.json({ forks }, 200);
  } catch (error) {
    console.error('[LINEAGE] Error:', error);
    return c.json({ error: 'Failed to get forks' }, 500);
  }
});

// ── GET /v1/skills/:id/dependents ──

const dependentsRoute = createRoute({
  method: 'get',
  path: '/v1/skills/{id}/dependents',
  tags: ['Lineage'],
  summary: 'Get skills depending on this one',
  request: {
    params: z.object({ id: SkillIdParam }),
  },
  responses: {
    200: { content: { 'application/json': { schema: DependentsResponseSchema } }, description: 'Dependents' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

app.openapi(dependentsRoute, async (c) => {
  const skillId = c.req.valid('param').id;
  const pool = createPool(c.env);
  try {
    const dependents = await getDependents(skillId, pool);
    return c.json({ dependents }, 200);
  } catch (error) {
    console.error('[LINEAGE] Error:', error);
    return c.json({ error: 'Failed to get dependents' }, 500);
  }
});

export { app as lineageRoutes };
