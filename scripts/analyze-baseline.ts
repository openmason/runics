#!/usr/bin/env tsx
// ══════════════════════════════════════════════════════════════════════════════
// Baseline Analysis Script
// ══════════════════════════════════════════════════════════════════════════════
//
// Analyzes eval results and recommends confidence threshold adjustments.
//
// Usage:
//   npm run analyze-baseline
//   npm run analyze-baseline -- --endpoint http://localhost:8787/v1/search
//
// This script:
// 1. Runs eval suite
// 2. Analyzes score distribution
// 3. Recommends tier thresholds based on actual data
// 4. Generates BASELINE.md with results
//
// ══════════════════════════════════════════════════════════════════════════════

import { runEvalSuite, type EvalRunResult } from '../src/eval/runner';
import { getFixtureStats } from '../src/eval/fixtures';
import { writeFileSync } from 'fs';

// ──────────────────────────────────────────────────────────────────────────────
// Parse CLI Arguments
// ──────────────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);

  const options = {
    endpoint: 'http://localhost:8787/v1/search',
    tenantId: 'eval-tenant',
    limit: 10,
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
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
    }
  }

  return options;
}

function printHelp() {
  console.log(`
Runics Search — Baseline Analysis

Runs eval suite, analyzes results, and recommends threshold adjustments.

Usage:
  npm run analyze-baseline [options]

Options:
  -e, --endpoint <url>    Search endpoint URL (default: http://localhost:8787/v1/search)
  -t, --tenant <id>       Tenant ID (default: eval-tenant)
  -h, --help              Show this help message

Output:
  - Console report with analysis
  - BASELINE.md file with documented results
`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Score Distribution Analysis
// ──────────────────────────────────────────────────────────────────────────────

interface ScoreDistribution {
  min: number;
  max: number;
  mean: number;
  median: number;
  p25: number;
  p75: number;
  p90: number;
  p95: number;
}

function analyzeScoreDistribution(result: EvalRunResult): ScoreDistribution {
  const topScores = result.results
    .map((r) => r.response.results[0]?.score ?? 0)
    .filter((score) => score > 0)
    .sort((a, b) => a - b);

  if (topScores.length === 0) {
    return { min: 0, max: 0, mean: 0, median: 0, p25: 0, p75: 0, p90: 0, p95: 0 };
  }

  const min = topScores[0];
  const max = topScores[topScores.length - 1];
  const mean = topScores.reduce((sum, s) => sum + s, 0) / topScores.length;

  const percentile = (p: number) => {
    const index = Math.floor((p / 100) * topScores.length);
    return topScores[Math.min(index, topScores.length - 1)];
  };

  return {
    min,
    max,
    mean,
    median: percentile(50),
    p25: percentile(25),
    p75: percentile(75),
    p90: percentile(90),
    p95: percentile(95),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Threshold Recommendations
// ──────────────────────────────────────────────────────────────────────────────

interface ThresholdRecommendation {
  current: { tier1: number; tier2: number };
  recommended: { tier1: number; tier2: number };
  reasoning: string[];
}

function recommendThresholds(
  result: EvalRunResult,
  distribution: ScoreDistribution
): ThresholdRecommendation {
  const reasoning: string[] = [];

  // Current thresholds (assumed defaults)
  const currentTier1 = 0.85;
  const currentTier2 = 0.70;

  // Calculate tier distribution percentages
  const total = result.metrics.tierDistribution[1] +
                result.metrics.tierDistribution[2] +
                result.metrics.tierDistribution[3];
  const tier1Pct = (result.metrics.tierDistribution[1] / total) * 100;
  const tier3Pct = (result.metrics.tierDistribution[3] / total) * 100;

  // Start with current thresholds
  let recommendedTier1 = currentTier1;
  let recommendedTier2 = currentTier2;

  // Rule 1: If Tier 3 > 15%, thresholds too high
  if (tier3Pct > 15) {
    reasoning.push(`Tier 3 is ${tier3Pct.toFixed(1)}% (target <10%) — thresholds too conservative`);

    // Lower thresholds based on score distribution
    // Aim for tier1 threshold around p75-p80
    recommendedTier1 = Math.max(0.70, distribution.p75 - 0.05);
    recommendedTier2 = Math.max(0.55, distribution.median - 0.05);

    reasoning.push(`Recommend lowering Tier 1 to ${recommendedTier1.toFixed(2)} (near p75: ${distribution.p75.toFixed(2)})`);
    reasoning.push(`Recommend lowering Tier 2 to ${recommendedTier2.toFixed(2)} (near median: ${distribution.median.toFixed(2)})`);
  }
  // Rule 2: If Tier 1 < 60%, thresholds too high
  else if (tier1Pct < 60) {
    reasoning.push(`Tier 1 is ${tier1Pct.toFixed(1)}% (target ~70%) — thresholds too high`);

    recommendedTier1 = Math.max(0.70, distribution.p75);
    recommendedTier2 = Math.max(0.55, distribution.median);

    reasoning.push(`Recommend lowering Tier 1 to ${recommendedTier1.toFixed(2)}`);
    reasoning.push(`Recommend lowering Tier 2 to ${recommendedTier2.toFixed(2)}`);
  }
  // Rule 3: If Tier 1 > 85% and recall < 85%, thresholds too low
  else if (tier1Pct > 85 && result.metrics.recall5 < 0.85) {
    reasoning.push(`Tier 1 is ${tier1Pct.toFixed(1)}% (target ~70%) but recall is only ${(result.metrics.recall5 * 100).toFixed(1)}%`);
    reasoning.push(`Thresholds may be too low — accepting low-quality results as high confidence`);

    recommendedTier1 = Math.min(0.90, distribution.p90);
    recommendedTier2 = Math.min(0.80, distribution.p75);

    reasoning.push(`Recommend raising Tier 1 to ${recommendedTier1.toFixed(2)}`);
    reasoning.push(`Recommend raising Tier 2 to ${recommendedTier2.toFixed(2)}`);
  }
  // Rule 4: Thresholds look good
  else {
    reasoning.push(`Tier distribution looks good (Tier 1: ${tier1Pct.toFixed(1)}%, Tier 3: ${tier3Pct.toFixed(1)}%)`);
    reasoning.push(`Current thresholds are appropriate for this dataset`);
    reasoning.push(`Consider minor adjustments based on production monitoring`);
  }

  return {
    current: { tier1: currentTier1, tier2: currentTier2 },
    recommended: { tier1: recommendedTier1, tier2: recommendedTier2 },
    reasoning,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Generate BASELINE.md
// ──────────────────────────────────────────────────────────────────────────────

function generateBaselineDoc(
  result: EvalRunResult,
  distribution: ScoreDistribution,
  thresholds: ThresholdRecommendation,
  endpoint: string
): string {
  const fixtureStats = getFixtureStats();
  const date = new Date().toISOString().split('T')[0];

  const lines: string[] = [];

  lines.push('# Runics Search — Phase 1 Baseline');
  lines.push('');
  lines.push(`**Date:** ${date}`);
  lines.push(`**Run ID:** ${result.runId}`);
  lines.push(`**Endpoint:** ${endpoint}`);
  lines.push('');

  // Overall Performance
  lines.push('## Overall Performance');
  lines.push('');
  lines.push('| Metric | Value | Target | Status |');
  lines.push('|--------|-------|--------|--------|');
  lines.push(`| Recall@1 | ${(result.metrics.recall1 * 100).toFixed(1)}% | - | - |`);
  lines.push(`| Recall@5 | ${(result.metrics.recall5 * 100).toFixed(1)}% | ≥70% | ${result.metrics.recall5 >= 0.70 ? '✅' : '❌'} |`);
  lines.push(`| MRR | ${result.metrics.mrr.toFixed(3)} | ≥0.65 | ${result.metrics.mrr >= 0.65 ? '✅' : '❌'} |`);
  lines.push(`| Avg Top Score | ${result.metrics.avgTopScore.toFixed(3)} | - | - |`);
  lines.push('');

  // Tier Distribution
  const total = result.metrics.tierDistribution[1] +
                result.metrics.tierDistribution[2] +
                result.metrics.tierDistribution[3];
  const tier1Pct = (result.metrics.tierDistribution[1] / total) * 100;
  const tier2Pct = (result.metrics.tierDistribution[2] / total) * 100;
  const tier3Pct = (result.metrics.tierDistribution[3] / total) * 100;

  lines.push('## Tier Distribution');
  lines.push('');
  lines.push('| Tier | Count | Percentage | Target | Status |');
  lines.push('|------|-------|------------|--------|--------|');
  lines.push(`| Tier 1 (High) | ${result.metrics.tierDistribution[1]} | ${tier1Pct.toFixed(1)}% | ~70% | ${tier1Pct >= 60 ? '✅' : '❌'} |`);
  lines.push(`| Tier 2 (Med) | ${result.metrics.tierDistribution[2]} | ${tier2Pct.toFixed(1)}% | ~20% | - |`);
  lines.push(`| Tier 3 (Low) | ${result.metrics.tierDistribution[3]} | ${tier3Pct.toFixed(1)}% | ~10% | ${tier3Pct <= 15 ? '✅' : '⚠️'} |`);
  lines.push('');

  // Score Distribution
  lines.push('## Score Distribution');
  lines.push('');
  lines.push('| Percentile | Score |');
  lines.push('|------------|-------|');
  lines.push(`| Min | ${distribution.min.toFixed(3)} |`);
  lines.push(`| P25 | ${distribution.p25.toFixed(3)} |`);
  lines.push(`| Median (P50) | ${distribution.median.toFixed(3)} |`);
  lines.push(`| Mean | ${distribution.mean.toFixed(3)} |`);
  lines.push(`| P75 | ${distribution.p75.toFixed(3)} |`);
  lines.push(`| P90 | ${distribution.p90.toFixed(3)} |`);
  lines.push(`| P95 | ${distribution.p95.toFixed(3)} |`);
  lines.push(`| Max | ${distribution.max.toFixed(3)} |`);
  lines.push('');

  // Per-Pattern Breakdown
  lines.push('## Per-Pattern Performance');
  lines.push('');
  lines.push('| Pattern | Recall@5 | MRR |');
  lines.push('|---------|----------|-----|');
  const patterns = Object.keys(result.metrics.byPattern).sort();
  for (const pattern of patterns) {
    const metrics = result.metrics.byPattern[pattern];
    lines.push(`| ${pattern} | ${(metrics.recall5 * 100).toFixed(1)}% | ${metrics.mrr.toFixed(3)} |`);
  }
  lines.push('');

  // Threshold Recommendations
  lines.push('## Confidence Threshold Analysis');
  lines.push('');
  lines.push('### Current Thresholds');
  lines.push('');
  lines.push('```toml');
  lines.push('CONFIDENCE_TIER1_THRESHOLD = "' + thresholds.current.tier1.toFixed(2) + '"');
  lines.push('CONFIDENCE_TIER2_THRESHOLD = "' + thresholds.current.tier2.toFixed(2) + '"');
  lines.push('```');
  lines.push('');
  lines.push('### Recommended Thresholds');
  lines.push('');
  lines.push('```toml');
  lines.push('CONFIDENCE_TIER1_THRESHOLD = "' + thresholds.recommended.tier1.toFixed(2) + '"');
  lines.push('CONFIDENCE_TIER2_THRESHOLD = "' + thresholds.recommended.tier2.toFixed(2) + '"');
  lines.push('```');
  lines.push('');
  lines.push('### Reasoning');
  lines.push('');
  for (const reason of thresholds.reasoning) {
    lines.push(`- ${reason}`);
  }
  lines.push('');

  // Failed Queries
  const failed = result.results.filter(r => !r.foundInTop5);
  if (failed.length > 0) {
    lines.push('## Failed Queries');
    lines.push('');
    lines.push(`${failed.length} queries failed (not found in top 5):`);
    lines.push('');

    const failedByPattern: Record<string, number> = {};
    for (const f of failed) {
      const pattern = f.fixture.pattern;
      failedByPattern[pattern] = (failedByPattern[pattern] || 0) + 1;
    }

    lines.push('### By Pattern');
    lines.push('');
    for (const [pattern, count] of Object.entries(failedByPattern)) {
      lines.push(`- **${pattern}**: ${count} failed`);
    }
    lines.push('');

    lines.push('### Sample Failed Queries');
    lines.push('');
    for (let i = 0; i < Math.min(5, failed.length); i++) {
      const f = failed[i];
      lines.push(`**${i + 1}. ${f.fixture.pattern}**`);
      lines.push(`- Query: "${f.fixture.query}"`);
      lines.push(`- Expected: ${f.fixture.expectedSkillId}`);
      lines.push(`- Rank: ${f.correctSkillRank ?? 'Not found'}`);
      lines.push(`- Tier: ${f.response.meta.tier}`);
      if (f.response.results[0]) {
        lines.push(`- Top result: ${f.response.results[0].name} (score: ${f.response.results[0].score.toFixed(3)})`);
      }
      lines.push('');
    }
  }

  // Test Fixture Stats
  lines.push('## Test Fixtures');
  lines.push('');
  lines.push(`- **Total:** ${fixtureStats.total}`);
  lines.push(`- **Unique Skills:** ${fixtureStats.uniqueSkills}`);
  lines.push('');
  lines.push('### By Pattern');
  lines.push('');
  for (const [pattern, count] of Object.entries(fixtureStats.byPattern)) {
    lines.push(`- ${pattern}: ${count}`);
  }
  lines.push('');

  // Phase 1 Exit Criteria
  lines.push('## Phase 1 Exit Criteria');
  lines.push('');
  const recall5Pass = result.metrics.recall5 >= 0.70;
  const mrrPass = result.metrics.mrr >= 0.65;
  const tier1Pass = tier1Pct >= 60;

  lines.push(`- ✅ Baseline measured: ${date}`);
  lines.push(`- ${recall5Pass ? '✅' : '❌'} Recall@5 ≥ 70%: ${(result.metrics.recall5 * 100).toFixed(1)}%`);
  lines.push(`- ${mrrPass ? '✅' : '❌'} MRR ≥ 0.65: ${result.metrics.mrr.toFixed(3)}`);
  lines.push(`- ${tier1Pass ? '✅' : '❌'} Tier 1 ≥ 60%: ${tier1Pct.toFixed(1)}%`);
  lines.push('');

  if (recall5Pass && mrrPass && tier1Pass) {
    lines.push('**Status:** ✅ Phase 1 baseline meets all targets. Ready for Phase 2.');
  } else {
    lines.push('**Status:** ⚠️ Baseline needs improvement before Phase 2.');
  }
  lines.push('');

  // Next Steps
  lines.push('## Next Steps');
  lines.push('');
  if (thresholds.recommended.tier1 !== thresholds.current.tier1) {
    lines.push('### 1. Adjust Thresholds');
    lines.push('');
    lines.push('Update `wrangler.toml` with recommended thresholds and redeploy:');
    lines.push('');
    lines.push('```bash');
    lines.push('# Edit wrangler.toml');
    lines.push('npm run deploy');
    lines.push('npm run eval -- --verbose');
    lines.push('```');
    lines.push('');
  }

  lines.push('### 2. Analyze Failed Queries');
  lines.push('');
  lines.push('Review failed queries to identify patterns:');
  lines.push('- Vocabulary gaps (terminology not in skill descriptions)');
  lines.push('- Multi-word concepts (embeddings miss compound terms)');
  lines.push('- Domain-specific jargon');
  lines.push('');

  lines.push('### 3. Move to Phase 2');
  lines.push('');
  lines.push('Implement intelligence layer:');
  lines.push('- Confidence gating (3-tier routing)');
  lines.push('- LLM deep search (Tier 3)');
  lines.push('- Async enrichment (Tier 2)');
  lines.push('- Composition detection');
  lines.push('');

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs();

  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║      RUNICS SEARCH — BASELINE ANALYSIS               ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');

  // Run eval suite
  console.log('📊 Running eval suite...');
  console.log('');

  const result = await runEvalSuite(options.endpoint, options.tenantId, {
    limit: options.limit,
    verbose: true,
  });

  console.log('');

  // Analyze score distribution
  console.log('📈 Analyzing score distribution...');
  const distribution = analyzeScoreDistribution(result);

  console.log('');
  console.log('Score Distribution:');
  console.log(`  Min:     ${distribution.min.toFixed(3)}`);
  console.log(`  P25:     ${distribution.p25.toFixed(3)}`);
  console.log(`  Median:  ${distribution.median.toFixed(3)}`);
  console.log(`  Mean:    ${distribution.mean.toFixed(3)}`);
  console.log(`  P75:     ${distribution.p75.toFixed(3)}`);
  console.log(`  P90:     ${distribution.p90.toFixed(3)}`);
  console.log(`  P95:     ${distribution.p95.toFixed(3)}`);
  console.log(`  Max:     ${distribution.max.toFixed(3)}`);
  console.log('');

  // Recommend thresholds
  console.log('🎯 Recommending confidence thresholds...');
  const thresholds = recommendThresholds(result, distribution);

  console.log('');
  console.log('Threshold Analysis:');
  console.log(`  Current Tier 1:     ${thresholds.current.tier1.toFixed(2)}`);
  console.log(`  Recommended Tier 1: ${thresholds.recommended.tier1.toFixed(2)}`);
  console.log(`  Current Tier 2:     ${thresholds.current.tier2.toFixed(2)}`);
  console.log(`  Recommended Tier 2: ${thresholds.recommended.tier2.toFixed(2)}`);
  console.log('');
  console.log('Reasoning:');
  for (const reason of thresholds.reasoning) {
    console.log(`  - ${reason}`);
  }
  console.log('');

  // Generate BASELINE.md
  console.log('📝 Generating BASELINE.md...');
  const baselineDoc = generateBaselineDoc(result, distribution, thresholds, options.endpoint);
  writeFileSync('BASELINE.md', baselineDoc);
  console.log('✅ BASELINE.md written');
  console.log('');

  // Exit criteria check
  const total = result.metrics.tierDistribution[1] +
                result.metrics.tierDistribution[2] +
                result.metrics.tierDistribution[3];
  const tier1Pct = (result.metrics.tierDistribution[1] / total) * 100;

  const recall5Pass = result.metrics.recall5 >= 0.70;
  const mrrPass = result.metrics.mrr >= 0.65;
  const tier1Pass = tier1Pct >= 60;

  console.log('═══════════════════════════════════════════════════════');
  console.log('  PHASE 1 EXIT CRITERIA');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
  console.log(`${recall5Pass ? '✅' : '❌'} Recall@5 ≥ 70%: ${(result.metrics.recall5 * 100).toFixed(1)}%`);
  console.log(`${mrrPass ? '✅' : '❌'} MRR ≥ 0.65: ${result.metrics.mrr.toFixed(3)}`);
  console.log(`${tier1Pass ? '✅' : '❌'} Tier 1 ≥ 60%: ${tier1Pct.toFixed(1)}%`);
  console.log('');

  if (recall5Pass && mrrPass && tier1Pass) {
    console.log('✅ Phase 1 baseline meets all targets!');
    console.log('');
    console.log('Next: Review BASELINE.md and move to Phase 2');
    process.exit(0);
  } else {
    console.log('⚠️  Baseline needs improvement before Phase 2');
    console.log('');
    console.log('Actions:');
    if (thresholds.recommended.tier1 !== thresholds.current.tier1) {
      console.log('  1. Update thresholds in wrangler.toml');
      console.log('  2. Redeploy and re-run eval');
    }
    console.log('  3. Review failed queries in BASELINE.md');
    console.log('  4. Consider improving agent summaries');
    process.exit(1);
  }
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
