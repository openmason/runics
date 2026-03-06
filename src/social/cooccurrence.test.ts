import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCoOccurrence } from './cooccurrence';

describe('getCoOccurrence', () => {
  let mockPool: any;

  beforeEach(() => {
    mockPool = { query: vi.fn() };
  });

  it('should return mapped co-occurrence results', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          peer_id: 'peer-1',
          name: 'Peer Skill',
          slug: 'peer-skill',
          composition_count: 5,
          total_paired_invocations: 1000,
        },
        {
          peer_id: 'peer-2',
          name: 'Other',
          slug: 'other',
          composition_count: 2,
          total_paired_invocations: 500,
        },
      ],
    });

    const result = await getCoOccurrence('skill-1', 5, mockPool);

    expect(result).toEqual([
      {
        skillId: 'peer-1',
        name: 'Peer Skill',
        slug: 'peer-skill',
        compositionCount: 5,
        totalPairedInvocations: 1000,
      },
      {
        skillId: 'peer-2',
        name: 'Other',
        slug: 'other',
        compositionCount: 2,
        totalPairedInvocations: 500,
      },
    ]);
  });

  it('should pass skillId and limit to query', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await getCoOccurrence('test-skill', 10, mockPool);

    expect(mockPool.query.mock.calls[0][1]).toEqual(['test-skill', 10]);
  });

  it('should return empty array when no co-occurrences', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const result = await getCoOccurrence('lonely-skill', 5, mockPool);
    expect(result).toEqual([]);
  });

  it('should query skill_cooccurrence materialized view', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await getCoOccurrence('skill-1', 5, mockPool);

    expect(mockPool.query.mock.calls[0][0]).toContain('skill_cooccurrence');
  });

  it('should use default limit of 5', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await getCoOccurrence('skill-1', undefined as any, mockPool);

    // The function signature has limit=5 default, so it's passed to query
    expect(mockPool.query.mock.calls[0][1][1]).toBe(5);
  });
});
