#!/usr/bin/env tsx
// ══════════════════════════════════════════════════════════════════════════════
// Eval Suite CLI Runner
// ══════════════════════════════════════════════════════════════════════════════
//
// Usage:
//   npm run eval
//   npm run eval -- --endpoint http://localhost:8787/v1/search
//   npm run eval -- --tenant my-tenant --verbose
//
// ══════════════════════════════════════════════════════════════════════════════

import { runEvalSuite, formatSummary, formatFailedQueries } from '../src/eval/runner';
import { getFixtureStats } from '../src/eval/fixtures';

// ──────────────────────────────────────────────────────────────────────────────
// Parse CLI Arguments
// ──────────────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);

  const options = {
    endpoint: 'http://localhost:8787/v1/search',
    tenantId: 'eval-tenant',
    limit: 10,
    verbose: false,
    showFailed: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--endpoint':
      case '-e':
        options.endpoint = args[++i];
        break;
      case '--tenant':
      case '-t':
        options.tenantId = args[++i];
        break;
      case '--limit':
      case '-l':
        options.limit = parseInt(args[++i]);
        break;
      case '--verbose':
      case '-v':
        options.verbose = true;
        break;
      case '--show-failed':
      case '-f':
        options.showFailed = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        printHelp();
        process.exit(1);
    }
  }

  return options;
}

function printHelp() {
  console.log(`
Runics Search — Eval Suite CLI Runner

Usage:
  npm run eval [options]

Options:
  -e, --endpoint <url>    Search endpoint URL (default: http://localhost:8787/v1/search)
  -t, --tenant <id>       Tenant ID to use (default: eval-tenant)
  -l, --limit <n>         Max results per query (default: 10)
  -v, --verbose           Show progress during execution
  -f, --show-failed       Show detailed report of failed queries
  -h, --help              Show this help message

Examples:
  npm run eval
  npm run eval -- --verbose
  npm run eval -- --endpoint https://runics-search.workers.dev/v1/search
  npm run eval -- --tenant prod-tenant --show-failed
`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs();

  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║         RUNICS SEARCH — EVAL SUITE RUNNER            ║');
  console.log('╚═══════════════════════════════════════════════════════╝');

  // Show fixture stats
  const stats = getFixtureStats();
  console.log('\nFixture Stats:');
  console.log(`  Total:          ${stats.total}`);
  console.log(`  Unique skills:  ${stats.uniqueSkills}`);
  console.log(`  By pattern:`);
  for (const [pattern, count] of Object.entries(stats.byPattern)) {
    console.log(`    ${pattern.padEnd(12)} ${count}`);
  }

  console.log('\nConfiguration:');
  console.log(`  Endpoint:       ${options.endpoint}`);
  console.log(`  Tenant ID:      ${options.tenantId}`);
  console.log(`  Limit:          ${options.limit}`);
  console.log(`  Verbose:        ${options.verbose}`);

  // Run eval suite
  try {
    const result = await runEvalSuite(
      options.endpoint,
      options.tenantId,
      {
        limit: options.limit,
        verbose: options.verbose,
      }
    );

    // Print summary
    console.log(formatSummary(result));

    // Print failed queries if requested
    if (options.showFailed && result.failed > 0) {
      console.log(formatFailedQueries(result));
    }

    // Exit code based on success
    const successRate = result.passed / result.fixtureCount;
    if (successRate < 0.5) {
      console.log('\n❌ Eval failed: success rate < 50%');
      process.exit(1);
    } else if (successRate < 0.8) {
      console.log('\n⚠️  Eval passed with warnings: success rate < 80%');
      process.exit(0);
    } else {
      console.log('\n✅ Eval passed: success rate >= 80%');
      process.exit(0);
    }
  } catch (error) {
    console.error('\n❌ Eval suite failed:');
    console.error((error as Error).message);
    console.error((error as Error).stack);
    process.exit(1);
  }
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
