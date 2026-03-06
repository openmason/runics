import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extendComposition } from './extend';
import { NotFoundError } from './fork';
import { ValidationError } from './compose';

vi.mock('nanoid', () => ({ nanoid: () => 'ext001' }));

describe('extendComposition', () => {
  let mockPool: any;
  let mockEnv: any;

  beforeEach(() => {
    mockPool = { query: vi.fn() };
    mockEnv = {
      EMBED_QUEUE: { send: vi.fn() },
      COGNIUM_QUEUE: { send: vi.fn() },
    };
  });

  it('should throw NotFoundError if composition not found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await expect(
      extendComposition('bad', [{ skillId: 's1' }], 'a', 'human', mockPool, mockEnv)
    ).rejects.toThrow(NotFoundError);
  });

  it('should throw ValidationError if skill is not a composition/pipeline', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ type: 'skill' }] });
    await expect(
      extendComposition('id', [{ skillId: 's1' }], 'a', 'human', mockPool, mockEnv)
    ).rejects.toThrow(ValidationError);
  });

  it('should throw ValidationError if new step skills not found', async () => {
    mockPool.query
      // source type check
      .mockResolvedValueOnce({ rows: [{ type: 'composition' }] })
      // validate new step skills
      .mockResolvedValueOnce({ rows: [] }); // none found

    await expect(
      extendComposition('id', [{ skillId: 's1' }], 'a', 'human', mockPool, mockEnv)
    ).rejects.toThrow(ValidationError);
  });

  it('should fork, append steps, and recompute trust/capabilities', async () => {
    mockPool.query
      // extendComposition: source type check
      .mockResolvedValueOnce({ rows: [{ type: 'composition' }] })
      // extendComposition: validate new step skills
      .mockResolvedValueOnce({ rows: [{ id: 'new-skill' }] })
      // forkSkill: SELECT source
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
            capabilities_required: ['git'],
          },
        ],
      })
      // forkSkill: INSERT fork
      .mockResolvedValueOnce({ rows: [{ id: 'fork-id', slug: 'comp-fork-ext001' }] })
      // forkSkill: copy composition_steps
      .mockResolvedValueOnce({ rows: [] })
      // forkSkill: update human_fork_count
      .mockResolvedValueOnce({ rows: [] })
      // extendComposition: get max step_order
      .mockResolvedValueOnce({ rows: [{ max_order: 2 }] })
      // extendComposition: insert new step
      .mockResolvedValueOnce({ rows: [] })
      // extendComposition: get all steps for recompute
      .mockResolvedValueOnce({
        rows: [
          { trust_score: '0.9', capabilities_required: ['git'] },
          { trust_score: '0.6', capabilities_required: ['docker'] },
          { trust_score: '0.7', capabilities_required: ['git', 'k8s'] },
        ],
      })
      // extendComposition: UPDATE trust_score + capabilities
      .mockResolvedValueOnce({ rows: [] });

    const result = await extendComposition(
      'comp-id',
      [{ skillId: 'new-skill', stepName: 'New Step' }],
      'author1',
      'human',
      mockPool,
      mockEnv
    );

    expect(result).toEqual({ id: 'fork-id', slug: 'comp-fork-ext001' });

    // Verify: the extend function inserted new steps and recomputed trust/capabilities
    // Check that the trust recompute UPDATE was called
    const trustUpdateCall = mockPool.query.mock.calls.find(
      (c: any) => typeof c[0] === 'string' && c[0].includes('UPDATE skills SET trust_score')
    );
    expect(trustUpdateCall).toBeDefined();
    // MIN(0.9, 0.6, 0.7) = 0.6
    expect(trustUpdateCall[1][0]).toBe(0.6);

    // Verify capabilities union: ['docker', 'git', 'k8s']
    const caps = trustUpdateCall[1][1] as string[];
    expect(caps.sort()).toEqual(['docker', 'git', 'k8s']);

    // Verify the fork_id was used for update
    expect(trustUpdateCall[1][2]).toBe('fork-id');
  });
});
