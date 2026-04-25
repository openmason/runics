import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCogniumSubmitQueue } from '../../src/cognium/submit-consumer';

// ── Mock helpers ────────────────────────────────────────────────────────────

function makeSkillRow(overrides?: Record<string, unknown>) {
  return {
    id: 'skill-1',
    slug: 'test-skill',
    version: '1.0.0',
    name: 'Test Skill',
    description: 'A test skill for testing',
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
    COGNIUM_POLL_DELAY_MS: '1000',
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
  })),
}));

// Mock buildCircleIRRequest
vi.mock('../../src/cognium/request-builder', () => ({
  buildCircleIRRequest: vi.fn(() => ({ repo_url: 'https://github.com/test', skill_context: {}, options: {} })),
}));

// ── Tests ───────────────────────────────────────────────────────────────────

describe('handleCogniumSubmitQueue', () => {
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

  it('should ack and skip when skill is not found in DB', async () => {
    await setupPool([{ rows: [] }]); // fetchSkillById returns nothing

    const msg = mockMsg({ skillId: 'missing-skill', priority: 'normal', timestamp: Date.now() });
    const batch = { messages: [msg] } as any;

    await handleCogniumSubmitQueue(batch, mockEnv());
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('should ack and skip when job is already in flight (dedup check)', async () => {
    await setupPool([
      { rows: [makeSkillRow()] },                    // fetchSkillById
      { rows: [{ cognium_job_id: 'existing-job' }] }, // dedup query
    ]);

    const msg = mockMsg({ skillId: 'skill-1', priority: 'normal', timestamp: Date.now() });
    const batch = { messages: [msg] } as any;

    await handleCogniumSubmitQueue(batch, mockEnv());
    expect(msg.ack).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled(); // Should NOT call Circle-IR
  });

  it('should submit to Circle-IR, store in KV, and enqueue poll on success', async () => {
    await setupPool([
      { rows: [makeSkillRow()] }, // fetchSkillById
      { rows: [] },               // dedup: no existing job
    ]);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ job_id: 'job-abc' }),
    });

    const env = mockEnv();
    const msg = mockMsg({ skillId: 'skill-1', priority: 'normal', timestamp: Date.now() });
    const batch = { messages: [msg] } as any;

    await handleCogniumSubmitQueue(batch, env);

    // Should have called Circle-IR
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://test-cognium.example.com/api/analyze/skill');

    // Should store job in KV
    expect(env.COGNIUM_JOBS.put).toHaveBeenCalledWith(
      'cognium:job:skill-1',
      expect.stringContaining('job-abc'),
      { expirationTtl: 3600 },
    );

    // Should enqueue poll
    expect(env.COGNIUM_POLL_QUEUE.send).toHaveBeenCalledWith(
      { skillId: 'skill-1', jobId: 'job-abc', attempt: 1 },
      { delaySeconds: 1 },
    );

    expect(msg.ack).toHaveBeenCalled();
  });

  it('should retry on 500 from Circle-IR', async () => {
    await setupPool([
      { rows: [makeSkillRow()] },
      { rows: [] },
    ]);

    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });

    const msg = mockMsg({ skillId: 'skill-1', priority: 'normal', timestamp: Date.now() });
    const batch = { messages: [msg] } as any;

    await handleCogniumSubmitQueue(batch, mockEnv());
    expect(msg.retry).toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('should retry on 429 from Circle-IR', async () => {
    await setupPool([
      { rows: [makeSkillRow()] },
      { rows: [] },
    ]);

    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 });

    const msg = mockMsg({ skillId: 'skill-1', priority: 'normal', timestamp: Date.now() });
    const batch = { messages: [msg] } as any;

    await handleCogniumSubmitQueue(batch, mockEnv());
    expect(msg.retry).toHaveBeenCalled();
  });

  it('should ack (not retry) on 4xx from Circle-IR', async () => {
    await setupPool([
      { rows: [makeSkillRow()] },
      { rows: [] },
    ]);

    fetchMock.mockResolvedValueOnce({ ok: false, status: 400 });

    const msg = mockMsg({ skillId: 'skill-1', priority: 'normal', timestamp: Date.now() });
    const batch = { messages: [msg] } as any;

    await handleCogniumSubmitQueue(batch, mockEnv());
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('should retry on unexpected error (e.g., network failure)', async () => {
    await setupPool([
      { rows: [makeSkillRow()] },
      { rows: [] },
    ]);

    fetchMock.mockRejectedValueOnce(new Error('Network error'));

    const msg = mockMsg({ skillId: 'skill-1', priority: 'normal', timestamp: Date.now() });
    const batch = { messages: [msg] } as any;

    await handleCogniumSubmitQueue(batch, mockEnv());
    expect(msg.retry).toHaveBeenCalled();
  });

  it('should process multiple messages in a batch', async () => {
    await setupPool([
      { rows: [makeSkillRow({ id: 'skill-1', slug: 'skill-a' })] },
      { rows: [] },
      { rows: [] }, // skill-2 not found
    ]);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ job_id: 'job-1' }),
    });

    const msg1 = mockMsg({ skillId: 'skill-1', priority: 'normal', timestamp: Date.now() });
    const msg2 = mockMsg({ skillId: 'skill-2', priority: 'normal', timestamp: Date.now() });
    const batch = { messages: [msg1, msg2] } as any;

    await handleCogniumSubmitQueue(batch, mockEnv());
    expect(msg1.ack).toHaveBeenCalled();
    expect(msg2.ack).toHaveBeenCalled();
  });
});
