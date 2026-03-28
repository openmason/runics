import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAncestry, getForks, getDependents } from './lineage';

describe('lineage', () => {
  let mockPool: any;

  beforeEach(() => {
    mockPool = { query: vi.fn() };
  });

  describe('getAncestry', () => {
    it('should return ancestry chain with mapped fields', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 'root', slug: 'root-skill', name: 'Root', version: '1.0.0', depth: 0 },
          { id: 'child', slug: 'child-skill', name: 'Child', version: '1.0.1', depth: 1 },
          { id: 'grandchild', slug: 'gc', name: 'GC', version: '1.0.2', depth: 2 },
        ],
      });

      const result = await getAncestry('grandchild', mockPool);

      expect(result).toEqual([
        { id: 'root', slug: 'root-skill', name: 'Root', version: '1.0.0', depth: 0 },
        { id: 'child', slug: 'child-skill', name: 'Child', version: '1.0.1', depth: 1 },
        { id: 'grandchild', slug: 'gc', name: 'GC', version: '1.0.2', depth: 2 },
      ]);
    });

    it('should handle null depth', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'a', slug: 's', name: 'N', version: '1.0.0', depth: null }],
      });

      const result = await getAncestry('a', mockPool);
      expect(result[0].depth).toBe(0);
    });

    it('should return empty array for no results', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      const result = await getAncestry('nonexistent', mockPool);
      expect(result).toEqual([]);
    });

    it('should pass skill ID to recursive CTE query', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      await getAncestry('test-id', mockPool);
      expect(mockPool.query.mock.calls[0][1]).toEqual(['test-id']);
      expect(mockPool.query.mock.calls[0][0]).toContain('WITH RECURSIVE');
    });

    it('should use forked_from for ancestry traversal', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      await getAncestry('test-id', mockPool);
      expect(mockPool.query.mock.calls[0][0]).toContain('forked_from');
    });
  });

  describe('getForks', () => {
    it('should return direct forks with mapped fields', async () => {
      // First query: look up source slug@version
      mockPool.query.mockResolvedValueOnce({
        rows: [{ slug: 'parent-skill', version: '1.0.0' }],
      });
      // Second query: find forks by forked_from
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'f1',
            slug: 'fork-1',
            name: 'Fork 1',
            author_type: 'human',
            created_at: '2025-01-01',
          },
          {
            id: 'f2',
            slug: 'fork-2',
            name: 'Fork 2',
            author_type: 'bot',
            created_at: '2025-01-02',
          },
        ],
      });

      const result = await getForks('parent-id', mockPool);

      expect(result).toEqual([
        {
          id: 'f1',
          slug: 'fork-1',
          name: 'Fork 1',
          authorType: 'human',
          createdAt: '2025-01-01',
        },
        {
          id: 'f2',
          slug: 'fork-2',
          name: 'Fork 2',
          authorType: 'bot',
          createdAt: '2025-01-02',
        },
      ]);
    });

    it('should query WHERE forked_from = slug@version', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ slug: 'my-skill', version: '2.0.0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await getForks('parent-id', mockPool);

      expect(mockPool.query.mock.calls[1][0]).toContain('forked_from');
      expect(mockPool.query.mock.calls[1][1]).toEqual(['my-skill@2.0.0']);
    });

    it('should return empty array when source not found', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      const result = await getForks('nonexistent', mockPool);
      expect(result).toEqual([]);
    });
  });

  describe('getDependents', () => {
    it('should return compositions that use the skill', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            composition_id: 'c1',
            composition_slug: 'comp-1',
            composition_name: 'Comp 1',
            step_order: 2,
          },
        ],
      });

      const result = await getDependents('skill-id', mockPool);

      expect(result).toEqual([
        {
          compositionId: 'c1',
          compositionSlug: 'comp-1',
          compositionName: 'Comp 1',
          stepOrder: 2,
        },
      ]);
    });

    it('should query composition_steps joined with skills', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      await getDependents('skill-id', mockPool);
      expect(mockPool.query.mock.calls[0][0]).toContain('composition_steps');
      expect(mockPool.query.mock.calls[0][0]).toContain('JOIN skills');
    });
  });
});
