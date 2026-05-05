import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyScanReport, markScanFailed } from '../../src/cognium/scan-report-handler';
import type { ScanFinding, SkillRow, CircleIRJobStatus } from '../../src/cognium/types';

// ── Mock helpers ────────────────────────────────────────────────────────────

function makeSkill(overrides?: Partial<SkillRow>): SkillRow {
  return {
    id: 'skill-1',
    slug: 'test-skill',
    version: '1.0.0',
    name: 'Test Skill',
    description: 'A test skill',
    source: 'github',
    status: 'published',
    executionLayer: 'mcp-remote',
    sourceUrl: 'https://github.com/owner/repo',
    ...overrides,
  };
}

function makeJob(overrides?: Partial<CircleIRJobStatus>): CircleIRJobStatus {
  return {
    job_id: 'job-1',
    status: 'completed',
    progress: 100,
    ...overrides,
  };
}

function makeFinding(overrides?: Partial<ScanFinding>): ScanFinding {
  return {
    severity: 'HIGH',
    cweId: 'CWE-89',
    tool: 'circle-ir',
    phase: 'sast',
    title: 'SQL injection',
    description: 'SQL injection found',
    confidence: 0.9,
    verdict: 'VULNERABLE',
    llmVerified: false,
    ...overrides,
  };
}

function mockClient() {
  return {
    query: vi.fn(),
    release: vi.fn(),
  };
}

function mockPool(client: ReturnType<typeof mockClient>) {
  return {
    query: vi.fn(),
    connect: vi.fn(async () => client),
  } as any;
}

function mockEnv() {
  return {} as any;
}

// Mock notification trigger
vi.mock('../../src/cognium/notification-trigger', () => ({
  triggerNotification: vi.fn(),
}));

// Mock composite cascade
vi.mock('../../src/cognium/composite-cascade', () => ({
  cascadeStatusToComposites: vi.fn(),
  repairCompositeStatus: vi.fn(),
}));

// ── Tests ───────────────────────────────────────────────────────────────────

describe('applyScanReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should write trust score, tier, status, and scan coverage for clean skill', async () => {
    const client = mockClient();
    const pool = mockPool(client);
    const skill = makeSkill({ source: 'github' });

    await applyScanReport(mockEnv(), pool, skill, [], makeJob());

    // Should have called BEGIN, UPDATE, COMMIT
    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();

    // The UPDATE query is the 2nd call (after BEGIN)
    const updateCall = client.query.mock.calls[1];
    expect(updateCall[0]).toContain('UPDATE skills SET');
    // trust_score=$1 → 0.55 (github base)
    expect(updateCall[1][0]).toBe(0.55);
    // status=$4 → published (no findings)
    expect(updateCall[1][3]).toBe('published');
  });

  it('should revoke via content safety path for CRITICAL + LLM-verified injection', async () => {
    const client = mockClient();
    const pool = mockPool(client);
    const skill = makeSkill();
    const findings: ScanFinding[] = [
      makeFinding({
        severity: 'CRITICAL',
        cweId: 'CWE-78',
        phase: 'sast',
        llmVerified: true,
      }),
    ];

    await applyScanReport(mockEnv(), pool, skill, findings, makeJob());

    // Content safety path — should call cascadeStatusToComposites
    const { cascadeStatusToComposites } = await import('../../src/cognium/composite-cascade');
    expect(cascadeStatusToComposites).toHaveBeenCalledWith(client, 'skill-1', 'revoked');

    // Should notify
    const { triggerNotification } = await import('../../src/cognium/notification-trigger');
    expect(triggerNotification).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'skill-1' }), 'revoked', 'Content safety failure');

    // Check the UPDATE sets status=revoked, trust=0.0
    const updateCall = client.query.mock.calls[1];
    expect(updateCall[0]).toContain("status = 'revoked'");
    expect(updateCall[0]).toContain("trust_score = 0.0");
  });

  it('should set status=vulnerable for HIGH severity findings', async () => {
    const client = mockClient();
    const pool = mockPool(client);
    const skill = makeSkill();
    const findings = [makeFinding({ severity: 'HIGH', llmVerified: false })];

    await applyScanReport(mockEnv(), pool, skill, findings, makeJob());

    const updateCall = client.query.mock.calls[1];
    expect(updateCall[1][3]).toBe('vulnerable'); // status=$4
  });

  it('should cascade to composites on vulnerable status', async () => {
    const client = mockClient();
    const pool = mockPool(client);
    const skill = makeSkill();
    const findings = [makeFinding({ severity: 'HIGH' })];

    await applyScanReport(mockEnv(), pool, skill, findings, makeJob());

    const { cascadeStatusToComposites } = await import('../../src/cognium/composite-cascade');
    expect(cascadeStatusToComposites).toHaveBeenCalledWith(client, 'skill-1', 'vulnerable');
  });

  it('should cascade but NOT notify for MEDIUM findings (vulnerable status)', async () => {
    const client = mockClient();
    const pool = mockPool(client);
    const skill = makeSkill();
    const findings = [makeFinding({ severity: 'MEDIUM', cweId: 'CWE-200' })];

    await applyScanReport(mockEnv(), pool, skill, findings, makeJob());

    // MEDIUM → vulnerable → cascade
    const { cascadeStatusToComposites } = await import('../../src/cognium/composite-cascade');
    expect(cascadeStatusToComposites).toHaveBeenCalledWith(client, 'skill-1', 'vulnerable');

    // MEDIUM → no notification (only HIGH triggers vulnerable notification)
    const { triggerNotification } = await import('../../src/cognium/notification-trigger');
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  it('should NOT cascade or notify for LOW findings (published status)', async () => {
    const client = mockClient();
    const pool = mockPool(client);
    const skill = makeSkill();
    const findings = [makeFinding({ severity: 'LOW', cweId: 'CWE-200' })];

    await applyScanReport(mockEnv(), pool, skill, findings, makeJob());

    const { cascadeStatusToComposites } = await import('../../src/cognium/composite-cascade');
    const { triggerNotification } = await import('../../src/cognium/notification-trigger');
    expect(cascadeStatusToComposites).not.toHaveBeenCalled();
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  it('should repair composites when previously-vulnerable skill is now clean', async () => {
    const client = mockClient();
    const pool = mockPool(client);
    const skill = makeSkill({ status: 'vulnerable' }); // was vulnerable

    await applyScanReport(mockEnv(), pool, skill, [], makeJob()); // now clean

    const { repairCompositeStatus } = await import('../../src/cognium/composite-cascade');
    expect(repairCompositeStatus).toHaveBeenCalledWith(client, 'skill-1');
  });

  it('should NOT repair composites when skill was already published', async () => {
    const client = mockClient();
    const pool = mockPool(client);
    const skill = makeSkill({ status: 'published' });

    await applyScanReport(mockEnv(), pool, skill, [], makeJob());

    const { repairCompositeStatus } = await import('../../src/cognium/composite-cascade');
    expect(repairCompositeStatus).not.toHaveBeenCalled();
  });

  it('should rollback transaction on error', async () => {
    const client = mockClient();
    client.query.mockRejectedValueOnce(undefined); // BEGIN succeeds implicitly
    client.query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN') return;
      if (sql === 'ROLLBACK') return;
      throw new Error('DB error');
    });
    const pool = mockPool(client);
    const skill = makeSkill();

    await expect(
      applyScanReport(mockEnv(), pool, skill, [], makeJob()),
    ).rejects.toThrow('DB error');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  it('should clear cognium_job_id in the UPDATE', async () => {
    const client = mockClient();
    const pool = mockPool(client);
    const skill = makeSkill();

    await applyScanReport(mockEnv(), pool, skill, [], makeJob());

    const updateCall = client.query.mock.calls[1];
    expect(updateCall[0]).toContain('cognium_job_id = NULL');
  });

  it('should set scan_coverage based on skill source', async () => {
    const client = mockClient();
    const pool = mockPool(client);

    // GitHub source → code-full
    const githubSkill = makeSkill({ sourceUrl: 'https://github.com/owner/repo' });
    await applyScanReport(mockEnv(), pool, githubSkill, [], makeJob());
    const call1 = client.query.mock.calls[1];
    expect(call1[1][2]).toBe('code-full'); // scan_coverage=$3

    vi.clearAllMocks();

    // Non-GitHub, no files → metadata-only
    const client2 = mockClient();
    const pool2 = mockPool(client2);
    const metadataSkill = makeSkill({ sourceUrl: null, repositoryUrl: null, skillMd: null, schemaJson: null, r2BundleKey: null });
    await applyScanReport(mockEnv(), pool2, metadataSkill, [], makeJob());
    const call2 = client2.query.mock.calls[1];
    expect(call2[1][2]).toBe('metadata-only');
  });

  it('should notify on HIGH + vulnerable status', async () => {
    const client = mockClient();
    const pool = mockPool(client);
    const skill = makeSkill();
    const findings = [makeFinding({ severity: 'HIGH', cweId: 'CWE-89' })];

    await applyScanReport(mockEnv(), pool, skill, findings, makeJob());

    const { triggerNotification } = await import('../../src/cognium/notification-trigger');
    expect(triggerNotification).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'skill-1' }), 'vulnerable', 'CWE-89');
  });

  it('should use Circle-IR trust_score when skillResult is available (capped by source)', async () => {
    const client = mockClient();
    const pool = mockPool(client);
    const skill = makeSkill({ source: 'github' });
    // v1.8.0: trust_score is 0–100; API returns 74, we store 0.74
    // But github cap is 0.65, so final score is capped
    const skillResult = { trust_score: 74, verdict: 'TRUSTED' as const } as any;

    await applyScanReport(mockEnv(), pool, skill, [], makeJob(), skillResult);

    const updateCall = client.query.mock.calls[1];
    // Circle-IR gives 0.74 but github cap is 0.65
    expect(updateCall[1][0]).toBe(0.65);
  });

  it('should fall back to local trust score when skillResult is null', async () => {
    const client = mockClient();
    const pool = mockPool(client);
    const skill = makeSkill({ source: 'github' });

    await applyScanReport(mockEnv(), pool, skill, [], makeJob(), null);

    const updateCall = client.query.mock.calls[1];
    // Local computation: github base = 0.55
    expect(updateCall[1][0]).toBe(0.55);
  });

  it('should clamp Circle-IR trust_score to [0.0, 1.0] then cap by source', async () => {
    const client = mockClient();
    const pool = mockPool(client);
    const skill = makeSkill(); // default source: github
    // v1.8.0: trust_score 0–100; value > 100 should clamp to 1.0
    // Then capped by github ceiling (0.65)
    const skillResult = { trust_score: 150, verdict: 'TRUSTED' as const } as any;

    await applyScanReport(mockEnv(), pool, skill, [], makeJob(), skillResult);

    const updateCall = client.query.mock.calls[1];
    // Clamped to 1.0, then capped to 0.65 (github ceiling)
    expect(updateCall[1][0]).toBe(0.65);
  });

  it('should clear scan_failure_reason on successful scan (normal path)', async () => {
    const client = mockClient();
    const pool = mockPool(client);
    const skill = makeSkill();

    await applyScanReport(mockEnv(), pool, skill, [], makeJob());

    const updateCall = client.query.mock.calls[1];
    expect(updateCall[0]).toContain('scan_failure_reason = NULL');
  });

  it('should clear scan_failure_reason on content safety revocation path', async () => {
    const client = mockClient();
    const pool = mockPool(client);
    const skill = makeSkill();
    const findings: ScanFinding[] = [
      makeFinding({
        severity: 'CRITICAL',
        cweId: 'CWE-78',
        phase: 'sast',
        llmVerified: true,
      }),
    ];

    await applyScanReport(mockEnv(), pool, skill, findings, makeJob());

    const updateCall = client.query.mock.calls[1];
    expect(updateCall[0]).toContain('scan_failure_reason = NULL');
  });
});

describe('markScanFailed', () => {
  it('should set verification_tier to unverified and clear cognium_job_id', async () => {
    const pool = {
      query: vi.fn(),
    } as any;

    await markScanFailed(pool, 'skill-1', 'Test failure');

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("verification_tier = 'unverified'");
    expect(sql).toContain('cognium_job_id = NULL');
    expect(sql).toContain('scan_failure_reason');
    expect(params).toEqual(['skill-1', 'Test failure']);
  });

  it('should NULL cognium_scanned_at to allow retry', async () => {
    const pool = { query: vi.fn() } as any;

    await markScanFailed(pool, 'skill-1', 'Test failure');

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('cognium_scanned_at = NULL');
    expect(sql).not.toContain('cognium_scanned_at = NOW()');
  });

  it('should increment scan_retry_count', async () => {
    const pool = { query: vi.fn() } as any;

    await markScanFailed(pool, 'skill-1', 'Test failure');

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('scan_retry_count = COALESCE(scan_retry_count, 0) + 1');
  });

  it('should persist Circle-IR job failure reason', async () => {
    const pool = { query: vi.fn() } as any;

    await markScanFailed(pool, 'skill-2', 'Circle-IR job failed');

    const [sql, params] = pool.query.mock.calls[0];
    expect(params).toEqual(['skill-2', 'Circle-IR job failed']);
    expect(sql).toContain('scan_failure_reason = $2');
  });

  it('should persist poll timeout reason', async () => {
    const pool = { query: vi.fn() } as any;

    await markScanFailed(pool, 'skill-3', 'Poll timeout after 12 attempts');

    const [, params] = pool.query.mock.calls[0];
    expect(params[1]).toBe('Poll timeout after 12 attempts');
  });

  it('should persist HTTP status failure reason', async () => {
    const pool = { query: vi.fn() } as any;

    await markScanFailed(pool, 'skill-4', 'Status check returned 404');

    const [, params] = pool.query.mock.calls[0];
    expect(params[1]).toBe('Status check returned 404');
  });
});
