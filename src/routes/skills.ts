// ══════════════════════════════════════════════════════════════════════════════
// Skills Routes — OpenAPI (read-only public + delete)
// ══════════════════════════════════════════════════════════════════════════════

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Env } from '../types';
import { initComponents, createPool } from '../components';
import { SkillIdParam, SkillSlugParam, VersionParam } from '../schemas/common';
import {
  SkillDetailSchema,
  SkillPullResponseSchema,
  SkillVersionsResponseSchema,
  ErrorResponseSchema,
  DeleteResultSchema,
} from '../schemas/responses';

const app = new OpenAPIHono<{ Bindings: Env }>();

// ── DELETE /v1/skills/:skillId ──

const deleteSkillRoute = createRoute({
  method: 'delete',
  path: '/v1/skills/{skillId}',
  tags: ['Skills'],
  summary: 'Delete a draft skill',
  request: {
    params: z.object({
      skillId: z.string().uuid().openapi({ param: { name: 'skillId', in: 'path' } }),
    }),
  },
  responses: {
    200: { content: { 'application/json': { schema: DeleteResultSchema } }, description: 'Skill deleted' },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not a draft' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

app.openapi(deleteSkillRoute, async (c) => {
  try {
    const skillId = c.req.valid('param').skillId;

    const pool = createPool(c.env);
    const skillResult = await pool.query(
      `SELECT id, status FROM skills WHERE id = $1`,
      [skillId]
    );

    if (skillResult.rows.length === 0) {
      return c.json({ error: 'not found' }, 404);
    }

    if (skillResult.rows[0].status !== 'draft') {
      return c.json(
        { error: 'only draft skills can be deleted — use PATCH /v1/skills/:id/status to deprecate published skills' },
        400
      );
    }

    const { provider } = initComponents(c.env);
    await provider.delete(skillId);
    await pool.query(`DELETE FROM skill_embeddings WHERE skill_id = $1`, [skillId]);
    await pool.query(`DELETE FROM skills WHERE id = $1`, [skillId]);

    return c.json({ id: skillId, status: 'deleted' as const }, 200);
  } catch (error) {
    console.error('Delete error:', error);
    return c.json({ error: 'Failed to delete skill' }, 500);
  }
});

// ── GET /v1/skills/:slug ──

const skillDetailRoute = createRoute({
  method: 'get',
  path: '/v1/skills/{slug}',
  tags: ['Skills'],
  summary: 'Get skill detail by slug',
  request: {
    params: z.object({ slug: SkillSlugParam }),
  },
  responses: {
    200: { content: { 'application/json': { schema: SkillDetailSchema } }, description: 'Skill detail' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

// @ts-expect-error response type validated at runtime by Zod
app.openapi(skillDetailRoute, async (c) => {
  const slug = c.req.valid('param').slug;
  const pool = createPool(c.env);

  try {
    const result = await pool.query(
      `SELECT
        s.id, s.name, s.slug, s.version, s.description, s.agent_summary,
        s.trust_score, s.verification_tier, s.trust_badge, s.status,
        s.execution_layer, s.mcp_url, s.skill_md, s.capabilities_required,
        s.skill_type, s.schema_json, s.source, s.source_url,
        s.tags, s.category, s.categories, s.ecosystem, s.language, s.license,
        s.readme, s.r2_bundle_key, s.auth_requirements, s.install_method,
        s.forked_from, s.run_count, s.last_run_at,
        s.author_id, s.author_type, s.tenant_id,
        s.revoked_reason, s.remediation_message, s.remediation_url,
        s.replacement_skill_id, rs.slug AS replacement_slug,
        s.avg_execution_time_ms, s.error_rate,
        s.human_star_count, s.human_fork_count, s.agent_invocation_count,
        s.runtime_env, s.visibility, s.environment_variables,
        s.cognium_scanned_at, s.content_safety_passed,
        s.quality_score, s.quality_tier, s.quality_results, s.quality_analyzed_at,
        s.trust_score_v2, s.trust_tier, s.trust_results, s.trust_analyzed_at,
        s.understand_results, s.understand_analyzed_at,
        s.spec_alignment_score, s.spec_gaps, s.spec_analyzed_at,
        s.created_at, s.updated_at, s.published_at
      FROM skills s
      LEFT JOIN skills rs ON rs.id = s.replacement_skill_id
      WHERE s.slug = $1
      ORDER BY s.created_at DESC
      LIMIT 1`,
      [slug]
    );

    if (result.rows.length === 0) {
      return c.json({ error: 'Skill not found' }, 404);
    }

    const row = result.rows[0];

    // v5.3: Tenant visibility — private/unlisted skills only visible to owning tenant
    if (row.visibility === 'private' || row.visibility === 'unlisted') {
      const callerTenant = c.req.header('X-Tenant-Id') || 'default';
      if (row.tenant_id && row.tenant_id !== callerTenant && callerTenant !== 'default') {
        return c.json({ error: 'Skill not found' }, 404);
      }
    }

    return c.json({
      id: row.id,
      name: row.name,
      slug: row.slug,
      version: row.version,
      description: row.description,
      agentSummary: row.agent_summary,
      trustScore: parseFloat(row.trust_score),
      verificationTier: row.verification_tier ?? 'unverified',
      trustBadge: row.trust_badge ?? null,
      status: row.status,
      executionLayer: row.execution_layer,
      mcpUrl: row.mcp_url ?? null,
      skillMd: row.skill_md ?? null,
      capabilitiesRequired: row.capabilities_required ?? [],
      skillType: row.skill_type ?? 'atomic',
      schemaJson: row.schema_json ?? null,
      source: row.source,
      sourceUrl: row.source_url ?? null,
      tags: row.tags ?? [],
      category: row.category ?? null,
      categories: row.categories ?? [],
      ecosystem: row.ecosystem ?? null,
      language: row.language ?? null,
      license: row.license ?? null,
      readme: row.readme ?? null,
      r2BundleKey: row.r2_bundle_key ?? null,
      authRequirements: row.auth_requirements ?? null,
      installMethod: row.install_method ?? null,
      forkedFrom: row.forked_from ?? null,
      runCount: parseInt(row.run_count) || 0,
      lastRunAt: row.last_run_at?.toISOString() ?? null,
      authorId: row.author_id ?? null,
      authorType: row.author_type,
      tenantId: row.tenant_id ?? null,
      revokedReason: row.revoked_reason ?? null,
      remediationMessage: row.remediation_message ?? null,
      remediationUrl: row.remediation_url ?? null,
      replacementSkillId: row.replacement_skill_id ?? null,
      replacementSlug: row.replacement_slug ?? null,
      shareUrl: `https://runics.net/skills/${row.slug}`,
      avgExecutionTimeMs: row.avg_execution_time_ms ?? null,
      errorRate: row.error_rate ?? null,
      humanStarCount: parseInt(row.human_star_count) || 0,
      humanForkCount: parseInt(row.human_fork_count) || 0,
      agentInvocationCount: parseInt(row.agent_invocation_count) || 0,
      runtimeEnv: row.runtime_env ?? 'api',
      visibility: row.visibility ?? 'public',
      environmentVariables: row.environment_variables ?? [],
      cogniumScanned: !!row.cognium_scanned_at,
      cogniumScannedAt: row.cognium_scanned_at?.toISOString() ?? null,
      contentSafetyPassed: row.content_safety_passed ?? null,
      qualityScore: row.quality_score ?? null,
      qualityTier: row.quality_tier ?? null,
      qualityResults: row.quality_results ?? null,
      qualityAnalyzedAt: row.quality_analyzed_at?.toISOString() ?? null,
      trustScoreV2: row.trust_score_v2 ?? null,
      trustTier: row.trust_tier ?? null,
      trustResults: row.trust_results ?? null,
      trustAnalyzedAt: row.trust_analyzed_at?.toISOString() ?? null,
      understandResults: row.understand_results ?? null,
      understandAnalyzedAt: row.understand_analyzed_at?.toISOString() ?? null,
      specAlignmentScore: row.spec_alignment_score ?? null,
      specGaps: row.spec_gaps ?? null,
      specAnalyzedAt: row.spec_analyzed_at?.toISOString() ?? null,
      createdAt: row.created_at?.toISOString() ?? null,
      updatedAt: row.updated_at?.toISOString() ?? null,
      publishedAt: row.published_at?.toISOString() ?? null,
    } as any, 200);
  } catch (error) {
    console.error('[SKILL DETAIL] Error:', error);
    return c.json({ error: 'Failed to fetch skill' }, 500);
  }
});

// ── GET /v1/skills/:slug/versions ──

const skillVersionsRoute = createRoute({
  method: 'get',
  path: '/v1/skills/{slug}/versions',
  tags: ['Skills'],
  summary: 'List all versions of a skill',
  request: {
    params: z.object({ slug: SkillSlugParam }),
  },
  responses: {
    200: { content: { 'application/json': { schema: SkillVersionsResponseSchema } }, description: 'Versions list' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

app.openapi(skillVersionsRoute, async (c) => {
  const slug = c.req.valid('param').slug;
  const pool = createPool(c.env);

  try {
    const result = await pool.query(
      `SELECT id, name, slug, version, status, trust_score, verification_tier,
              run_count, execution_layer, source, skill_type,
              runtime_env, visibility, cognium_scanned_at,
              created_at, updated_at, published_at
       FROM skills
       WHERE slug = $1
       ORDER BY
         (trust_score::float * 0.7 + LEAST(run_count, 100)::float / 100.0 * 0.3) DESC,
         created_at DESC`,
      [slug]
    );

    if (result.rows.length === 0) {
      return c.json({ error: 'No skills found with this slug' }, 404);
    }

    return c.json({
      slug,
      totalVersions: result.rows.length,
      versions: result.rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        version: r.version,
        status: r.status,
        trustScore: parseFloat(r.trust_score),
        verificationTier: r.verification_tier ?? 'unverified',
        runCount: parseInt(r.run_count) || 0,
        executionLayer: r.execution_layer,
        source: r.source,
        skillType: r.skill_type ?? 'atomic',
        runtimeEnv: r.runtime_env ?? 'api',
        visibility: r.visibility ?? 'public',
        cogniumScanned: !!r.cognium_scanned_at,
        cogniumScannedAt: r.cognium_scanned_at?.toISOString() ?? null,
        createdAt: r.created_at?.toISOString() ?? null,
        updatedAt: r.updated_at?.toISOString() ?? null,
        publishedAt: r.published_at?.toISOString() ?? null,
      })),
    }, 200);
  } catch (error) {
    console.error('[SKILL VERSIONS] Error:', error);
    return c.json({ error: 'Failed to fetch versions' }, 500);
  }
});

// ── GET /v1/skills/:slug/:version ──

const skillVersionDetailRoute = createRoute({
  method: 'get',
  path: '/v1/skills/{slug}/{version}',
  tags: ['Skills'],
  summary: 'Get specific version of a skill',
  request: {
    params: z.object({ slug: SkillSlugParam, version: VersionParam }),
  },
  responses: {
    200: { content: { 'application/json': { schema: SkillDetailSchema } }, description: 'Skill version detail' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

// @ts-expect-error response type validated at runtime by Zod
app.openapi(skillVersionDetailRoute, async (c) => {
  const { slug, version } = c.req.valid('param');
  const pool = createPool(c.env);

  try {
    const result = await pool.query(
      `SELECT
        s.id, s.name, s.slug, s.version, s.description, s.agent_summary,
        s.trust_score, s.verification_tier, s.trust_badge, s.status,
        s.execution_layer, s.mcp_url, s.skill_md, s.capabilities_required,
        s.skill_type, s.schema_json, s.source, s.source_url,
        s.tags, s.category, s.categories, s.ecosystem, s.language, s.license,
        s.readme, s.r2_bundle_key, s.auth_requirements, s.install_method,
        s.forked_from, s.run_count, s.last_run_at,
        s.author_id, s.author_type, s.tenant_id,
        s.revoked_reason, s.remediation_message, s.remediation_url,
        s.replacement_skill_id, rs.slug AS replacement_slug,
        s.avg_execution_time_ms, s.error_rate,
        s.human_star_count, s.human_fork_count, s.agent_invocation_count,
        s.runtime_env, s.visibility, s.environment_variables,
        s.cognium_scanned_at, s.content_safety_passed,
        s.created_at, s.updated_at, s.published_at
      FROM skills s
      LEFT JOIN skills rs ON rs.id = s.replacement_skill_id
      WHERE s.slug = $1 AND s.version = $2
      LIMIT 1`,
      [slug, version]
    );

    if (result.rows.length === 0) {
      return c.json({ error: `Version ${version} not found for skill ${slug}` }, 404);
    }

    const row = result.rows[0];

    return c.json({
      id: row.id,
      name: row.name,
      slug: row.slug,
      version: row.version,
      description: row.description,
      agentSummary: row.agent_summary,
      trustScore: parseFloat(row.trust_score),
      verificationTier: row.verification_tier ?? 'unverified',
      trustBadge: row.trust_badge ?? null,
      status: row.status,
      executionLayer: row.execution_layer,
      mcpUrl: row.mcp_url ?? null,
      skillMd: row.skill_md ?? null,
      capabilitiesRequired: row.capabilities_required ?? [],
      skillType: row.skill_type ?? 'atomic',
      schemaJson: row.schema_json ?? null,
      source: row.source,
      sourceUrl: row.source_url ?? null,
      tags: row.tags ?? [],
      category: row.category ?? null,
      categories: row.categories ?? [],
      ecosystem: row.ecosystem ?? null,
      language: row.language ?? null,
      license: row.license ?? null,
      readme: row.readme ?? null,
      r2BundleKey: row.r2_bundle_key ?? null,
      authRequirements: row.auth_requirements ?? null,
      installMethod: row.install_method ?? null,
      forkedFrom: row.forked_from ?? null,
      runCount: parseInt(row.run_count) || 0,
      lastRunAt: row.last_run_at?.toISOString() ?? null,
      authorId: row.author_id ?? null,
      authorType: row.author_type,
      tenantId: row.tenant_id ?? null,
      revokedReason: row.revoked_reason ?? null,
      remediationMessage: row.remediation_message ?? null,
      remediationUrl: row.remediation_url ?? null,
      replacementSkillId: row.replacement_skill_id ?? null,
      replacementSlug: row.replacement_slug ?? null,
      shareUrl: `https://runics.net/skills/${row.slug}`,
      avgExecutionTimeMs: row.avg_execution_time_ms ?? null,
      errorRate: row.error_rate ?? null,
      humanStarCount: parseInt(row.human_star_count) || 0,
      humanForkCount: parseInt(row.human_fork_count) || 0,
      agentInvocationCount: parseInt(row.agent_invocation_count) || 0,
      runtimeEnv: row.runtime_env ?? 'api',
      visibility: row.visibility ?? 'public',
      environmentVariables: row.environment_variables ?? [],
      cogniumScanned: !!row.cognium_scanned_at,
      cogniumScannedAt: row.cognium_scanned_at?.toISOString() ?? null,
      contentSafetyPassed: row.content_safety_passed ?? null,
      qualityScore: null,
      qualityTier: null,
      qualityResults: null,
      qualityAnalyzedAt: null,
      trustScoreV2: null,
      trustTier: null,
      trustResults: null,
      trustAnalyzedAt: null,
      understandResults: null,
      understandAnalyzedAt: null,
      specAlignmentScore: null,
      specGaps: null,
      specAnalyzedAt: null,
      createdAt: row.created_at?.toISOString() ?? null,
      updatedAt: row.updated_at?.toISOString() ?? null,
      publishedAt: row.published_at?.toISOString() ?? null,
    } as any, 200);
  } catch (error) {
    console.error('[SKILL VERSION DETAIL] Error:', error);
    return c.json({ error: 'Failed to fetch skill version' }, 500);
  }
});

// ── GET /v1/skills/:slug/pull — Download Skill for Local Use (v5.3) ──

const pullRoute = createRoute({
  method: 'get',
  path: '/v1/skills/{slug}/pull',
  tags: ['Skills'],
  summary: 'Download skill for local agent use',
  request: {
    params: z.object({ slug: SkillSlugParam }),
    query: z.object({
      version: z.string().optional().openapi({ param: { name: 'version', in: 'query' } }),
    }),
  },
  responses: {
    200: { content: { 'application/json': { schema: SkillPullResponseSchema } }, description: 'Skill content' },
    403: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Private skill' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Not found' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

// @ts-expect-error response type validated at runtime by Zod
app.openapi(pullRoute, async (c) => {
  const slug = c.req.valid('param').slug;
  const version = c.req.valid('query').version;
  const pool = createPool(c.env);

  try {
    const query = version
      ? `SELECT s.slug, s.version, s.name, s.description, s.skill_md, s.schema_json,
                s.execution_layer, s.runtime_env, s.portable, s.trust_score,
                s.verification_tier, s.trust_badge, s.status, s.tags, s.categories,
                s.auth_requirements, s.capabilities_required, s.mcp_url,
                s.forked_from, s.source, s.visibility, s.tenant_id
         FROM skills s WHERE s.slug = $1 AND s.version = $2 LIMIT 1`
      : `SELECT s.slug, s.version, s.name, s.description, s.skill_md, s.schema_json,
                s.execution_layer, s.runtime_env, s.portable, s.trust_score,
                s.verification_tier, s.trust_badge, s.status, s.tags, s.categories,
                s.auth_requirements, s.capabilities_required, s.mcp_url,
                s.forked_from, s.source, s.visibility, s.tenant_id
         FROM skills s WHERE s.slug = $1
         ORDER BY (COALESCE(s.trust_score, 0.5)::float * 0.7
                   + LEAST(COALESCE(s.run_count, 0)::float / 100.0, 0.3)) DESC
         LIMIT 1`;

    const params = version ? [slug, version] : [slug];
    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return c.json({ error: 'not found' }, 404);
    }

    const row = result.rows[0];

    // Privacy: 403 if private and no tenant match
    if (row.visibility === 'private') {
      const tenantId = c.req.header('X-Tenant-Id') || 'default';
      if (row.tenant_id && row.tenant_id !== tenantId) {
        return c.json({ error: 'private skill' }, 403);
      }
    }

    return c.json({
      slug: row.slug,
      version: row.version,
      name: row.name,
      description: row.description,
      skillMd: row.skill_md ?? null,
      schemaJson: row.schema_json ?? null,
      executionLayer: row.execution_layer,
      runtimeEnv: row.runtime_env ?? 'api',
      portable: row.portable ?? false,
      trustScore: parseFloat(row.trust_score) || 0.5,
      verificationTier: row.verification_tier ?? 'unverified',
      trustBadge: row.trust_badge ?? null,
      status: row.status,
      tags: row.tags ?? [],
      categories: row.categories ?? [],
      authRequirements: row.auth_requirements ?? null,
      capabilitiesRequired: row.capabilities_required ?? [],
      mcpUrl: row.mcp_url ?? null,
      forkedFrom: row.forked_from ?? null,
      source: row.source,
    }, 200);
  } catch (error) {
    console.error('[SKILL PULL] Error:', error);
    return c.json({ error: 'Failed to pull skill' }, 500);
  }
});

// ── GET /v1/catalog/export — Offline Catalog Snapshot (v5.3) ──

const catalogExportRoute = createRoute({
  method: 'get',
  path: '/v1/catalog/export',
  tags: ['Skills'],
  summary: 'Export catalog as NDJSON for offline use',
  request: {
    query: z.object({
      portable: z.string().optional().openapi({ param: { name: 'portable', in: 'query' } }),
      runtimeEnv: z.string().optional().openapi({ param: { name: 'runtimeEnv', in: 'query' } }),
      minTrust: z.string().optional().openapi({ param: { name: 'minTrust', in: 'query' } }),
    }),
  },
  responses: {
    200: { description: 'NDJSON catalog export' },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Server error' },
  },
});

app.openapi(catalogExportRoute, async (c) => {
  const pool = createPool(c.env);

  try {
    const portableParam = c.req.valid('query').portable;
    const runtimeEnvParam = c.req.valid('query').runtimeEnv;
    const minTrust = parseFloat(c.req.valid('query').minTrust || '0.5');

    const conditions: string[] = [
      "status = 'published'",
      "visibility = 'public'",
    ];
    const params: any[] = [];
    let paramCount = 0;

    if (!isNaN(minTrust)) {
      conditions.push(`COALESCE(trust_score, 0.5)::float >= $${++paramCount}`);
      params.push(minTrust);
    }

    if (portableParam === 'true') {
      conditions.push('portable = true');
    }

    if (runtimeEnvParam) {
      const envs = runtimeEnvParam.split(',').map(s => s.trim()).filter(Boolean);
      if (envs.length > 0) {
        conditions.push(`runtime_env = ANY($${++paramCount}::text[])`);
        params.push(envs);
      }
    }

    const result = await pool.query(
      `SELECT slug, version, name, description, agent_summary, skill_md,
              schema_json, execution_layer, runtime_env, portable, trust_score,
              tags, categories, mcp_url
       FROM skills
       WHERE ${conditions.join(' AND ')}
       ORDER BY COALESCE(trust_score, 0.5)::float DESC`,
      params
    );

    const lines = result.rows.map((r: any) => JSON.stringify({
      slug: r.slug,
      version: r.version,
      name: r.name,
      description: r.description,
      agentSummary: r.agent_summary,
      skillMd: r.skill_md,
      schemaJson: r.schema_json,
      executionLayer: r.execution_layer,
      runtimeEnv: r.runtime_env,
      portable: r.portable,
      trustScore: parseFloat(r.trust_score) || 0.5,
      tags: r.tags ?? [],
      categories: r.categories ?? [],
      mcpUrl: r.mcp_url,
    }));

    return new Response(lines.join('\n'), {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Content-Disposition': 'attachment; filename="runics-catalog.jsonl"',
      },
    });
  } catch (error) {
    console.error('[CATALOG EXPORT] Error:', error);
    return c.json({ error: 'Failed to export catalog' }, 500);
  }
});

export { app as skillRoutes };
