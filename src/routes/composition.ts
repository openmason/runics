// ══════════════════════════════════════════════════════════════════════════════
// Composition Routes — OpenAPI
// ══════════════════════════════════════════════════════════════════════════════

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Env } from '../types';
import { createPool } from '../components';
import { SkillIdParam } from '../schemas/common';
import {
  CompositionDetailSchema,
  ErrorResponseSchema,
} from '../schemas/responses';
import { forkSkill, NotFoundError } from '../composition/fork';
import { copySkill } from '../composition/copy';
import { createComposition, ValidationError } from '../composition/compose';
import { extendComposition } from '../composition/extend';
import { publishComposition } from '../composition/publish';
import {
  forkInputSchema,
  copyInputSchema,
  compositionInputSchema,
  extendInputSchema,
} from '../composition/schema';

const app = new OpenAPIHono<{ Bindings: Env }>();

const CreatedResponseSchema = z.object({}).passthrough().openapi('CompositionCreated');
const StepsUpdatedSchema = z.object({ id: z.string(), status: z.string() }).openapi('StepsUpdated');

// ── POST /v1/skills/:id/fork ──

const forkRoute = createRoute({
  method: 'post',
  path: '/v1/skills/{id}/fork',
  tags: ['Composition'],
  summary: 'Fork a skill',
  request: {
    params: z.object({ id: SkillIdParam }),
    body: { content: { 'application/json': { schema: forkInputSchema } }, required: true },
  },
  responses: {
    201: { content: { 'application/json': { schema: CreatedResponseSchema } }, description: 'Fork created' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

// @ts-expect-error response type validated at runtime by Zod
app.openapi(forkRoute, async (c) => {
  const sourceId = c.req.valid('param').id;
  const { authorId, authorType } = c.req.valid('json');
  const pool = createPool(c.env);

  try {
    const result = await forkSkill(sourceId, authorId, authorType, pool, c.env);
    return c.json(result as any, 201);
  } catch (error) {
    if (error instanceof NotFoundError) return c.json({ error: error.message }, 404);
    console.error('[COMPOSITION] Fork error:', error);
    return c.json({ error: 'Failed to fork skill' }, 500);
  }
});

// ── POST /v1/skills/:id/copy ──

const copyRoute = createRoute({
  method: 'post',
  path: '/v1/skills/{id}/copy',
  tags: ['Composition'],
  summary: 'Copy a skill',
  request: {
    params: z.object({ id: SkillIdParam }),
    body: { content: { 'application/json': { schema: copyInputSchema } }, required: true },
  },
  responses: {
    201: { content: { 'application/json': { schema: CreatedResponseSchema } }, description: 'Copy created' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

// @ts-expect-error response type validated at runtime by Zod
app.openapi(copyRoute, async (c) => {
  const sourceId = c.req.valid('param').id;
  const { authorId, authorType } = c.req.valid('json');
  const pool = createPool(c.env);

  try {
    const result = await copySkill(sourceId, authorId, authorType, pool, c.env);
    return c.json(result as any, 201);
  } catch (error) {
    if (error instanceof NotFoundError) return c.json({ error: error.message }, 404);
    console.error('[COMPOSITION] Copy error:', error);
    return c.json({ error: 'Failed to copy skill' }, 500);
  }
});

// ── POST /v1/skills/:id/extend ──

const extendRoute = createRoute({
  method: 'post',
  path: '/v1/skills/{id}/extend',
  tags: ['Composition'],
  summary: 'Extend a composition with more steps',
  request: {
    params: z.object({ id: SkillIdParam }),
    body: { content: { 'application/json': { schema: extendInputSchema } }, required: true },
  },
  responses: {
    201: { content: { 'application/json': { schema: CreatedResponseSchema } }, description: 'Extended' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Validation error' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

// @ts-expect-error response type validated at runtime by Zod
app.openapi(extendRoute, async (c) => {
  const compositionId = c.req.valid('param').id;
  const { authorId, authorType, steps } = c.req.valid('json');
  const pool = createPool(c.env);

  try {
    const result = await extendComposition(
      compositionId, steps, authorId, authorType, pool, c.env
    );
    return c.json(result as any, 201);
  } catch (error) {
    if (error instanceof NotFoundError) return c.json({ error: error.message }, 404);
    if (error instanceof ValidationError) return c.json({ error: error.message }, 400);
    console.error('[COMPOSITION] Extend error:', error);
    return c.json({ error: 'Failed to extend composition' }, 500);
  }
});

// ── POST /v1/compositions ──

const createCompositionRoute = createRoute({
  method: 'post',
  path: '/v1/compositions',
  tags: ['Composition'],
  summary: 'Create a new composition',
  request: {
    body: { content: { 'application/json': { schema: compositionInputSchema } }, required: true },
  },
  responses: {
    201: { content: { 'application/json': { schema: CreatedResponseSchema } }, description: 'Composition created' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Validation error' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

// @ts-expect-error response type validated at runtime by Zod
app.openapi(createCompositionRoute, async (c) => {
  const input = c.req.valid('json');
  const pool = createPool(c.env);

  try {
    const result = await createComposition(input, pool, c.env);
    return c.json(result as any, 201);
  } catch (error) {
    if (error instanceof ValidationError) return c.json({ error: error.message }, 400);
    console.error('[COMPOSITION] Create error:', error);
    return c.json({ error: 'Failed to create composition' }, 500);
  }
});

// ── GET /v1/compositions/:id ──

const getCompositionRoute = createRoute({
  method: 'get',
  path: '/v1/compositions/{id}',
  tags: ['Composition'],
  summary: 'Get composition detail with steps',
  request: {
    params: z.object({ id: SkillIdParam }),
  },
  responses: {
    200: { content: { 'application/json': { schema: CompositionDetailSchema } }, description: 'Composition detail' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

// @ts-expect-error response type validated at runtime by Zod
app.openapi(getCompositionRoute, async (c) => {
  const compositionId = c.req.valid('param').id;
  const pool = createPool(c.env);

  try {
    const skill = await pool.query(
      `SELECT * FROM skills WHERE id = $1 AND skill_type IN ('auto-composite', 'human-composite', 'composition', 'pipeline')`,
      [compositionId]
    );
    if (skill.rows.length === 0) return c.json({ error: 'Composition not found' }, 404);

    const steps = await pool.query(
      `SELECT cs.*, s.name AS skill_name, s.slug AS skill_slug
       FROM composition_steps cs
       JOIN skills s ON s.id = cs.skill_id
       WHERE cs.composition_id = $1
       ORDER BY cs.step_order`,
      [compositionId]
    );

    return c.json({
      ...skill.rows[0],
      steps: steps.rows.map((r: any) => ({
        id: r.id,
        stepOrder: r.step_order,
        skillId: r.skill_id,
        skillName: r.skill_name,
        skillSlug: r.skill_slug,
        stepName: r.step_name,
        inputMapping: r.input_mapping,
        onError: r.on_error,
      })),
    } as any, 200);
  } catch (error) {
    console.error('[COMPOSITION] Get error:', error);
    return c.json({ error: 'Failed to get composition' }, 500);
  }
});

// ── PUT /v1/compositions/:id/steps ──

const ReplaceStepsBodySchema = z
  .object({
    steps: z.array(z.object({
      skillId: z.string().uuid(),
      stepName: z.string().optional(),
      inputMapping: z.record(z.string()).optional(),
      onError: z.enum(['fail', 'skip', 'retry']).optional(),
    })).min(2),
  })
  .openapi('ReplaceStepsBody');

const replaceStepsRoute = createRoute({
  method: 'put',
  path: '/v1/compositions/{id}/steps',
  tags: ['Composition'],
  summary: 'Replace all steps in a draft composition',
  request: {
    params: z.object({ id: SkillIdParam }),
    body: { content: { 'application/json': { schema: ReplaceStepsBodySchema } }, required: true },
  },
  responses: {
    200: { content: { 'application/json': { schema: StepsUpdatedSchema } }, description: 'Steps updated' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Validation error' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

app.openapi(replaceStepsRoute, async (c) => {
  const compositionId = c.req.valid('param').id;
  const pool = createPool(c.env);

  try {
    const { steps } = c.req.valid('json');

    const skill = await pool.query(
      `SELECT status, skill_type FROM skills WHERE id = $1`,
      [compositionId]
    );
    if (skill.rows.length === 0) return c.json({ error: 'Composition not found' }, 404);
    if (skill.rows[0].status !== 'draft') {
      return c.json({ error: 'Can only modify steps on draft compositions' }, 400);
    }

    await pool.query(`DELETE FROM composition_steps WHERE composition_id = $1`, [compositionId]);

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      await pool.query(
        `INSERT INTO composition_steps (composition_id, step_order, skill_id, step_name, input_mapping, on_error)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          compositionId, i + 1, step.skillId,
          step.stepName || null,
          step.inputMapping ? JSON.stringify(step.inputMapping) : null,
          step.onError || 'fail',
        ]
      );
    }

    return c.json({ id: compositionId, status: 'steps_updated' }, 200);
  } catch (error) {
    console.error('[COMPOSITION] Replace steps error:', error);
    return c.json({ error: 'Failed to replace steps' }, 500);
  }
});

// ── POST /v1/compositions/:id/publish ──

const publishCompositionRoute = createRoute({
  method: 'post',
  path: '/v1/compositions/{id}/publish',
  tags: ['Composition'],
  summary: 'Publish a draft composition',
  request: {
    params: z.object({ id: SkillIdParam }),
  },
  responses: {
    200: { content: { 'application/json': { schema: CreatedResponseSchema } }, description: 'Published' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Validation error' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

// @ts-expect-error response type validated at runtime by Zod
app.openapi(publishCompositionRoute, async (c) => {
  const compositionId = c.req.valid('param').id;
  const pool = createPool(c.env);

  try {
    const result = await publishComposition(compositionId, pool);
    return c.json(result as any, 200);
  } catch (error) {
    if (error instanceof NotFoundError) return c.json({ error: error.message }, 404);
    if (error instanceof ValidationError) return c.json({ error: error.message }, 400);
    console.error('[COMPOSITION] Publish error:', error);
    return c.json({ error: 'Failed to publish composition' }, 500);
  }
});

export { app as compositionRoutes };
