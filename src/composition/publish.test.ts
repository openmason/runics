import { describe, it, expect, vi, beforeEach } from 'vitest';
import { publishComposition } from './publish';
import { NotFoundError } from './fork';
import { ValidationError } from './compose';

describe('publishComposition', () => {
  let mockPool: any;

  beforeEach(() => {
    mockPool = { query: vi.fn() };
  });

  it('should throw NotFoundError if composition not found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await expect(publishComposition('bad-id', mockPool)).rejects.toThrow(NotFoundError);
  });

  it('should throw ValidationError if skill is not a composition/pipeline', async () => {
    mockPool.query.mockResolvedValue({
      rows: [{ id: 'id', slug: 's', status: 'draft', type: 'skill' }],
    });
    await expect(publishComposition('id', mockPool)).rejects.toThrow(ValidationError);
    await expect(publishComposition('id', mockPool)).rejects.toThrow('not a composition');
  });

  it('should throw ValidationError if status is not draft', async () => {
    mockPool.query.mockResolvedValue({
      rows: [{ id: 'id', slug: 's', status: 'published', type: 'composition' }],
    });
    await expect(publishComposition('id', mockPool)).rejects.toThrow(ValidationError);
    await expect(publishComposition('id', mockPool)).rejects.toThrow("'published' state");
  });

  it('should throw ValidationError if any step skill is not published', async () => {
    let callCount = 0;
    mockPool.query.mockImplementation(() => {
      callCount++;
      if (callCount % 2 === 1) {
        return Promise.resolve({
          rows: [{ id: 'id', slug: 's', status: 'draft', type: 'composition' }],
        });
      }
      return Promise.resolve({
        rows: [
          { skill_id: 's1', status: 'published', name: 'Skill 1' },
          { skill_id: 's2', status: 'deprecated', name: 'Skill 2' },
        ],
      });
    });

    await expect(publishComposition('id', mockPool)).rejects.toThrow(ValidationError);
    await expect(publishComposition('id', mockPool)).rejects.toThrow('not published');
  });

  it('should transition to published when all validations pass', async () => {
    mockPool.query
      // SELECT skill
      .mockResolvedValueOnce({
        rows: [{ id: 'comp-id', slug: 'my-comp', status: 'draft', type: 'composition' }],
      })
      // SELECT steps
      .mockResolvedValueOnce({
        rows: [
          { skill_id: 's1', status: 'published', name: 'Skill 1' },
          { skill_id: 's2', status: 'published', name: 'Skill 2' },
        ],
      })
      // UPDATE
      .mockResolvedValueOnce({
        rows: [{ id: 'comp-id', slug: 'my-comp', status: 'published' }],
      });

    const result = await publishComposition('comp-id', mockPool);

    expect(result).toEqual({ id: 'comp-id', slug: 'my-comp', status: 'published' });
    // Verify UPDATE was called
    expect(mockPool.query.mock.calls[2][0]).toContain("status = 'published'");
  });

  it('should work for pipeline type', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'p-id', slug: 'my-pipe', status: 'draft', type: 'pipeline' }],
      })
      .mockResolvedValueOnce({ rows: [] }) // no steps
      .mockResolvedValueOnce({
        rows: [{ id: 'p-id', slug: 'my-pipe', status: 'published' }],
      });

    const result = await publishComposition('p-id', mockPool);
    expect(result.status).toBe('published');
  });

  it('should include unpublished skill names in error message', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'id', slug: 's', status: 'draft', type: 'composition' }],
      })
      .mockResolvedValueOnce({
        rows: [
          { skill_id: 's1', status: 'deprecated', name: 'Alpha' },
          { skill_id: 's2', status: 'archived', name: 'Beta' },
        ],
      });

    try {
      await publishComposition('id', mockPool);
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e.message).toContain('Alpha (deprecated)');
      expect(e.message).toContain('Beta (archived)');
    }
  });
});

describe('NotFoundError', () => {
  it('should have correct name and message', () => {
    const error = new NotFoundError('not found');
    expect(error.name).toBe('NotFoundError');
    expect(error.message).toBe('not found');
    expect(error).toBeInstanceOf(Error);
  });
});

describe('ValidationError', () => {
  it('should have correct name', () => {
    const error = new ValidationError('invalid');
    expect(error.name).toBe('ValidationError');
    expect(error.message).toBe('invalid');
    expect(error).toBeInstanceOf(Error);
  });
});
