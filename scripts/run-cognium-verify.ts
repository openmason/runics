#!/usr/bin/env tsx
// ══════════════════════════════════════════════════════════════════════════════
// Cognium Scan Pipeline — Verification Script
// ══════════════════════════════════════════════════════════════════════════════
//
// Runs synthetic scoring tests and optional live Circle-IR scans to verify
// the entire Cognium scan pipeline is functioning correctly.
//
// Usage:
//   npm run verify:cognium
//   npm run verify:cognium -- --endpoint https://runics.phantoms.workers.dev
//   npm run verify:cognium -- --skip-live
//   npm run verify:cognium -- --verbose
//
// ══════════════════════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

interface TestCase {
  name: string;
  source: string; // which source's skill to use
  findings: Array<{ severity: string; cweId: string }>;
  expected: {
    trustScore?: number;
    status?: string;
    contentUnsafe?: boolean;
  };
}

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

interface DiscoveredSkills {
  github?: { id: string; slug: string };
  'mcp-registry'?: { id: string; slug: string };
  clawhub?: { id: string; slug: string };
}

// ──────────────────────────────────────────────────────────────────────────────
// CLI Argument Parsing
// ──────────────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    endpoint: process.env.RUNICS_ENDPOINT ?? 'http://localhost:8787',
    skipLive: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--endpoint':
      case '-e':
        options.endpoint = args[++i];
        break;
      case '--skip-live':
        options.skipLive = true;
        break;
      case '--verbose':
      case '-v':
        options.verbose = true;
        break;
      case '--help':
      case '-h':
        console.log(`
Cognium Scan Pipeline Verification Script

Usage:
  npm run verify:cognium [options]

Options:
  --endpoint, -e <url>   Target endpoint (default: https://runics.workers.dev)
  --skip-live            Skip live Circle-IR scans (synthetic only)
  --verbose, -v          Show detailed output
  --help, -h             Show this help
`);
        process.exit(0);
    }
  }

  return options;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

async function adminPost(endpoint: string, path: string, body?: any): Promise<any> {
  const url = `${endpoint}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

async function discoverSkills(endpoint: string): Promise<DiscoveredSkills> {
  const skills: DiscoveredSkills = {};

  // Strategy 1: Direct DB query (most reliable — works even without Workers AI)
  let dbUrl = process.env.DATABASE_URL ?? process.env.NEON_CONNECTION_STRING;

  // Auto-read from wrangler.toml if not set in env
  if (!dbUrl) {
    try {
      const fs = await import('fs');
      const path = await import('path');
      const toml = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'wrangler.toml'), 'utf-8');
      const match = toml.match(/NEON_CONNECTION_STRING\s*=\s*"([^"]+)"/);
      if (match) dbUrl = match[1];
    } catch {
      // Ignore — fall through to search-based discovery
    }
  }

  if (dbUrl) {
    try {
      const { Pool } = await import('@neondatabase/serverless');
      const pool = new Pool({ connectionString: dbUrl });
      const result = await pool.query(
        `SELECT DISTINCT ON (source) id, slug, source FROM skills
         WHERE status = 'published' AND source IN ('github', 'mcp-registry', 'clawhub')
         ORDER BY source, created_at DESC`
      );
      for (const row of result.rows) {
        skills[row.source as keyof DiscoveredSkills] = { id: row.id, slug: row.slug };
      }
      await pool.end();
      if (Object.keys(skills).length > 0) return skills;
    } catch {
      // Fall through to search-based discovery
    }
  }

  // Strategy 2: Search endpoint (requires Workers AI + full stack)
  const sources = ['github', 'mcp-registry', 'clawhub'];
  for (const source of sources) {
    try {
      const res = await fetch(`${endpoint}/v1/search?q=tool&limit=5&appetite=broad`);
      if (!res.ok) continue;
      const data = await res.json() as any;
      const match = data.results?.find((r: any) => r.source === source);
      if (match) {
        skills[source as keyof DiscoveredSkills] = { id: match.id, slug: match.slug };
      }
      break; // One search is enough — we look for all sources in the results
    } catch {
      // Ignore discovery failures
    }
  }

  return skills;
}

// ──────────────────────────────────────────────────────────────────────────────
// Synthetic Scoring Tests
// ──────────────────────────────────────────────────────────────────────────────

function buildTestCases(): TestCase[] {
  return [
    {
      name: 'Clean GitHub skill (no findings)',
      source: 'github',
      findings: [],
      expected: { trustScore: 0.55, status: 'published', contentUnsafe: false },
    },
    {
      name: 'Clean MCP-registry skill (no findings)',
      source: 'mcp-registry',
      findings: [],
      expected: { trustScore: 0.80, status: 'published', contentUnsafe: false },
    },
    {
      name: 'CRITICAL CWE-78 (OS command injection)',
      source: 'github',
      findings: [{ severity: 'CRITICAL', cweId: 'CWE-78' }],
      expected: { status: 'revoked', contentUnsafe: true },
    },
    {
      name: 'HIGH CWE-89 (SQL injection)',
      source: 'github',
      findings: [{ severity: 'HIGH', cweId: 'CWE-89' }],
      expected: { status: 'vulnerable', contentUnsafe: false },
    },
    {
      name: 'MEDIUM CWE-200 (information exposure)',
      source: 'github',
      findings: [{ severity: 'MEDIUM', cweId: 'CWE-200' }],
      expected: { status: 'vulnerable' },
    },
    {
      name: 'LOW CWE-200 (information exposure)',
      source: 'github',
      findings: [{ severity: 'LOW', cweId: 'CWE-200' }],
      expected: { status: 'published' },
    },
    {
      name: 'Multiple findings — trust accumulation',
      source: 'mcp-registry',
      findings: [
        { severity: 'HIGH', cweId: 'CWE-79' },  // -0.20
        { severity: 'MEDIUM', cweId: 'CWE-200' }, // -0.05
      ],
      expected: { trustScore: 0.55, status: 'vulnerable' },
    },
    {
      name: 'Secret exposure CWE-798 — heavy trust impact',
      source: 'github',
      findings: [{ severity: 'HIGH', cweId: 'CWE-798' }],
      expected: { trustScore: 0.25, status: 'vulnerable' },
    },
  ];
}

async function runSyntheticTests(
  endpoint: string,
  skills: DiscoveredSkills,
  verbose: boolean,
): Promise<TestResult[]> {
  const testCases = buildTestCases();
  const results: TestResult[] = [];

  for (const tc of testCases) {
    const skill = skills[tc.source as keyof DiscoveredSkills];
    if (!skill) {
      results.push({
        name: tc.name,
        passed: false,
        details: `No ${tc.source} skill discovered — skipped`,
      });
      continue;
    }

    try {
      const res = await adminPost(
        endpoint,
        `/v1/admin/scan-test/${skill.id}`,
        { findings: tc.findings },
      );

      const failures: string[] = [];

      if (tc.expected.trustScore !== undefined) {
        if (res.computed.trustScore !== tc.expected.trustScore) {
          failures.push(`trustScore: expected ${tc.expected.trustScore}, got ${res.computed.trustScore}`);
        }
      }

      if (tc.expected.status !== undefined) {
        if (res.computed.status !== tc.expected.status) {
          failures.push(`status: expected ${tc.expected.status}, got ${res.computed.status}`);
        }
      }

      if (tc.expected.contentUnsafe !== undefined) {
        if (res.computed.contentUnsafe !== tc.expected.contentUnsafe) {
          failures.push(`contentUnsafe: expected ${tc.expected.contentUnsafe}, got ${res.computed.contentUnsafe}`);
        }
      }

      if (failures.length === 0) {
        results.push({ name: tc.name, passed: true, details: 'OK' });
      } else {
        results.push({ name: tc.name, passed: false, details: failures.join('; ') });
      }

      if (verbose) {
        console.log(`  [${failures.length === 0 ? 'PASS' : 'FAIL'}] ${tc.name}`);
        if (failures.length > 0) console.log(`         ${failures.join('\n         ')}`);
      }
    } catch (err) {
      results.push({ name: tc.name, passed: false, details: `Error: ${(err as Error).message}` });
      if (verbose) console.log(`  [ERR ] ${tc.name}: ${(err as Error).message}`);
    }
  }

  return results;
}

// ──────────────────────────────────────────────────────────────────────────────
// Live Circle-IR Scans
// ──────────────────────────────────────────────────────────────────────────────

async function runLiveScans(
  endpoint: string,
  skills: DiscoveredSkills,
  verbose: boolean,
): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // Test 1: GitHub skill (Mode A — repo URL, full code analysis)
  const githubSkill = skills['github'];
  if (githubSkill) {
    if (verbose) console.log(`  Scanning GitHub skill ${githubSkill.slug} (mode=inline)...`);
    try {
      const res = await adminPost(endpoint, `/v1/admin/scan/${githubSkill.id}?mode=inline`);
      const passed = res.success === true && res.jobId;
      results.push({
        name: `Live scan GitHub skill (${githubSkill.slug})`,
        passed,
        details: passed
          ? `jobId=${res.jobId}, findings=${res.findingsCount}, verdict=${res.verdict}`
          : `Unexpected response: ${JSON.stringify(res)}`,
      });
      if (verbose) console.log(`  [${passed ? 'PASS' : 'FAIL'}] Live GitHub scan: findings=${res.findingsCount}, verdict=${res.verdict}`);
    } catch (err) {
      // Timeout is acceptable for GitHub repos (may exceed 60s)
      const msg = (err as Error).message;
      const isTimeout = msg.includes('502') || msg.includes('timeout') || msg.includes('still running');
      results.push({
        name: `Live scan GitHub skill (${githubSkill.slug})`,
        passed: false,
        details: isTimeout ? `Timeout (expected for large repos): ${msg}` : `Error: ${msg}`,
      });
      if (verbose) console.log(`  [${isTimeout ? 'SKIP' : 'FAIL'}] Live GitHub scan: ${msg}`);
    }
  } else {
    results.push({ name: 'Live scan GitHub skill', passed: false, details: 'No GitHub skill discovered' });
  }

  // Test 2: Non-GitHub skill (Mode B — inline files)
  const nonGithubSkill = skills['clawhub'] ?? skills['mcp-registry'];
  if (nonGithubSkill) {
    if (verbose) console.log(`  Scanning non-GitHub skill ${nonGithubSkill.slug} (mode=inline)...`);
    try {
      const res = await adminPost(endpoint, `/v1/admin/scan/${nonGithubSkill.id}?mode=inline`);
      const passed = res.success === true && res.jobId;
      results.push({
        name: `Live scan non-GitHub skill (${nonGithubSkill.slug})`,
        passed,
        details: passed
          ? `jobId=${res.jobId}, findings=${res.findingsCount}, verdict=${res.verdict}`
          : `Unexpected response: ${JSON.stringify(res)}`,
      });
      if (verbose) console.log(`  [${passed ? 'PASS' : 'FAIL'}] Live non-GitHub scan: findings=${res.findingsCount}, verdict=${res.verdict}`);
    } catch (err) {
      results.push({
        name: `Live scan non-GitHub skill (${nonGithubSkill.slug})`,
        passed: false,
        details: `Error: ${(err as Error).message}`,
      });
      if (verbose) console.log(`  [FAIL] Live non-GitHub scan: ${(err as Error).message}`);
    }
  } else {
    results.push({ name: 'Live scan non-GitHub skill', passed: false, details: 'No non-GitHub skill discovered' });
  }

  return results;
}

// ──────────────────────────────────────────────────────────────────────────────
// Restore Skills (clean up after synthetic tests)
// ──────────────────────────────────────────────────────────────────────────────

async function restoreSkills(
  endpoint: string,
  skills: DiscoveredSkills,
  verbose: boolean,
): Promise<void> {
  const skillIds = Object.values(skills).map(s => s.id);
  let restored = 0;

  for (const skillId of skillIds) {
    try {
      await adminPost(endpoint, `/v1/admin/scan-test/${skillId}`, { findings: [] });
      restored++;
    } catch {
      // Best-effort restore
    }
  }

  if (verbose) console.log(`\nRestored ${restored}/${skillIds.length} skills to clean state.`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log(`
+-----------------------------------------------------------+
|     COGNIUM SCAN PIPELINE VERIFICATION                    |
+-----------------------------------------------------------+
`);
  console.log(`Configuration:`);
  console.log(`  Endpoint:   ${opts.endpoint}`);
  console.log(`  Skip live:  ${opts.skipLive}`);
  console.log(`  Verbose:    ${opts.verbose}`);
  console.log();

  // Step 1: Discover skills
  console.log('Discovering skills...');
  const skills = await discoverSkills(opts.endpoint);
  const discovered = Object.entries(skills);

  if (discovered.length === 0) {
    console.error('ERROR: No skills discovered. Is the endpoint reachable?');
    process.exit(1);
  }

  for (const [source, skill] of discovered) {
    console.log(`  ${source.padEnd(15)} ${skill!.id.slice(0, 8)}... (${skill!.slug})`);
  }
  console.log();

  // Step 2: Synthetic scoring tests
  console.log('Running synthetic scoring tests...');
  const syntheticResults = await runSyntheticTests(opts.endpoint, skills, opts.verbose);
  if (!opts.verbose) {
    for (const r of syntheticResults) {
      console.log(`  [${r.passed ? 'PASS' : 'FAIL'}] ${r.name}${r.passed ? '' : ` — ${r.details}`}`);
    }
  }
  console.log();

  // Step 3: Live Circle-IR scans (optional)
  let liveResults: TestResult[] = [];
  if (!opts.skipLive) {
    console.log('Running live Circle-IR scans...');
    liveResults = await runLiveScans(opts.endpoint, skills, opts.verbose);
    if (!opts.verbose) {
      for (const r of liveResults) {
        console.log(`  [${r.passed ? 'PASS' : 'FAIL'}] ${r.name}${r.passed ? '' : ` — ${r.details}`}`);
      }
    }
    console.log();
  }

  // Step 4: Restore skills
  console.log('Restoring skills to clean state...');
  await restoreSkills(opts.endpoint, skills, opts.verbose);
  console.log();

  // Summary
  const allResults = [...syntheticResults, ...liveResults];
  const passed = allResults.filter(r => r.passed).length;
  const failed = allResults.filter(r => !r.passed).length;
  const total = allResults.length;

  console.log(`+-----------------------------------------------------------+`);
  console.log(`|  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`.padEnd(60) + `|`);
  console.log(`+-----------------------------------------------------------+`);

  if (failed > 0) {
    console.log(`\nFailed tests:`);
    for (const r of allResults.filter(r => !r.passed)) {
      console.log(`  - ${r.name}: ${r.details}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
