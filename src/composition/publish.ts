import { Pool } from '@neondatabase/serverless';
import { NotFoundError } from './fork';
import { ValidationError } from './compose';

export async function publishComposition(
  compositionId: string,
  pool: Pool
): Promise<{ id: string; slug: string; status: string }> {
  // Verify skill exists and is a draft composition/pipeline
  const skill = await pool.query(
    `SELECT id, slug, status, skill_type FROM skills WHERE id = $1`,
    [compositionId]
  );

  if (!skill.rows[0]) {
    throw new NotFoundError(`Composition ${compositionId} not found`);
  }

  if (!['auto-composite', 'human-composite', 'composition', 'pipeline'].includes(skill.rows[0].skill_type)) {
    throw new ValidationError(`Skill ${compositionId} is not a composition`);
  }

  if (skill.rows[0].status !== 'draft') {
    throw new ValidationError(
      `Composition ${compositionId} is in '${skill.rows[0].status}' state, expected 'draft'`
    );
  }

  // Validate all steps still point to published skills
  const steps = await pool.query(
    `SELECT cs.skill_id, s.status, s.name
     FROM composition_steps cs
     JOIN skills s ON s.id = cs.skill_id
     WHERE cs.composition_id = $1`,
    [compositionId]
  );

  const unpublished = steps.rows.filter((r: any) => r.status !== 'published');
  if (unpublished.length > 0) {
    const details = unpublished
      .map((r: any) => `${r.name} (${r.status})`)
      .join(', ');
    throw new ValidationError(
      `Cannot publish: the following step skills are not published: ${details}`
    );
  }

  // Transition to published
  const result = await pool.query(
    `UPDATE skills
     SET status = 'published', published_at = NOW(), updated_at = NOW()
     WHERE id = $1
     RETURNING id, slug, status`,
    [compositionId]
  );

  return {
    id: result.rows[0].id,
    slug: result.rows[0].slug,
    status: result.rows[0].status,
  };
}
