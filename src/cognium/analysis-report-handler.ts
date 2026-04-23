// ══════════════════════════════════════════════════════════════════════════════
// Cognium Client — Analysis Report Handler
// ══════════════════════════════════════════════════════════════════════════════
//
// Writes results from Circle-IR extended analysis endpoints (quality, trust,
// understand, spec-diff) to the skills table.
//
// Each result is best-effort — if one endpoint fails, the others are still
// written. All writes happen in a single UPDATE to minimize DB round-trips.
//
// ══════════════════════════════════════════════════════════════════════════════

import { Pool } from '@neondatabase/serverless';
import type {
  QualityResultResponse,
  TrustResultResponse,
  UnderstandResultResponse,
  SpecDiffResultResponse,
} from './types';

export interface AnalysisResults {
  quality?: QualityResultResponse | null;
  trust?: TrustResultResponse | null;
  understand?: UnderstandResultResponse | null;
  specDiff?: SpecDiffResultResponse | null;
}

export async function applyAnalysisResults(
  pool: Pool,
  skillId: string,
  results: AnalysisResults,
): Promise<void> {
  const setClauses: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (results.quality) {
    const normalizedScore = Math.max(0, Math.min(1, results.quality.score / 100));
    setClauses.push(
      `quality_score = $${idx++}`,
      `quality_tier = $${idx++}`,
      `quality_results = $${idx++}`,
      `quality_analyzed_at = NOW()`,
    );
    params.push(normalizedScore, results.quality.tier, JSON.stringify(results.quality));
  }

  if (results.trust) {
    const normalizedScore = Math.max(0, Math.min(1, results.trust.score / 100));
    setClauses.push(
      `trust_score_v2 = $${idx++}`,
      `trust_tier = $${idx++}`,
      `trust_results = $${idx++}`,
      `trust_analyzed_at = NOW()`,
    );
    params.push(normalizedScore, results.trust.tier, JSON.stringify(results.trust));
  }

  if (results.understand) {
    setClauses.push(
      `understand_results = $${idx++}`,
      `understand_analyzed_at = NOW()`,
    );
    params.push(JSON.stringify(results.understand));
  }

  if (results.specDiff) {
    const normalizedScore = Math.max(0, Math.min(1, results.specDiff.alignmentScore / 100));
    setClauses.push(
      `spec_alignment_score = $${idx++}`,
      `spec_gaps = $${idx++}`,
      `spec_analyzed_at = NOW()`,
    );
    params.push(normalizedScore, JSON.stringify(results.specDiff.gaps));
  }

  if (setClauses.length === 0) return;

  setClauses.push(`updated_at = NOW()`);
  params.push(skillId);

  await pool.query(
    `UPDATE skills SET ${setClauses.join(', ')} WHERE id = $${idx}`,
    params,
  );
}
