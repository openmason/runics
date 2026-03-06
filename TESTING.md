# Runics Search - Testing & Verification Guide

This guide covers how to test and verify the Runics Search system at different levels.

## Table of Contents
1. [Health Checks](#health-checks)
2. [Search Functionality](#search-functionality)
3. [Running the Eval Suite](#running-the-eval-suite)
4. [Tier Distribution Verification](#tier-distribution-verification)
5. [Database Verification](#database-verification)
6. [Performance Testing](#performance-testing)
7. [Production Monitoring](#production-monitoring)

---

## Health Checks

### Production Health
```bash
curl -s https://runics.phantoms.workers.dev/health | jq .
```

**Expected output:**
- `ok: true`
- `dbStatus: "ok"`
- `aiStatus: "ok"`
- All 4 tables present: `skills`, `skill_embeddings`, `search_logs`, `quality_feedback`

### Local Dev Health
```bash
curl -s http://localhost:8787/health | jq .
```

---

## Search Functionality

### Basic Search Test
```bash
curl -s https://runics.phantoms.workers.dev/v1/search \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "format typescript code",
    "tenantId": "eval-tenant",
    "limit": 5
  }' | jq .
```

**Expected output:**
- `results` array with matching skills
- Top result should be "prettier" (score ~0.509)
- `meta.tier` should be 1 (high confidence)

### Test All Query Patterns

**Direct query:**
```bash
curl -s https://runics.phantoms.workers.dev/v1/search \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"check rust dependency licenses","tenantId":"eval-tenant","limit":3}' \
  | jq '{tier: .meta.tier, topResult: .results[0].name, score: .results[0].score}'
```

**Problem query:**
```bash
curl -s https://runics.phantoms.workers.dev/v1/search \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"code formatting is inconsistent across the team","tenantId":"eval-tenant","limit":3}' \
  | jq '{tier: .meta.tier, topResult: .results[0].name, score: .results[0].score}'
```

**Business query:**
```bash
curl -s https://runics.phantoms.workers.dev/v1/search \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"improve application performance and scalability","tenantId":"eval-tenant","limit":3}' \
  | jq '{tier: .meta.tier, topResult: .results[0].name, score: .results[0].score}'
```

### Verify Caching
Run the same query twice and check for cache hit:
```bash
# First request (cache miss)
curl -s https://runics.phantoms.workers.dev/v1/search \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"test cache","tenantId":"eval-tenant","limit":3}' \
  | jq '{cacheHit: .meta.cacheHit, latencyMs: .meta.latencyMs}'

# Second request (should be cache hit)
curl -s https://runics.phantoms.workers.dev/v1/search \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"test cache","tenantId":"eval-tenant","limit":3}' \
  | jq '{cacheHit: .meta.cacheHit, latencyMs: .meta.latencyMs}'
```

**Expected:** Second request should have `cacheHit: true` and lower latency.

---

## Running the Eval Suite

### Full Eval Suite (Production)
```bash
npm run eval -- --endpoint https://runics.phantoms.workers.dev --verbose
```

**Expected metrics:**
- Recall@5: ≥70% (currently 100%)
- MRR: ≥0.65 (currently 0.969)
- Success rate: 100%

### Eval Against Local Dev
```bash
npm run eval -- --endpoint http://localhost:8787 --verbose
```

### Generate Baseline Report
```bash
npm run analyze-baseline -- --endpoint https://runics.phantoms.workers.dev
```

This generates `BASELINE.md` with detailed analysis.

---

## Tier Distribution Verification

### Check Tier Assignment for Multiple Queries
```bash
# Create a test script
cat > /tmp/test-tiers.sh << 'EOF'
#!/bin/bash

queries=(
  "check rust dependency licenses"
  "format typescript code"
  "lint javascript files"
  "scan docker images"
  "run postgres database"
  "convert markdown to pdf"
  "api responses too slow"
)

echo "Query,TopResult,Score,Tier"
for query in "${queries[@]}"; do
  result=$(curl -s https://runics.phantoms.workers.dev/v1/search \
    -X POST \
    -H 'Content-Type: application/json' \
    -d "{\"query\":\"$query\",\"tenantId\":\"eval-tenant\",\"limit\":1}")

  name=$(echo "$result" | jq -r '.results[0].name')
  score=$(echo "$result" | jq -r '.results[0].score')
  tier=$(echo "$result" | jq -r '.meta.tier')

  echo "\"$query\",\"$name\",$score,$tier"
done
EOF

chmod +x /tmp/test-tiers.sh
/tmp/test-tiers.sh
```

**Expected distribution:**
- Tier 1: ~50% (high confidence, score ≥0.40)
- Tier 2: ~50% (medium confidence, score ≥0.35)
- Tier 3: ~0% (low confidence, score <0.35)

---

## Database Verification

### Check Indexed Skills
```bash
# Run this script to check skills in database
cat > /tmp/check-db.ts << 'EOF'
import { Pool } from '@neondatabase/serverless';

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_4P6BeXkZLcTA@ep-autumn-river-akx7s38p.c-3.us-west-2.aws.neon.tech/neondb?sslmode=require'
});

const client = await pool.connect();

try {
  // Count skills
  const skillsResult = await client.query('SELECT COUNT(*) FROM skills');
  console.log(`Total skills: ${skillsResult.rows[0].count}`);

  // Count embeddings
  const embeddingsResult = await client.query('SELECT COUNT(*) FROM skill_embeddings');
  console.log(`Total embeddings: ${embeddingsResult.rows[0].count}`);

  // List all skills
  const allSkills = await client.query('SELECT id, name, category, trust_score FROM skills ORDER BY name');
  console.log('\nIndexed skills:');
  allSkills.rows.forEach((skill, i) => {
    console.log(`${i + 1}. ${skill.name} (${skill.category}) - trust: ${skill.trust_score}`);
  });

  // Check embedding dimensions
  const dimResult = await client.query(
    "SELECT source, vector_dims(embedding) as dims FROM skill_embeddings LIMIT 1"
  );
  console.log(`\nEmbedding dimensions: ${dimResult.rows[0]?.dims || 'N/A'}`);

} finally {
  client.release();
  await pool.end();
}
EOF

tsx /tmp/check-db.ts
```

**Expected output:**
- Total skills: 7
- Total embeddings: 7
- Embedding dimensions: 384 (bge-small-en-v1.5)

---

## Performance Testing

### Latency Test (10 concurrent queries)
```bash
# Simple latency test
for i in {1..10}; do
  (curl -s -w "\nTime: %{time_total}s\n" https://runics.phantoms.workers.dev/v1/search \
    -X POST \
    -H 'Content-Type: application/json' \
    -d "{\"query\":\"test query $i\",\"tenantId\":\"eval-tenant\",\"limit\":3}" \
    | jq -r '.meta.latencyMs' | xargs -I {} echo "Latency: {}ms") &
done
wait
```

**Expected latency:**
- p50: <300ms (with cache miss)
- p50: <50ms (with cache hit)
- p95: <500ms

### Throughput Test
```bash
# Install apache bench if needed: brew install httpd
ab -n 100 -c 10 -p /tmp/search-payload.json -T 'application/json' \
  https://runics.phantoms.workers.dev/v1/search

# Create payload file
echo '{"query":"format typescript code","tenantId":"eval-tenant","limit":5}' > /tmp/search-payload.json
```

---

## Production Monitoring

### Watch Live Logs
```bash
# Start tailing production logs
npx wrangler tail runics
```

This shows real-time requests, errors, and performance metrics.

### Check for Errors
```bash
# Tail logs and filter for errors
npx wrangler tail runics | grep -i error
```

### Common Issues to Monitor

1. **Database Connection Errors**
   - Look for: `Connection terminated unexpectedly`
   - Cause: Neon free tier connection limits
   - Expected: Occasional, auto-recovers

2. **Cache Errors**
   - Look for: `Cache set error`
   - Cause: Invalid TTL or KV issues
   - Should not occur (fixed with 60s minimum TTL)

3. **AI Errors**
   - Look for: `AI.run failed`
   - Cause: Workers AI rate limits or timeouts
   - Monitor frequency

---

## Automated Test Suite

Create a comprehensive test script:

```bash
cat > test-all.sh << 'EOF'
#!/bin/bash
set -e

echo "================================"
echo "  Runics Search - Full Test Suite"
echo "================================"
echo

# 1. Health check
echo "1. Health Check..."
curl -sf https://runics.phantoms.workers.dev/health > /dev/null && echo "✅ Production healthy" || echo "❌ Production unhealthy"
echo

# 2. Basic search
echo "2. Basic Search..."
result=$(curl -sf https://runics.phantoms.workers.dev/v1/search \
  -X POST -H 'Content-Type: application/json' \
  -d '{"query":"format typescript code","tenantId":"eval-tenant","limit":1}')
top_result=$(echo "$result" | jq -r '.results[0].name')
[ "$top_result" = "prettier" ] && echo "✅ Search working (found: $top_result)" || echo "❌ Search failed (found: $top_result, expected: prettier)"
echo

# 3. Run eval suite
echo "3. Running Eval Suite..."
npm run eval -- --endpoint https://runics.phantoms.workers.dev 2>&1 | tail -10
echo

# 4. Check database
echo "4. Database Check..."
health=$(curl -sf https://runics.phantoms.workers.dev/health)
db_status=$(echo "$health" | jq -r '.dbStatus')
table_count=$(echo "$health" | jq -r '.tables | length')
[ "$db_status" = "ok" ] && [ "$table_count" -eq 4 ] && echo "✅ Database OK ($table_count tables)" || echo "❌ Database issues"
echo

echo "================================"
echo "  Test Complete"
echo "================================"
EOF

chmod +x test-all.sh
```

Run all tests:
```bash
./test-all.sh
```

---

## Quick Verification Commands

```bash
# One-line health check
curl -sf https://runics.phantoms.workers.dev/health && echo "✅ OK" || echo "❌ FAIL"

# One-line search test
curl -sf https://runics.phantoms.workers.dev/v1/search -X POST -H 'Content-Type: application/json' -d '{"query":"test","tenantId":"eval-tenant","limit":1}' | jq -r '.results[0].name'

# One-line eval (just show metrics)
npm run eval -- --endpoint https://runics.phantoms.workers.dev 2>&1 | grep -A 10 "Overall Performance"
```

---

## Troubleshooting

### Issue: Search returns no results
```bash
# Check if skills are indexed
curl -s https://runics.phantoms.workers.dev/health | jq '.tables'

# Re-seed if needed
npm run seed -- --endpoint https://runics.phantoms.workers.dev
```

### Issue: Eval suite failing
```bash
# Check endpoint is accessible
curl -sf https://runics.phantoms.workers.dev/health || echo "Endpoint down"

# Run with verbose logging
npm run eval -- --endpoint https://runics.phantoms.workers.dev --verbose
```

### Issue: High latency
```bash
# Check cache is working
curl -s https://runics.phantoms.workers.dev/v1/search \
  -X POST -H 'Content-Type: application/json' \
  -d '{"query":"test","tenantId":"eval-tenant","limit":1}' \
  | jq '.meta.cacheHit'

# Should return true on second request
```

---

## Next Steps

After verification:
1. Review `BASELINE.md` for detailed metrics
2. Monitor production logs for errors
3. Run eval suite regularly to track quality
4. Move to Phase 2 (intelligence layer) when ready
