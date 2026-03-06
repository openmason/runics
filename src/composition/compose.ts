import { Pool } from '@neondatabase/serverless';
import { nanoid } from 'nanoid';
import type { CompositionInput, Env } from '../types';

export async function createComposition(
  input: CompositionInput,
  pool: Pool,
  env: Env
): Promise<{ id: string; slug: string }> {
  const skillIds = input.steps.map((s) => s.skillId);

  // Validate all skill IDs exist and are published
  const skills = await pool.query(
    `SELECT id, trust_score, capabilities_required FROM skills
     WHERE id = ANY($1::uuid[]) AND status = 'published'`,
    [skillIds]
  );

  if (skills.rows.length !== skillIds.length) {
    const foundIds = new Set(skills.rows.map((r: any) => r.id));
    const missing = skillIds.filter((id) => !foundIds.has(id));
    throw new ValidationError(`Skills not found or not published: ${missing.join(', ')}`);
  }

  // Compute trust_score = MIN across all step skills
  const trustScore = Math.min(
    ...skills.rows.map((r: any) => parseFloat(r.trust_score) || 0)
  );

  // Compute capabilities_required = union of all step skills
  const capabilitiesSet = new Set<string>();
  for (const row of skills.rows) {
    if (row.capabilities_required) {
      for (const cap of row.capabilities_required) {
        capabilitiesSet.add(cap);
      }
    }
  }
  const capabilities = Array.from(capabilitiesSet);

  const slug = input.slug || `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${nanoid(6)}`;

  // Insert composition as a skill row
  const result = await pool.query(
    `INSERT INTO skills (
      name, slug, version, type, status,
      description, tags, author_id, author_type,
      trust_score, capabilities_required, execution_layer, source
    ) VALUES (
      $1, $2, '1.0.0', 'composition', 'draft',
      $3, $4, $5, $6,
      $7, $8, 'instructions', 'direct'
    ) RETURNING id, slug`,
    [
      input.name,
      slug,
      input.description,
      input.tags || [],
      input.authorId,
      input.authorType,
      trustScore,
      capabilities,
    ]
  );

  const compositionId = result.rows[0].id;

  // Insert composition steps in order
  for (let i = 0; i < input.steps.length; i++) {
    const step = input.steps[i];
    await pool.query(
      `INSERT INTO composition_steps (
        composition_id, step_order, skill_id, step_name, input_mapping, on_error
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        compositionId,
        i + 1,
        step.skillId,
        step.stepName || null,
        step.inputMapping ? JSON.stringify(step.inputMapping) : null,
        step.onError || 'fail',
      ]
    );
  }

  // Enqueue for embedding and security scanning
  await env.EMBED_QUEUE.send({ skillId: compositionId, action: 'embed' });
  await env.COGNIUM_QUEUE.send({ skillId: compositionId, action: 'scan' });

  return { id: compositionId, slug: result.rows[0].slug };
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
