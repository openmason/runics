import { Pool } from '@neondatabase/serverless';

const DAILY_STAR_LIMIT = 200;

export async function starSkill(
  skillId: string,
  userId: string,
  pool: Pool
): Promise<{ starred: boolean }> {
  // Rate limit check
  const rateCheck = await pool.query(
    `SELECT COUNT(*)::int AS count FROM user_stars
     WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 day'`,
    [userId]
  );

  if (rateCheck.rows[0].count >= DAILY_STAR_LIMIT) {
    throw new RateLimitError(`Star rate limit exceeded (${DAILY_STAR_LIMIT}/day)`);
  }

  // Idempotent upsert — only increment counter on actual insert
  const result = await pool.query(
    `INSERT INTO user_stars (user_id, skill_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, skill_id) DO NOTHING
     RETURNING *`,
    [userId, skillId]
  );

  if (result.rows.length > 0) {
    await pool.query(
      `UPDATE skills SET human_star_count = human_star_count + 1 WHERE id = $1`,
      [skillId]
    );
    return { starred: true };
  }

  // Already starred — no-op
  return { starred: false };
}

export async function unstarSkill(
  skillId: string,
  userId: string,
  pool: Pool
): Promise<{ unstarred: boolean }> {
  const result = await pool.query(
    `DELETE FROM user_stars WHERE user_id = $1 AND skill_id = $2 RETURNING *`,
    [userId, skillId]
  );

  if (result.rows.length > 0) {
    await pool.query(
      `UPDATE skills SET human_star_count = GREATEST(human_star_count - 1, 0) WHERE id = $1`,
      [skillId]
    );
    return { unstarred: true };
  }

  return { unstarred: false };
}

export async function getStarStatus(
  skillId: string,
  userId: string | null,
  pool: Pool
): Promise<{ starCount: number; userStarred: boolean }> {
  const skill = await pool.query(
    `SELECT human_star_count FROM skills WHERE id = $1`,
    [skillId]
  );

  const starCount = skill.rows[0]?.human_star_count ?? 0;

  if (!userId) {
    return { starCount, userStarred: false };
  }

  const userStar = await pool.query(
    `SELECT 1 FROM user_stars WHERE user_id = $1 AND skill_id = $2`,
    [userId, skillId]
  );

  return { starCount, userStarred: userStar.rows.length > 0 };
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}
