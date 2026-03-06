// ══════════════════════════════════════════════════════════════════════════════
// k6 Load Test — Runics Search Service
// ══════════════════════════════════════════════════════════════════════════════
//
// Usage:
//   k6 run --env ENDPOINT=http://localhost:8787 scripts/k6/load-test.js
//   k6 run --env ENDPOINT=https://runics.your-domain.workers.dev scripts/k6/load-test.js
//
// SLOs:
//   p50 < 60ms, p99 < 500ms, p999 < 1500ms, error rate < 1%
//
// ══════════════════════════════════════════════════════════════════════════════

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ──────────────────────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────────────────────

const ENDPOINT = __ENV.ENDPOINT || 'http://localhost:8787';
const SEARCH_URL = `${ENDPOINT}/v1/search`;
const TENANT_ID = __ENV.TENANT_ID || 'eval-tenant';

// Custom metrics
const errorRate = new Rate('search_errors');
const searchDuration = new Trend('search_duration', true);

export const options = {
  stages: [
    { duration: '30s', target: 10 },   // Warm up
    { duration: '1m', target: 50 },    // Ramp to sustained load
    { duration: '2m', target: 50 },    // Sustained load
    { duration: '30s', target: 100 },  // Peak load
    { duration: '1m', target: 100 },   // Sustained peak
    { duration: '30s', target: 0 },    // Ramp down
  ],
  thresholds: {
    'search_duration': [
      'p(50)<60',     // p50 < 60ms
      'p(99)<500',    // p99 < 500ms
      'p(99.9)<1500', // p999 < 1500ms
    ],
    'search_errors': ['rate<0.01'], // Error rate < 1%
    'http_req_failed': ['rate<0.01'],
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Query Pool — Weighted by Expected Tier
// ──────────────────────────────────────────────────────────────────────────────

// Tier 1 queries (~70%): Direct, high-confidence matches
const tier1Queries = [
  'format my code with prettier',
  'run eslint on my project',
  'scan docker images for vulnerabilities',
  'set up postgres with docker',
  'convert markdown to pdf',
  'run redis cache server',
  'check license compliance',
  'format python code with black',
  'run jest unit tests',
  'deploy to cloudflare workers',
  'lint rust code with clippy',
  'run playwright e2e tests',
  'scan for security vulnerabilities with trivy',
  'lint my dockerfiles',
  'manage kubernetes deployments',
  'format code with biome',
  'check dependencies with dependabot',
  'generate API documentation with typedoc',
  'run terraform infrastructure',
  'set up prometheus monitoring',
];

// Tier 2 queries (~20%): Problem-oriented, medium confidence
const tier2Queries = [
  'my code formatting is inconsistent',
  'need to check if dependencies have known CVEs',
  'want to make sure our containers are secure',
  'how do I run database migrations',
  'need API testing automation',
  'my team needs standardized commit messages',
  'we need to visualize our metrics',
  'need to automate our release process',
  'help me document my component library',
  'want to generate API client from OpenAPI spec',
];

// Tier 3 queries (~10%): Vague, business-oriented, low confidence
const tier3Queries = [
  'improve our development workflow',
  'make sure our app is enterprise-ready',
  'we need better observability',
  'help with compliance requirements',
  'improve code quality across the team',
];

// ──────────────────────────────────────────────────────────────────────────────
// Query Selection (Weighted Random)
// ──────────────────────────────────────────────────────────────────────────────

function selectQuery() {
  const rand = Math.random();

  if (rand < 0.70) {
    // 70% Tier 1
    return tier1Queries[Math.floor(Math.random() * tier1Queries.length)];
  } else if (rand < 0.90) {
    // 20% Tier 2
    return tier2Queries[Math.floor(Math.random() * tier2Queries.length)];
  } else {
    // 10% Tier 3
    return tier3Queries[Math.floor(Math.random() * tier3Queries.length)];
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Test Scenario
// ──────────────────────────────────────────────────────────────────────────────

export default function () {
  const query = selectQuery();

  const payload = JSON.stringify({
    query,
    tenantId: TENANT_ID,
    limit: 5,
    appetite: 'balanced',
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
    },
    tags: { name: 'search' },
  };

  const start = Date.now();
  const res = http.post(SEARCH_URL, payload, params);
  const duration = Date.now() - start;

  searchDuration.add(duration);

  const success = check(res, {
    'status is 200': (r) => r.status === 200,
    'has results': (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body.results);
      } catch {
        return false;
      }
    },
    'has confidence': (r) => {
      try {
        const body = JSON.parse(r.body);
        return ['high', 'medium', 'low_enriched', 'no_match'].includes(body.confidence);
      } catch {
        return false;
      }
    },
    'has meta': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.meta && typeof body.meta.latencyMs === 'number';
      } catch {
        return false;
      }
    },
  });

  errorRate.add(!success);

  // Random think time between requests (100-500ms)
  sleep(0.1 + Math.random() * 0.4);
}

// ──────────────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────────────

export function handleSummary(data) {
  const metrics = data.metrics;

  const summary = {
    search_p50: metrics.search_duration?.values?.['p(50)']?.toFixed(1) + 'ms',
    search_p95: metrics.search_duration?.values?.['p(95)']?.toFixed(1) + 'ms',
    search_p99: metrics.search_duration?.values?.['p(99)']?.toFixed(1) + 'ms',
    search_p999: metrics.search_duration?.values?.['p(99.9)']?.toFixed(1) + 'ms',
    error_rate: (metrics.search_errors?.values?.rate * 100)?.toFixed(2) + '%',
    total_requests: metrics.http_reqs?.values?.count,
    rps: metrics.http_reqs?.values?.rate?.toFixed(1),
  };

  console.log('\n══════════════════════════════════════════════');
  console.log('  Runics Search — Load Test Results');
  console.log('══════════════════════════════════════════════');
  console.log(`  p50:    ${summary.search_p50}  (SLO: <60ms)`);
  console.log(`  p95:    ${summary.search_p95}`);
  console.log(`  p99:    ${summary.search_p99}  (SLO: <500ms)`);
  console.log(`  p999:   ${summary.search_p999}  (SLO: <1500ms)`);
  console.log(`  Errors: ${summary.error_rate}  (SLO: <1%)`);
  console.log(`  Total:  ${summary.total_requests} requests @ ${summary.rps} rps`);
  console.log('══════════════════════════════════════════════\n');

  return {
    stdout: JSON.stringify(summary, null, 2) + '\n',
  };
}
