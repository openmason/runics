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
            skill_type: 'atomic',
            description: 'desc',
            readme: null,
            schema_json: null,
            execution_layer: 'instructions',
            tags: ['tag1'],
            categories: ['cat1'],
            ecosystem: 'npm',
            license: 'MIT',
            root_source: null,
            source: 'forge',
            version: '1.0.0',
            capabilities_required: ['git'],
          },
        ],
      })
      // INSERT fork
      .mockResolvedValueOnce({
        rows: [{ id: 'fork-id', slug: 'original-skill-fork-abc123', version: '1.0.0', status: 'draft' }],
      })
      // UPDATE human_fork_count
      .mockResolvedValueOnce({ rows: [] });

    const result = await forkSkill('source-id', 'author1', 'human', mockPool, mockEnv);

    expect(result).toEqual({
      id: 'fork-id',
      slug: 'original-skill-fork-abc123',
      version: '1.0.0',
      forkedFrom: 'original-skill@1.0.0',
      trustScore: 0.40,
      status: 'draft',
    });
    expect(mockPool.query).toHaveBeenCalledTimes(3);
    // Verify fork counter is for human
    expect(mockPool.query.mock.calls[2][0]).toContain('human_fork_count');
    // Verify queues were called
    expect(mockEnv.EMBED_QUEUE.send).toHaveBeenCalledWith({ skillId: 'fork-id', action: 'embed' });
    expect(mockEnv.COGNIUM_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: 'fork-id',
        priority: 'normal',
      })
    );
  });

  it('should increment agent_fork_count for bot author', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          {
            slug: 'sk',
            name: 'S',
            skill_type: 'atomic',
            description: 'd',
            readme: null,
            schema_json: { type: 'object' },
            execution_layer: 'instructions',
            tags: [],
            categories: [],
            ecosystem: null,
            license: null,
            root_source: 'github',
            source: 'forge',
            version: '1.0.0',
            capabilities_required: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'f-id', slug: 'sk-fork-abc123', version: '1.0.0', status: 'draft' }] })
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
            skill_type: 'auto-composite',
            type: 'composition',
            description: 'd',
            readme: null,
            schema_json: null,
            execution_layer: 'instructions',
            tags: [],
            categories: [],
            ecosystem: null,
            license: null,
            root_source: null,
            source: 'forge',
            version: '1.0.0',
            capabilities_required: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'fork-id', slug: 'comp-fork-abc123', version: '1.0.0', status: 'draft' }] })
      // copy steps
      .mockResolvedValueOnce({ rows: [] })
      // update counter
      .mockResolvedValueOnce({ rows: [] });

    await forkSkill('comp-id', 'a', 'human', mockPool, mockEnv);

    // 4 queries: select, insert, copy steps, update counter
    expect(mockPool.query).toHaveBeenCalledTimes(4);
    expect(mockPool.query.mock.calls[2][0]).toContain('composition_steps');
  });

  it('should set root_source from source when root_source is null', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          {
            slug: 'sk',
            name: 'S',
            skill_type: 'atomic',
            description: 'd',
            readme: null,
            schema_json: null,
            execution_layer: 'instructions',
            tags: [],
            categories: [],
            ecosystem: null,
            license: null,
            root_source: null,
            source: 'forge',
            version: '2.0.0',
            capabilities_required: [],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'f', slug: 's', version: '1.0.0', status: 'draft' }] })
      .mockResolvedValueOnce({ rows: [] });

    await forkSkill('source-id', 'a', 'human', mockPool, mockEnv);

    // Check INSERT params: forkedFrom should reference source slug@version
    const insertParams = mockPool.query.mock.calls[1][1];
    expect(insertParams[12]).toBe('sk@2.0.0'); // forkedFrom
    // root_source falls back to source ('forge') when null
    expect(insertParams[14]).toBe('forge'); // rootSource
    // trust score for 'forge' source = 0.40
    expect(insertParams[15]).toBe(0.40); // trustScore
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
