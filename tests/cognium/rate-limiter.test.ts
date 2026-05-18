import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CogniumRateLimiter } from '../../src/cognium/rate-limiter';

// ── Mock helpers ────────────────────────────────────────────────────────────

function mockKV(initialState?: { tokens: number; lastRefillAt: number }) {
  const store: Record<string, string> = {};
  if (initialState) {
    store['cognium:ratelimit:bucket'] = JSON.stringify(initialState);
  }
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(async (key: string, value: string) => { store[key] = value; }),
    delete: vi.fn(),
  } as any;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('CogniumRateLimiter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should grant token on first call (empty bucket initializes full)', async () => {
    const kv = mockKV();
    const limiter = new CogniumRateLimiter({ ratePerSecond: 2, maxTokens: 10, kv });

    const result = await limiter.tryAcquire();
    expect(result).toBe(true);
    expect(kv.put).toHaveBeenCalledWith(
      'cognium:ratelimit:bucket',
      expect.any(String),
      { expirationTtl: 300 },
    );

    // Verify stored state has 9 tokens (10 - 1)
    const storedState = JSON.parse(kv.put.mock.calls[0][1]);
    expect(storedState.tokens).toBe(9);
  });

  it('should deny when bucket is empty (no tokens)', async () => {
    const kv = mockKV({ tokens: 0, lastRefillAt: Date.now() });
    const limiter = new CogniumRateLimiter({ ratePerSecond: 2, maxTokens: 10, kv });

    const result = await limiter.tryAcquire();
    expect(result).toBe(false);
  });

  it('should exhaust bucket after maxTokens acquisitions', async () => {
    const kv = mockKV();
    const limiter = new CogniumRateLimiter({ ratePerSecond: 2, maxTokens: 3, kv });

    // First 3 should succeed
    expect(await limiter.tryAcquire()).toBe(true);
    expect(await limiter.tryAcquire()).toBe(true);
    expect(await limiter.tryAcquire()).toBe(true);

    // 4th should fail
    expect(await limiter.tryAcquire()).toBe(false);
  });

  it('should refill tokens based on elapsed time', async () => {
    const now = Date.now();
    // Bucket was emptied 2 seconds ago, rate=2/sec → should have refilled ~4 tokens
    const kv = mockKV({ tokens: 0, lastRefillAt: now - 2000 });
    const limiter = new CogniumRateLimiter({ ratePerSecond: 2, maxTokens: 10, kv });

    const result = await limiter.tryAcquire();
    expect(result).toBe(true);

    // Verify tokens were refilled (4 refilled - 1 consumed = 3)
    const storedState = JSON.parse(kv.put.mock.calls[0][1]);
    expect(storedState.tokens).toBeGreaterThanOrEqual(2);
    expect(storedState.tokens).toBeLessThanOrEqual(4);
  });

  it('should cap refill at maxTokens', async () => {
    const now = Date.now();
    // Bucket was emptied 100 seconds ago, rate=2/sec → 200 tokens but cap at 10
    const kv = mockKV({ tokens: 0, lastRefillAt: now - 100_000 });
    const limiter = new CogniumRateLimiter({ ratePerSecond: 2, maxTokens: 10, kv });

    const result = await limiter.tryAcquire();
    expect(result).toBe(true);

    const storedState = JSON.parse(kv.put.mock.calls[0][1]);
    expect(storedState.tokens).toBe(9); // 10 capped - 1 consumed
  });

  it('should use custom key when provided', async () => {
    const kv = mockKV();
    const limiter = new CogniumRateLimiter({
      ratePerSecond: 2,
      maxTokens: 10,
      kv,
      key: 'custom:bucket',
    });

    await limiter.tryAcquire();
    expect(kv.get).toHaveBeenCalledWith('custom:bucket');
    expect(kv.put).toHaveBeenCalledWith('custom:bucket', expect.any(String), expect.anything());
  });

  it('should store state with 300s TTL on deny', async () => {
    const kv = mockKV({ tokens: 0, lastRefillAt: Date.now() });
    const limiter = new CogniumRateLimiter({ ratePerSecond: 2, maxTokens: 10, kv });

    await limiter.tryAcquire();
    expect(kv.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { expirationTtl: 300 },
    );
  });

  describe('fromEnv', () => {
    it('should create limiter with default rate when env var not set', () => {
      const kv = mockKV();
      const limiter = CogniumRateLimiter.fromEnv({ COGNIUM_JOBS: kv as any });

      // Default: rate=2, maxTokens=10
      // We can verify by acquiring 10 tokens
      expect(limiter).toBeInstanceOf(CogniumRateLimiter);
    });

    it('should create limiter with custom rate from env var', async () => {
      const kv = mockKV();
      const limiter = CogniumRateLimiter.fromEnv({
        COGNIUM_JOBS: kv as any,
        COGNIUM_RATE_LIMIT_PER_SECOND: '5',
      });

      // rate=5, maxTokens=25
      const result = await limiter.tryAcquire();
      expect(result).toBe(true);

      const storedState = JSON.parse(kv.put.mock.calls[0][1]);
      expect(storedState.tokens).toBe(24); // 25 - 1
    });
  });
});
