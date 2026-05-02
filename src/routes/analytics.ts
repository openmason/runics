// ══════════════════════════════════════════════════════════════════════════════
// Analytics Routes — OpenAPI
// ══════════════════════════════════════════════════════════════════════════════

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Env } from '../types';
import { initComponents, createPool } from '../components';
import { HoursQuery, LimitQuery } from '../schemas/common';
import {
  TierDistributionSchema,
  MatchSourcesResponseSchema,
  LatencyPercentilesSchema,
  CostBreakdownSchema,
  FailedQueriesResponseSchema,
  Tier3PatternsResponseSchema,
  RevokedImpactResponseSchema,
  VulnerableUsageResponseSchema,
  ErrorResponseSchema,
} from '../schemas/responses';

const app = new OpenAPIHono<{ Bindings: Env }>();

// ── GET /v1/analytics/tiers ──

const tiersRoute = createRoute({
  method: 'get',
  path: '/v1/analytics/tiers',
  tags: ['Analytics'],
  summary: 'Search tier distribution',
  request: { query: z.object({ hours: HoursQuery }) },
  responses: {
    200: { content: { 'application/json': { schema: TierDistributionSchema } }, description: 'Tier distribution' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

// @ts-expect-error response type validated at runtime by Zod
app.openapi(tiersRoute, async (c) => {
  try {
    const hours = parseInt(c.req.valid('query').hours || '24');
    const { qualityTracker } = initComponents(c.env);
    const distribution = await qualityTracker.getTierDistribution(hours);
    return c.json(distribution as any, 200);
  } catch (error) {
    console.error('Analytics error:', error);
    return c.json({ error: 'Failed to get tier distribution' }, 500);
  }
});

// ── GET /v1/analytics/match-sources ──

const matchSourcesRoute = createRoute({
  method: 'get',
  path: '/v1/analytics/match-sources',
  tags: ['Analytics'],
  summary: 'Match source breakdown',
  request: { query: z.object({ hours: HoursQuery }) },
  responses: {
    200: { content: { 'application/json': { schema: MatchSourcesResponseSchema } }, description: 'Match sources' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

// @ts-expect-error response type validated at runtime by Zod
app.openapi(matchSourcesRoute, async (c) => {
  try {
    const hours = parseInt(c.req.valid('query').hours || '24');
    const { qualityTracker } = initComponents(c.env);
    const stats = await qualityTracker.getMatchSourceStats(hours);
    return c.json({ matchSources: stats }, 200);
  } catch (error) {
    console.error('Analytics error:', error);
    return c.json({ error: 'Failed to get match source stats' }, 500);
  }
});

// ── GET /v1/analytics/latency ──

const latencyRoute = createRoute({
  method: 'get',
  path: '/v1/analytics/latency',
  tags: ['Analytics'],
  summary: 'Search latency percentiles',
  request: { query: z.object({ hours: HoursQuery }) },
  responses: {
    200: { content: { 'application/json': { schema: LatencyPercentilesSchema } }, description: 'Latency percentiles' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

// @ts-expect-error response type validated at runtime by Zod
app.openapi(latencyRoute, async (c) => {
  try {
    const hours = parseInt(c.req.valid('query').hours || '24');
    const { qualityTracker } = initComponents(c.env);
    const percentiles = await qualityTracker.getLatencyPercentiles(hours);
    return c.json(percentiles as any, 200);
  } catch (error) {
    console.error('Analytics error:', error);
    return c.json({ error: 'Failed to get latency percentiles' }, 500);
  }
});

// ── GET /v1/analytics/cost ──

const costRoute = createRoute({
  method: 'get',
  path: '/v1/analytics/cost',
  tags: ['Analytics'],
  summary: 'Search cost breakdown',
  request: { query: z.object({ hours: HoursQuery }) },
  responses: {
    200: { content: { 'application/json': { schema: CostBreakdownSchema } }, description: 'Cost breakdown' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

// @ts-expect-error response type validated at runtime by Zod
app.openapi(costRoute, async (c) => {
  try {
    const hours = parseInt(c.req.valid('query').hours || '24');
    const { qualityTracker } = initComponents(c.env);
    const breakdown = await qualityTracker.getCostBreakdown(hours);
    return c.json(breakdown as any, 200);
  } catch (error) {
    console.error('Analytics error:', error);
    return c.json({ error: 'Failed to get cost breakdown' }, 500);
  }
});

// ── GET /v1/analytics/failed-queries ──

const failedQueriesRoute = createRoute({
  method: 'get',
  path: '/v1/analytics/failed-queries',
  tags: ['Analytics'],
  summary: 'Recent failed/zero-result queries',
  request: { query: z.object({ hours: HoursQuery, limit: LimitQuery }) },
  responses: {
    200: { content: { 'application/json': { schema: FailedQueriesResponseSchema } }, description: 'Failed queries' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

app.openapi(failedQueriesRoute, async (c) => {
  try {
    const q = c.req.valid('query');
    const hours = parseInt(q.hours || '24');
    const limit = parseInt(q.limit || '100');
    const { qualityTracker } = initComponents(c.env);
    const queries = await qualityTracker.getFailedQueries(hours, limit);
    return c.json({ queries }, 200);
  } catch (error) {
    console.error('Analytics error:', error);
    return c.json({ error: 'Failed to get failed queries' }, 500);
  }
});

// ── GET /v1/analytics/tier3-patterns ──

const tier3PatternsRoute = createRoute({
  method: 'get',
  path: '/v1/analytics/tier3-patterns',
  tags: ['Analytics'],
  summary: 'Tier 3 query patterns (LLM fallback)',
  request: { query: z.object({ hours: HoursQuery }) },
  responses: {
    200: { content: { 'application/json': { schema: Tier3PatternsResponseSchema } }, description: 'Tier 3 patterns' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

app.openapi(tier3PatternsRoute, async (c) => {
  try {
    const hours = parseInt(c.req.valid('query').hours || '24');
    const { qualityTracker } = initComponents(c.env);
    const patterns = await qualityTracker.getTier3Patterns(hours);
    return c.json({ patterns }, 200);
  } catch (error) {
    console.error('Analytics error:', error);
    return c.json({ error: 'Failed to get tier 3 patterns' }, 500);
  }
});

// ── GET /v1/analytics/revoked-impact ──

const revokedImpactRoute = createRoute({
  method: 'get',
  path: '/v1/analytics/revoked-impact',
  tags: ['Analytics'],
  summary: 'Revoked skills impact analysis',
  responses: {
    200: { content: { 'application/json': { schema: RevokedImpactResponseSchema } }, description: 'Revoked impact' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

app.openapi(revokedImpactRoute, async (c) => {
  try {
    const pool = createPool(c.env);
    const [revokedResult, searchImpact] = await Promise.all([
      pool.query(
        `SELECT count(*)::int AS cnt,
                array_agg(json_build_object(
                  'slug', slug, 'name', name, 'source', source,
                  'revokedReason', revoked_reason,
                  'revokedAt', revoked_at,
                  'remediationMessage', remediation_message,
                  'replacementSkillId', replacement_skill_id
                ) ORDER BY revoked_at DESC NULLS LAST) AS skills
         FROM skills WHERE status = 'revoked'`
      ),
      pool.query(
        `SELECT count(*)::int AS cnt
         FROM search_logs
         WHERE timestamp > NOW() - INTERVAL '30 days'
           AND result_skill_ids && (SELECT array_agg(id) FROM skills WHERE status = 'revoked')`
      ).catch(() => ({ rows: [{ cnt: 0 }] })),
    ]);

    return c.json({
      revokedCount: revokedResult.rows[0].cnt,
      revokedSkills: (revokedResult.rows[0].skills ?? []).slice(0, 50),
      affectedSearches30d: searchImpact.rows[0].cnt,
    }, 200);
  } catch (error) {
    console.error('[ANALYTICS] Revoked impact error:', error);
    return c.json({ error: 'Failed to get revoked impact' }, 500);
  }
});

// ── GET /v1/analytics/vulnerable-usage ──

const vulnerableUsageRoute = createRoute({
  method: 'get',
  path: '/v1/analytics/vulnerable-usage',
  tags: ['Analytics'],
  summary: 'Vulnerable skills usage analysis',
  responses: {
    200: { content: { 'application/json': { schema: VulnerableUsageResponseSchema } }, description: 'Vulnerable usage' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

app.openapi(vulnerableUsageRoute, async (c) => {
  try {
    const pool = createPool(c.env);
    const [vulnerableResult, searchImpact] = await Promise.all([
      pool.query(
        `SELECT count(*)::int AS cnt,
                array_agg(json_build_object(
                  'slug', slug, 'name', name, 'source', source,
                  'trustScore', trust_score,
                  'verificationTier', verification_tier,
                  'runCount', run_count,
                  'cogniumScannedAt', cognium_scanned_at
                ) ORDER BY run_count DESC) AS skills
         FROM skills WHERE status = 'vulnerable'`
      ),
      pool.query(
        `SELECT count(*)::int AS cnt
         FROM search_logs
         WHERE timestamp > NOW() - INTERVAL '30 days'
           AND result_skill_ids && (SELECT array_agg(id) FROM skills WHERE status = 'vulnerable')`
      ).catch(() => ({ rows: [{ cnt: 0 }] })),
    ]);

    return c.json({
      vulnerableCount: vulnerableResult.rows[0].cnt,
      vulnerableSkills: (vulnerableResult.rows[0].skills ?? []).slice(0, 50),
      appearedInSearch30d: searchImpact.rows[0].cnt,
    }, 200);
  } catch (error) {
    console.error('[ANALYTICS] Vulnerable usage error:', error);
    return c.json({ error: 'Failed to get vulnerable usage' }, 500);
  }
});

export { app as analyticsRoutes };
