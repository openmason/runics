import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createComposition, ValidationError } from './compose';

vi.mock('nanoid', () => ({ nanoid: () => 'nano01' }));

describe('ValidationError', () => {
  it('should have correct name', () => {
    const error = new ValidationError('test message');
    expect(error.name).toBe('ValidationError');
    expect(error.message).toBe('test message');
  });

  it('should be instanceof Error', () => {
    const error = new ValidationError('test');
    expect(error).toBeInstanceOf(Error);
  });
});

describe('createComposition', () => {
  let mockPool: any;
  let mockEnv: any;

  const input = {
    name: 'My Composition',
    description: 'A test composition',
    authorId: 'author-1',
    authorType: 'human' as const,
    steps: [
      { skillId: 'skill-a', stepName: 'Step A' },
      { skillId: 'skill-b', stepName: 'Step B' },
    ],
    tags: ['test'],
  };

  beforeEach(() => {
    mockPool = { query: vi.fn() };
    mockEnv = {
      EMBED_QUEUE: { send: vi.fn() },
      COGNIUM_QUEUE: { send: vi.fn() },
    };
  });

  it('should throw ValidationError if some skills not found', async () => {
    mockPool.query.mockResolvedValue({
      rows: [{ id: 'skill-a', trust_score: 0.9, capabilities_required: ['git'] }],
      // Only 1 of 2 skills found
    });

    await expect(createComposition(input, mockPool, mockEnv)).rejects.toThrow(ValidationError);
    await expect(createComposition(input, mockPool, mockEnv)).rejects.toThrow('skill-b');
  });

  it('should compute trust_score as MIN of component skills', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          { id: 'skill-a', trust_score: '0.9', capabilities_required: ['git'] },
          { id: 'skill-b', trust_score: '0.5', capabilities_required: ['docker'] },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'comp-id', slug: 'my-composition-nano01' }],
      })
      // step inserts
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await createComposition(input, mockPool, mockEnv);

    // Check the INSERT INTO skills params
    const insertParams = mockPool.query.mock.calls[1][1];
    expect(insertParams[6]).toBe(0.45); // trust_score = MIN(0.9, 0.5) × 0.90
  });

  it('should compute capabilities as union of all skills', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          { id: 'skill-a', trust_score: '0.8', capabilities_required: ['git', 'docker'] },
          { id: 'skill-b', trust_score: '0.7', capabilities_required: ['docker', 'k8s'] },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'comp-id', slug: 'slug' }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await createComposition(input, mockPool, mockEnv);

    const insertParams = mockPool.query.mock.calls[1][1];
    const capabilities = insertParams[7] as string[];
    expect(capabilities.sort()).toEqual(['docker', 'git', 'k8s']);
  });

  it('should handle null capabilities_required gracefully', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          { id: 'skill-a', trust_score: '0.8', capabilities_required: null },
          { id: 'skill-b', trust_score: '0.7', capabilities_required: ['git'] },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'comp-id', slug: 'slug' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await createComposition(input, mockPool, mockEnv);

    const insertParams = mockPool.query.mock.calls[1][1];
    expect(insertParams[7]).toEqual(['git']);
  });

  it('should insert composition steps in order', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          { id: 'skill-a', trust_score: '0.8', capabilities_required: [] },
          { id: 'skill-b', trust_score: '0.7', capabilities_required: [] },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'comp-id', slug: 'slug' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await createComposition(input, mockPool, mockEnv);

    // Step 1 insert
    const step1Params = mockPool.query.mock.calls[2][1];
    expect(step1Params[0]).toBe('comp-id');
    expect(step1Params[1]).toBe(1); // step_order
    expect(step1Params[2]).toBe('skill-a');

    // Step 2 insert
    const step2Params = mockPool.query.mock.calls[3][1];
    expect(step2Params[1]).toBe(2); // step_order
    expect(step2Params[2]).toBe('skill-b');
  });

  it('should use slug from input when provided', async () => {
    const inputWithSlug = { ...input, slug: 'custom-slug' };
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          { id: 'skill-a', trust_score: '0.8', capabilities_required: [] },
          { id: 'skill-b', trust_score: '0.7', capabilities_required: [] },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'comp-id', slug: 'custom-slug' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await createComposition(inputWithSlug, mockPool, mockEnv);
    expect(result.slug).toBe('custom-slug');
  });

  it('should enqueue for embed and scan', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          { id: 'skill-a', trust_score: '0.8', capabilities_required: [] },
          { id: 'skill-b', trust_score: '0.7', capabilities_required: [] },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'comp-id', slug: 'slug' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await createComposition(input, mockPool, mockEnv);

    expect(mockEnv.EMBED_QUEUE.send).toHaveBeenCalledWith({
      skillId: 'comp-id',
      action: 'embed',
    });
    expect(mockEnv.COGNIUM_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: 'comp-id',
        priority: 'normal',
      })
    );
  });

  it('should handle step with inputMapping and onError', async () => {
    const inputWithMappings = {
      ...input,
      steps: [
        { skillId: 'skill-a', stepName: 'Step A', inputMapping: { key: 'val' }, onError: 'skip' as const },
        { skillId: 'skill-b' },
      ],
    };

    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          { id: 'skill-a', trust_score: '0.8', capabilities_required: [] },
          { id: 'skill-b', trust_score: '0.7', capabilities_required: [] },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'comp-id', slug: 'slug' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await createComposition(inputWithMappings, mockPool, mockEnv);

    const step1Params = mockPool.query.mock.calls[2][1];
    expect(step1Params[4]).toBe('{"key":"val"}'); // JSON stringified inputMapping
    expect(step1Params[5]).toBe('skip'); // onError

    const step2Params = mockPool.query.mock.calls[3][1];
    expect(step2Params[3]).toBeNull(); // stepName
    expect(step2Params[4]).toBeNull(); // inputMapping
    expect(step2Params[5]).toBe('fail'); // default onError
  });

  it('should handle trust_score of 0', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          { id: 'skill-a', trust_score: '0', capabilities_required: [] },
          { id: 'skill-b', trust_score: '0.7', capabilities_required: [] },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'comp-id', slug: 'slug' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await createComposition(input, mockPool, mockEnv);

    const insertParams = mockPool.query.mock.calls[1][1];
    expect(insertParams[6]).toBe(0); // trust_score = MIN(0, 0.7) = 0
  });
});
