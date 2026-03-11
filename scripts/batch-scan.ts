#!/usr/bin/env tsx
// ══════════════════════════════════════════════════════════════════════════════
// Batch Scan — Submit skills to Cognium via the admin scan endpoint
// ══════════════════════════════════════════════════════════════════════════════
//
// Usage:
//   npx tsx scripts/batch-scan.ts --limit 10 --verbose
//   npx tsx scripts/batch-scan.ts --limit 10 --source github
//   npx tsx scripts/batch-scan.ts --limit 0   # all skills
//   npx tsx scripts/batch-scan.ts --status     # check scan status only
//
// ══════════════════════════════════════════════════════════════════════════════

import { Pool } from '@neondatabase/serverless';
import * as fs from 'fs';
import * as path from 'path';

// ── Config ───────────────────────────────────────────────────────────────────

interface Options {
  endpoint: string;
  adminKey: string;
  limit: number;
  source: string | null;   // filter by source
  mode: 'queue' | 'inline';
  verbose: boolean;
  statusOnly: boolean;
  concurrency: number;
  delayMs: number;         // delay between submissions
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const opts: Options = {
    endpoint: process.env.RUNICS_ENDPOINT ?? 'https://runics.phantoms.workers.dev',
    adminKey: process.env.ADMIN_API_KEY ?? '',
    limit: 10,
    source: null,
    mode: 'queue',
    verbose: false,
    statusOnly: false,
    concurrency: 1,
    delayMs: 500,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--endpoint': case '-e': opts.endpoint = args[++i]; break;
      case '--admin-key': case '-k': opts.adminKey = args[++i]; break;
      case '--limit': case '-n': opts.limit = parseInt(args[++i], 10); break;
      case '--source': case '-s': opts.source = args[++i]; break;
      case '--mode': case '-m': opts.mode = args[++i] as 'queue' | 'inline'; break;
      case '--verbose': case '-v': opts.verbose = true; break;
      case '--status': opts.statusOnly = true; break;
      case '--concurrency': case '-c': opts.concurrency = parseInt(args[++i], 10); break;
      case '--delay': case '-d': opts.delayMs = parseInt(args[++i], 10); break;
      case '--help': case '-h':
        console.log(`
Batch Scan — Submit skills to Cognium

Usage:
  npx tsx scripts/batch-scan.ts [options]

Options:
  --endpoint, -e <url>     Target endpoint (default: production)
  --admin-key, -k <key>    Admin API key (or ADMIN_API_KEY env var)
  --limit, -n <count>      Max skills to scan (default: 10, 0 = all)
  --source, -s <source>    Filter by source (github, mcp-registry, clawhub)
  --mode, -m <mode>        'queue' (async, default) or 'inline' (sync)
  --verbose, -v            Show detailed output
  --status                 Just show current scan coverage, don't submit
  --concurrency, -c <n>    Parallel submissions (default: 1)
  --delay, -d <ms>         Delay between submissions (default: 500ms)
  --help, -h               Show this help
`);
        process.exit(0);
    }
  }

  // Auto-read admin key from wrangler.toml secrets won't work — it's a secret.
  // Must be provided via env or CLI.

  return opts;
}

// ── DB Connection ────────────────────────────────────────────────────────────

function getDbUrl(): string {
  let dbUrl = process.env.DATABASE_URL ?? process.env.NEON_CONNECTION_STRING;
  if (!dbUrl) {
    try {
      const toml = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'wrangler.toml'), 'utf-8');
      const match = toml.match(/NEON_CONNECTION_STRING\s*=\s*"([^"]+)"/);
      if (match) dbUrl = match[1];
    } catch { /* ignore */ }
  }
  if (!dbUrl) {
    console.error('ERROR: No database URL found. Set NEON_CONNECTION_STRING or DATABASE_URL.');
    process.exit(1);
  }
  return dbUrl;
}

// ── Status Report ────────────────────────────────────────────────────────────

async function showStatus(pool: Pool) {
  const result = await pool.query(`
    SELECT
      source,
      count(*) as total,
      count(CASE WHEN scan_coverage IS NOT NULL THEN 1 END) as scanned_by_cognium,
      count(CASE WHEN cognium_job_id IS NOT NULL THEN 1 END) as in_flight,
      count(CASE WHEN status = 'revoked' THEN 1 END) as revoked,
      count(CASE WHEN status = 'vulnerable' THEN 1 END) as vulnerable,
      count(CASE WHEN status = 'published' THEN 1 END) as published
    FROM skills
    WHERE source IN ('github', 'mcp-registry', 'clawhub')
    GROUP BY source
    ORDER BY source
  `);

  console.log('\n=== Scan Coverage ===');
  console.table(result.rows);

  // Recent scan activity
  const recent = await pool.query(`
    SELECT id, slug, source, status, trust_score, verification_tier, scan_coverage,
           cognium_job_id, cognium_job_submitted_at
    FROM skills
    WHERE cognium_job_submitted_at IS NOT NULL
    ORDER BY cognium_job_submitted_at DESC
    LIMIT 10
  `);

  if (recent.rows.length > 0) {
    console.log('\n=== Recent Scan Activity (last 10) ===');
    for (const r of recent.rows) {
      const age = r.cognium_job_submitted_at
        ? `${Math.round((Date.now() - new Date(r.cognium_job_submitted_at).getTime()) / 60000)}m ago`
        : 'N/A';
      console.log(
        `  ${r.slug.padEnd(40)} ${r.source.padEnd(14)} ` +
        `status=${r.status.padEnd(12)} trust=${r.trust_score ?? 'N/A'} ` +
        `tier=${(r.verification_tier ?? 'N/A').padEnd(10)} ` +
        `coverage=${r.scan_coverage ?? 'N/A'} ` +
        `job=${r.cognium_job_id ? 'in-flight' : 'done'} (${age})`
      );
    }
  }
}

// ── Fetch Skills to Scan ─────────────────────────────────────────────────────

interface SkillToScan {
  id: string;
  slug: string;
  source: string;
  status: string;
}

async function fetchSkillsToScan(pool: Pool, opts: Options): Promise<SkillToScan[]> {
  const conditions: string[] = [
    "source IN ('github', 'mcp-registry', 'clawhub')",
    "cognium_job_id IS NULL",   // skip in-flight
    "status != 'revoked'",      // skip already revoked
  ];
  const params: any[] = [];

  if (opts.source) {
    params.push(opts.source);
    conditions.push(`source = $${params.length}`);
  }

  const where = conditions.join(' AND ');
  const limitClause = opts.limit > 0 ? `LIMIT ${opts.limit}` : '';

  // Pick a balanced mix: interleave sources using row_number partitioning
  const query = `
    WITH ranked AS (
      SELECT id, slug, source, status,
             ROW_NUMBER() OVER (PARTITION BY source ORDER BY random()) AS rn
      FROM skills
      WHERE ${where}
    )
    SELECT id, slug, source, status
    FROM ranked
    ORDER BY rn, source
    ${limitClause}
  `;

  const result = await pool.query(query, params);
  return result.rows;
}

// ── Submit Scan ──────────────────────────────────────────────────────────────

interface ScanResult {
  skillId: string;
  slug: string;
  source: string;
  success: boolean;
  message: string;
  jobId?: string;
}

async function submitScan(
  endpoint: string,
  skillId: string,
  mode: 'queue' | 'inline',
  adminKey: string,
): Promise<any> {
  const url = `${endpoint}/v1/admin/scan/${skillId}?mode=${mode}&force=true`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (adminKey) headers['Authorization'] = `Bearer ${adminKey}`;

  const res = await fetch(url, { method: 'POST', headers });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }

  return res.json();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const pool = new Pool({ connectionString: getDbUrl() });

  console.log(`
+-----------------------------------------------------------+
|     COGNIUM BATCH SCAN                                    |
+-----------------------------------------------------------+
`);

  if (opts.statusOnly) {
    await showStatus(pool);
    await pool.end();
    process.exit(0);
  }

  if (!opts.adminKey) {
    console.error('ERROR: Admin API key required. Use --admin-key or set ADMIN_API_KEY env var.');
    await pool.end();
    process.exit(1);
  }

  // Show current status first
  await showStatus(pool);
  console.log();

  // Fetch skills to scan
  console.log(`Fetching skills to scan (limit=${opts.limit || 'ALL'}, source=${opts.source || 'all'})...`);
  const skills = await fetchSkillsToScan(pool, opts);

  if (skills.length === 0) {
    console.log('No skills to scan.');
    await pool.end();
    process.exit(0);
  }

  // Show breakdown
  const bySrc: Record<string, number> = {};
  for (const s of skills) bySrc[s.source] = (bySrc[s.source] || 0) + 1;
  console.log(`Found ${skills.length} skills:`);
  for (const [src, cnt] of Object.entries(bySrc)) {
    console.log(`  ${src.padEnd(15)} ${cnt}`);
  }
  console.log();

  // Submit scans
  console.log(`Submitting scans (mode=${opts.mode}, concurrency=${opts.concurrency}, delay=${opts.delayMs}ms)...`);
  const results: ScanResult[] = [];
  let submitted = 0;
  let failed = 0;

  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i];

    try {
      const res = await submitScan(opts.endpoint, skill.id, opts.mode, opts.adminKey);
      submitted++;
      results.push({
        skillId: skill.id,
        slug: skill.slug,
        source: skill.source,
        success: true,
        message: res.mode === 'queue' ? 'enqueued' : `findings=${res.findingsCount}`,
        jobId: res.jobId,
      });

      if (opts.verbose) {
        console.log(`  [${submitted}/${skills.length}] ${skill.slug} (${skill.source}) → ${res.mode === 'queue' ? 'enqueued' : `done, findings=${res.findingsCount}`}`);
      } else {
        process.stdout.write(`\r  Submitted ${submitted}/${skills.length}...`);
      }
    } catch (err) {
      failed++;
      results.push({
        skillId: skill.id,
        slug: skill.slug,
        source: skill.source,
        success: false,
        message: (err as Error).message,
      });
      if (opts.verbose) {
        console.log(`  [FAIL] ${skill.slug} (${skill.source}): ${(err as Error).message}`);
      }
    }

    // Rate limiting delay
    if (i < skills.length - 1 && opts.delayMs > 0) {
      await new Promise(r => setTimeout(r, opts.delayMs));
    }
  }

  if (!opts.verbose) console.log(); // clear \r line

  // Summary
  console.log();
  console.log(`+-----------------------------------------------------------+`);
  console.log(`|  Submitted: ${submitted}/${skills.length}  Failed: ${failed}`.padEnd(60) + `|`);
  console.log(`+-----------------------------------------------------------+`);

  if (failed > 0) {
    console.log(`\nFailed submissions:`);
    for (const r of results.filter(r => !r.success)) {
      console.log(`  - ${r.slug} (${r.source}): ${r.message}`);
    }
  }

  if (opts.mode === 'queue') {
    console.log(`\nScans enqueued. Monitor progress with:`);
    console.log(`  npx tsx scripts/batch-scan.ts --status`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
