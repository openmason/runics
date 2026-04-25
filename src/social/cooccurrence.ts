import type { Pool } from '../db/connection';
import type { CoOccurrenceResult } from '../types';

export async function getCoOccurrence(
  skillId: string,
  limit: number = 5,
  pool: Pool
): Promise<CoOccurrenceResult[]> {
  const result = await pool.query(
    `SELECT
      CASE WHEN sc.skill_a = $1 THEN sc.skill_b ELSE sc.skill_a END AS peer_id,
      s.name,
      s.slug,
      sc.composition_count,
      sc.total_paired_invocations
    FROM skill_cooccurrence sc
    JOIN skills s ON s.id = (CASE WHEN sc.skill_a = $1 THEN sc.skill_b ELSE sc.skill_a END)
    WHERE sc.skill_a = $1 OR sc.skill_b = $1
    ORDER BY sc.total_paired_invocations DESC
    LIMIT $2`,
    [skillId, limit]
  );

  return result.rows.map((r: any) => ({
    skillId: r.peer_id,
    name: r.name,
    slug: r.slug,
    compositionCount: r.composition_count,
    totalPairedInvocations: r.total_paired_invocations,
  }));
}
