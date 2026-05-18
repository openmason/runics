// ══════════════════════════════════════════════════════════════════════════════
// Cognium Rate Limiter — Token Bucket for Circle-IR API Calls (v5.3)
// ══════════════════════════════════════════════════════════════════════════════
//
// Prevents Runics from overwhelming Circle-IR with scan requests.
// Uses a KV-backed token bucket: refills at `rate` tokens/sec, burst up to
// `maxTokens`. Each outbound call to Circle-IR must acquire a token first.
//
// If no token is available, callers should retry (queue re-delivery) rather
// than wait — Workers have strict execution time limits.
//
// ══════════════════════════════════════════════════════════════════════════════

export interface RateLimiterConfig {
  /** Tokens replenished per second (default: 2) */
  ratePerSecond: number;
  /** Maximum burst size (default: rate × 5) */
  maxTokens: number;
  /** KV namespace for state storage */
  kv: KVNamespace;
  /** KV key for the bucket state */
  key?: string;
}

interface BucketState {
  tokens: number;
  lastRefillAt: number; // epoch ms
}

const DEFAULT_KEY = 'cognium:ratelimit:bucket';

export class CogniumRateLimiter {
  private ratePerSecond: number;
  private maxTokens: number;
  private kv: KVNamespace;
  private key: string;

  constructor(config: RateLimiterConfig) {
    this.ratePerSecond = config.ratePerSecond;
    this.maxTokens = config.maxTokens;
    this.kv = config.kv;
    this.key = config.key ?? DEFAULT_KEY;
  }

  /**
   * Try to acquire a token. Returns true if granted, false if bucket is empty.
   * Non-blocking — callers should msg.retry() on false rather than polling.
   */
  async tryAcquire(): Promise<boolean> {
    const now = Date.now();
    const raw = await this.kv.get(this.key);
    let state: BucketState;

    if (!raw) {
      // First call — initialize with full bucket
      state = { tokens: this.maxTokens, lastRefillAt: now };
    } else {
      state = JSON.parse(raw);
    }

    // Refill tokens based on elapsed time
    const elapsed = (now - state.lastRefillAt) / 1000;
    const refill = elapsed * this.ratePerSecond;
    state.tokens = Math.min(this.maxTokens, state.tokens + refill);
    state.lastRefillAt = now;

    if (state.tokens < 1) {
      // No tokens — write back the refilled state and deny
      await this.kv.put(this.key, JSON.stringify(state), { expirationTtl: 300 });
      return false;
    }

    // Consume one token
    state.tokens -= 1;
    await this.kv.put(this.key, JSON.stringify(state), { expirationTtl: 300 });
    return true;
  }

  /**
   * Create a rate limiter from environment variables.
   */
  static fromEnv(env: { COGNIUM_JOBS: KVNamespace; COGNIUM_RATE_LIMIT_PER_SECOND?: string }): CogniumRateLimiter {
    const rate = parseInt(env.COGNIUM_RATE_LIMIT_PER_SECOND ?? '2', 10);
    return new CogniumRateLimiter({
      ratePerSecond: rate,
      maxTokens: rate * 5,
      kv: env.COGNIUM_JOBS,
    });
  }
}
