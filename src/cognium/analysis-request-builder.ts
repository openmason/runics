// ══════════════════════════════════════════════════════════════════════════════
// Cognium Client — Analysis Request Builder
// ══════════════════════════════════════════════════════════════════════════════
//
// Builds request payloads for Circle-IR extended analysis endpoints:
// quality, trust, understand, spec-diff.
//
// All 4 endpoints now support repo_url / bundle_url / files (v1.19.0).
// Source mode is determined by the same logic as analyze/skill.
//
// ══════════════════════════════════════════════════════════════════════════════

import type {
  SkillRow,
  QualityRequest,
  TrustRequest,
  UnderstandRequest,
  SpecDiffRequest,
} from './types';
import { buildCircleIRRequest } from './request-builder';

export interface AnalysisRequests {
  quality: QualityRequest;
  trust: TrustRequest;
  understand: UnderstandRequest;
  specDiff: SpecDiffRequest;
}

export function buildAnalysisRequests(
  skill: SkillRow,
  bundleFiles?: Record<string, string> | null,
): AnalysisRequests {
  // Reuse the existing request builder to determine source mode
  const base = buildCircleIRRequest(skill, bundleFiles);

  // All endpoints now support repo_url, bundle_url, files (v1.19.0)
  const quality: QualityRequest = {};
  const understand: UnderstandRequest = {};
  const specDiff: SpecDiffRequest = {};

  if (base.repo_url) {
    quality.repo_url = base.repo_url;
    understand.repo_url = base.repo_url;
    specDiff.repo_url = base.repo_url;
    if (base.branch) {
      quality.branch = base.branch;
      understand.branch = base.branch;
      specDiff.branch = base.branch;
    }
  } else if (base.bundle_url) {
    quality.bundle_url = base.bundle_url;
    understand.bundle_url = base.bundle_url;
    specDiff.bundle_url = base.bundle_url;
    // Send files as fallback if bundle download fails
    if (base.files) {
      quality.files = base.files;
      understand.files = base.files;
      specDiff.files = base.files;
    }
  } else if (base.files) {
    quality.files = base.files;
    understand.files = base.files;
    specDiff.files = base.files;
  }

  // Trust endpoint — same source mode + skill_context metadata
  const trust: TrustRequest = {
    skill_context: {
      name: skill.name,
      description: skill.description || undefined,
      source_registry: skill.source,
      source_url: skill.sourceUrl || undefined,
      execution_layer: skill.executionLayer || undefined,
    },
  };

  if (base.repo_url) {
    trust.repo_url = base.repo_url;
    if (base.branch) trust.branch = base.branch;
  } else if (base.bundle_url) {
    trust.bundle_url = base.bundle_url;
    if (base.files) trust.files = base.files;
  } else if (base.files) {
    trust.files = base.files;
  }

  return { quality, trust, understand, specDiff };
}
