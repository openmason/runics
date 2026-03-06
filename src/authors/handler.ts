import { Hono } from 'hono';
import { Pool } from '@neondatabase/serverless';
import type { Env } from '../types';

export const authorRoutes = new Hono<{ Bindings: Env }>();

// GET /v1/authors/:handle — Author profile with aggregate stats
authorRoutes.get('/:handle', async (c) => {
  const handle = c.req.param('handle');
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

  try {
    const result = await pool.query(
      `SELECT
        a.*,
        COUNT(s.id) FILTER (WHERE s.status = 'published') AS published_count,
        COALESCE(SUM(s.human_star_count), 0) AS total_stars,
        COALESCE(SUM(s.agent_invocation_count), 0) AS total_invocations,
        COALESCE(SUM(s.human_fork_count), 0) AS total_forks
      FROM authors a
      LEFT JOIN skills s ON s.author_id = a.id
      WHERE a.handle = $1
      GROUP BY a.id`,
      [handle]
    );

    if (result.rows.length === 0) {
      return c.json({ error: 'Author not found' }, 404);
    }

    const author = result.rows[0];
    return c.json({
      id: author.id,
      handle: author.handle,
      displayName: author.display_name,
      authorType: author.author_type,
      bio: author.bio,
      avatarUrl: author.avatar_url,
      homepageUrl: author.homepage_url,
      botModel: author.bot_model,
      verified: author.verified,
      stats: {
        publishedCount: parseInt(author.published_count) || 0,
        totalStars: parseInt(author.total_stars) || 0,
        totalInvocations: parseInt(author.total_invocations) || 0,
        totalForks: parseInt(author.total_forks) || 0,
      },
      createdAt: author.created_at,
    });
  } catch (error) {
    console.error('[AUTHORS] Error fetching author:', error);
    return c.json({ error: 'Failed to fetch author' }, 500);
  }
});

// GET /v1/authors/:handle/skills — Paginated skills by author
authorRoutes.get('/:handle/skills', async (c) => {
  const handle = c.req.param('handle');
  const type = c.req.query('type');
  const status = c.req.query('status');
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const offset = parseInt(c.req.query('offset') || '0');
  const pool = new Pool({ connectionString: c.env.NEON_CONNECTION_STRING });

  try {
    const conditions: string[] = ['a.handle = $1'];
    const params: any[] = [handle];
    let paramIdx = 2;

    if (type) {
      conditions.push(`s.type = $${paramIdx++}`);
      params.push(type);
    }
    if (status) {
      conditions.push(`s.status = $${paramIdx++}`);
      params.push(status);
    }

    const where = conditions.join(' AND ');

    const result = await pool.query(
      `SELECT s.id, s.name, s.slug, s.type, s.status, s.description,
              s.trust_score, s.human_star_count, s.agent_invocation_count,
              s.tags, s.created_at, s.published_at
       FROM skills s
       JOIN authors a ON a.id = s.author_id
       WHERE ${where}
       ORDER BY s.created_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    );

    return c.json({
      skills: result.rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        type: r.type,
        status: r.status,
        description: r.description,
        trustScore: parseFloat(r.trust_score) || 0,
        humanStarCount: r.human_star_count,
        agentInvocationCount: r.agent_invocation_count,
        tags: r.tags,
        createdAt: r.created_at,
        publishedAt: r.published_at,
      })),
      limit,
      offset,
    });
  } catch (error) {
    console.error('[AUTHORS] Error fetching skills:', error);
    return c.json({ error: 'Failed to fetch author skills' }, 500);
  }
});
