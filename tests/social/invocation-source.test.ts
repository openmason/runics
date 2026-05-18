import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recordInvocations } from '../../src/social/invocations';
import type { InvocationBatch } from '../../src/types';

// ── Mock helpers ────────────────────────────────────────────────────────────

function mockPool() {
  return {
    query: vi.fn(async () => ({ rows: [] })),
  } as any;
}

function makeBatch(invocations: InvocationBatch['invocations']): InvocationBatch {
  return { invocations };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('invocation source field', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should include source in INSERT with default "cortex"', async () => {
    const pool = mockPool();
    const batch = makeBatch([
      {
        skillId: '00000000-0000-0000-0000-000000000001',
        tenantId: 'test-tenant',
        callerType: 'agent',
        succeeded: true,
      },
    ]);

    await recordInvocations(batch, pool);

    // First query is the INSERT
    const insertCall = pool.query.mock.calls[0];
    expect(insertCall[0]).toContain('source');
    // Params: skillId, compositionId, tenantId, callerType, source, durationMs, succeeded
    expect(insertCall[1][4]).toBe('cortex'); // source defaults to 'cortex'
  });

  it('should pass "local" source when specified', async () => {
    const pool = mockPool();
    const batch = makeBatch([
      {
        skillId: '00000000-0000-0000-0000-000000000001',
        tenantId: 'test-tenant',
        callerType: 'agent',
        source: 'local',
        succeeded: true,
      },
    ]);

    await recordInvocations(batch, pool);

    const insertCall = pool.query.mock.calls[0];
    expect(insertCall[1][4]).toBe('local');
  });

  it('should handle mixed source values in batch', async () => {
    const pool = mockPool();
    const batch = makeBatch([
      {
        skillId: '00000000-0000-0000-0000-000000000001',
        tenantId: 'test-tenant',
        callerType: 'agent',
        source: 'cortex',
        succeeded: true,
      },
      {
        skillId: '00000000-0000-0000-0000-000000000002',
        tenantId: 'test-tenant',
        callerType: 'human',
        source: 'local',
        succeeded: false,
      },
    ]);

    await recordInvocations(batch, pool);

    const insertCall = pool.query.mock.calls[0];
    // 7 params per row, 2 rows = 14 params
    expect(insertCall[1]).toHaveLength(14);
    // First row source
    expect(insertCall[1][4]).toBe('cortex');
    // Second row source (offset by 7)
    expect(insertCall[1][11]).toBe('local');
  });

  it('should include source column in SQL', async () => {
    const pool = mockPool();
    const batch = makeBatch([
      {
        skillId: '00000000-0000-0000-0000-000000000001',
        tenantId: 'test-tenant',
        callerType: 'agent',
        succeeded: true,
      },
    ]);

    await recordInvocations(batch, pool);

    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain('skill_id, composition_id, tenant_id, caller_type, source, duration_ms, succeeded');
  });
});
