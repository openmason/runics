import { describe, it, expect, vi, beforeEach } from 'vitest';
import { triggerNotification } from '../../src/cognium/notification-trigger';

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockEnv(overrides?: Record<string, any>) {
  return {
    ACTIVEPIECES_WEBHOOK_URL: 'https://hooks.example.com/webhook',
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

  it('should skip when ACTIVEPIECES_WEBHOOK_URL is not configured', async () => {
    await triggerNotification(mockEnv({ ACTIVEPIECES_WEBHOOK_URL: undefined }), 'skill-1', 'revoked');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should send webhook on first attempt when 200', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    await triggerNotification(mockEnv(), 'skill-1', 'revoked', 'CWE-78');

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

    await triggerNotification(mockEnv(), 'skill-1', 'vulnerable', 'CWE-89');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.event).toBe('skill.flagged');
    expect(body.status).toBe('vulnerable');
  });

  it('should retry on 5xx and succeed on second attempt', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const p = triggerNotification(mockEnv(), 'skill-1', 'revoked');
    // Advance past the 500ms delay after first failure
    await vi.advanceTimersByTimeAsync(600);
    await p;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should retry on 429 (rate limited)', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const p = triggerNotification(mockEnv(), 'skill-1', 'revoked');
    await vi.advanceTimersByTimeAsync(600);
    await p;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should NOT retry on 4xx (non-retryable)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, statusText: 'Bad Request' });

    await triggerNotification(mockEnv(), 'skill-1', 'revoked');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should NOT retry on 404', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' });

    await triggerNotification(mockEnv(), 'skill-1', 'revoked');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should retry on network error and succeed', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('Network failure'))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const p = triggerNotification(mockEnv(), 'skill-1', 'revoked');
    await vi.advanceTimersByTimeAsync(600);
    await p;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should exhaust all 3 retries on persistent 500', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    const p = triggerNotification(mockEnv(), 'skill-1', 'revoked');
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

    const p = triggerNotification(mockEnv(), 'skill-1', 'revoked');
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

    const sleepCalls: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    // Track timer durations via fake timers
    const p = triggerNotification(mockEnv(), 'skill-1', 'revoked');

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

    const p = triggerNotification(mockEnv(), 'skill-1', 'revoked');
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(1100);

    // Should resolve without throwing
    await expect(p).resolves.toBeUndefined();
  });

  it('should set reason to null when not provided', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    await triggerNotification(mockEnv(), 'skill-1', 'vulnerable');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reason).toBeNull();
  });

  it('should include timestamp in ISO format', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    await triggerNotification(mockEnv(), 'skill-1', 'revoked');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
