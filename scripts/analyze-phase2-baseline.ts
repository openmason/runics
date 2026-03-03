#!/usr/bin/env tsx
// ══════════════════════════════════════════════════════════════════════════════
// Phase 2 Baseline Analysis — Score Distribution & Threshold Derivation
// ══════════════════════════════════════════════════════════════════════════════
//
// Runs the eval fixtures against the search endpoint and analyzes:
// 1. Score distribution of correct matches vs noise
// 2. Gap analysis between correct and best-wrong scores
// 3. Derives optimal TIER1 and TIER2 threshold values
// 4. Outputs recommended configuration for wrangler.toml
//
// Usage:
//   npx tsx scripts/analyze-phase2-baseline.ts
//   npx tsx scripts/analyze-phase2-baseline.ts --endpoint http://localhost:8787
//
// ══════════════════════════════════════════════════════════════════════════════

import { evalFixtures } from '../src/eval/fixtures';
import type { FindSkillResponse } from '../src/types';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

interface QueryAnalysis {
  fixtureId: string;
  query: string;
  pattern: string;
  expectedSkillId: string;
  tier: 1 | 2 | 3;
  correctScore: number | null;      // score of the expected skill (null if not found)
  bestWrongScore: number | null;     // highest score of a wrong skill
  gap: number | null;                // correctScore - bestWrongScore
  correctRank: number | null;        // rank of correct skill
  topScore: number;                  // highest score overall
  resultCount: number;
  latencyMs: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// CLI Args
// ──────────────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    endpoint: 'http://localhost:8787/v1/search',
    tenantId: 'eval-tenant',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--endpoint':
      case '-e':
        options.endpoint = args[++i];
        if (!options.endpoint.endsWith('/v1/search')) {
          options.endpoint = options.endpoint.replace(/\/$/, '') + '/v1/search';
        }
        break;
      case '--tenant':
      case '-t':
        options.tenantId = args[++i];
        break;
    }
  }

  return options;
}

// ──────────────────────────────────────────────────────────────────────────────
// Execute Query
// ──────────────────────────────────────────────────────────────────────────────

async function executeQuery(
  endpoint: string,
  query: string,
  tenantId: string
): Promise<FindSkillResponse> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, tenantId, limit: 10 }),
  });

  if (!response.ok) {
    throw new Error(`Search request failed: ${response.status}`);
  }

  return (await response.json()) as FindSkillResponse;
}

// ──────────────────────────────────────────────────────────────────────────────
// Percentile Helper
// ──────────────────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ──────────────────────────────────────────────────────────────────────────────
// Main Analysis
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs();

  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║    PHASE 2 BASELINE — SCORE DISTRIBUTION ANALYSIS    ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log(`\nEndpoint: ${options.endpoint}`);
  console.log(`Fixtures: ${evalFixtures.length}\n`);

  const analyses: QueryAnalysis[] = [];
  let errors = 0;

  for (let i = 0; i < evalFixtures.length; i++) {
    const fixture = evalFixtures[i];
    process.stdout.write(
      `[${i + 1}/${evalFixtures.length}] ${fixture.pattern.padEnd(12)} — ${fixture.query.slice(0, 50).padEnd(50)}...`
    );

    try {
      const start = Date.now();
      const response = await executeQuery(options.endpoint, fixture.query, options.tenantId);
      const latencyMs = Date.now() - start;

      // Find the correct skill in results
      let correctScore: number | null = null;
      let correctRank: number | null = null;
      let bestWrongScore: number | null = null;

      for (let j = 0; j < response.results.length; j++) {
        if (response.results[j].id === fixture.expectedSkillId) {
          correctScore = response.results[j].score;
          correctRank = j + 1;
        } else {
          if (bestWrongScore === null || response.results[j].score > bestWrongScore) {
            bestWrongScore = response.results[j].score;
          }
        }
      }

      const topScore = response.results[0]?.score ?? 0;
      const gap = correctScore !== null && bestWrongScore !== null
        ? correctScore - bestWrongScore
        : null;

      analyses.push({
        fixtureId: fixture.id,
        query: fixture.query,
        pattern: fixture.pattern,
        expectedSkillId: fixture.expectedSkillId,
        tier: response.meta.tier,
        correctScore,
        bestWrongScore,
        gap,
        correctRank,
        topScore,
        resultCount: response.results.length,
        latencyMs,
      });

      const status = correctRank === 1 ? '✅' : correctRank !== null ? `⚠️ R${correctRank}` : '❌';
      console.log(` ${status} score=${correctScore?.toFixed(3) ?? 'n/a'} gap=${gap?.toFixed(3) ?? 'n/a'} T${response.meta.tier} ${latencyMs}ms`);
    } catch (error) {
      console.log(` ❌ Error: ${(error as Error).message}`);
      errors++;
    }
  }

  if (analyses.length === 0) {
    console.error('\nNo results to analyze. Ensure the server is running and skills are seeded.');
    process.exit(1);
  }

  // ── Score Distribution ──
  const correctScores = analyses
    .filter((a) => a.correctScore !== null)
    .map((a) => a.correctScore!)
    .sort((a, b) => a - b);

  const wrongScores = analyses
    .filter((a) => a.bestWrongScore !== null)
    .map((a) => a.bestWrongScore!)
    .sort((a, b) => a - b);

  const gaps = analyses
    .filter((a) => a.gap !== null)
    .map((a) => a.gap!)
    .sort((a, b) => a - b);

  const topScores = analyses.map((a) => a.topScore).sort((a, b) => a - b);

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  SCORE DISTRIBUTION');
  console.log('═══════════════════════════════════════════════════════\n');

  console.log(`Correct Match Scores (n=${correctScores.length}):`);
  console.log(`  Min:   ${correctScores[0]?.toFixed(4) ?? 'n/a'}`);
  console.log(`  P10:   ${percentile(correctScores, 10).toFixed(4)}`);
  console.log(`  P25:   ${percentile(correctScores, 25).toFixed(4)}`);
  console.log(`  P50:   ${percentile(correctScores, 50).toFixed(4)}`);
  console.log(`  P75:   ${percentile(correctScores, 75).toFixed(4)}`);
  console.log(`  P90:   ${percentile(correctScores, 90).toFixed(4)}`);
  console.log(`  Max:   ${correctScores[correctScores.length - 1]?.toFixed(4) ?? 'n/a'}`);
  console.log(`  Mean:  ${(correctScores.reduce((a, b) => a + b, 0) / correctScores.length).toFixed(4)}`);

  console.log(`\nBest Wrong Scores (n=${wrongScores.length}):`);
  console.log(`  Min:   ${wrongScores[0]?.toFixed(4) ?? 'n/a'}`);
  console.log(`  P50:   ${percentile(wrongScores, 50).toFixed(4)}`);
  console.log(`  P75:   ${percentile(wrongScores, 75).toFixed(4)}`);
  console.log(`  P90:   ${percentile(wrongScores, 90).toFixed(4)}`);
  console.log(`  Max:   ${wrongScores[wrongScores.length - 1]?.toFixed(4) ?? 'n/a'}`);

  console.log(`\nGap (correct - best wrong) (n=${gaps.length}):`);
  console.log(`  Min:   ${gaps[0]?.toFixed(4) ?? 'n/a'}`);
  console.log(`  P10:   ${percentile(gaps, 10).toFixed(4)}`);
  console.log(`  P25:   ${percentile(gaps, 25).toFixed(4)}`);
  console.log(`  P50:   ${percentile(gaps, 50).toFixed(4)}`);
  console.log(`  P75:   ${percentile(gaps, 75).toFixed(4)}`);
  console.log(`  Max:   ${gaps[gaps.length - 1]?.toFixed(4) ?? 'n/a'}`);

  console.log(`\nTop Scores (n=${topScores.length}):`);
  console.log(`  P25:   ${percentile(topScores, 25).toFixed(4)}`);
  console.log(`  P50:   ${percentile(topScores, 50).toFixed(4)}`);
  console.log(`  P75:   ${percentile(topScores, 75).toFixed(4)}`);

  // ── Current Tier Distribution ──
  const tierDist = { 1: 0, 2: 0, 3: 0 };
  for (const a of analyses) {
    tierDist[a.tier]++;
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  CURRENT TIER DISTRIBUTION');
  console.log('═══════════════════════════════════════════════════════\n');
  console.log(`  Tier 1: ${tierDist[1]} (${((tierDist[1] / analyses.length) * 100).toFixed(1)}%)`);
  console.log(`  Tier 2: ${tierDist[2]} (${((tierDist[2] / analyses.length) * 100).toFixed(1)}%)`);
  console.log(`  Tier 3: ${tierDist[3]} (${((tierDist[3] / analyses.length) * 100).toFixed(1)}%)`);

  // ── Recall Stats ──
  const rank1 = analyses.filter((a) => a.correctRank === 1).length;
  const rank5 = analyses.filter((a) => a.correctRank !== null && a.correctRank <= 5).length;
  const notFound = analyses.filter((a) => a.correctRank === null).length;

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  RECALL');
  console.log('═══════════════════════════════════════════════════════\n');
  console.log(`  Recall@1: ${rank1}/${analyses.length} (${((rank1 / analyses.length) * 100).toFixed(1)}%)`);
  console.log(`  Recall@5: ${rank5}/${analyses.length} (${((rank5 / analyses.length) * 100).toFixed(1)}%)`);
  console.log(`  Not found: ${notFound}/${analyses.length}`);
  console.log(`  Errors: ${errors}`);

  // ── Per-Pattern Breakdown ──
  const patterns = [...new Set(analyses.map((a) => a.pattern))].sort();

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  PER-PATTERN ANALYSIS');
  console.log('═══════════════════════════════════════════════════════\n');

  for (const pattern of patterns) {
    const patternAnalyses = analyses.filter((a) => a.pattern === pattern);
    const patternCorrectScores = patternAnalyses
      .filter((a) => a.correctScore !== null)
      .map((a) => a.correctScore!)
      .sort((a, b) => a - b);
    const patternR1 = patternAnalyses.filter((a) => a.correctRank === 1).length;
    const patternR5 = patternAnalyses.filter((a) => a.correctRank !== null && a.correctRank <= 5).length;

    console.log(`${pattern} (n=${patternAnalyses.length}):`);
    console.log(`  R@1: ${patternR1}/${patternAnalyses.length} (${((patternR1 / patternAnalyses.length) * 100).toFixed(1)}%)  R@5: ${patternR5}/${patternAnalyses.length} (${((patternR5 / patternAnalyses.length) * 100).toFixed(1)}%)`);
    if (patternCorrectScores.length > 0) {
      console.log(`  Scores: min=${patternCorrectScores[0].toFixed(3)} med=${percentile(patternCorrectScores, 50).toFixed(3)} max=${patternCorrectScores[patternCorrectScores.length - 1].toFixed(3)}`);
    }
  }

  // ── Threshold Recommendations ──
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  THRESHOLD RECOMMENDATIONS');
  console.log('═══════════════════════════════════════════════════════\n');

  // Strategy: Tier 1 should capture ~60-70% of queries that have correct matches
  // Tier 2 should capture another ~20-25%
  // Tier 3 is for the rest (~5-15%)
  //
  // We derive TIER1 from: P30 of correct scores (captures ~70% in T1)
  // We derive TIER2 from: P10 of correct scores (captures ~90% in T1+T2, leaves ~10% for T3)
  // We also consider the noise floor (best wrong scores) to avoid false positives

  const tier1Rec = percentile(correctScores, 30);
  const tier2Rec = percentile(correctScores, 10);
  const gapMed = percentile(gaps, 50);

  console.log('Derived from score distribution:');
  console.log(`  CONFIDENCE_TIER1_THRESHOLD = "${tier1Rec.toFixed(2)}"  (P30 of correct scores → ~70% T1)`);
  console.log(`  CONFIDENCE_TIER2_THRESHOLD = "${tier2Rec.toFixed(2)}"  (P10 of correct scores → ~90% T1+T2)`);
  console.log(`  SCORE_GAP_THRESHOLD = "${Math.max(0.02, gapMed * 0.5).toFixed(2)}"  (50% of median gap)`);
  console.log('');
  console.log('Copy to wrangler.toml [vars]:');
  console.log(`  CONFIDENCE_TIER1_THRESHOLD = "${tier1Rec.toFixed(2)}"`);
  console.log(`  CONFIDENCE_TIER2_THRESHOLD = "${tier2Rec.toFixed(2)}"`);
  console.log(`  SCORE_GAP_THRESHOLD = "${Math.max(0.02, gapMed * 0.5).toFixed(2)}"`);

  // ── Missed Queries Detail ──
  const missed = analyses.filter((a) => a.correctRank === null || a.correctRank > 5);
  if (missed.length > 0) {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log(`  MISSED QUERIES (${missed.length})`);
    console.log('═══════════════════════════════════════════════════════\n');

    for (const m of missed) {
      console.log(`  ${m.fixtureId}: "${m.query}"`);
      console.log(`    Expected: ${m.expectedSkillId}`);
      console.log(`    Rank: ${m.correctRank ?? 'not found'}  Top: ${m.topScore.toFixed(3)}  Correct: ${m.correctScore?.toFixed(3) ?? 'n/a'}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
