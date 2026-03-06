# Runics Search — Phase 1 Baseline

**Date:** 2026-03-02
**Run ID:** eval-1772473512465-9wzdfyb
**Endpoint:** https://runics.phantoms.workers.dev

## Overall Performance

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Recall@1 | 93.8% | - | - |
| Recall@5 | 100.0% | ≥70% | ✅ |
| MRR | 0.969 | ≥0.65 | ✅ |
| Avg Top Score | 0.474 | - | - |

## Tier Distribution

| Tier | Count | Percentage | Target | Status |
|------|-------|------------|--------|--------|
| Tier 1 (High) | 16 | 50.0% | ~70% | ❌ |
| Tier 2 (Med) | 16 | 50.0% | ~20% | - |
| Tier 3 (Low) | 0 | 0.0% | ~10% | ✅ |

## Score Distribution

| Percentile | Score |
|------------|-------|
| Min | 0.380 |
| P25 | 0.449 |
| Median (P50) | 0.480 |
| Mean | 0.474 |
| P75 | 0.509 |
| P90 | 0.535 |
| P95 | 0.557 |
| Max | 0.563 |

## Per-Pattern Performance

| Pattern | Recall@5 | MRR |
|---------|----------|-----|
| alternate | 100.0% | 1.000 |
| business | 100.0% | 1.000 |
| composition | 100.0% | 0.833 |
| direct | 100.0% | 1.000 |
| problem | 100.0% | 1.000 |

## Confidence Threshold Analysis

### Current Thresholds

```toml
CONFIDENCE_TIER1_THRESHOLD = "0.85"
CONFIDENCE_TIER2_THRESHOLD = "0.70"
```

### Recommended Thresholds

```toml
CONFIDENCE_TIER1_THRESHOLD = "0.70"
CONFIDENCE_TIER2_THRESHOLD = "0.55"
```

### Reasoning

- Tier 1 is 50.0% (target ~70%) — thresholds too high
- Recommend lowering Tier 1 to 0.70
- Recommend lowering Tier 2 to 0.55

## Test Fixtures

- **Total:** 32
- **Unique Skills:** 7

### By Pattern

- direct: 6
- problem: 7
- business: 7
- alternate: 6
- composition: 6

## Phase 1 Exit Criteria

- ✅ Baseline measured: 2026-03-02
- ✅ Recall@5 ≥ 70%: 100.0%
- ✅ MRR ≥ 0.65: 0.969
- ❌ Tier 1 ≥ 60%: 50.0%

**Status:** ⚠️ Baseline needs improvement before Phase 2.

## Next Steps

### 1. Adjust Thresholds

Update `wrangler.toml` with recommended thresholds and redeploy:

```bash
# Edit wrangler.toml
npm run deploy
npm run eval -- --verbose
```

### 2. Analyze Failed Queries

Review failed queries to identify patterns:
- Vocabulary gaps (terminology not in skill descriptions)
- Multi-word concepts (embeddings miss compound terms)
- Domain-specific jargon

### 3. Move to Phase 2

Implement intelligence layer:
- Confidence gating (3-tier routing)
- LLM deep search (Tier 3)
- Async enrichment (Tier 2)
- Composition detection
