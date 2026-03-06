import { describe, it, expect, vi, beforeEach } from 'vitest';
import { forkSkill, NotFoundError } from './fork';

vi.mock('nanoid', () => ({ nanoid: () => 'abc123' }));

describe('forkSkill', () => {
  let mockPool: any;
  let mockEnv: any;

  beforeEach(() => {
    mockPool = { query: vi.fn() };
    mockEnv = {
      EMBED_QUEUE: { send: vi.fn() },
      COGNIUM_QUEUE: { send: vi.fn() },
    };
  });

  it('should throw NotFoundError if source skill not found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await expect(forkSkill('bad-id', 'author1', 'human', mockPool, mockEnv)).rejects.toThrow(
      NotFoundError
    );
  });

  it('should fork a skill and return id/slug', async () => {
    mockPool.query
      // SELECT source
      .mockResolvedValueOnce({
        rows: [
          {
            slug: 'original-skill',
            name: 'Original',
            type: 'skill',
            description: 'desc',
            readme: null,
            schema_json: null,
            execution_layer: 'instructions',
            tags: ['tag1'],
            categories: ['cat1'],
            ecosystem: 'npm',
            license: 'MIT',
            origin_id: null,
            fork_depth: 0,
            capabilities_required: ['git'],
          },
        ],
      })
      // INSERT fork
      .mockResolvedValueOnce({
        rows: [{ id: 'fork-id', slug: 'original-skill-fork-abc123' }],
      })
      // UPDATE human_fork_count
      .mockResolvedValueOnce({ rows: [] });

    const result = await forkSkill('source-id', 'author1', 'human', mockPool, mockEnv);

    expect(result).toEqual({ id: 'fork-id', slug: 'original-skill-fork-abc123' });
    expect(mockPool.query).toHaveBeenCalledTimes(3);
    // Verify fork counter is for human
    expect(mockPool.query.mock.calls[2][0]).toContain('human_fork_count');
    // Verify queues were called
    expect(mockEnv.EMBED_QUEUE.send).toHaveBeenCalledWith({ skillId: 'fork-id', action: 'embed' });
    expect(mockEnv.COGNIUM_QUEUE.send).toHaveBeenCalledWith({
      skillId: 'fork-id',
      action: 'scan',
    });
  });

  it('should increment agent_fork_count for bot author', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          {
            slug: 'sk',
            name: 'S',
            type: 'skill',
            description: 'd',
            readme: null,
            schema_json: { type: 'object' },
            execution_layer: 'instructions',
            tags: [],
            categories: [],
            ecosystem: null,
            license: null,
            origin_id: 'root',
            fork_depth: 1,
            capabilities_required: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'f-id', slug: 'sk-fork-abc123' }] })
      .mockResolvedValueOnce({ rows: [] });

    await forkSkill('source-id', 'bot1', 'bot', mockPool, mockEnv);

    expect(mockPool.query.mock.calls[2][0]).toContain('agent_fork_count');
  });

  it('should copy composition steps for composition type', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          {
            slug: 'comp',
            name: 'Comp',
            type: 'composition',
            description: 'd',
            readme: null,
            schema_json: null,
            execution_layer: 'instructions',
            tags: [],
            categories: [],
            ecosystem: null,
            license: null,
            origin_id: null,
            fork_depth: 0,
            capabilities_required: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'fork-id', slug: 'comp-fork-abc123' }] })
      // copy steps
      .mockResolvedValueOnce({ rows: [] })
      // update counter
      .mockResolvedValueOnce({ rows: [] });

    await forkSkill('comp-id', 'a', 'human', mockPool, mockEnv);

    // 4 queries: select, insert, copy steps, update counter
    expect(mockPool.query).toHaveBeenCalledTimes(4);
    expect(mockPool.query.mock.calls[2][0]).toContain('composition_steps');
  });

  it('should set origin_id to sourceId when source has no origin', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          {
            slug: 'sk',
            name: 'S',
            type: 'skill',
            description: 'd',
            readme: null,
            schema_json: null,
            execution_layer: 'instructions',
            tags: [],
            categories: [],
            ecosystem: null,
            license: null,
            origin_id: null,
            fork_depth: null,
            capabilities_required: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'f', slug: 's' }] })
      .mockResolvedValueOnce({ rows: [] });

    await forkSkill('source-id', 'a', 'human', mockPool, mockEnv);

    // Check INSERT params: origin_id should be sourceId since source has null
    const insertParams = mockPool.query.mock.calls[1][1];
    expect(insertParams[14]).toBe('source-id'); // origin_id fallback
    expect(insertParams[15]).toBe(1); // fork_depth: (null ?? 0) + 1
  });
});

describe('NotFoundError', () => {
  it('should have correct name and message', () => {
    const error = new NotFoundError('test');
    expect(error.name).toBe('NotFoundError');
    expect(error.message).toBe('test');
    expect(error).toBeInstanceOf(Error);
  });
});
