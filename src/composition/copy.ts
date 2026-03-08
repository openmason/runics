import { Pool } from '@neondatabase/serverless';
import { nanoid } from 'nanoid';
import type { ForkResult, Env } from '../types';
import { NotFoundError } from './fork';

export async function copySkill(
  sourceId: string,
  authorId: string,
  authorType: 'human' | 'bot',
  pool: Pool,
  env: Env
): Promise<ForkResult> {
  const source = await pool.query(
    `SELECT * FROM skills WHERE id = $1 AND status = 'published'`,
    [sourceId]
  );

  if (!source.rows[0]) {
    throw new NotFoundError(`Skill ${sourceId} not found or not published`);
  }

  const s = source.rows[0];
  const slug = `${s.slug}-copy-${nanoid(6)}`;

  const copy = await pool.query(
    `INSERT INTO skills (
      name, slug, version, skill_type, status,
      description, readme, schema_json, execution_layer,
      tags, categories, ecosystem, license,
      author_id, author_type,
      trust_score, capabilities_required,
      source, verification_tier
    ) VALUES (
      $1, $2, '1.0.0', 'atomic', 'draft',
      $3, $4, $5, $6,
      $7, $8, $9, $10,
      $11, $12,
      0.5, $13,
      'direct', 'unverified'
    ) RETURNING id, slug, version, status`,
    [
      `${s.name} (copy)`,
      slug,
      s.description,
      s.readme,
      s.schema_json ? JSON.stringify(s.schema_json) : null,
      s.execution_layer,
      s.tags,
      s.categories,
      s.ecosystem,
      s.license,
      authorId,
      authorType,
      s.capabilities_required,
    ]
  );

  // Copy composition steps if source is a composition
  const sourceType = s.skill_type ?? s.type;
  if (['auto-composite', 'human-composite', 'composition', 'pipeline'].includes(sourceType)) {
    await pool.query(
      `INSERT INTO composition_steps (composition_id, step_order, skill_id, step_name, input_mapping, condition, on_error)
       SELECT $1, step_order, skill_id, step_name, input_mapping, condition, on_error
       FROM composition_steps WHERE composition_id = $2`,
      [copy.rows[0].id, sourceId]
    );
  }

  // Increment human_copy_count on source (human action only)
  if (authorType === 'human') {
    await pool.query(
      `UPDATE skills SET human_copy_count = human_copy_count + 1 WHERE id = $1`,
      [sourceId]
    );
  }

  // Enqueue for embedding and security scanning (best-effort)
  try {
    await env.EMBED_QUEUE.send({ skillId: copy.rows[0].id, action: 'embed' });
    await env.COGNIUM_QUEUE.send({
      skillId: copy.rows[0].id,
      priority: 'normal' as const,
      timestamp: Date.now(),
    });
  } catch (queueErr) {
    console.error(`[COPY] Queue send failed for ${copy.rows[0].id}: ${(queueErr as Error).message}`);
  }

  return {
    id: copy.rows[0].id,
    slug: copy.rows[0].slug,
    version: copy.rows[0].version,
    forkedFrom: '', // copy has no lineage
    trustScore: 0.5,
    status: copy.rows[0].status,
  };
}
