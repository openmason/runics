import type { Pool } from '../db/connection';
import type { LeaderboardFilters, LeaderboardEntry } from '../types';

function buildWhereClause(
  filters: LeaderboardFilters
): { clause: string; params: any[]; nextParam: number } {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  if (filters.skillType) {
    conditions.push(`skill_type = $${paramIdx++}`);
    params.push(filters.skillType);
  }
  if (filters.category) {
    conditions.push(`$${paramIdx++} = ANY(categories)`);
    params.push(filters.category);
  }
  if (filters.ecosystem) {
    conditions.push(`ecosystem = $${paramIdx++}`);
    params.push(filters.ecosystem);
  }

  const clause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { clause, params, nextParam: paramIdx };
}

function clampLimit(filters: LeaderboardFilters): number {
  return Math.min(Math.max(filters.limit || 20, 1), 100);
}

export async function getHumanLeaderboard(
  filters: LeaderboardFilters,
  pool: Pool
): Promise<LeaderboardEntry[]> {
  const { clause, params, nextParam } = buildWhereClause(filters);
  const limit = clampLimit(filters);
  const offset = filters.offset || 0;

  const result = await pool.query(
    `SELECT * FROM leaderboard_human ${clause}
     ORDER BY human_score DESC
     LIMIT $${nextParam} OFFSET $${nextParam + 1}`,
    [...params, limit, offset]
  );

  return result.rows.map(mapHumanEntry);
}

export async function getAgentLeaderboard(
  filters: LeaderboardFilters,
  pool: Pool
): Promise<LeaderboardEntry[]> {
  const { clause, params, nextParam } = buildWhereClause(filters);
  const limit = clampLimit(filters);
  const offset = filters.offset || 0;

  const result = await pool.query(
    `SELECT * FROM leaderboard_agent ${clause}
     ORDER BY agent_score DESC
     LIMIT $${nextParam} OFFSET $${nextParam + 1}`,
    [...params, limit, offset]
  );

  return result.rows.map(mapAgentEntry);
}

export async function getTrendingLeaderboard(
  filters: LeaderboardFilters,
  pool: Pool
): Promise<LeaderboardEntry[]> {
  const { clause, params, nextParam } = buildWhereClause(filters);
  const limit = clampLimit(filters);
  const offset = filters.offset || 0;

  const result = await pool.query(
    `SELECT * FROM leaderboard_agent ${clause}
     ORDER BY weekly_agent_invocation_count DESC
     LIMIT $${nextParam} OFFSET $${nextParam + 1}`,
    [...params, limit, offset]
  );

  return result.rows.map(mapAgentEntry);
}

export async function getMostComposedLeaderboard(
  filters: LeaderboardFilters,
  pool: Pool
): Promise<LeaderboardEntry[]> {
  const { clause, params, nextParam } = buildWhereClause(filters);
  const limit = clampLimit(filters);
  const offset = filters.offset || 0;

  const result = await pool.query(
    `SELECT * FROM leaderboard_agent ${clause}
     ORDER BY composition_inclusion_count DESC
     LIMIT $${nextParam} OFFSET $${nextParam + 1}`,
    [...params, limit, offset]
  );

  return result.rows.map(mapAgentEntry);
}

export async function getMostForkedLeaderboard(
  filters: LeaderboardFilters,
  pool: Pool
): Promise<LeaderboardEntry[]> {
  const { clause, params, nextParam } = buildWhereClause(filters);
  const limit = clampLimit(filters);
  const offset = filters.offset || 0;

  const result = await pool.query(
    `SELECT * FROM leaderboard_human ${clause}
     ORDER BY human_fork_count DESC
     LIMIT $${nextParam} OFFSET $${nextParam + 1}`,
    [...params, limit, offset]
  );

  return result.rows.map(mapHumanEntry);
}

function mapHumanEntry(r: any): LeaderboardEntry {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    skillType: r.skill_type,
    authorHandle: r.author_handle,
    authorType: r.author_type,
    score: r.human_score,
    trustScore: parseFloat(r.trust_score) || 0,
    humanStarCount: r.human_star_count,
    humanForkCount: r.human_fork_count,
  };
}

function mapAgentEntry(r: any): LeaderboardEntry {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    skillType: r.skill_type,
    authorHandle: r.author_handle,
    authorType: r.author_type,
    score: r.agent_score,
    trustScore: parseFloat(r.trust_score) || 0,
    agentInvocationCount: r.agent_invocation_count,
    weeklyAgentInvocationCount: r.weekly_agent_invocation_count,
    compositionInclusionCount: r.composition_inclusion_count,
    avgExecutionTimeMs: r.avg_execution_time_ms,
    errorRate: r.error_rate,
  };
}
