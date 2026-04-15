# API Key Middleware — Specification

> **Version:** 1.0 · April 2026
> **Status:** New specification. P0 — blocking partner launch.
> **Company:** Cognium Labs
> **Scope:** Shared authentication and authorization middleware across Cognium, Runics, and Cortex API surfaces.
> **Companion docs:** `ARCHITECTURE.md`

---

## 1. What This Is

A shared Hono middleware that validates API keys, resolves tenants, checks scopes, and enforces rate limits on every API call to Cognium, Runics, and Cortex. Partners get one API key and can access whichever surfaces their key is scoped to.

This is not a full identity provider. It handles machine-to-machine authentication for API consumers (partners, agents, CLI tools, CI/CD pipelines). Human user authentication (passkeys, magic link, SSO) is handled separately per product and is out of scope for this middleware.

---

## 2. Design Principles

**One key, scoped access.** A partner receives a single API key. The key's metadata defines which surfaces it can access (cognium, runics, cortex — any combination).

**Stateless validation.** Every request is validated independently via KV lookup. No sessions, no cookies, no JWTs for API access.

**Defense in depth.** The middleware validates at the API gateway layer. Individual services validate tenant-level permissions internally (e.g., Runics checks skill visibility per tenant).

**Zero-trust default.** No API key → 401. Invalid scope → 403. Rate exceeded → 429. Expired key → 401.

---

## 3. Data Model

### 3.1 Tenant Record (Postgres)

```sql
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,                    -- "tenant_abc123"
  name TEXT NOT NULL,                      -- "Acme Corp"
  type TEXT NOT NULL DEFAULT 'partner'
    CHECK (type IN ('internal', 'partner', 'enterprise')),
  contact_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'revoked')),
  plan TEXT NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free', 'starter', 'pro', 'enterprise')),
  rate_limit_rpm INTEGER NOT NULL DEFAULT 60,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 3.2 API Key Record (Postgres)

```sql
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,                     -- "key_xyz789"
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  key_hash TEXT NOT NULL UNIQUE,           -- SHA-256 hash of the API key
  key_prefix TEXT NOT NULL,                -- first 8 chars for identification: "ck_live_a1b2..."
  name TEXT NOT NULL,                      -- "Production key" / "CI pipeline"
  scopes TEXT[] NOT NULL,                  -- {'cognium', 'runics', 'cortex'}
  key_type TEXT NOT NULL DEFAULT 'standard'
    CHECK (key_type IN ('standard', 'read-only', 'admin')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'rotated', 'revoked')),
  expires_at TIMESTAMPTZ,                  -- NULL = never expires
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id);
```

### 3.3 API Key Metadata (KV — hot path)

KV stores the hot-path lookup data. Postgres is the source of truth. KV is populated on key creation and invalidated on rotation/revocation.

```typescript
// KV key: apikey:{sha256hash}
// KV value:
interface APIKeyMetadata {
  keyId: string;
  tenantId: string;
  tenantName: string;
  tenantStatus: 'active' | 'suspended' | 'revoked';
  scopes: ('cognium' | 'runics' | 'cortex')[];
  keyType: 'standard' | 'read-only' | 'admin';
  rateLimitRpm: number;
  expiresAt: string | null;
}
```

KV TTL: 5 minutes. On cache miss, middleware queries Postgres and populates KV.

---

## 4. Key Format

```
ck_live_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
```

- Prefix: `ck_live_` (production) or `ck_test_` (sandbox)
- Body: 40-character random alphanumeric string
- Total: 48 characters

The key is shown once on creation and never stored in plaintext. Only the SHA-256 hash is persisted.

---

## 5. Middleware Implementation

### 5.1 Hono Middleware

```typescript
import { createMiddleware } from 'hono/factory';

interface Env {
  API_KEYS: KVNamespace;
  DB: Hyperdrive;
  RATE_LIMIT: KVNamespace;
}

export const apiKeyAuth = (requiredScope: 'cognium' | 'runics' | 'cortex') =>
  createMiddleware<{ Bindings: Env }>(async (c, next) => {
    // 1. Extract key from header
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing API key' }, 401);
    }
    const apiKey = authHeader.slice(7);

    // 2. Hash and lookup
    const keyHash = await sha256(apiKey);
    let metadata = await c.env.API_KEYS.get<APIKeyMetadata>(
      `apikey:${keyHash}`,
      'json'
    );

    // 3. Cache miss → query Postgres
    if (!metadata) {
      metadata = await fetchFromPostgres(c.env.DB, keyHash);
      if (metadata) {
        await c.env.API_KEYS.put(
          `apikey:${keyHash}`,
          JSON.stringify(metadata),
          { expirationTtl: 300 } // 5 minutes
        );
      }
    }

    // 4. Validate
    if (!metadata) {
      return c.json({ error: 'Invalid API key' }, 401);
    }

    if (metadata.tenantStatus !== 'active') {
      return c.json({ error: 'Tenant suspended' }, 403);
    }

    if (metadata.expiresAt && new Date(metadata.expiresAt) < new Date()) {
      return c.json({ error: 'API key expired' }, 401);
    }

    if (!metadata.scopes.includes(requiredScope)) {
      return c.json({ error: `Key not scoped for ${requiredScope}` }, 403);
    }

    // 5. Rate limit
    const rateLimitKey = `rate:${metadata.keyId}:${currentMinute()}`;
    const count = parseInt(await c.env.RATE_LIMIT.get(rateLimitKey) ?? '0');
    if (count >= metadata.rateLimitRpm) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }
    await c.env.RATE_LIMIT.put(rateLimitKey, String(count + 1), {
      expirationTtl: 120 // 2 minutes (covers current + next minute)
    });

    // 6. Inject tenant context
    c.set('tenantId', metadata.tenantId);
    c.set('tenantName', metadata.tenantName);
    c.set('keyType', metadata.keyType);
    c.set('keyId', metadata.keyId);

    // 7. Update last_used_at (fire-and-forget, non-blocking)
    c.executionCtx.waitUntil(
      updateLastUsed(c.env.DB, metadata.keyId)
    );

    await next();
  });
```

### 5.2 Usage per Service

```typescript
// Cognium API
const cogniumApp = new Hono<{ Bindings: Env }>();
cogniumApp.use('/v1/*', apiKeyAuth('cognium'));

// Runics API
const runicsApp = new Hono<{ Bindings: Env }>();
runicsApp.use('/v1/*', apiKeyAuth('runics'));

// Cortex API
const cortexApp = new Hono<{ Bindings: Env }>();
cortexApp.use('/v1/*', apiKeyAuth('cortex'));
```

---

## 6. Key Management API

Hosted on a shared management Worker (e.g., `api.cogniumlabs.com`). Initially admin-only; partner self-service in future.

### 6.1 Endpoints

| Method | Path | Description | Auth |
|---|---|---|---|
| `POST` | `/v1/tenants` | Create a tenant | Admin |
| `GET` | `/v1/tenants/:id` | Get tenant details | Admin |
| `PATCH` | `/v1/tenants/:id` | Update tenant (status, plan, rate limit) | Admin |
| `POST` | `/v1/tenants/:id/keys` | Create an API key for a tenant | Admin |
| `GET` | `/v1/tenants/:id/keys` | List keys for a tenant (prefix only, no secrets) | Admin |
| `DELETE` | `/v1/tenants/:id/keys/:keyId` | Revoke a key | Admin |
| `POST` | `/v1/tenants/:id/keys/:keyId/rotate` | Rotate a key (creates new, marks old as rotated) | Admin |

### 6.2 Key Creation Response

```json
{
  "keyId": "key_xyz789",
  "apiKey": "ck_live_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
  "prefix": "ck_live_a1b2",
  "scopes": ["cognium", "runics"],
  "expiresAt": null,
  "warning": "Store this key securely. It will not be shown again."
}
```

### 6.3 Key Rotation

Rotation creates a new key and marks the old one as `rotated`. The old key remains valid for a grace period (default: 24 hours) to allow migration.

```typescript
interface RotationResult {
  newKey: { keyId: string; apiKey: string; prefix: string };
  oldKey: { keyId: string; prefix: string; expiresAt: string };
  gracePeriodHours: number;
}
```

---

## 7. Partner Onboarding Flow

### MVP (Manual)

```bash
# 1. Admin creates tenant via CLI script
pnpm run admin:create-tenant \
  --name "Acme Corp" \
  --email "api@acme.com" \
  --plan starter \
  --rate-limit 120

# 2. Admin creates API key
pnpm run admin:create-key \
  --tenant tenant_abc123 \
  --name "Production" \
  --scopes cognium,runics

# 3. Key displayed once → send to partner securely
# API Key: ck_live_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6

# 4. Partner uses key
curl -H "Authorization: Bearer ck_live_a1b2..." \
  https://runics.net/v1/search?q=flight+search
```

### Future (Self-Service)

Partner signs up → creates account → generates keys from dashboard → sets scopes. Requires identity provider integration (parked).

---

## 8. Rate Limiting

### Tiers

| Plan | RPM | Burst | Notes |
|---|---|---|---|
| Free | 30 | 10/sec | For evaluation |
| Starter | 120 | 30/sec | Small teams |
| Pro | 600 | 100/sec | Production use |
| Enterprise | Custom | Custom | Negotiated |

### Implementation

KV-based sliding window counter per API key per minute. Key format: `rate:{keyId}:{minute_timestamp}`. TTL: 120 seconds (auto-cleanup).

Burst limiting (per-second) uses a separate counter: `burst:{keyId}:{second_timestamp}`. TTL: 10 seconds.

---

## 9. Security

- API keys are never stored in plaintext. SHA-256 hash only.
- KV cache has 5-minute TTL. Revocation takes effect within 5 minutes.
- For immediate revocation, a `revoked_keys` KV set can be checked on every request (hot path). Add key hash to set on revoke, check set before KV metadata lookup.
- Keys are scoped per surface. A `runics`-only key cannot call Cortex endpoints.
- `read-only` keys cannot call mutation endpoints (POST/PUT/DELETE on Runics publish, Cortex workflow creation). Enforced per-endpoint, not in middleware.
- All key management endpoints require admin authentication (separate from API keys — internal bearer token or Cloudflare Access).

---

## 10. Package Structure

```
packages/api-key-middleware/
├── package.json          # @cognium/api-key-middleware
├── src/
│   ├── index.ts          # Public exports
│   ├── middleware.ts      # Hono middleware factory
│   ├── hash.ts           # SHA-256 hashing utility
│   ├── rate-limit.ts     # KV-based rate limiting
│   ├── types.ts          # APIKeyMetadata, TenantRecord
│   └── management.ts     # Key CRUD operations (used by admin API)
├── tests/
│   ├── middleware.test.ts
│   ├── rate-limit.test.ts
│   └── management.test.ts
└── README.md
```

Estimated total: ~500 lines of source, ~400 lines of tests.

**Dependencies:** `hono`, `zod`. Same stack as rest of Cognium Labs.

---

## 11. Wrangler Configuration

Each service that uses the middleware needs these bindings:

```toml
[[kv_namespaces]]
binding = "API_KEYS"
id = "..."            # shared KV namespace for API key metadata cache

[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "..."            # shared KV namespace for rate limit counters

[[hyperdrive]]
binding = "DB"
id = "..."            # shared Hyperdrive binding for Postgres fallback
```

All three services (Cognium, Runics, Cortex) share the same KV namespaces and Hyperdrive binding for consistent key validation and rate limiting.
