import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recordInvocations } from './invocations';

describe('recordInvocations', () => {
  let mockPool: any;

  beforeEach(() => {
    mockPool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
  });

  it('should return immediately for empty batch', async () => {
    await recordInvocations({ invocations: [] }, mockPool);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('should bulk insert a single chunk of invocations', async () => {
    const batch = {
      invocations: [
        {
          skillId: 'skill-1',
          tenantId: 'tenant-1',
          callerType: 'agent' as const,
          durationMs: 100,
          succeeded: true,
        },
        {
          skillId: 'skill-2',
          tenantId: 'tenant-1',
          callerType: 'agent' as const,
          durationMs: 200,
          succeeded: false,
        },
      ],
    };

    await recordInvocations(batch, mockPool);

    // 1 bulk insert + 2 UPDATE per skill = 3 queries
    expect(mockPool.query).toHaveBeenCalledTimes(3);

    // Verify bulk INSERT
    const insertCall = mockPool.query.mock.calls[0];
    expect(insertCall[0]).toContain('INSERT INTO skill_invocations');
    expect(insertCall[1].length).toBe(12); // 2 invocations × 6 params
  });

  it('should chunk large batches', async () => {
    const invocations = Array.from({ length: 250 }, (_, i) => ({
      skillId: 'skill-1',
      tenantId: 'tenant-1',
      callerType: 'agent' as const,
      durationMs: 100,
      succeeded: true,
    }));

    await recordInvocations({ invocations }, mockPool);

    // 3 chunks (100+100+50) + 1 update for skill-1 = 4 queries
    expect(mockPool.query).toHaveBeenCalledTimes(4);
  });

  it('should group by skill_id for counter updates', async () => {
    const batch = {
      invocations: [
        {
          skillId: 'a',
          tenantId: 't',
          callerType: 'agent' as const,
          durationMs: 100,
          succeeded: true,
        },
        {
          skillId: 'b',
          tenantId: 't',
          callerType: 'agent' as const,
          durationMs: 200,
          succeeded: true,
        },
        {
          skillId: 'a',
          tenantId: 't',
          callerType: 'agent' as const,
          durationMs: 50,
          succeeded: false,
        },
      ],
    };

    await recordInvocations(batch, mockPool);

    // 1 insert chunk + 2 UPDATE statements (skill a and b) = 3
    expect(mockPool.query).toHaveBeenCalledTimes(3);

    // Find the UPDATE for skill 'a'
    const updateCalls = mockPool.query.mock.calls.filter((c: any) =>
      c[0].includes('UPDATE skills')
    );
    expect(updateCalls.length).toBe(2);

    // Skill 'a': count=2, avgDuration=(100+50)/2=75, errorRate=1/2=0.5
    const skillAUpdate = updateCalls.find((c: any) => c[1][3] === 'a');
    expect(skillAUpdate[1][0]).toBe(2); // count
    expect(skillAUpdate[1][1]).toBe(75); // avgDuration
    expect(skillAUpdate[1][2]).toBe(0.5); // errorRate
  });

  it('should handle invocations with no durationMs', async () => {
    const batch = {
      invocations: [
        {
          skillId: 'a',
          tenantId: 't',
          callerType: 'agent' as const,
          durationMs: undefined,
          succeeded: true,
        },
      ],
    };

    await recordInvocations(batch, mockPool);

    const updateCall = mockPool.query.mock.calls.find((c: any) =>
      c[0].includes('UPDATE skills')
    );
    expect(updateCall[1][1]).toBeNull(); // avgDuration null when no durations
  });

  it('should handle compositionId in invocations', async () => {
    const batch = {
      invocations: [
        {
          skillId: 'a',
          compositionId: 'comp-1',
          tenantId: 't',
          callerType: 'agent' as const,
          durationMs: 100,
          succeeded: true,
        },
      ],
    };

    await recordInvocations(batch, mockPool);

    const insertParams = mockPool.query.mock.calls[0][1];
    expect(insertParams[1]).toBe('comp-1'); // compositionId param
  });

  it('should default compositionId to null', async () => {
    const batch = {
      invocations: [
        {
          skillId: 'a',
          tenantId: 't',
          callerType: 'agent' as const,
          durationMs: 100,
          succeeded: true,
        },
      ],
    };

    await recordInvocations(batch, mockPool);

    const insertParams = mockPool.query.mock.calls[0][1];
    expect(insertParams[1]).toBeNull(); // compositionId defaults to null
  });
});
