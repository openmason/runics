import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCogniumPollQueue } from '../../src/cognium/poll-consumer';

// ── Mock helpers ────────────────────────────────────────────────────────────

function makeSkillRow(overrides?: Record<string, unknown>) {
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

function mockPool(queryResults: { rows: any[] }[]) {
  let callCount = 0;
  return {
    query: vi.fn(async () => {
      const result = queryResults[callCount] ?? { rows: [] };
      callCount++;
      return result;
    }),
    connect: vi.fn(async () => ({
      query: vi.fn(),
      release: vi.fn(),
    })),
  } as any;
}

function mockMsg(body: any) {
  return {
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function mockEnv(overrides?: Record<string, any>) {
  return {
    NEON_CONNECTION_STRING: 'postgresql://test',
    COGNIUM_URL: 'https://test-cognium.example.com',
    COGNIUM_API_KEY: 'test-key',
    COGNIUM_MAX_POLL_ATTEMPTS: '12',
    COGNIUM_JOBS: {
      put: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
    },
    COGNIUM_POLL_QUEUE: {
      send: vi.fn(),
    },
    ...overrides,
  } as any;
}

// Mock the connection module
vi.mock('../../src/db/connection', () => ({
  createPool: vi.fn(() => ({
    query: vi.fn(async () => ({ rows: [] })),
    connect: vi.fn(async () => ({ query: vi.fn(), release: vi.fn() })),
  })),
}));

// Mock scan-report-handler
vi.mock('../../src/cognium/scan-report-handler', () => ({
  applyScanReport: vi.fn(),
  markScanFailed: vi.fn(),
}));

// Mock finding-mapper
vi.mock('../../src/cognium/finding-mapper', () => ({
  normalizeFindings: vi.fn((raw: any) => Array.isArray(raw) ? raw : []),
}));

// ── Tests ───────────────────────────────────────────────────────────────────

describe('handleCogniumPollQueue', () => {
  let fetchMock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  async function setupPool(queryResults: { rows: any[] }[]) {
    const pool = mockPool(queryResults);
    const { createPool } = await import('../../src/db/connection');
    (createPool as any).mockReturnValue(pool);
    return pool;
  }

  it('should retry on 5xx status check response', async () => {
    await setupPool([]);

    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });

    const msg = mockMsg({ skillId: 'skill-1', jobId: 'job-1', attempt: 1 });
    const batch = { messages: [msg] } as any;

    await handleCogniumPollQueue(batch, mockEnv());
    expect(msg.retry).toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('should tolerate 404 on early attempts and re-enqueue (race condition)', async () => {
    await setupPool([]);

    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

    const env = mockEnv();
    const msg = mockMsg({ skillId: 'skill-1', jobId: 'job-1', attempt: 1 });
    const batch = { messages: [msg] } as any;

    await handleCogniumPollQueue(batch, env);

    const { markScanFailed } = await import('../../src/cognium/scan-report-handler');
    expect(markScanFailed).not.toHaveBeenCalled();
    expect(env.COGNIUM_POLL_QUEUE.send).toHaveBeenCalledWith(
      { skillId: 'skill-1', jobId: 'job-1', attempt: 2 },
      expect.objectContaining({ delaySeconds: expect.any(Number) }),
    );
    expect(msg.ack).toHaveBeenCalled();
  });

  it('should mark failed on 404 past tolerance threshold', async () => {
    await setupPool([]);

    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

    const env = mockEnv();
    const msg = mockMsg({ skillId: 'skill-1', jobId: 'job-1', attempt: 3 });
    const batch = { messages: [msg] } as any;

    await handleCogniumPollQueue(batch, env);

    const { markScanFailed } = await import('../../src/cognium/scan-report-handler');
    expect(markScanFailed).toHaveBeenCalledWith(expect.anything(), 'skill-1', expect.stringContaining('404'));
    expect(env.COGNIUM_JOBS.delete).toHaveBeenCalledWith('cognium:job:skill-1');
    expect(msg.ack).toHaveBeenCalled();
  });

  it('should mark failed on non-404 4xx immediately (unrecoverable)', async () => {
    await setupPool([]);

    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });

    const env = mockEnv();
    const msg = mockMsg({ skillId: 'skill-1', jobId: 'job-1', attempt: 1 });
    const batch = { messages: [msg] } as any;

    await handleCogniumPollQueue(batch, env);

    const { markScanFailed } = await import('../../src/cognium/scan-report-handler');
    expect(markScanFailed).toHaveBeenCalledWith(expect.anything(), 'skill-1', expect.stringContaining('403'));
    expect(env.COGNIUM_JOBS.delete).toHaveBeenCalledWith('cognium:job:skill-1');
    expect(msg.ack).toHaveBeenCalled();
  });

  it('should handle completed job: fetch findings, apply report, delete KV, ack', async () => {
    const skill = makeSkillRow();
    await setupPool([
      { rows: [skill] }, // fetchSkillById in handleCompleted
    ]);

    // Status check → completed
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ job_id: 'job-1', status: 'completed', progress: 100 }),
    });
    // Findings fetch
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ findings: [] }),
    });
    // Skill-result fetch
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ trust_score: 0.85, verdict: 'TRUSTED' }),
    });
    // Results fetch (files_detail + bundle_metadata)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ files_detail: [], bundle_metadata: { bundle_download: 'skipped' } }),
    });

    const env = mockEnv();
    const msg = mockMsg({ skillId: 'skill-1', jobId: 'job-1', attempt: 3 });
    const batch = { messages: [msg] } as any;

    await handleCogniumPollQueue(batch, env);

    const { applyScanReport } = await import('../../src/cognium/scan-report-handler');
    expect(applyScanReport).toHaveBeenCalled();
    expect(env.COGNIUM_JOBS.delete).toHaveBeenCalledWith('cognium:job:skill-1');
    expect(msg.ack).toHaveBeenCalled();
  });

  it('should handle failed job: mark failed, delete KV, ack', async () => {
    await setupPool([]);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ job_id: 'job-1', status: 'failed', progress: 0 }),
    });

    const env = mockEnv();
    const msg = mockMsg({ skillId: 'skill-1', jobId: 'job-1', attempt: 1 });
    const batch = { messages: [msg] } as any;

    await handleCogniumPollQueue(batch, env);

    const { markScanFailed } = await import('../../src/cognium/scan-report-handler');
    expect(markScanFailed).toHaveBeenCalledWith(expect.anything(), 'skill-1', expect.stringContaining('failed'));
    expect(env.COGNIUM_JOBS.delete).toHaveBeenCalledWith('cognium:job:skill-1');
    expect(msg.ack).toHaveBeenCalled();
  });

  it('should handle cancelled job same as failed (v1.12.2)', async () => {
    await setupPool([]);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ job_id: 'job-1', status: 'cancelled', progress: 50 }),
    });

    const env = mockEnv();
    const msg = mockMsg({ skillId: 'skill-1', jobId: 'job-1', attempt: 1 });
    const batch = { messages: [msg] } as any;

    await handleCogniumPollQueue(batch, env);

    const { markScanFailed } = await import('../../src/cognium/scan-report-handler');
    expect(markScanFailed).toHaveBeenCalledWith(expect.anything(), 'skill-1', expect.stringContaining('cancelled'));
    expect(env.COGNIUM_JOBS.delete).toHaveBeenCalledWith('cognium:job:skill-1');
    expect(msg.ack).toHaveBeenCalled();
  });

  it('should re-enqueue with backoff when still running', async () => {
    await setupPool([]);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ job_id: 'job-1', status: 'running', progress: 40 }),
    });

    const env = mockEnv();
    const msg = mockMsg({ skillId: 'skill-1', jobId: 'job-1', attempt: 2 });
    const batch = { messages: [msg] } as any;

    await handleCogniumPollQueue(batch, env);

    // Attempt 2 → POLL_DELAYS_MS[2] = 60_000 → delaySeconds = 60
    expect(env.COGNIUM_POLL_QUEUE.send).toHaveBeenCalledWith(
      { skillId: 'skill-1', jobId: 'job-1', attempt: 3 },
      { delaySeconds: 60 },
    );
    expect(msg.ack).toHaveBeenCalled();
  });

  it('should give up after max attempts', async () => {
    await setupPool([]);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ job_id: 'job-1', status: 'running', progress: 80 }),
    });

    const env = mockEnv({ COGNIUM_MAX_POLL_ATTEMPTS: '5' });
    const msg = mockMsg({ skillId: 'skill-1', jobId: 'job-1', attempt: 5 });
    const batch = { messages: [msg] } as any;

    await handleCogniumPollQueue(batch, env);

    const { markScanFailed } = await import('../../src/cognium/scan-report-handler');
    expect(markScanFailed).toHaveBeenCalledWith(expect.anything(), 'skill-1', expect.stringContaining('timeout'));
    expect(env.COGNIUM_POLL_QUEUE.send).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalled();
  });

  it('should mark failed when findings fetch returns non-OK', async () => {
    await setupPool([]);

    // Status → completed
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ job_id: 'job-1', status: 'completed', progress: 100 }),
    });
    // Findings → 500
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    // Skill-result (still fetched in parallel)
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    // Results (still fetched in parallel)
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });

    const env = mockEnv();
    const msg = mockMsg({ skillId: 'skill-1', jobId: 'job-1', attempt: 1 });
    const batch = { messages: [msg] } as any;

    await handleCogniumPollQueue(batch, env);

    const { markScanFailed } = await import('../../src/cognium/scan-report-handler');
    expect(markScanFailed).toHaveBeenCalledWith(expect.anything(), 'skill-1', expect.stringContaining('Findings'));
  });

  it('should still apply report when skill-result fetch fails (non-fatal)', async () => {
    await setupPool([
      { rows: [makeSkillRow()] },
    ]);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ job_id: 'job-1', status: 'completed', progress: 100 }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ findings: [{ severity: 'high', description: 'test', verdict: 'VULNERABLE' }] }),
    });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 }); // skill-result fails
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 }); // results fails

    const env = mockEnv();
    const msg = mockMsg({ skillId: 'skill-1', jobId: 'job-1', attempt: 1 });
    const batch = { messages: [msg] } as any;

    await handleCogniumPollQueue(batch, env);

    const { applyScanReport } = await import('../../src/cognium/scan-report-handler');
    // Should still call applyScanReport with null skillResult
    expect(applyScanReport).toHaveBeenCalledWith(
      env, expect.anything(), expect.anything(), expect.anything(), expect.anything(), null,
    );
  });

  it('should skip report when skill is deleted between submit and poll', async () => {
    await setupPool([
      { rows: [] }, // fetchSkillById → not found
    ]);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ job_id: 'job-1', status: 'completed', progress: 100 }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ findings: [] }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ trust_score: 0.85 }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ files_detail: [] }),
    });

    const env = mockEnv();
    const msg = mockMsg({ skillId: 'skill-1', jobId: 'job-1', attempt: 1 });
    const batch = { messages: [msg] } as any;

    await handleCogniumPollQueue(batch, env);

    const { applyScanReport } = await import('../../src/cognium/scan-report-handler');
    expect(applyScanReport).not.toHaveBeenCalled();
  });

  it('should retry on unexpected errors', async () => {
    await setupPool([]);

    fetchMock.mockRejectedValueOnce(new Error('Network failure'));

    const msg = mockMsg({ skillId: 'skill-1', jobId: 'job-1', attempt: 1 });
    const batch = { messages: [msg] } as any;

    await handleCogniumPollQueue(batch, mockEnv());
    expect(msg.retry).toHaveBeenCalled();
  });
});
