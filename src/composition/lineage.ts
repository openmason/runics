import type { Pool } from '../db/connection';

export async function getAncestry(
  skillId: string,
  pool: Pool
): Promise<{ id: string; slug: string; name: string; version: string; depth: number }[]> {
  const result = await pool.query(
    `WITH RECURSIVE ancestry AS (
      SELECT id, slug, name, version, forked_from, 0 AS depth
      FROM skills WHERE id = $1
      UNION ALL
      SELECT s.id, s.slug, s.name, s.version, s.forked_from, a.depth + 1
      FROM skills s
      JOIN ancestry a ON s.slug || '@' || s.version = a.forked_from
    )
    SELECT id, slug, name, version, depth
    FROM ancestry
    ORDER BY depth ASC`,
    [skillId]
  );

  return result.rows.map((r: any) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    version: r.version,
    depth: r.depth ?? 0,
  }));
}

export async function getForks(
  skillId: string,
  pool: Pool
): Promise<
  { id: string; slug: string; name: string; authorType: string; createdAt: string }[]
> {
  // Look up source skill's slug@version to find forks via forked_from
  const source = await pool.query(
    `SELECT slug, version FROM skills WHERE id = $1`,
    [skillId]
  );
  if (source.rows.length === 0) return [];

  const slugAtVersion = `${source.rows[0].slug}@${source.rows[0].version}`;

  const result = await pool.query(
    `SELECT id, slug, name, author_type, created_at
     FROM skills
     WHERE forked_from = $1
     ORDER BY created_at DESC`,
    [slugAtVersion]
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
