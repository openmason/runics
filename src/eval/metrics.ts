// ══════════════════════════════════════════════════════════════════════════════
// Eval Metrics — Recall@K, MRR, Pattern Analysis
// ══════════════════════════════════════════════════════════════════════════════
//
// Computes search quality metrics from eval results.
//
// Key metrics:
// - Recall@1: % of queries where correct skill is rank 1
// - Recall@5: % of queries where correct skill is in top 5
// - MRR: Mean reciprocal rank (1/rank of correct skill)
// - Tier distribution: % of queries in each tier
// - By-pattern breakdown: Metrics per phrasing pattern
//
// ══════════════════════════════════════════════════════════════════════════════

import type { EvalMetrics, EvalFixture, FindSkillResponse } from '../types';

export interface EvalResult {
  fixture: EvalFixture;
  response: FindSkillResponse;
  correctSkillRank: number | null; // null if not found
  foundInTop5: boolean;
  foundInTop1: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Compute All Metrics
// ──────────────────────────────────────────────────────────────────────────────

export function computeMetrics(results: EvalResult[]): EvalMetrics {
  if (results.length === 0) {
    return {
      recall1: 0,
      recall5: 0,
      mrr: 0,
      avgTopScore: 0,
      tierDistribution: { 1: 0, 2: 0, 3: 0 },
      byPattern: {},
    };
  }

  // Overall metrics
  const recall1 = computeRecall1(results);
  const recall5 = computeRecall5(results);
  const mrr = computeMRR(results);
  const avgTopScore = computeAvgTopScore(results);
  const tierDistribution = computeTierDistribution(results);

  // Per-pattern breakdown
  const byPattern = computeByPattern(results);

  return {
    recall1,
    recall5,
    mrr,
    avgTopScore,
    tierDistribution,
    byPattern,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Recall@1: Correct Skill is Rank 1
// ──────────────────────────────────────────────────────────────────────────────

function computeRecall1(results: EvalResult[]): number {
  const top1Count = results.filter((r) => r.foundInTop1).length;
  return top1Count / results.length;
}

// ──────────────────────────────────────────────────────────────────────────────
// Recall@5: Correct Skill in Top 5
// ──────────────────────────────────────────────────────────────────────────────

function computeRecall5(results: EvalResult[]): number {
  const top5Count = results.filter((r) => r.foundInTop5).length;
  return top5Count / results.length;
}

// ──────────────────────────────────────────────────────────────────────────────
// MRR: Mean Reciprocal Rank
// ──────────────────────────────────────────────────────────────────────────────

function computeMRR(results: EvalResult[]): number {
  let reciprocalRankSum = 0;

  for (const result of results) {
    if (result.correctSkillRank !== null) {
      reciprocalRankSum += 1 / result.correctSkillRank;
    }
    // If not found, contributes 0 to MRR
  }

  return reciprocalRankSum / results.length;
}

// ──────────────────────────────────────────────────────────────────────────────
// Average Top Score
// ──────────────────────────────────────────────────────────────────────────────

function computeAvgTopScore(results: EvalResult[]): number {
  const topScores = results
    .map((r) => r.response.results[0]?.score ?? 0)
    .filter((score) => score > 0);

  if (topScores.length === 0) {
    return 0;
  }

  return topScores.reduce((sum, score) => sum + score, 0) / topScores.length;
}

// ──────────────────────────────────────────────────────────────────────────────
// Tier Distribution
// ──────────────────────────────────────────────────────────────────────────────

function computeTierDistribution(
  results: EvalResult[]
): Record<1 | 2 | 3, number> {
  const distribution: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };

  for (const result of results) {
    const tier = result.response.meta.tier;
    distribution[tier]++;
  }

  return distribution;
}

// ──────────────────────────────────────────────────────────────────────────────
// Per-Pattern Breakdown
// ──────────────────────────────────────────────────────────────────────────────

function computeByPattern(
  results: EvalResult[]
): Record<string, { recall5: number; mrr: number }> {
  // Group results by pattern
  const byPattern: Record<string, EvalResult[]> = {};

  for (const result of results) {
    const pattern = result.fixture.pattern;
    if (!byPattern[pattern]) {
      byPattern[pattern] = [];
    }
    byPattern[pattern].push(result);
  }

  // Compute metrics per pattern
  const metrics: Record<string, { recall5: number; mrr: number }> = {};

  for (const [pattern, patternResults] of Object.entries(byPattern)) {
    metrics[pattern] = {
      recall5: computeRecall5(patternResults),
      mrr: computeMRR(patternResults),
    };
  }

  return metrics;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helper: Find Rank of Expected Skill
// ──────────────────────────────────────────────────────────────────────────────

export function findSkillRank(
  response: FindSkillResponse,
  expectedSkillId: string
): number | null {
  for (let i = 0; i < response.results.length; i++) {
    if (response.results[i].id === expectedSkillId) {
      return i + 1; // Rank is 1-indexed
    }
  }
  return null; // Not found
}

// ──────────────────────────────────────────────────────────────────────────────
// Build EvalResult from Response
// ──────────────────────────────────────────────────────────────────────────────

export function buildEvalResult(
  fixture: EvalFixture,
  response: FindSkillResponse
): EvalResult {
  const rank = findSkillRank(response, fixture.expectedSkillId);

  return {
    fixture,
    response,
    correctSkillRank: rank,
    foundInTop5: rank !== null && rank <= 5,
    foundInTop1: rank !== null && rank === 1,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Format Metrics for Display
// ──────────────────────────────────────────────────────────────────────────────

export function formatMetrics(metrics: EvalMetrics): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════');
  lines.push('  EVAL METRICS');
  lines.push('═══════════════════════════════════════════════════════');
  lines.push('');

  // Overall metrics
  lines.push('Overall Performance:');
  lines.push(`  Recall@1:       ${(metrics.recall1 * 100).toFixed(1)}%`);
  lines.push(`  Recall@5:       ${(metrics.recall5 * 100).toFixed(1)}%`);
  lines.push(`  MRR:            ${metrics.mrr.toFixed(3)}`);
  lines.push(`  Avg Top Score:  ${metrics.avgTopScore.toFixed(3)}`);
  lines.push('');

  // Tier distribution
  const total =
    metrics.tierDistribution[1] +
    metrics.tierDistribution[2] +
    metrics.tierDistribution[3];

  lines.push('Tier Distribution:');
  lines.push(
    `  Tier 1 (High):   ${metrics.tierDistribution[1]} (${((metrics.tierDistribution[1] / total) * 100).toFixed(1)}%)`
  );
  lines.push(
    `  Tier 2 (Med):    ${metrics.tierDistribution[2]} (${((metrics.tierDistribution[2] / total) * 100).toFixed(1)}%)`
  );
  lines.push(
    `  Tier 3 (Low):    ${metrics.tierDistribution[3]} (${((metrics.tierDistribution[3] / total) * 100).toFixed(1)}%)`
  );
  lines.push('');

  // Per-pattern breakdown
  lines.push('By Pattern:');
  const patterns = Object.keys(metrics.byPattern).sort();

  for (const pattern of patterns) {
    const patternMetrics = metrics.byPattern[pattern];
    lines.push(
      `  ${pattern.padEnd(12)} — Recall@5: ${(patternMetrics.recall5 * 100).toFixed(1)}%  MRR: ${patternMetrics.mrr.toFixed(3)}`
    );
  }

  lines.push('═══════════════════════════════════════════════════════');

  return lines.join('\n');
}
