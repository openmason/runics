import { describe, it, expect, vi, beforeEach } from 'vitest';
import { triggerNotification } from '../../src/cognium/notification-trigger';

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockSkill(overrides?: Record<string, string>) {
  return {
    id: 'skill-1',
    slug: 'test-skill',
    version: '1.0.0',
    ...overrides,
  };
}

function mockEnv(overrides?: Record<string, any>) {
  return {
    ACTIVEPIECES_WEBHOOK_URL: 'https://hooks.example.com/webhook',
    SKILL_EVENTS: { send: vi.fn() },
    ...overrides,
  } as any;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('triggerNotification', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  it('should skip webhook when ACTIVEPIECES_WEBHOOK_URL is not configured', async () => {
    await triggerNotification(mockEnv({ ACTIVEPIECES_WEBHOOK_URL: undefined }), mockSkill(), 'revoked');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should send webhook on first attempt when 200', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    await triggerNotification(mockEnv(), mockSkill(), 'revoked', 'CWE-78');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hooks.example.com/webhook');
    const body = JSON.parse(opts.body);
    expect(body.event).toBe('skill.revoked');
    expect(body.skillId).toBe('skill-1');
    expect(body.reason).toBe('CWE-78');
  });

  it('should send skill.flagged event for vulnerable status', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    await triggerNotification(mockEnv(), mockSkill(), 'vulnerable', 'CWE-89');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.event).toBe('skill.flagged');
    expect(body.status).toBe('vulnerable');
  });

  it('should retry on 5xx and succeed on second attempt', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const p = triggerNotification(mockEnv(), mockSkill(), 'revoked');
    // Advance past the 500ms delay after first failure
    await vi.advanceTimersByTimeAsync(600);
    await p;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should retry on 429 (rate limited)', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const p = triggerNotification(mockEnv(), mockSkill(), 'revoked');
    await vi.advanceTimersByTimeAsync(600);
    await p;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should NOT retry on 4xx (non-retryable)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, statusText: 'Bad Request' });

    await triggerNotification(mockEnv(), mockSkill(), 'revoked');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should NOT retry on 404', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' });

    await triggerNotification(mockEnv(), mockSkill(), 'revoked');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should retry on network error and succeed', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('Network failure'))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const p = triggerNotification(mockEnv(), mockSkill(), 'revoked');
    await vi.advanceTimersByTimeAsync(600);
    await p;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should exhaust all 3 retries on persistent 500', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    const p = triggerNotification(mockEnv(), mockSkill(), 'revoked');
    // Attempt 0 fails → sleep 500ms
    await vi.advanceTimersByTimeAsync(600);
    // Attempt 1 fails → sleep 1000ms
    await vi.advanceTimersByTimeAsync(1100);
    // Attempt 2 fails → no more sleep
    await p;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('should exhaust all 3 retries on persistent network errors', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('Timeout'))
      .mockRejectedValueOnce(new Error('Timeout'))
      .mockRejectedValueOnce(new Error('Timeout'));

    const p = triggerNotification(mockEnv(), mockSkill(), 'revoked');
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(1100);
    await p;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('should use exponential backoff delays', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const p = triggerNotification(mockEnv(), mockSkill(), 'revoked');

    // After attempt 0: delay = 500 * 2^0 = 500ms
    await vi.advanceTimersByTimeAsync(500);
    // After attempt 1: delay = 500 * 2^1 = 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    await p;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('should not throw even after all retries exhausted', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'));

    const p = triggerNotification(mockEnv(), mockSkill(), 'revoked');
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(1100);

    // Should resolve without throwing
    await expect(p).resolves.toBeUndefined();
  });

  it('should set reason to null when not provided (webhook)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    await triggerNotification(mockEnv(), mockSkill(), 'vulnerable');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reason).toBeNull();
  });

  it('should include timestamp in ISO format (webhook)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    await triggerNotification(mockEnv(), mockSkill(), 'revoked');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('SKILL_EVENTS queue emission', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  it('should emit skill.revoked event to SKILL_EVENTS queue', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const env = mockEnv();

    await triggerNotification(env, mockSkill(), 'revoked', 'CWE-78');

    expect(env.SKILL_EVENTS.send).toHaveBeenCalledTimes(1);
    const event = env.SKILL_EVENTS.send.mock.calls[0][0];
    expect(event.type).toBe('skill.revoked');
    expect(event.skillId).toBe('skill-1');
    expect(event.slug).toBe('test-skill');
    expect(event.version).toBe('1.0.0');
    expect(event.reason).toBe('CWE-78');
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('should emit skill.vulnerable event to SKILL_EVENTS queue', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const env = mockEnv();

    await triggerNotification(env, mockSkill(), 'vulnerable', 'CWE-89');

    const event = env.SKILL_EVENTS.send.mock.calls[0][0];
    expect(event.type).toBe('skill.vulnerable');
  });

  it('should emit event even when ACTIVEPIECES_WEBHOOK_URL is not configured', async () => {
    const env = mockEnv({ ACTIVEPIECES_WEBHOOK_URL: undefined });

    await triggerNotification(env, mockSkill(), 'revoked');

    expect(env.SKILL_EVENTS.send).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should set reason to null when not provided', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const env = mockEnv();

    await triggerNotification(env, mockSkill(), 'revoked');

    const event = env.SKILL_EVENTS.send.mock.calls[0][0];
    expect(event.reason).toBeNull();
  });

  it('should not throw if SKILL_EVENTS queue send fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const env = mockEnv();
    env.SKILL_EVENTS.send.mockRejectedValueOnce(new Error('Queue quota exceeded'));

    await expect(
      triggerNotification(env, mockSkill(), 'revoked'),
    ).resolves.toBeUndefined();
  });

  it('should skip event emission when SKILL_EVENTS binding is missing', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const env = mockEnv({ SKILL_EVENTS: undefined });

    await expect(
      triggerNotification(env, mockSkill(), 'revoked'),
    ).resolves.toBeUndefined();
    // Webhook should still work
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
