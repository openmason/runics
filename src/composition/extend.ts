import type { Pool } from '../db/connection';
import type { ForkResult, Env } from '../types';
import type { ExtendInput } from './schema';
import { forkSkill, NotFoundError } from './fork';
import { ValidationError } from './compose';

export async function extendComposition(
  compositionId: string,
  newSteps: ExtendInput['steps'],
  authorId: string,
  authorType: 'human' | 'bot',
  pool: Pool,
  env: Env
): Promise<ForkResult> {
  // Verify source is a composition/pipeline
  const source = await pool.query(
    `SELECT skill_type FROM skills WHERE id = $1 AND status = 'published'`,
    [compositionId]
  );

  if (!source.rows[0]) {
    throw new NotFoundError(`Composition ${compositionId} not found or not published`);
  }

  if (!['auto-composite', 'human-composite', 'composition', 'pipeline'].includes(source.rows[0].skill_type)) {
    throw new ValidationError(`Skill ${compositionId} is not a composition`);
  }

  // Validate new step skill IDs exist and are published
  const newSkillIds = newSteps.map((s) => s.skillId);
  const skills = await pool.query(
    `SELECT id FROM skills WHERE id = ANY($1::uuid[]) AND status = 'published'`,
    [newSkillIds]
  );

  if (skills.rows.length !== newSkillIds.length) {
    const foundIds = new Set(skills.rows.map((r: any) => r.id));
    const missing = newSkillIds.filter((id) => !foundIds.has(id));
    throw new ValidationError(`Skills not found or not published: ${missing.join(', ')}`);
  }

  // Fork the composition first
  const fork = await forkSkill(compositionId, authorId, authorType, pool, env);

  // Get current max step_order
  const maxOrder = await pool.query(
    `SELECT COALESCE(MAX(step_order), 0) AS max_order
     FROM composition_steps WHERE composition_id = $1`,
    [fork.id]
  );

  let nextOrder = (maxOrder.rows[0].max_order as number) + 1;

  // Append new steps
  for (const step of newSteps) {
    await pool.query(
      `INSERT INTO composition_steps (
        composition_id, step_order, skill_id, step_name, input_mapping, on_error
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        fork.id,
        nextOrder++,
        step.skillId,
        step.stepName || null,
        step.inputMapping ? JSON.stringify(step.inputMapping) : null,
        step.onError || 'fail',
      ]
    );
  }

  // Recompute trust_score and capabilities_required on the fork
  const allSteps = await pool.query(
    `SELECT s.trust_score, s.capabilities_required
     FROM composition_steps cs
     JOIN skills s ON s.id = cs.skill_id
     WHERE cs.composition_id = $1`,
    [fork.id]
  );

  const trustScore = Math.min(
    ...allSteps.rows.map((r: any) => parseFloat(r.trust_score) || 0)
  );

  const capabilitiesSet = new Set<string>();
  for (const row of allSteps.rows) {
    if (row.capabilities_required) {
      for (const cap of row.capabilities_required) {
        capabilitiesSet.add(cap);
      }
    }
  }

  await pool.query(
    `UPDATE skills SET trust_score = $1, capabilities_required = $2 WHERE id = $3`,
    [trustScore, Array.from(capabilitiesSet), fork.id]
  );

  return fork;
}
