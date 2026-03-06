import { describe, it, expect, vi, beforeEach } from 'vitest';
import { starSkill, unstarSkill, getStarStatus, RateLimitError } from './stars';

describe('RateLimitError', () => {
  it('should have correct name and message', () => {
    const error = new RateLimitError('limit exceeded');
    expect(error.name).toBe('RateLimitError');
    expect(error.message).toBe('limit exceeded');
    expect(error).toBeInstanceOf(Error);
  });
});

describe('starSkill', () => {
  let mockPool: any;

  beforeEach(() => {
    mockPool = { query: vi.fn() };
  });

  it('should throw RateLimitError when daily limit reached', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ count: 200 }] });
    await expect(starSkill('skill1', 'user1', mockPool)).rejects.toThrow(RateLimitError);
  });

  it('should throw RateLimitError when over daily limit', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ count: 201 }] });
    await expect(starSkill('skill1', 'user1', mockPool)).rejects.toThrow(RateLimitError);
  });

  it('should allow star within daily limit', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ count: 199 }] }) // rate check
      .mockResolvedValueOnce({ rows: [{ user_id: 'u', skill_id: 's' }] }) // INSERT RETURNING
      .mockResolvedValueOnce({ rows: [] }); // UPDATE counter

    const result = await starSkill('skill1', 'user1', mockPool);
    expect(result).toEqual({ starred: true });
  });

  it('should increment human_star_count on new star', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })
      .mockResolvedValueOnce({ rows: [{ user_id: 'u', skill_id: 's' }] })
      .mockResolvedValueOnce({ rows: [] });

    await starSkill('skill1', 'user1', mockPool);

    expect(mockPool.query).toHaveBeenCalledTimes(3);
    expect(mockPool.query.mock.calls[2][0]).toContain('human_star_count');
  });

  it('should be idempotent (no-op on duplicate star)', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })
      .mockResolvedValueOnce({ rows: [] }); // ON CONFLICT DO NOTHING returns empty

    const result = await starSkill('skill1', 'user1', mockPool);

    expect(result).toEqual({ starred: false });
    // Only 2 queries: rate check + INSERT (no counter update)
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });
});

describe('unstarSkill', () => {
  let mockPool: any;

  beforeEach(() => {
    mockPool = { query: vi.fn() };
  });

  it('should decrement counter when star existed', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ user_id: 'u', skill_id: 's' }] }) // DELETE RETURNING
      .mockResolvedValueOnce({ rows: [] }); // UPDATE counter

    const result = await unstarSkill('skill1', 'user1', mockPool);

    expect(result).toEqual({ unstarred: true });
    expect(mockPool.query.mock.calls[1][0]).toContain('GREATEST');
  });

  it('should be no-op when star did not exist', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // DELETE returns nothing

    const result = await unstarSkill('skill1', 'user1', mockPool);

    expect(result).toEqual({ unstarred: false });
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });
});

describe('getStarStatus', () => {
  let mockPool: any;

  beforeEach(() => {
    mockPool = { query: vi.fn() };
  });

  it('should return count and userStarred=false when no userId', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ human_star_count: 42 }] });

    const result = await getStarStatus('skill1', null, mockPool);

    expect(result).toEqual({ starCount: 42, userStarred: false });
    expect(mockPool.query).toHaveBeenCalledTimes(1); // no user_stars query
  });

  it('should return userStarred=true when user has starred', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ human_star_count: 10 }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

    const result = await getStarStatus('skill1', 'user1', mockPool);

    expect(result).toEqual({ starCount: 10, userStarred: true });
  });

  it('should return userStarred=false when user has not starred', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ human_star_count: 10 }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await getStarStatus('skill1', 'user1', mockPool);

    expect(result).toEqual({ starCount: 10, userStarred: false });
  });

  it('should default starCount to 0 when skill not found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const result = await getStarStatus('nonexistent', null, mockPool);
    expect(result.starCount).toBe(0);
  });
});
