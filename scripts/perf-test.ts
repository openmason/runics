#!/usr/bin/env tsx
// ══════════════════════════════════════════════════════════════════════════════
// Performance Test Suite — Runics Registry
// ══════════════════════════════════════════════════════════════════════════════
//
// Runs latency measurements against multiple endpoints, computes percentiles,
// and checks against SLOs. Exits with code 1 if any SLO fails (CI-friendly).
//
// Usage:
//   npm run perf
//   npm run perf -- --endpoint https://runics.phantoms.workers.dev
//   npm run perf -- --iterations 20 --admin-key <key>
//
// ══════════════════════════════════════════════════════════════════════════════

// ── Types ────────────────────────────────────────────────────────────────────

interface PerfTest {
  name: string;
  method: 'GET' | 'POST';
  path: string;
  body?: object;
  headers?: Record<string, string>;
  sloP95Ms: number;
  requiresAdmin?: boolean;
  validate?: (status: number, body: any) => boolean;
}

interface PerfResult {
  name: string;
  method: string;
  path: string;
  latencies: number[];
  p50: number;
  p95: number;
  p99: number;
  sloP95Ms: number;
  passed: boolean;
  errors: number;
}

// ── Config ───────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    endpoint: process.env.RUNICS_ENDPOINT ?? 'https://runics.phantoms.workers.dev',
    adminKey: process.env.ADMIN_API_KEY ?? '',
    iterations: 10,
    warmup: 2,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--endpoint': case '-e': opts.endpoint = args[++i]; break;
      case '--admin-key': case '-k': opts.adminKey = args[++i]; break;
      case '--iterations': case '-n': opts.iterations = parseInt(args[++i], 10); break;
      case '--warmup': opts.warmup = parseInt(args[++i], 10); break;
      case '--help': case '-h':
        console.log(`
Performance Test Suite — Runics Registry

Usage:
  npm run perf -- [options]

Options:
  --endpoint, -e <url>     Target endpoint (default: production)
  --admin-key, -k <key>    Admin API key (or ADMIN_API_KEY env var)
  --iterations, -n <count> Iterations per test (default: 10)
  --warmup <count>         Warmup iterations (default: 2, not measured)
  --help, -h               Show this help
`);
        process.exit(0);
    }
  }

  return opts;
}

// ── Test Definitions ─────────────────────────────────────────────────────────

const tests: PerfTest[] = [
  {
    name: 'health',
    method: 'GET',
    path: '/health',
    sloP95Ms: 500,
    validate: (status) => status === 200,
  },
  {
    name: 'search-tier1',
    method: 'POST',
    path: '/v1/search',
    body: { query: 'format my code with prettier', tenantId: 'perf-test', limit: 5 },
    sloP95Ms: 300,
    validate: (status) => status === 200,
  },
  {
    name: 'search-tier2',
    method: 'POST',
    path: '/v1/search',
    body: { query: 'my code formatting is inconsistent across the team', tenantId: 'perf-test', limit: 5 },
    sloP95Ms: 600,
    validate: (status) => status === 200,
  },
  {
    name: 'skill-lookup',
    method: 'GET',
    path: '/v1/skills/skills-public',
    sloP95Ms: 400,
    validate: (status) => status === 200,
  },
  {
    name: 'leaderboard',
    method: 'GET',
    path: '/v1/leaderboards/trending',
    sloP95Ms: 400,
    validate: (status) => status === 200,
  },
  {
    name: 'scan-stats',
    method: 'GET',
    path: '/v1/admin/scan-stats',
    sloP95Ms: 800,
    requiresAdmin: true,
    validate: (status, body) => status === 200 && typeof body?.total === 'number',
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function pad(n: number, width: number): string {
  const s = n.toFixed(0);
  return s.padStart(width);
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function runTest(
  test: PerfTest,
  endpoint: string,
  iterations: number,
  warmup: number,
  adminKey: string,
): Promise<PerfResult> {
  const url = `${endpoint}${test.path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...test.headers,
  };
  if (test.requiresAdmin && adminKey) {
    headers['Authorization'] = `Bearer ${adminKey}`;
  }

  const fetchOpts: RequestInit = {
    method: test.method,
    headers,
  };
  if (test.body) {
    fetchOpts.body = JSON.stringify(test.body);
  }

  // Warmup (not measured)
  for (let i = 0; i < warmup; i++) {
    try { await fetch(url, fetchOpts); } catch { /* ignore */ }
  }

  // Measured iterations
  const latencies: number[] = [];
  let errors = 0;

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    try {
      const res = await fetch(url, fetchOpts);
      const elapsed = performance.now() - start;
      const body = await res.json().catch(() => null);

      if (test.validate && !test.validate(res.status, body)) {
        errors++;
      }
      latencies.push(elapsed);
    } catch {
      latencies.push(performance.now() - start);
      errors++;
    }
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);

  return {
    name: test.name,
    method: test.method,
    path: test.path,
    latencies,
    p50,
    p95,
    p99,
    sloP95Ms: test.sloP95Ms,
    passed: p95 <= test.sloP95Ms && errors === 0,
    errors,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const endpoint = opts.endpoint.replace(/\/$/, '');

  console.log('');
  console.log('Runics Performance Test');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(`Endpoint:   ${endpoint}`);
  console.log(`Iterations: ${opts.iterations} (+ ${opts.warmup} warmup)`);
  console.log('');

  const filteredTests = tests.filter(t => {
    if (t.requiresAdmin && !opts.adminKey) {
      console.log(`  ${t.name.padEnd(18)} SKIPPED (no --admin-key)`);
      return false;
    }
    return true;
  });

  const results: PerfResult[] = [];
  for (const test of filteredTests) {
    process.stdout.write(`  ${test.name.padEnd(18)} ${test.method.padEnd(5)} ${test.path.padEnd(30)} `);
    const result = await runTest(test, endpoint, opts.iterations, opts.warmup, opts.adminKey);
    results.push(result);

    const status = result.passed ? 'PASS' : 'FAIL';
    const errStr = result.errors > 0 ? ` (${result.errors} errors)` : '';
    console.log(
      `p50=${pad(result.p50, 5)}ms  p95=${pad(result.p95, 5)}ms  p99=${pad(result.p99, 5)}ms  ` +
      `${status} (SLO p95 < ${result.sloP95Ms}ms)${errStr}`
    );
  }

  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const totalRequests = results.reduce((sum, r) => sum + r.latencies.length, 0);

  console.log('');
  console.log(`Summary: ${passed}/${total} passed | ${totalRequests} total requests`);
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('');

  if (passed < total) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
