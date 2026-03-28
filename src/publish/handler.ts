// ══════════════════════════════════════════════════════════════════════════════
// Publish API — Route Handlers
// ══════════════════════════════════════════════════════════════════════════════
//
// Write path for skills entering Runics from internal sources:
// - Forge (generated/distilled skills)
// - Cognium (trust score updates)
// - Manual uploads
// - Tenant-specific skill registration
//
// Skills are inserted into the DB and enqueued for async embedding + scanning.
//
// ══════════════════════════════════════════════════════════════════════════════

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { Pool } from '@neondatabase/serverless';
import {
  publishSkillSchema,
  updateSkillSchema,
  attestationUpdateSchema,
  statusChangeSchema,
} from './schema';
import type { Env, CogniumSubmitMessage } from '../types';
import { SearchCache } from '../cache/kv-cache';

export const publishRoutes = new Hono<{ Bindings: Env }>();

// ──────────────────────────────────────────────────────────────────────────────
// POST /v1/skills — Publish a new skill
// ──────────────────────────────────────────────────────────────────────────────

publishRoutes.post('/', zValidator('json', publishSkillSchema), async (c) => {
  const input = c.req.valid('json');
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

  try {
    const result = await pool.query(
      `INSERT INTO skills (
        name, slug, version, source, description, schema_json,
        execution_layer, mcp_url, skill_md, capabilities_required,
        source_url, trust_score, tenant_id, tags, category,
        author_id, author_type, status, published_at,
        skill_type, composition_skill_ids, forked_from, forked_by,
        fork_changes, human_distilled_by, human_distilled_at,
        trust_badge, verification_tier, run_count,
        runtime_env, visibility, environment_variables
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                'published',NOW(),$18,$19,$20,$21,$22,$23,$24,$25,'unverified',0,
                $26,$27,$28)
      RETURNING id, slug, version`,
      [
        input.name,
        input.slug,
        input.version ?? '1.0.0',
        input.source ?? 'manual',
        input.description,
        input.schemaJson ? JSON.stringify(input.schemaJson) : null,
        input.executionLayer,
        input.mcpUrl ?? null,
        input.skillMd ?? null,
        input.capabilitiesRequired ?? [],
        input.sourceUrl ?? null,
        input.trustScore ?? 0.5,
        input.tenantId ?? null,
        input.tags ?? [],
        input.category ?? null,
        input.authorId ?? null,
        input.authorType ?? 'human',
        // v5.0 fields
        input.skillType ?? 'atomic',
        input.compositionSkillIds ?? null,
        input.forkedFrom ?? null,
        input.forkedBy ?? null,
        input.forkChanges ? JSON.stringify(input.forkChanges) : null,
        input.humanDistilledBy ?? null,
        input.humanDistilledBy ? new Date() : null,
        input.trustBadge ?? null,
        // v5.2 fields
        input.runtimeEnv ?? 'api',
        input.visibility ?? 'public',
        input.environmentVariables ?? null,
      ]
    );

    const inserted = result.rows[0];

    // Enqueue for embedding generation and scanning (best-effort)
    try {
      await c.env.EMBED_QUEUE.send({
        skillId: inserted.id,
        action: 'embed',
        source: input.source ?? 'manual',
      });
      await c.env.COGNIUM_QUEUE.send({
        skillId: inserted.id,
        priority: ['forge', 'human-distilled'].includes(input.source ?? '') ? 'high' : 'normal',
        timestamp: Date.now(),
      } satisfies CogniumSubmitMessage);
    } catch (queueErr) {
      console.error(`[PUBLISH] Queue send failed for ${inserted.id}: ${(queueErr as Error).message}`);
    }

    // Upsert author (non-blocking)
    if (input.authorId) {
      c.executionCtx.waitUntil(
        pool
          .query(
            `INSERT INTO authors (id, handle, author_type, bot_model, total_skills_published)
             VALUES ($1, $2, $3, $4, 1)
             ON CONFLICT (id) DO UPDATE SET
               total_skills_published = authors.total_skills_published + 1,
               bot_model = COALESCE(EXCLUDED.bot_model, authors.bot_model)`,
            [
              input.authorId,
              input.authorHandle ?? input.authorId,
              input.authorType ?? 'human',
              input.authorBotModel ?? null,
            ]
          )
          .catch((e) => console.error('[PUBLISH] Author upsert failed:', e.message))
      );
    }

    return c.json({ id: inserted.id, slug: inserted.slug, version: inserted.version, status: 'published' }, 201);
  } catch (error) {
    console.error('[PUBLISH] Error:', error);
    return c.json({ error: 'Failed to publish skill', message: (error as Error).message }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// PUT /v1/skills/:id — Update an existing skill
// ──────────────────────────────────────────────────────────────────────────────

publishRoutes.put('/:id', zValidator('json', updateSkillSchema), async (c) => {
  const skillId = c.req.param('id');
  const input = c.req.valid('json');
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

  try {
    // v5.2: Only draft skills are editable — fork to modify published skills
    const statusCheck = await pool.query(
      `SELECT status FROM skills WHERE id = $1`,
      [skillId]
    );
    if (statusCheck.rows.length === 0) {
      return c.json({ error: 'Skill not found' }, 404);
    }
    if (statusCheck.rows[0].status !== 'draft') {
      return c.json({ error: 'only draft skills are editable — fork to modify published skills' }, 400);
    }

    // Build dynamic SET clause
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    const fieldMap: Record<string, string> = {
      name: 'name',
      description: 'description',
      skillMd: 'skill_md',
      mcpUrl: 'mcp_url',
      tags: 'tags',
      category: 'category',
    };

    for (const [key, col] of Object.entries(fieldMap)) {
      if ((input as Record<string, unknown>)[key] !== undefined) {
        setClauses.push(`${col} = $${paramIdx}`);
        values.push((input as Record<string, unknown>)[key]);
        paramIdx++;
      }
    }

    // Handle JSON fields separately
    if (input.schemaJson !== undefined) {
      setClauses.push(`schema_json = $${paramIdx}`);
      values.push(JSON.stringify(input.schemaJson));
      paramIdx++;
    }
    if (input.capabilitiesRequired !== undefined) {
      setClauses.push(`capabilities_required = $${paramIdx}`);
      values.push(input.capabilitiesRequired);
      paramIdx++;
    }
    if (input.categories !== undefined) {
      setClauses.push(`categories = $${paramIdx}`);
      values.push(input.categories);
      paramIdx++;
    }
    if (input.runtimeEnv !== undefined) {
      setClauses.push(`runtime_env = $${paramIdx}`);
      values.push(input.runtimeEnv);
      paramIdx++;
    }
    if (input.visibility !== undefined) {
      setClauses.push(`visibility = $${paramIdx}`);
      values.push(input.visibility);
      paramIdx++;
    }
    if (input.environmentVariables !== undefined) {
      setClauses.push(`environment_variables = $${paramIdx}`);
      values.push(input.environmentVariables);
      paramIdx++;
    }

    if (setClauses.length === 0) {
      return c.json({ error: 'No fields to update' }, 400);
    }

    setClauses.push(`updated_at = NOW()`);
    values.push(skillId);

    const sql = `UPDATE skills SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING id, slug`;
    const result = await pool.query(sql, values);

    if (result.rows.length === 0) {
      return c.json({ error: 'Skill not found' }, 404);
    }

    // Re-enqueue for embedding if description or skill_md changed (best-effort)
    if (input.description !== undefined || input.skillMd !== undefined) {
      try {
        await c.env.EMBED_QUEUE.send({
          skillId,
          action: 'embed',
          source: 'update',
        });
      } catch (queueErr) {
        console.error(`[PUBLISH] Queue send failed for update ${skillId}: ${(queueErr as Error).message}`);
      }
    }

    return c.json({ id: skillId, status: 'draft' });
  } catch (error) {
    console.error('[PUBLISH] Update error:', error);
    return c.json({ error: 'Failed to update skill', message: (error as Error).message }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// PUT /v1/skills/:id/trust — Cognium attestation callback (v5.0)
// ──────────────────────────────────────────────────────────────────────────────

publishRoutes.put('/:id/trust', zValidator('json', attestationUpdateSchema), async (c) => {
  const skillId = c.req.param('id');
  const body = c.req.valid('json');
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

  try {
    // Content safety is an absolute gate
    if (!body.contentSafe) {
      await pool.query(
        `UPDATE skills SET
          trust_score = 0.0,
          content_safety_passed = false,
          status = 'revoked',
          revoked_at = NOW(),
          revoked_reason = 'content_safety_failed',
          cognium_scanned_at = NOW(),
          verification_tier = $1,
          scan_coverage = $2,
          cognium_findings = $3,
          analyzer_summary = $4,
          updated_at = NOW()
        WHERE id = $5`,
        [body.tier, body.scanCoverage, JSON.stringify(body.findings), JSON.stringify(body.analyzerSummary), skillId]
      );
      return c.json({ id: skillId, status: 'revoked', trustScore: 0.0 });
    }

    await pool.query(
      `UPDATE skills SET
        trust_score = $1,
        verification_tier = $2,
        content_safety_passed = true,
        scan_coverage = $3,
        status = $4,
        revoked_at = CASE WHEN $4 = 'revoked' THEN NOW() ELSE NULL END,
        revoked_reason = CASE WHEN $4 = 'revoked' THEN $5 ELSE NULL END,
        remediation_message = $6,
        remediation_url = $7,
        cognium_findings = $8,
        analyzer_summary = $9,
        cognium_scanned_at = $10::timestamptz,
        updated_at = NOW()
      WHERE id = $11`,
      [
        body.trustScore,
        body.tier,
        body.scanCoverage,
        body.recommendedStatus,
        body.statusReason ?? null,
        body.remediationMessage ?? null,
        body.remediationUrl ?? null,
        JSON.stringify(body.findings),
        JSON.stringify(body.analyzerSummary),
        body.scannedAt,
        skillId,
      ]
    );

    return c.json({
      id: skillId,
      trustScore: body.trustScore,
      tier: body.tier,
      status: body.recommendedStatus,
    });
  } catch (error) {
    console.error('[PUBLISH] Trust update error:', error);
    return c.json(
      { error: 'Failed to update trust score', message: (error as Error).message },
      500
    );
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// PATCH /v1/skills/:id/status — Owner-initiated status changes (v5.0)
// ──────────────────────────────────────────────────────────────────────────────

publishRoutes.patch('/:id/status', zValidator('json', statusChangeSchema), async (c) => {
  const skillId = c.req.param('id');
  const { status, reason, replacementSkillId } = c.req.valid('json');
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

  try {
    // Status transition guard: owner can only toggle between published ↔ deprecated.
    // Cognium controls all other transitions (revoked, vulnerable, etc.).
    const currentResult = await pool.query(
      `SELECT status, slug FROM skills WHERE id = $1`,
      [skillId]
    );

    if (currentResult.rows.length === 0) {
      return c.json({ error: 'Skill not found' }, 404);
    }

    const currentStatus = currentResult.rows[0].status;
    const slug = currentResult.rows[0].slug;
    const validTransitions: Record<string, string[]> = {
      published: ['deprecated'],
      deprecated: ['published'],
    };

    const allowed = validTransitions[currentStatus];
    if (!allowed || !allowed.includes(status)) {
      return c.json({
        error: `Cannot transition from '${currentStatus}' to '${status}'. Owner can only toggle between published and deprecated.`,
      }, 409);
    }

    await pool.query(
      `UPDATE skills SET
        status = $1,
        deprecated_at = CASE WHEN $1 = 'deprecated' THEN NOW() ELSE NULL END,
        deprecated_reason = CASE WHEN $1 = 'deprecated' THEN $2 ELSE NULL END,
        replacement_skill_id = $3,
        updated_at = NOW()
      WHERE id = $4`,
      [status, reason ?? null, replacementSkillId ?? null, skillId]
    );

    // Cache invalidation: deprecation removes from search, un-deprecation restores
    const cache = new SearchCache(c.env.SEARCH_CACHE, parseInt(c.env.CACHE_TTL_SECONDS || '120'));
    if (status === 'deprecated') {
      await cache.addRevokedSlug(slug);
    } else if (status === 'published') {
      await cache.removeRevokedSlug(slug);
    }

    return c.json({ id: skillId, status });
  } catch (error) {
    console.error('[PUBLISH] Status change error:', error);
    return c.json(
      { error: 'Failed to update status', message: (error as Error).message },
      500
    );
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// PUT /v1/skills/:id/bundle — Upload code bundle to R2
// ──────────────────────────────────────────────────────────────────────────────

publishRoutes.put('/:id/bundle', async (c) => {
  const skillId = c.req.param('id');

  try {
    const body = await c.req.arrayBuffer();
    const key = `skills/${skillId}/bundle.tar.gz`;

    await c.env.R2_BUCKET.put(key, body);

    const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });
    await pool.query(
      'UPDATE skills SET r2_bundle_key = $1, updated_at = NOW() WHERE id = $2',
      [key, skillId]
    );

    return c.json({ id: skillId, bundleKey: key, status: 'uploaded' });
  } catch (error) {
    console.error('[PUBLISH] Bundle upload error:', error);
    return c.json(
      { error: 'Failed to upload bundle', message: (error as Error).message },
      500
    );
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /v1/skills/:id/publish — Publish a draft skill (v5.2)
// ──────────────────────────────────────────────────────────────────────────────

publishRoutes.post('/:id/publish', async (c) => {
  const skillId = c.req.param('id');
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

  try {
    // Fetch the skill
    const skillResult = await pool.query(
      `SELECT id, status, description, skill_md, mcp_url, r2_bundle_key FROM skills WHERE id = $1`,
      [skillId]
    );

    if (skillResult.rows.length === 0) {
      return c.json({ error: 'not found' }, 404);
    }

    const skill = skillResult.rows[0];

    if (skill.status !== 'draft') {
      return c.json({ error: 'only draft skills can be published' }, 400);
    }

    // Require description and at least one content artifact
    if (!skill.description) {
      return c.json({ error: 'description required' }, 400);
    }
    if (!skill.skill_md && !skill.mcp_url && !skill.r2_bundle_key) {
      return c.json({ error: 'skill needs content: skill_md, mcp_url, or code bundle' }, 400);
    }

    await pool.query(
      `UPDATE skills SET status = 'published', published_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [skillId]
    );

    // Enqueue for embedding + scanning (best-effort)
    try {
      await c.env.EMBED_QUEUE.send({ skillId, action: 'embed', source: 'publish' });
      await c.env.COGNIUM_QUEUE.send({
        skillId,
        priority: 'normal',
        timestamp: Date.now(),
      } satisfies CogniumSubmitMessage);
    } catch (queueErr) {
      console.error(`[PUBLISH] Queue send failed for publish ${skillId}: ${(queueErr as Error).message}`);
    }

    return c.json({ id: skillId, status: 'published' });
  } catch (error) {
    console.error('[PUBLISH] Publish draft error:', error);
    return c.json(
      { error: 'Failed to publish skill', message: (error as Error).message },
      500
    );
  }
});

