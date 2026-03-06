import { Pool } from '@neondatabase/serverless';

export async function getAncestry(
  skillId: string,
  pool: Pool
): Promise<{ id: string; slug: string; name: string; forkDepth: number }[]> {
  const result = await pool.query(
    `WITH RECURSIVE ancestry AS (
      SELECT id, slug, name, fork_depth, fork_of
      FROM skills WHERE id = $1
      UNION ALL
      SELECT s.id, s.slug, s.name, s.fork_depth, s.fork_of
      FROM skills s
      JOIN ancestry a ON s.id = a.fork_of
    )
    SELECT id, slug, name, fork_depth
    FROM ancestry
    ORDER BY fork_depth ASC`,
    [skillId]
  );

  return result.rows.map((r: any) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    forkDepth: r.fork_depth ?? 0,
  }));
}

export async function getForks(
  skillId: string,
  pool: Pool
): Promise<
  { id: string; slug: string; name: string; authorType: string; createdAt: string }[]
> {
  const result = await pool.query(
    `SELECT id, slug, name, author_type, created_at
     FROM skills
     WHERE fork_of = $1
     ORDER BY created_at DESC`,
    [skillId]
  );

  return result.rows.map((r: any) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    authorType: r.author_type,
    createdAt: r.created_at,
  }));
}

export async function getDependents(
  skillId: string,
  pool: Pool
): Promise<
  {
    compositionId: string;
    compositionSlug: string;
    compositionName: string;
    stepOrder: number;
  }[]
> {
  const result = await pool.query(
    `SELECT cs.composition_id, s.slug AS composition_slug, s.name AS composition_name, cs.step_order
     FROM composition_steps cs
     JOIN skills s ON s.id = cs.composition_id
     WHERE cs.skill_id = $1
     ORDER BY s.name ASC`,
    [skillId]
  );

  return result.rows.map((r: any) => ({
    compositionId: r.composition_id,
    compositionSlug: r.composition_slug,
    compositionName: r.composition_name,
    stepOrder: r.step_order,
  }));
}
