#!/usr/bin/env tsx
// ══════════════════════════════════════════════════════════════════════════════
// Smoke Test — Runics Production Verification
// ══════════════════════════════════════════════════════════════════════════════
//
// Verifies a deployed Runics instance is healthy and all subsystems are
// operational. Tests infrastructure (DB, AI, KV, Queues), public endpoints,
// the public guard (write routes blocked on api.runics.net), and response
// shape correctness.
//
// Usage:
//   npm run smoke                              # default: api.runics.net
//   npm run smoke -- --endpoint https://runics.cognium.workers.dev
//   npm run smoke -- --admin-key <key>         # also test admin endpoints
//
// Exit code 0 = all checks pass, 1 = failures detected.
//
// ══════════════════════════════════════════════════════════════════════════════

// ── Types ────────────────────────────────────────────────────────────────────

interface Check {
  name: string;
  run: () => Promise<CheckResult>;
}

interface CheckResult {
  passed: boolean;
  detail: string;
  latencyMs: number;
}

// ── Config ───────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    endpoint: 'https://api.runics.net',
    adminKey: '',
    verbose: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--endpoint' && args[i + 1]) opts.endpoint = args[++i];
    if (args[i] === '--admin-key' && args[i + 1]) opts.adminKey = args[++i];
    if (args[i] === '--verbose' || args[i] === '-v') opts.verbose = true;
  }
  return opts;
}

const config = parseArgs();
const BASE = config.endpoint.replace(/\/$/, '');

// ── Helpers ──────────────────────────────────────────────────────────────────

async function timedFetch(
  url: string,
  init?: RequestInit
): Promise<{ status: number; body: any; latencyMs: number }> {
  const start = performance.now();
  const res = await fetch(url, init);
  const latencyMs = Math.round(performance.now() - start);
  let body: any;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('json')) {
    body = await res.json();
  } else {
    body = await res.text();
  }
  return { status: res.status, body, latencyMs };
}

function ok(detail: string, latencyMs: number): CheckResult {
  return { passed: true, detail, latencyMs };
}

function fail(detail: string, latencyMs: number): CheckResult {
  return { passed: false, detail, latencyMs };
}

// ── Checks ───────────────────────────────────────────────────────────────────

const checks: Check[] = [];

// 1. Health endpoint — DB, AI, tables
checks.push({
  name: 'Health endpoint',
  run: async () => {
    const { status, body, latencyMs } = await timedFetch(`${BASE}/health`);
    if (status !== 200) return fail(`status ${status}`, latencyMs);
    if (!body.ok) return fail(`ok=false: ${body.dbError ?? 'unknown'}`, latencyMs);
    if (body.dbStatus !== 'ok') return fail(`dbStatus=${body.dbStatus}: ${body.dbError}`, latencyMs);
    if (body.aiStatus !== 'ok') return fail(`aiStatus=${body.aiStatus}: ${body.aiError}`, latencyMs);
    if (body.missingTables?.length > 0)
      return fail(`missing tables: ${body.missingTables.join(', ')}`, latencyMs);
    const tableCount = body.tables?.length ?? 0;
    return ok(`DB ok, AI ok, ${tableCount} tables, ${body.dbLatencyMs}ms db`, latencyMs);
  },
});

// 2. Search endpoint — accepts POST, returns expected shape
checks.push({
  name: 'POST /v1/search',
  run: async () => {
    const { status, body, latencyMs } = await timedFetch(`${BASE}/v1/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'hello world', tenantId: 'smoke-test' }),
    });
    if (status !== 200) return fail(`status ${status}: ${JSON.stringify(body)}`, latencyMs);
    if (!Array.isArray(body.results)) return fail('missing results array', latencyMs);
    if (body.meta === undefined) return fail('missing meta object', latencyMs);
    return ok(`${body.results.length} results, confidence=${body.confidence}, tier=${body.meta.tier}`, latencyMs);
  },
});

// 3. Skill detail — GET /v1/skills/ prefix works (will 404 with no data, that's ok)
checks.push({
  name: 'GET /v1/skills/:slug (shape check)',
  run: async () => {
    const { status, body, latencyMs } = await timedFetch(`${BASE}/v1/skills/nonexistent-smoke-test-skill`);
    // 404 is expected with empty DB — we just check the endpoint responds
    if (status === 404) return ok('404 for nonexistent skill (expected)', latencyMs);
    if (status === 200) {
      if (!body.slug) return fail('200 but missing slug field', latencyMs);
      return ok(`found skill: ${body.slug}`, latencyMs);
    }
    return fail(`unexpected status ${status}`, latencyMs);
  },
});

// 4. Leaderboards — GET /v1/leaderboards/human
checks.push({
  name: 'GET /v1/leaderboards/human',
  run: async () => {
    const { status, body, latencyMs } = await timedFetch(`${BASE}/v1/leaderboards/human`);
    if (status !== 200) return fail(`status ${status}: ${JSON.stringify(body).slice(0, 200)}`, latencyMs);
    if (!Array.isArray(body.leaderboard)) return fail('missing leaderboard array', latencyMs);
    return ok(`${body.leaderboard.length} entries`, latencyMs);
  },
});

// 5. Authors — GET /v1/authors/:handle
checks.push({
  name: 'GET /v1/authors/:handle (shape check)',
  run: async () => {
    const { status, body, latencyMs } = await timedFetch(`${BASE}/v1/authors/nonexistent-smoke`);
    if (status === 404) return ok('404 for nonexistent author (expected)', latencyMs);
    if (status === 200) return ok(`found author: ${body.handle}`, latencyMs);
    return fail(`unexpected status ${status}`, latencyMs);
  },
});

// 6. Eval results — GET /v1/eval/results
checks.push({
  name: 'GET /v1/eval/results',
  run: async () => {
    const { status, body, latencyMs } = await timedFetch(`${BASE}/v1/eval/results`);
    if (status !== 200) return fail(`status ${status}`, latencyMs);
    if (!Array.isArray(body.runs)) return fail('missing runs array', latencyMs);
    return ok(`${body.runs.length} eval runs`, latencyMs);
  },
});

// 7. Compositions — GET /v1/compositions/:id
checks.push({
  name: 'GET /v1/compositions/:id (shape check)',
  run: async () => {
    const { status, body, latencyMs } = await timedFetch(
      `${BASE}/v1/compositions/00000000-0000-0000-0000-000000000000`
    );
    if (status === 404) return ok('404 for nonexistent composition (expected)', latencyMs);
    if (status === 200) return ok(`found composition`, latencyMs);
    return fail(`unexpected status ${status}`, latencyMs);
  },
});

// 8. Public guard — write routes should return 404 on public domain
const isPublicDomain = BASE.includes('api.runics.net');

if (isPublicDomain) {
  const blockedRoutes = [
    { name: 'Guard: POST /v1/skills (blocked)', method: 'POST', path: '/v1/skills' },
    { name: 'Guard: POST /v1/invocations (blocked)', method: 'POST', path: '/v1/invocations' },
    { name: 'Guard: POST /v1/search/feedback (blocked)', method: 'POST', path: '/v1/search/feedback' },
    { name: 'Guard: GET /v1/admin/scan-stats (blocked)', method: 'GET', path: '/v1/admin/scan-stats' },
    { name: 'Guard: GET /v1/analytics/tiers (blocked)', method: 'GET', path: '/v1/analytics/tiers' },
    { name: 'Guard: POST /v1/eval/run (blocked)', method: 'POST', path: '/v1/eval/run' },
  ];

  for (const route of blockedRoutes) {
    checks.push({
      name: route.name,
      run: async () => {
        const { status, body, latencyMs } = await timedFetch(`${BASE}${route.path}`, {
          method: route.method,
          headers: { 'Content-Type': 'application/json' },
          body: route.method === 'POST' ? '{}' : undefined,
        });
        if (status === 404 && body?.error === 'Not found')
          return ok('correctly blocked (404)', latencyMs);
        return fail(`expected 404 but got ${status}`, latencyMs);
      },
    });
  }
}

// 9. Admin endpoints (only if --admin-key provided)
if (config.adminKey) {
  checks.push({
    name: 'Admin: GET /v1/admin/scan-stats',
    run: async () => {
      const { status, body, latencyMs } = await timedFetch(`${BASE}/v1/admin/scan-stats`, {
        headers: { 'X-Admin-Key': config.adminKey },
      });
      if (status === 404 && isPublicDomain)
        return ok('blocked on public domain (expected)', latencyMs);
      if (status !== 200) return fail(`status ${status}`, latencyMs);
      return ok(`scan stats returned`, latencyMs);
    },
  });
}

// 10. CORS preflight
checks.push({
  name: 'CORS preflight (OPTIONS)',
  run: async () => {
    const { status, latencyMs } = await timedFetch(`${BASE}/v1/search`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://runics.net',
        'Access-Control-Request-Method': 'POST',
      },
    });
    // 200 or 204 both acceptable for CORS preflight
    if (status === 200 || status === 204) return ok(`status ${status}`, latencyMs);
    return fail(`status ${status} (expected 200/204)`, latencyMs);
  },
});

// 11. Versions list — GET /v1/skills/:slug/versions
checks.push({
  name: 'GET /v1/skills/:slug/versions (shape check)',
  run: async () => {
    const { status, body, latencyMs } = await timedFetch(`${BASE}/v1/skills/nonexistent-smoke/versions`);
    if (status === 200 && Array.isArray(body.versions))
      return ok(`${body.versions.length} versions`, latencyMs);
    if (status === 404) return ok('404 for nonexistent slug (expected)', latencyMs);
    return fail(`unexpected status ${status}`, latencyMs);
  },
});

// ── Runner ───────────────────────────────────────────────────────────────────

async function run() {
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  Runics Smoke Test');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  Endpoint:  ${BASE}`);
  console.log(`  Public:    ${isPublicDomain ? 'yes (guard checks enabled)' : 'no (internal)'}`);
  console.log(`  Admin key: ${config.adminKey ? 'provided' : 'not provided (skipping admin checks)'}`);
  console.log(`  Checks:    ${checks.length}`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const check of checks) {
    try {
      const result = await check.run();
      const icon = result.passed ? '✓' : '✗';
      const color = result.passed ? '\x1b[32m' : '\x1b[31m';
      const reset = '\x1b[0m';
      const latency = `${result.latencyMs}ms`.padStart(6);

      console.log(`  ${color}${icon}${reset}  ${latency}  ${check.name}`);
      if (config.verbose || !result.passed) {
        console.log(`              ${result.detail}`);
      }

      if (result.passed) {
        passed++;
      } else {
        failed++;
        failures.push(`${check.name}: ${result.detail}`);
      }
    } catch (err: any) {
      failed++;
      const msg = err.message ?? String(err);
      console.log(`  \x1b[31m✗\x1b[0m         ${check.name}`);
      console.log(`              ERROR: ${msg}`);
      failures.push(`${check.name}: ${msg}`);
    }
  }

  console.log('');
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`  ${passed} passed, ${failed} failed, ${checks.length} total`);

  if (failures.length > 0) {
    console.log('');
    console.log('  Failures:');
    for (const f of failures) {
      console.log(`    - ${f}`);
    }
  }

  console.log('──────────────────────────────────────────────────────────────');
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
