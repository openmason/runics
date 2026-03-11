import { describe, it, expect, vi } from 'vitest';
import { cascadeStatusToComposites, repairCompositeStatus } from '../../src/cognium/composite-cascade';

function mockPool(queryResults: { rows: any[] }[]) {
  let callCount = 0;
  return {
    query: vi.fn(async () => {
      const result = queryResults[callCount] ?? { rows: [] };
      callCount++;
      return result;
    }),
  } as any;
}

describe('cascadeStatusToComposites', () => {
  it('should cascade revoked status to degraded on composites', async () => {
    const pool = mockPool([
      { rows: [{ id: 'comp-1', slug: 'composite-a', version: '1.0', status: 'published' }] },
      { rows: [] },
    ]);
    await cascadeStatusToComposites(pool, 'skill-abc', 'revoked');
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[1][1]).toEqual(['degraded', 'comp-1']);
  });

  it('should cascade vulnerable status to contains-vulnerable on composites', async () => {
    const pool = mockPool([
      { rows: [{ id: 'comp-1', slug: 'composite-a', version: '1.0', status: 'published' }] },
      { rows: [] },
    ]);
    await cascadeStatusToComposites(pool, 'skill-abc', 'vulnerable');
    expect(pool.query.mock.calls[1][1]).toEqual(['contains-vulnerable', 'comp-1']);
  });

  it('should do nothing when no composites contain the skill', async () => {
    const pool = mockPool([{ rows: [] }]);
    await cascadeStatusToComposites(pool, 'skill-abc', 'revoked');
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe('repairCompositeStatus', () => {
  it('should repair composite to published when all constituents are clean', async () => {
    const pool = mockPool([
      { rows: [{ id: 'comp-1', composition_skill_ids: ['skill-a', 'skill-b'] }] },
      { rows: [{ status: 'published' }, { status: 'published' }] },
      { rows: [] },
    ]);
    await repairCompositeStatus(pool, 'skill-a');
    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(pool.query.mock.calls[2][1]).toEqual(['comp-1']);
  });

  it('should NOT repair composite when some constituents are still vulnerable', async () => {
    const pool = mockPool([
      { rows: [{ id: 'comp-1', composition_skill_ids: ['skill-a', 'skill-b'] }] },
      { rows: [{ status: 'published' }, { status: 'vulnerable' }] },
    ]);
    await repairCompositeStatus(pool, 'skill-a');
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('should NOT repair composite when a constituent has been deleted (row count mismatch)', async () => {
    const pool = mockPool([
      // Composite references 3 skills, but only 2 exist in DB
      { rows: [{ id: 'comp-1', composition_skill_ids: ['skill-a', 'skill-b', 'skill-deleted'] }] },
      { rows: [{ status: 'published' }, { status: 'published' }] }, // only 2 rows returned
    ]);
    await repairCompositeStatus(pool, 'skill-a');
    // Should NOT issue the UPDATE (only 2 queries: find composites + check constituents)
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('should repair composite when all constituents exist and are clean', async () => {
    const pool = mockPool([
      { rows: [{ id: 'comp-1', composition_skill_ids: ['skill-a', 'skill-b'] }] },
      { rows: [{ status: 'published' }, { status: 'deprecated' }] }, // 2 rows = 2 skills
      { rows: [] },
    ]);
    await repairCompositeStatus(pool, 'skill-a');
    // Should issue UPDATE (3 queries: find + check + update)
    expect(pool.query).toHaveBeenCalledTimes(3);
  });
});
