import { Pool } from '@neondatabase/serverless';
import { nanoid } from 'nanoid';
import type { ForkResult, Env } from '../types';
import { BASE_TRUST } from '../cognium/scoring-policy';

export async function forkSkill(
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
  const slug = `${s.slug}-fork-${nanoid(6)}`;

  // v5.0: Trust reset uses root_source for base trust floor
  const rootSource = s.root_source ?? s.source;
  const trustScore = BASE_TRUST[rootSource] ?? 0.40;

  // v5.0: forked_from stores slug@version reference
  const forkedFrom = `${s.slug}@${s.version ?? '1.0.0'}`;

  const fork = await pool.query(
    `INSERT INTO skills (
      name, slug, version, skill_type, status,
      description, readme, schema_json, execution_layer,
      tags, categories, ecosystem, license,
      author_id, author_type,
      forked_from, forked_by, root_source,
      trust_score, capabilities_required,
      source, verification_tier
    ) VALUES (
      $1, $2, '1.0.0', 'forked', 'draft',
      $3, $4, $5, $6,
      $7, $8, $9, $10,
      $11, $12,
      $13, $14, $15,
      $16, $17,
      'direct', 'unverified'
    ) RETURNING id, slug, version, status`,
    [
      `${s.name} (fork)`,
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
      forkedFrom,
      authorId,
      rootSource,
      trustScore,
      s.capabilities_required,
    ]
  );

  // If source is a composition, copy its steps and composition_skill_ids
  const sourceType = s.skill_type ?? 'atomic';
  if (['auto-composite', 'human-composite', 'composition', 'pipeline'].includes(sourceType)) {
    await pool.query(
      `INSERT INTO composition_steps (composition_id, step_order, skill_id, step_name, input_mapping, condition, on_error)
       SELECT $1, step_order, skill_id, step_name, input_mapping, condition, on_error
       FROM composition_steps WHERE composition_id = $2`,
      [fork.rows[0].id, sourceId]
    );
    // Copy composition_skill_ids
    if (s.composition_skill_ids) {
      await pool.query(
        `UPDATE skills SET composition_skill_ids = $1 WHERE id = $2`,
        [s.composition_skill_ids, fork.rows[0].id]
      );
    }
  }

  // Increment source fork count based on author type
  if (authorType === 'human') {
    await pool.query(
      `UPDATE skills SET human_fork_count = human_fork_count + 1 WHERE id = $1`,
      [sourceId]
    );
  } else {
    await pool.query(
      `UPDATE skills SET agent_fork_count = agent_fork_count + 1 WHERE id = $1`,
      [sourceId]
    );
  }

  // Enqueue for embedding and security scanning (best-effort)
  try {
    await env.EMBED_QUEUE.send({ skillId: fork.rows[0].id, action: 'embed' });
    await env.COGNIUM_QUEUE.send({
      skillId: fork.rows[0].id,
      priority: 'normal' as const,
      timestamp: Date.now(),
    });
  } catch (queueErr) {
    console.error(`[FORK] Queue send failed for ${fork.rows[0].id}: ${(queueErr as Error).message}`);
  }

  return {
    id: fork.rows[0].id,
    slug: fork.rows[0].slug,
    version: fork.rows[0].version,
    forkedFrom,
    trustScore,
    status: fork.rows[0].status,
  };
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
