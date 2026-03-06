# Runics Search — Eval Suite

The eval suite measures search quality by running test queries against the live search endpoint and computing precision metrics.

## Overview

The eval suite consists of:

1. **Fixtures** (`fixtures.ts`) — 32 query/skill pairs covering 5 phrasing patterns
2. **Metrics** (`metrics.ts`) — Recall@1, Recall@5, MRR computation
3. **Runner** (`runner.ts`) — Executes fixtures and computes metrics

## Fixtures

32 query/skill test pairs across 5 phrasing patterns:

| Pattern | Count | Description |
|---------|-------|-------------|
| **direct** | 6 | User knows exactly what they want |
| **problem** | 7 | User describes their problem, not the solution |
| **business** | 7 | Non-technical/PM language |
| **alternate** | 6 | Different terminology for same concept |
| **composition** | 6 | Part of a larger workflow |

### Example Skills

- `cargo-deny` — Rust license/advisory checker
- `prettier` — Code formatter
- `eslint` — JavaScript linter
- `trivy` — Container security scanner
- `docker-postgres` — Local Postgres for development
- `pandoc` — Document converter
- `redis` — Caching layer

## Metrics

### Recall@1
Percentage of queries where the correct skill is ranked #1.

**Target:** ≥70% (Phase 1 baseline)

### Recall@5
Percentage of queries where the correct skill is in the top 5 results.

**Target:** ≥85% (Phase 1 baseline)

### MRR (Mean Reciprocal Rank)
Average of `1 / rank` across all queries. Higher is better.

**Target:** ≥0.75 (Phase 1 baseline)

### Tier Distribution
Percentage of queries routed to each confidence tier:
- Tier 1 (high): Target ~70%
- Tier 2 (medium): Target ~20%
- Tier 3 (low): Target ~10%

### Per-Pattern Breakdown
Metrics computed for each phrasing pattern to identify which patterns work well and which need improvement.

## Running the Eval Suite

### Via CLI (Recommended)

```bash
# Run against local dev server
npm run dev  # in one terminal
npm run eval # in another terminal

# Run with verbose output
npm run eval -- --verbose

# Show failed queries
npm run eval -- --show-failed

# Run against production
npm run eval -- --endpoint https://runics.workers.dev/v1/search
```

### Via API

```bash
# Start the server
npm run dev

# Run eval suite
curl -X POST http://localhost:8787/v1/eval/run \
  -H "Content-Type: application/json" \
  -d '{"tenantId": "eval-tenant", "verbose": true}'
```

### Via Wrangler Deploy

```bash
# Deploy first
npm run deploy

# Run eval against production
npm run eval -- --endpoint https://runics.YOUR_SUBDOMAIN.workers.dev/v1/search
```

## Expected Output

```
╔═══════════════════════════════════════════════════════╗
║         RUNICS SEARCH — EVAL SUITE RUNNER            ║
╚═══════════════════════════════════════════════════════╝

Fixture Stats:
  Total:          32
  Unique skills:  7
  By pattern:
    direct       6
    problem      7
    business     7
    alternate    6
    composition  6

Configuration:
  Endpoint:       http://localhost:8787/v1/search
  Tenant ID:      eval-tenant
  Limit:          10
  Verbose:        true

🔍 Running eval suite (32 fixtures)...
Run ID: eval-1234567890-abc123
Endpoint: http://localhost:8787/v1/search

[1/32] direct       — check rust dependency licenses...               ✅ Rank 1
[2/32] direct       — format typescript code...                       ✅ Rank 1
...

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
  alternate    — Recall@5: 83.3%  MRR: 0.778
  business     — Recall@5: 85.7%  MRR: 0.802
  composition  — Recall@5: 83.3%  MRR: 0.764
  direct       — Recall@5: 100.0% MRR: 0.917
  problem      — Recall@5: 85.7%  MRR: 0.816

═══════════════════════════════════════════════════════

✅ Eval passed: success rate >= 80%
```

## Phase Goals

### Phase 1 (Single-Vector Baseline)
- **Recall@5:** 70%+ (establishes baseline)
- **MRR:** 0.65+ (establishes baseline)
- **Tier 1:** 60%+ (confidence thresholds need tuning)

**Goal:** Measure baseline, derive tier thresholds from actual score distribution.

### Phase 2 (Intelligence Layer)
- **Recall@5:** 80%+ (LLM fallback rescues Tier 3 queries)
- **MRR:** 0.75+ (improved from baseline)
- **Tier 3 cost:** < 15% of queries (validates threshold tuning)

**Goal:** Measure LLM fallback effectiveness, validate cost model.

### Phase 3 (Multi-Vector Validation)
- **Recall@5:** 90%+ (alternate queries improve coverage)
- **MRR:** 0.85+ (better ranking from richer representations)
- **Match source diversity:** All 5 alt_query types pull weight

**Goal:** A/B test multi-vector vs single-vector + query expansion. Decide based on measured lift.

## Interpreting Results

### Good Baseline (Phase 1)
- Recall@5 ≥ 70%
- Direct pattern performs best (users who know what they want)
- Problem/business patterns slightly lower (vocabulary gap)
- Tier distribution close to 70/20/10

### Needs Improvement
- Recall@5 < 60% → embedding model issue or fixture quality
- Direct pattern < 80% → basic functionality broken
- Tier 3 > 30% → confidence thresholds too conservative

### Failed Queries Analysis

When queries fail (not in top 5), look for:
1. **Vocabulary gaps** — user terminology not in skill descriptions
2. **Multi-word concepts** — embeddings miss compound terms
3. **Domain-specific jargon** — technical terms not captured
4. **Composition queries** — single-skill search can't handle workflows

These patterns inform:
- Alternate query prompt tuning (Phase 3)
- Agent summary prompt improvements
- New embedding categories

## Adding Fixtures

1. Identify a real skill from your registry
2. Write 5 queries across all patterns
3. Add to `fixtures.ts`
4. Run `npm run eval` to validate

Example:
```typescript
{
  id: 'eval-direct-007',
  query: 'validate json schema',
  expectedSkillId: 'ajv-validator',
  pattern: 'direct',
},
{
  id: 'eval-problem-008',
  query: 'api responses dont match expected format',
  expectedSkillId: 'ajv-validator',
  pattern: 'problem',
},
// ... etc
```

## Continuous Monitoring

Run the eval suite:
- **Before** any search architecture change
- **After** any search architecture change
- **Daily** in CI to catch regressions
- **After** adding/updating skills to measure coverage

Store results over time to track quality trends.
