# Runics Search — Setup & Deployment Guide

Complete guide to set up and deploy Runics Search Phase 1.

## Prerequisites

- Node.js 20+ and npm
- Cloudflare account with Workers enabled
- Neon Postgres database (or any PostgreSQL 15+ with pgvector)
- Wrangler CLI installed (`npm install -g wrangler`)

## Step 1: Install Dependencies

```bash
npm install
```

## Step 2: Set Up Neon Postgres

### 2.1 Create Database

1. Go to [Neon Console](https://console.neon.tech)
2. Create a new project
3. Note your connection string: `postgresql://user:password@host/database`

### 2.2 Run Migrations

Execute the SQL migrations in order:

```bash
# Connect to your Neon database
psql "postgresql://user:password@host/database"

# Or use the Neon SQL Editor in the console
```

Run each migration file:

```sql
-- 1. Create skill_embeddings table
\i src/db/migrations/0001_skill_embeddings.sql

-- 2. Create search_logs table
\i src/db/migrations/0002_search_logs.sql

-- 3. Create quality_feedback table
\i src/db/migrations/0003_quality_feedback.sql
```

**Note:** You also need to create the `skills` table (managed by the platform). Minimal schema:

```sql
CREATE TABLE IF NOT EXISTS skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  source TEXT NOT NULL,
  description TEXT,
  agent_summary TEXT,
  alternate_queries TEXT[],
  schema_json JSONB,
  auth_requirements JSONB,
  install_method JSONB,
  trust_score NUMERIC(3,2) DEFAULT 0.5,
  cognium_scanned BOOLEAN DEFAULT FALSE,
  cognium_report JSONB,
  capabilities_required TEXT[],
  execution_layer TEXT NOT NULL,
  source_execution_id UUID,
  reuse_count INTEGER DEFAULT 0,
  content_safety_passed BOOLEAN,
  tags TEXT[],
  category TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_skills_trust_score ON skills(trust_score);
CREATE INDEX idx_skills_source ON skills(source);
CREATE INDEX idx_skills_slug ON skills(slug);
CREATE INDEX idx_skills_execution_layer ON skills(execution_layer);
```

## Step 3: Set Up Cloudflare Infrastructure

### 3.1 Create KV Namespace

```bash
# Production namespace
wrangler kv:namespace create SEARCH_CACHE

# Note the ID output, e.g., "id = abc123..."
```

### 3.2 Create Hyperdrive Connection

```bash
# Create Hyperdrive connection to Neon
wrangler hyperdrive create runics-db \
  --connection-string="postgresql://user:password@host/database?sslmode=require"

# Note the ID output, e.g., "id = xyz789..."
```

### 3.3 Update wrangler.toml

Edit `wrangler.toml` and replace placeholder IDs:

```toml
[[kv_namespaces]]
binding = "SEARCH_CACHE"
id = "abc123..."  # Replace with your KV namespace ID

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "xyz789..."  # Replace with your Hyperdrive ID
```

## Step 4: Configure Environment Variables

Review and adjust thresholds in `wrangler.toml`:

```toml
[vars]
# Model configuration (use these exact model IDs)
EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5"
RERANKER_MODEL = "@cf/baai/bge-reranker-base"
LLM_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
SAFETY_MODEL = "@cf/meta/llama-guard-3-8b"

# Confidence tier thresholds (tune after Phase 1 eval)
CONFIDENCE_TIER1_THRESHOLD = "0.85"
CONFIDENCE_TIER2_THRESHOLD = "0.70"

# Cache TTL
CACHE_TTL_SECONDS = "60"

# Default appetite
DEFAULT_APPETITE = "balanced"

# Score fusion weights
VECTOR_WEIGHT = "0.7"
FULLTEXT_WEIGHT = "0.3"
```

## Step 5: Deploy to Cloudflare Workers

```bash
# Deploy to production
npm run deploy

# Note your worker URL, e.g., https://runics.YOUR_SUBDOMAIN.workers.dev
```

## Step 6: Seed Test Skills

Populate the 7 test skills needed for the eval suite:

```bash
# Against production
npm run seed -- --endpoint https://runics.YOUR_SUBDOMAIN.workers.dev

# Or against local dev (in another terminal: npm run dev)
npm run seed
```

Expected output:

```
╔═══════════════════════════════════════════════════════╗
║       RUNICS SEARCH — SEED EVAL SKILLS               ║
╚═══════════════════════════════════════════════════════╝

Endpoint:    https://runics.YOUR_SUBDOMAIN.workers.dev
Tenant ID:   eval-tenant
Skills:      7

🔍 Checking endpoint health...
✅ Endpoint healthy (db latency: 45ms)

📦 Indexing skills...

[1/7] cargo-deny           ✅
[2/7] prettier             ✅
[3/7] eslint               ✅
[4/7] trivy                ✅
[5/7] docker-postgres      ✅
[6/7] pandoc               ✅
[7/7] redis                ✅

═══════════════════════════════════════════════════════
Success: 7/7
Failed:  0/7
═══════════════════════════════════════════════════════

✅ All skills indexed successfully!
```

## Step 7: Run Eval Suite

Measure baseline performance:

```bash
# Against production
npm run eval -- --endpoint https://runics.YOUR_SUBDOMAIN.workers.dev --verbose --show-failed

# Or against local dev
npm run eval -- --verbose --show-failed
```

### Phase 1 Success Criteria

- ✅ **Recall@5 ≥ 70%** — Establishes baseline
- ✅ **MRR ≥ 0.65** — Establishes baseline
- ✅ **Tier 1 ≥ 60%** — Validates confidence thresholds
- ✅ **p50 latency < 60ms** — Performance target

### Expected Output

```
═══════════════════════════════════════════════════════
  EVAL METRICS
═══════════════════════════════════════════════════════

Overall Performance:
  Recall@1:       75.0%
  Recall@5:       87.5%
  MRR:            0.812
  Avg Top Score:  0.856

Tier Distribution:
  Tier 1 (High):   23 (71.9%)
  Tier 2 (Med):    6 (18.8%)
  Tier 3 (Low):    3 (9.4%)

By Pattern:
  direct       — Recall@5: 100.0% MRR: 0.917
  problem      — Recall@5: 85.7%  MRR: 0.816
  business     — Recall@5: 85.7%  MRR: 0.802
  alternate    — Recall@5: 83.3%  MRR: 0.778
  composition  — Recall@5: 83.3%  MRR: 0.764
```

## Step 8: Tune Confidence Thresholds

Based on eval results:

1. Look at score distribution (avg top score)
2. Analyze tier distribution
3. Adjust thresholds in `wrangler.toml`:

```toml
# If Tier 3 > 15%, thresholds may be too high
CONFIDENCE_TIER1_THRESHOLD = "0.80"  # Lower if needed
CONFIDENCE_TIER2_THRESHOLD = "0.65"  # Lower if needed
```

4. Redeploy and re-run eval to validate

## Local Development

### Start Dev Server

```bash
npm run dev
```

Server runs at `http://localhost:8787`

### Test Endpoints

```bash
# Health check
curl http://localhost:8787/health

# Search
curl -X POST http://localhost:8787/v1/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "check rust dependency licenses",
    "tenantId": "eval-tenant",
    "limit": 5
  }'

# Index a skill
curl -X POST http://localhost:8787/v1/skills/test-skill-123/index \
  -H "Content-Type: application/json" \
  -d @skill.json

# Run eval
curl -X POST http://localhost:8787/v1/eval/run
```

## Monitoring & Analytics

### View Search Quality

```bash
# Tier distribution (last 24 hours)
curl http://localhost:8787/v1/analytics/tiers?hours=24

# Match source stats
curl http://localhost:8787/v1/analytics/match-sources?hours=24

# Latency percentiles
curl http://localhost:8787/v1/analytics/latency?hours=24

# Cost breakdown
curl http://localhost:8787/v1/analytics/cost?hours=24

# Failed queries
curl http://localhost:8787/v1/analytics/failed-queries?hours=24&limit=50

# Tier 3 patterns (for Phase 3 planning)
curl http://localhost:8787/v1/analytics/tier3-patterns?hours=24
```

## Troubleshooting

### "Health check failed"

- Verify Hyperdrive connection string is correct
- Check Neon database is running and accessible
- Verify migrations ran successfully

### "Content safety check failed"

- Llama Guard flagged the skill content as unsafe
- Review skill description for prohibited content
- Adjust content or skip safety check for development

### "Embedding generation failed"

- Workers AI may be rate limited
- Check model ID is correct: `@cf/baai/bge-small-en-v1.5`
- Verify Workers AI is enabled on your account

### Low Recall@5 (< 60%)

- Agent summaries may be poor quality
- Check if skills were indexed correctly
- Review fixture queries (may not match skill descriptions)
- Consider re-running seed with updated descriptions

### High Tier 3 (> 30%)

- Confidence thresholds too conservative
- Lower `CONFIDENCE_TIER1_THRESHOLD` and `CONFIDENCE_TIER2_THRESHOLD`
- Re-deploy and re-run eval

## Next Steps

### Phase 2: Intelligence Layer

Once baseline is measured and thresholds tuned:

1. Implement confidence gating logic
2. Add LLM deep search (Tier 3)
3. Add async enrichment (Tier 2)
4. Implement composition detection
5. Measure lift over baseline

### Phase 3: Multi-Vector Validation

After Phase 2 is complete:

1. Implement alternate query generation
2. A/B test multi-vector vs query expansion
3. Measure lift per alternate query type
4. Decide on final strategy based on data

### Production Hardening

1. Add rate limiting
2. Implement error recovery (retries, circuit breaker)
3. Set up Langfuse for quality dashboards
4. Configure alerts on latency/error rate
5. Load test to validate SLOs

## Commands Reference

```bash
# Development
npm run dev              # Start local dev server
npm run typecheck        # Run TypeScript checks
npm test                 # Run unit tests

# Database
npm run db:generate      # Generate Drizzle migrations
npm run db:migrate       # Apply migrations (not used - manual SQL)

# Deployment
npm run deploy           # Deploy to Cloudflare Workers

# Eval & Seeding
npm run seed             # Seed test skills
npm run eval             # Run eval suite
npm run eval -- --verbose --show-failed  # Detailed output

# Environment-specific
npm run seed -- --endpoint https://production.workers.dev
npm run eval -- --endpoint https://production.workers.dev
```

## Cost Estimates

Based on 10K queries/day:

| Component | Monthly Cost |
|-----------|--------------|
| Neon Postgres Pro (10GB) | $19 |
| Workers AI (embeddings + LLM) | ~$18 |
| Cloudflare Workers compute | ~$5 |
| **Total** | **~$42/month** |

Query-time cost: ~$0.60/day = ~$18/month

## Architecture Compliance Checklist

- ✅ SearchProvider abstraction boundary
- ✅ Non-blocking logging via waitUntil
- ✅ Configurable thresholds (no hardcoded values)
- ✅ Content safety at index time
- ✅ Trust-based filtering
- ✅ KV caching with tier-based TTL
- ✅ Eval suite with 30+ fixtures
- ✅ Analytics for quality learning
- ✅ Single-vector baseline (Phase 1)
- ⏳ Multi-vector validation (Phase 3)
- ⏳ LLM deep search (Phase 2)

Phase 1 foundation is complete! 🎉
