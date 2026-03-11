// ══════════════════════════════════════════════════════════════════════════════
// Cognium Client — Composite Cascade
// ══════════════════════════════════════════════════════════════════════════════
//
// Cascades revoked/vulnerable status to composite skills containing the
// affected constituent. Also handles repair when a constituent is patched.
//
// Uses composition_skill_ids (UUID[]) for O(1) GIN index lookups.
//
// ══════════════════════════════════════════════════════════════════════════════

import type { SkillStatus } from '../types';

// Accept Pool or transactional Client — both have .query()
type Queryable = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

export async function cascadeStatusToComposites(
  pool: Queryable,
  constituentSkillId: string,
  newStatus: 'revoked' | 'vulnerable',
): Promise<void> {
  const derivedStatus: SkillStatus = newStatus === 'revoked' ? 'degraded' : 'contains-vulnerable';

  // Find all composites that include this skill and are not already revoked/draft
  const composites = await pool.query(
    `SELECT id, slug, version, status FROM skills
     WHERE skill_type IN ('auto-composite', 'human-composite')
       AND composition_skill_ids @> ARRAY[$1]::uuid[]
       AND status NOT IN ('revoked', 'draft')`,
    [constituentSkillId]
  );

  for (const composite of composites.rows) {
    await pool.query(
      `UPDATE skills SET status = $1, updated_at = NOW() WHERE id = $2`,
      [derivedStatus, composite.id]
    );
    console.log(`[CASCADE] Composite ${composite.slug}@${composite.version} -> ${derivedStatus}`);
  }
}

export async function repairCompositeStatus(
  pool: Queryable,
  repairedSkillId: string,
): Promise<void> {
  // Find composites containing this skill that are currently 'contains-vulnerable' or 'degraded'
  const composites = await pool.query(
    `SELECT id, composition_skill_ids FROM skills
     WHERE skill_type IN ('auto-composite', 'human-composite')
       AND composition_skill_ids @> ARRAY[$1]::uuid[]
       AND status IN ('contains-vulnerable', 'degraded')`,
    [repairedSkillId]
  );

  for (const composite of composites.rows) {
    const skillIds = composite.composition_skill_ids ?? [];
    if (skillIds.length === 0) continue;

    // Check if ALL constituents are now clean
    // Must match row count to skillIds count — missing/deleted skills block repair
    const constituents = await pool.query(
      `SELECT status FROM skills WHERE id = ANY($1::uuid[])`,
      [skillIds]
    );

    const allClean = constituents.rows.length === skillIds.length &&
      constituents.rows.every((c: { status: string }) =>
        ['published', 'deprecated'].includes(c.status)
      );

    if (allClean) {
      await pool.query(
        `UPDATE skills SET status = 'published', updated_at = NOW() WHERE id = $1`,
        [composite.id]
      );
      console.log(`[CASCADE] Composite ${composite.id} repaired -> published`);
    }
  }
}
