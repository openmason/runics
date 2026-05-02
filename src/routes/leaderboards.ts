// ══════════════════════════════════════════════════════════════════════════════
// Leaderboard Routes — OpenAPI
// ══════════════════════════════════════════════════════════════════════════════

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Env, LeaderboardFilters } from '../types';
import { createPool } from '../components';
import {
  LeaderboardResponseSchema,
  ErrorResponseSchema,
} from '../schemas/responses';
import {
  getHumanLeaderboard,
  getAgentLeaderboard,
  getTrendingLeaderboard,
  getMostComposedLeaderboard,
  getMostForkedLeaderboard,
} from '../social/leaderboards';

const app = new OpenAPIHono<{ Bindings: Env }>();

const LeaderboardQuerySchema = z.object({
  type: z.string().optional().openapi({ param: { name: 'type', in: 'query' } }),
  category: z.string().optional().openapi({ param: { name: 'category', in: 'query' } }),
  ecosystem: z.string().optional().openapi({ param: { name: 'ecosystem', in: 'query' } }),
  limit: z.string().optional().openapi({ param: { name: 'limit', in: 'query' } }),
  offset: z.string().optional().openapi({ param: { name: 'offset', in: 'query' } }),
});

function parseFilters(q: z.infer<typeof LeaderboardQuerySchema>): LeaderboardFilters {
  return {
    skillType: q.type as LeaderboardFilters['skillType'],
    category: q.category,
    ecosystem: q.ecosystem,
    limit: q.limit ? parseInt(q.limit) : undefined,
    offset: q.offset ? parseInt(q.offset) : undefined,
  };
}

// ── Human ──

const humanRoute = createRoute({
  method: 'get',
  path: '/v1/leaderboards/human',
  tags: ['Leaderboards'],
  summary: 'Human-starred leaderboard',
  request: { query: LeaderboardQuerySchema },
  responses: {
    200: { content: { 'application/json': { schema: LeaderboardResponseSchema } }, description: 'Leaderboard' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

app.openapi(humanRoute, async (c) => {
  const pool = createPool(c.env);
  try {
    const results = await getHumanLeaderboard(parseFilters(c.req.valid('query')), pool);
    return c.json({ leaderboard: results }, 200);
  } catch (error) {
    console.error('[LEADERBOARD] Human error:', error);
    return c.json({ error: 'Failed to get leaderboard' }, 500);
  }
});

// ── Agents ──

const agentsRoute = createRoute({
  method: 'get',
  path: '/v1/leaderboards/agents',
  tags: ['Leaderboards'],
  summary: 'Agent-invoked leaderboard',
  request: { query: LeaderboardQuerySchema },
  responses: {
    200: { content: { 'application/json': { schema: LeaderboardResponseSchema } }, description: 'Leaderboard' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

app.openapi(agentsRoute, async (c) => {
  const pool = createPool(c.env);
  try {
    const results = await getAgentLeaderboard(parseFilters(c.req.valid('query')), pool);
    return c.json({ leaderboard: results }, 200);
  } catch (error) {
    console.error('[LEADERBOARD] Agent error:', error);
    return c.json({ error: 'Failed to get leaderboard' }, 500);
  }
});

// ── Trending ──

const trendingRoute = createRoute({
  method: 'get',
  path: '/v1/leaderboards/trending',
  tags: ['Leaderboards'],
  summary: 'Trending skills leaderboard',
  request: { query: LeaderboardQuerySchema },
  responses: {
    200: { content: { 'application/json': { schema: LeaderboardResponseSchema } }, description: 'Leaderboard' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

app.openapi(trendingRoute, async (c) => {
  const pool = createPool(c.env);
  try {
    const results = await getTrendingLeaderboard(parseFilters(c.req.valid('query')), pool);
    return c.json({ leaderboard: results }, 200);
  } catch (error) {
    console.error('[LEADERBOARD] Trending error:', error);
    return c.json({ error: 'Failed to get leaderboard' }, 500);
  }
});

// ── Most Composed ──

const mostComposedRoute = createRoute({
  method: 'get',
  path: '/v1/leaderboards/most-composed',
  tags: ['Leaderboards'],
  summary: 'Most-composed skills leaderboard',
  request: { query: LeaderboardQuerySchema },
  responses: {
    200: { content: { 'application/json': { schema: LeaderboardResponseSchema } }, description: 'Leaderboard' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

app.openapi(mostComposedRoute, async (c) => {
  const pool = createPool(c.env);
  try {
    const results = await getMostComposedLeaderboard(parseFilters(c.req.valid('query')), pool);
    return c.json({ leaderboard: results }, 200);
  } catch (error) {
    console.error('[LEADERBOARD] Most-composed error:', error);
    return c.json({ error: 'Failed to get leaderboard' }, 500);
  }
});

// ── Most Forked ──

const mostForkedRoute = createRoute({
  method: 'get',
  path: '/v1/leaderboards/most-forked',
  tags: ['Leaderboards'],
  summary: 'Most-forked skills leaderboard',
  request: { query: LeaderboardQuerySchema },
  responses: {
    200: { content: { 'application/json': { schema: LeaderboardResponseSchema } }, description: 'Leaderboard' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

app.openapi(mostForkedRoute, async (c) => {
  const pool = createPool(c.env);
  try {
    const results = await getMostForkedLeaderboard(parseFilters(c.req.valid('query')), pool);
    return c.json({ leaderboard: results }, 200);
  } catch (error) {
    console.error('[LEADERBOARD] Most-forked error:', error);
    return c.json({ error: 'Failed to get leaderboard' }, 500);
  }
});

export { app as leaderboardRoutes };
