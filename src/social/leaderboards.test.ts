import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getHumanLeaderboard,
  getAgentLeaderboard,
  getTrendingLeaderboard,
  getMostComposedLeaderboard,
} from './leaderboards';

describe('getHumanLeaderboard', () => {
  let mockPool: any;

  beforeEach(() => {
    mockPool = { query: vi.fn() };
  });

  it('should return mapped human leaderboard entries', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 's1',
          slug: 'skill-1',
          name: 'Skill 1',
          type: 'skill',
          author_handle: 'alice',
          author_type: 'human',
          human_score: 75,
          trust_score: '0.9',
          human_star_count: 10,
          human_fork_count: 5,
        },
      ],
    });

    const result = await getHumanLeaderboard({}, mockPool);

    expect(result).toEqual([
      {
        id: 's1',
        slug: 'skill-1',
        name: 'Skill 1',
        type: 'skill',
        authorHandle: 'alice',
        authorType: 'human',
        score: 75,
        trustScore: 0.9,
        humanStarCount: 10,
        humanForkCount: 5,
      },
    ]);
  });

  it('should apply type filter', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await getHumanLeaderboard({ type: 'composition' }, mockPool);

    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toContain('WHERE type = $1');
    expect(mockPool.query.mock.calls[0][1][0]).toBe('composition');
  });

  it('should apply category filter', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await getHumanLeaderboard({ category: 'devops' }, mockPool);

    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toContain('ANY(categories)');
    expect(mockPool.query.mock.calls[0][1][0]).toBe('devops');
  });

  it('should apply ecosystem filter', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await getHumanLeaderboard({ ecosystem: 'npm' }, mockPool);

    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toContain('ecosystem = $1');
  });

  it('should combine multiple filters', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await getHumanLeaderboard({ type: 'skill', category: 'ai', ecosystem: 'npm' }, mockPool);

    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toContain('WHERE');
    expect(sql).toContain('AND');
  });

  it('should clamp limit between 1 and 100', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await getHumanLeaderboard({ limit: 200 }, mockPool);
    const params = mockPool.query.mock.calls[0][1];
    expect(params[0]).toBe(100); // clamped to max

    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await getHumanLeaderboard({ limit: 0 }, mockPool);
    const params2 = mockPool.query.mock.calls[1][1];
    expect(params2[0]).toBe(20); // 0 is falsy → default 20
  });

  it('should use default limit of 20', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await getHumanLeaderboard({}, mockPool);
    const params = mockPool.query.mock.calls[0][1];
    expect(params[0]).toBe(20);
  });

  it('should apply offset', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await getHumanLeaderboard({ offset: 50 }, mockPool);
    const params = mockPool.query.mock.calls[0][1];
    expect(params[1]).toBe(50); // offset param
  });

  it('should handle null trust_score', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 's1',
          slug: 'sk',
          name: 'S',
          type: 'skill',
          author_handle: null,
          author_type: 'human',
          human_score: 10,
          trust_score: null,
          human_star_count: 1,
          human_fork_count: 0,
        },
      ],
    });

    const result = await getHumanLeaderboard({}, mockPool);
    expect(result[0].trustScore).toBe(0);
  });
});

describe('getAgentLeaderboard', () => {
  let mockPool: any;

  beforeEach(() => {
    mockPool = { query: vi.fn() };
  });

  it('should return mapped agent leaderboard entries', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 's1',
          slug: 'skill-1',
          name: 'Skill 1',
          type: 'skill',
          author_handle: 'bot-1',
          author_type: 'bot',
          agent_score: 1054,
          trust_score: '0.8',
          agent_invocation_count: 1000,
          weekly_agent_invocation_count: 100,
          composition_inclusion_count: 5,
          avg_execution_time_ms: 50,
          error_rate: 0.02,
        },
      ],
    });

    const result = await getAgentLeaderboard({}, mockPool);

    expect(result[0]).toEqual({
      id: 's1',
      slug: 'skill-1',
      name: 'Skill 1',
      type: 'skill',
      authorHandle: 'bot-1',
      authorType: 'bot',
      score: 1054,
      trustScore: 0.8,
      agentInvocationCount: 1000,
      weeklyAgentInvocationCount: 100,
      compositionInclusionCount: 5,
      avgExecutionTimeMs: 50,
      errorRate: 0.02,
    });
  });

  it('should order by agent_score DESC', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await getAgentLeaderboard({}, mockPool);
    expect(mockPool.query.mock.calls[0][0]).toContain('ORDER BY agent_score DESC');
  });
});

describe('getTrendingLeaderboard', () => {
  let mockPool: any;

  beforeEach(() => {
    mockPool = { query: vi.fn() };
  });

  it('should order by weekly_agent_invocation_count DESC', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await getTrendingLeaderboard({}, mockPool);
    expect(mockPool.query.mock.calls[0][0]).toContain(
      'ORDER BY weekly_agent_invocation_count DESC'
    );
  });

  it('should apply filters same as other leaderboards', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await getTrendingLeaderboard({ type: 'pipeline' }, mockPool);
    expect(mockPool.query.mock.calls[0][0]).toContain('WHERE type = $1');
  });
});

describe('getMostComposedLeaderboard', () => {
  let mockPool: any;

  beforeEach(() => {
    mockPool = { query: vi.fn() };
  });

  it('should order by composition_inclusion_count DESC', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await getMostComposedLeaderboard({}, mockPool);
    expect(mockPool.query.mock.calls[0][0]).toContain(
      'ORDER BY composition_inclusion_count DESC'
    );
  });
});
