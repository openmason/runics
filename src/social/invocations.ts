import { Pool } from '@neondatabase/serverless';
import type { InvocationBatch } from '../types';

const CHUNK_SIZE = 100;

export async function recordInvocations(
  batch: InvocationBatch,
  pool: Pool
): Promise<void> {
  const { invocations } = batch;
  if (invocations.length === 0) return;

  // Bulk insert in chunks to stay within parameter limits
  for (let i = 0; i < invocations.length; i += CHUNK_SIZE) {
    const chunk = invocations.slice(i, i + CHUNK_SIZE);
    const values: any[] = [];
    const placeholders: string[] = [];

    chunk.forEach((inv, idx) => {
      const offset = idx * 6;
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`
      );
      values.push(
        inv.skillId,
        inv.compositionId || null,
        inv.tenantId,
        inv.callerType,
        inv.durationMs ?? null,
        inv.succeeded
      );
    });

    await pool.query(
      `INSERT INTO skill_invocations (skill_id, composition_id, tenant_id, caller_type, duration_ms, succeeded)
       VALUES ${placeholders.join(', ')}`,
      values
    );
  }

  // Group by skill_id and update counters
  const skillGroups = new Map<
    string,
    { count: number; totalDuration: number; durationCount: number; errorCount: number }
  >();

  for (const inv of invocations) {
    const group = skillGroups.get(inv.skillId) || {
      count: 0,
      totalDuration: 0,
      durationCount: 0,
      errorCount: 0,
    };
    group.count++;
    if (inv.durationMs != null) {
      group.totalDuration += inv.durationMs;
      group.durationCount++;
    }
    if (!inv.succeeded) {
      group.errorCount++;
    }
    skillGroups.set(inv.skillId, group);
  }

  for (const [skillId, group] of skillGroups) {
    const avgDuration =
      group.durationCount > 0 ? group.totalDuration / group.durationCount : null;
    const errorRate = group.errorCount / group.count;

    await pool.query(
      `UPDATE skills SET
        agent_invocation_count = agent_invocation_count + $1,
        weekly_agent_invocation_count = weekly_agent_invocation_count + $1,
        last_used_at = NOW(),
        avg_execution_time_ms = CASE
          WHEN avg_execution_time_ms IS NULL THEN $2
          WHEN $2 IS NULL THEN avg_execution_time_ms
          ELSE avg_execution_time_ms * 0.9 + $2 * 0.1
        END,
        error_rate = CASE
          WHEN error_rate IS NULL THEN $3
          ELSE error_rate * 0.9 + $3 * 0.1
        END
      WHERE id = $4`,
      [group.count, avgDuration, errorRate, skillId]
    );
  }
}
