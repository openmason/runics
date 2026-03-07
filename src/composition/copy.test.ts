import { describe, it, expect, vi, beforeEach } from 'vitest';
import { copySkill } from './copy';
import { NotFoundError } from './fork';

vi.mock('nanoid', () => ({ nanoid: () => 'xyz789' }));

const SOURCE_ROW = {
  slug: 'original',
  name: 'Original',
  skill_type: 'atomic',
  description: 'desc',
  readme: null,
  schema_json: null,
  execution_layer: 'instructions',
  tags: ['a'],
  categories: [],
  ecosystem: null,
  license: 'MIT',
  capabilities_required: ['git'],
};

describe('copySkill', () => {
  let mockPool: any;
  let mockEnv: any;

  beforeEach(() => {
    mockPool = { query: vi.fn() };
    mockEnv = {
      EMBED_QUEUE: { send: vi.fn() },
      COGNIUM_QUEUE: { send: vi.fn() },
    };
  });

  it('should throw NotFoundError when skill not found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await expect(copySkill('bad', 'a', 'human', mockPool, mockEnv)).rejects.toThrow(
      NotFoundError
    );
  });

  it('should copy a skill with no lineage and return full ForkResult', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [SOURCE_ROW] })
      .mockResolvedValueOnce({ rows: [{ id: 'copy-id', slug: 'original-copy-xyz789', version: '1.0.0', status: 'draft' }] })
      .mockResolvedValueOnce({ rows: [] }); // human_copy_count

    const result = await copySkill('src-id', 'author1', 'human', mockPool, mockEnv);

    expect(result).toEqual({
      id: 'copy-id',
      slug: 'original-copy-xyz789',
      version: '1.0.0',
      forkedFrom: '',
      trustScore: 0.5,
      status: 'draft',
    });
    // INSERT uses skill_type='atomic' with no fork lineage columns
    const insertSql = mockPool.query.mock.calls[1][0];
    expect(insertSql).toContain('skill_type');
    expect(insertSql).toContain('atomic');
  });

  it('should increment human_copy_count for human author', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [SOURCE_ROW] })
      .mockResolvedValueOnce({ rows: [{ id: 'c', slug: 's', version: '1.0.0', status: 'draft' }] })
      .mockResolvedValueOnce({ rows: [] });

    await copySkill('src', 'a', 'human', mockPool, mockEnv);

    expect(mockPool.query).toHaveBeenCalledTimes(3);
    expect(mockPool.query.mock.calls[2][0]).toContain('human_copy_count');
  });

  it('should NOT increment copy count for bot author', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [SOURCE_ROW] })
      .mockResolvedValueOnce({ rows: [{ id: 'c', slug: 's', version: '1.0.0', status: 'draft' }] });

    await copySkill('src', 'a', 'bot', mockPool, mockEnv);

    // Only 2 queries: SELECT + INSERT (no counter update for bot)
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });

  it('should copy composition steps for pipeline type', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ ...SOURCE_ROW, skill_type: 'auto-composite', type: 'pipeline' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'c', slug: 's', version: '1.0.0', status: 'draft' }] })
      .mockResolvedValueOnce({ rows: [] }) // copy steps
      .mockResolvedValueOnce({ rows: [] }); // human_copy_count

    await copySkill('src', 'a', 'human', mockPool, mockEnv);

    expect(mockPool.query).toHaveBeenCalledTimes(4);
    expect(mockPool.query.mock.calls[2][0]).toContain('composition_steps');
  });

  it('should enqueue for embedding and scanning', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [SOURCE_ROW] })
      .mockResolvedValueOnce({ rows: [{ id: 'new-id', slug: 's', version: '1.0.0', status: 'draft' }] });

    await copySkill('src', 'a', 'bot', mockPool, mockEnv);

    expect(mockEnv.EMBED_QUEUE.send).toHaveBeenCalledWith({ skillId: 'new-id', action: 'embed' });
    expect(mockEnv.COGNIUM_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: 'new-id',
        priority: 'normal',
      })
    );
  });

  it('should stringify schema_json if present', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ ...SOURCE_ROW, schema_json: { type: 'object' } }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'c', slug: 's', version: '1.0.0', status: 'draft' }] });

    await copySkill('src', 'a', 'bot', mockPool, mockEnv);

    const insertParams = mockPool.query.mock.calls[1][1];
    expect(insertParams[4]).toBe('{"type":"object"}');
  });
});
