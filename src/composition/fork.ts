import { Pool } from '@neondatabase/serverless';
import { nanoid } from 'nanoid';
import type { ForkResult, Env } from '../types';

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

  const fork = await pool.query(
    `INSERT INTO skills (
      name, slug, version, type, status,
      description, readme, schema_json, execution_layer,
      tags, categories, ecosystem, license,
      author_id, author_type,
      fork_of, origin_id, fork_depth,
      trust_score, capabilities_required,
      source
    ) VALUES (
      $1, $2, '1.0.0', $3, 'draft',
      $4, $5, $6, $7,
      $8, $9, $10, $11,
      $12, $13,
      $14, $15, $16,
      0.5, $17,
      'direct'
    ) RETURNING id, slug`,
    [
      `${s.name} (fork)`,
      slug,
      s.type,
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
      sourceId,
      s.origin_id ?? sourceId,
      (s.fork_depth ?? 0) + 1,
      s.capabilities_required,
    ]
  );

  // If source is a composition, copy its steps
  if (['composition', 'pipeline'].includes(s.type)) {
    await pool.query(
      `INSERT INTO composition_steps (composition_id, step_order, skill_id, step_name, input_mapping, condition, on_error)
       SELECT $1, step_order, skill_id, step_name, input_mapping, condition, on_error
       FROM composition_steps WHERE composition_id = $2`,
      [fork.rows[0].id, sourceId]
    );
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

  // Enqueue for embedding and security scanning
  await env.EMBED_QUEUE.send({ skillId: fork.rows[0].id, action: 'embed' });
  await env.COGNIUM_QUEUE.send({ skillId: fork.rows[0].id, action: 'scan' });

  return { id: fork.rows[0].id, slug: fork.rows[0].slug };
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
