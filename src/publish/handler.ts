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
import { publishSkillSchema, updateSkillSchema, trustUpdateSchema } from './schema';
import type { Env, EmbedQueueMessage, CogniumQueueMessage } from '../types';

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
        author_id, author_type, status, published_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'published',NOW())
      RETURNING id, slug`,
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
      ]
    );

    const inserted = result.rows[0];

    // Enqueue for embedding generation (async)
    await c.env.EMBED_QUEUE.send({
      skillId: inserted.id,
      action: 'embed',
      source: input.source ?? 'manual',
    } satisfies EmbedQueueMessage);

    // Enqueue for Cognium scanning (unless source IS cognium)
    if (input.source !== 'cognium') {
      await c.env.COGNIUM_QUEUE.send({
        skillId: inserted.id,
        action: 'scan',
        source: input.source ?? 'manual',
      } satisfies CogniumQueueMessage);
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

    return c.json({ id: inserted.id, slug: inserted.slug, status: 'published' }, 201);
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
    // Build dynamic SET clause
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    const fieldMap: Record<string, string> = {
      name: 'name',
      description: 'description',
      executionLayer: 'execution_layer',
      mcpUrl: 'mcp_url',
      skillMd: 'skill_md',
      trustScore: 'trust_score',
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

    // Re-enqueue for embedding if description changed
    if (input.description !== undefined) {
      await c.env.EMBED_QUEUE.send({
        skillId,
        action: 'embed',
        source: 'update',
      } satisfies EmbedQueueMessage);
    }

    return c.json({ id: skillId, status: 'updated' });
  } catch (error) {
    console.error('[PUBLISH] Update error:', error);
    return c.json({ error: 'Failed to update skill', message: (error as Error).message }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// PUT /v1/skills/:id/trust — Cognium trust score callback
// ──────────────────────────────────────────────────────────────────────────────

publishRoutes.put('/:id/trust', zValidator('json', trustUpdateSchema), async (c) => {
  const skillId = c.req.param('id');
  const { trustScore, cogniumReport } = c.req.valid('json');
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

  try {
    const result = await pool.query(
      `UPDATE skills SET
        trust_score = $1,
        cognium_scanned_at = NOW(),
        cognium_scanned = true,
        cognium_report = $2,
        content_safety_passed = $3,
        updated_at = NOW()
      WHERE id = $4
      RETURNING id`,
      [trustScore, JSON.stringify(cogniumReport), cogniumReport.contentSafe, skillId]
    );

    if (result.rows.length === 0) {
      return c.json({ error: 'Skill not found' }, 404);
    }

    return c.json({ id: skillId, trustScore, status: 'updated' });
  } catch (error) {
    console.error('[PUBLISH] Trust update error:', error);
    return c.json(
      { error: 'Failed to update trust score', message: (error as Error).message },
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
