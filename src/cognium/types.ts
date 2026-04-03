// ══════════════════════════════════════════════════════════════════════════════
// Cognium Client — Type Definitions
// ══════════════════════════════════════════════════════════════════════════════

import type { SkillStatus } from '../types';

// ─── Queue Messages ──────────────────────────────────────────────────────────

export interface CogniumSubmitMessage {
  skillId: string;
  priority: 'normal' | 'high';
  timestamp: number;
}

export interface CogniumPollMessage {
  skillId: string;
  jobId: string;
  attempt: number;
}

// ─── Circle-IR API Types (Legacy — single-file analyze) ─────────────────────

export interface CircleIRAnalyzeRequest {
  code: string;
  filename?: string;
  language?: 'java' | 'typescript' | 'javascript' | 'python' | 'rust';
}

// ─── Circle-IR Skills API Types (POST /api/analyze/skill) ───────────────────

export interface LLMModelConfig {
  model: string;
  api_key?: string;
  base_url?: string;
}

export interface LLMConfig {
  api_key?: string;
  base_url?: string;
  model?: string;
  enrichment_model?: LLMModelConfig;
  verification_model?: LLMModelConfig;
  discovery_model?: LLMModelConfig;
}

export interface CircleIRSkillAnalyzeRequest {
  // Mode A: repo URL for GitHub-sourced skills
  repo_url?: string;
  branch?: string;
  // Mode B: bundle URL for ClawHub zip bundles (Circle-IR downloads + extracts)
  bundle_url?: string;
  // Mode C: inline files for ClawHub / registry skills (also fallback for failed bundle_url)
  files?: Record<string, string>;
  // Required: skill context for instruction + capability analysis
  skill_context: {
    name: string;
    source_registry: string;
    version?: string;
    author?: string;
    description?: string;
  };
  // Analysis options (v1.8.0)
  options?: {
    enable_sast?: boolean;
    enable_instruction_safety?: boolean;
    enable_capability_mismatch?: boolean;
    enable_enrichment?: boolean;
    enable_llm_verification?: boolean;
    max_files?: number;
  };
  llm_config?: LLMConfig;
}

export type CircleIRAnalysisPhase = 'sast' | 'instruction_safety' | 'capability_mismatch';

export interface CircleIRJobStatus {
  job_id: string;
  status: 'pending' | 'analyzing' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  current?: {
    phase: string;
    file?: string;
    step: string;
  };
  metrics?: {
    files_total: number;
    files_analyzed: number;
    files_failed: number;
    files_skipped: number;
    llm_calls_made?: number;
    llm_tokens_used?: number;
  };
  results?: {
    findings_found: number;
    components_found?: number;
    flows_extracted?: number;
    requirements_inferred?: number;
  };
  errors?: Array<{ phase: string; error: string; timestamp: string; file?: string }>;
  warnings?: string[];
  started_at?: string | null;
  completed_at?: string | null;
  bundle_metadata?: CircleIRBundleMetadata;
  files_detail?: CircleIRFileDetail[];
}

export interface CircleIRBundleMetadata {
  bundle_download: 'success' | 'failed' | 'skipped';
  bundle_download_status?: number;
  fallback_used?: 'inline_files' | 'skill_context_only';
  extraction_truncated?: boolean;
}

export type CircleIRFileStatus = 'analyzed' | 'skipped' | 'failed';

export type CircleIRSkipReason =
  | 'unsupported_language'
  | 'unknown_language'
  | 'binary_file'
  | 'too_large'
  | 'max_files_exceeded'
  | 'parse_error';

export interface CircleIRFileDetail {
  file: string;
  size_bytes: number;
  language: string | null;
  status: CircleIRFileStatus;
  phases_run?: CircleIRAnalysisPhase[];
  skip_reason?: CircleIRSkipReason;
  detected_extension?: string;
  error?: string;
}

export type CircleIRVerdict = 'TRUSTED' | 'REVIEW' | 'UNTRUSTED';

// Response from GET /api/analyze/{job_id}/skill-result (v1.8.0)
// trust_score is 0–100; TRUSTED ≥ 80, REVIEW 60–79, UNTRUSTED < 60
export interface CircleIRSkillResult {
  job_id?: string;
  status?: string;
  trust_score: number; // 0–100
  verdict: CircleIRVerdict;
  skill_context: {
    name: string;
    source_registry?: string;
    version?: string;
    author?: string;
    description?: string;
  };
  phase_counts: Record<CircleIRAnalysisPhase, number>;
  by_phase: Record<CircleIRAnalysisPhase, { findings: number }>;
  by_severity: { critical: number; high: number; medium: number; low: number };
  findings_total: number;
  errors: number;
  warnings: number;
}

export interface CircleIRFinding {
  id: string;
  cwe_id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  confidence: number;
  verdict: 'VULNERABLE' | 'SAFE' | 'NEEDS_REVIEW';
  verification_status: 'verified' | 'failed' | 'pending' | 'skipped';
  phase: CircleIRAnalysisPhase; // formally documented in v1.13.1 — safe to rely on
  file: string;
  line_start: number | null;
  line_end: number | null;
  description: string;
  track1_detected?: boolean;
  llm_verified?: boolean;
  dfg_verified?: boolean;
  source?: { type: string; variable?: string; location?: { line: number; code_snippet: string } };
  sink?: {
    type: string;
    method?: string | null;
    cwe?: string;
    location?: { line: number; column?: number | null; code_snippet: string };
  };
  taint_flow?: Array<{ step: number; line: number; code_snippet: string; description: string }>;
  llm_result?: {
    verdict: 'TRUE_POSITIVE' | 'FALSE_POSITIVE' | 'UNCERTAIN';
    confidence: number;
    reasoning: string;
    exploitability: 'high' | 'medium' | 'low' | 'none';
    severity?: string;
    exploit_scenario?: string | null;
  };
}

// ─── Circle-IR v1.12.2 — New Async APIs ─────────────────────────────────────
//
// Shared status shape for Trust / Quality / Understand / SpecDiff / Cluster jobs.
// These APIs follow the same pattern: POST → job_id → poll status → fetch results.
//

export type AsyncJobStatusValue = 'pending' | 'analyzing' | 'completed' | 'failed' | 'cancelled';

export interface AsyncJobStatus {
  job_id: string;
  status: AsyncJobStatusValue;
  progress: number;
  current?: { phase: string; file?: string; step: string };
  started_at?: string | null;
  completed_at?: string | null;
  errors?: Array<{ phase: string; error: string; timestamp: string; file?: string }>;
  warnings?: string[];
}

// ─── Trust Score API (POST /api/trust) ───────────────────────────────────────
// 27-pass security analysis: VERIFIED (85+) PASSING (60-84) ADVISORY (40-59) FAILING (<40) BLOCKED (critical)

export type TrustTier = 'VERIFIED' | 'PASSING' | 'ADVISORY' | 'FAILING' | 'BLOCKED';

// Priority: path > repo_url > bundle_url > files. bundle_url falls back to files on download failure.
// skill_context is stored as job metadata (does not yet influence pass scoring — v1.13.1).
export interface TrustRequest {
  path?: string;
  repo_url?: string;   // v1.13.1 — clones and analyzes
  branch?: string;
  bundle_url?: string; // v1.13.1 — downloads and extracts zip
  files?: Record<string, string>;
  skill_context?: {    // v1.13.1 — metadata stored on job
    name?: string;
    source_registry?: string;
    version?: string;
    author?: string;
    description?: string;
  };
  disabledPasses?: string[];
  trustDisabledPasses?: string[];
}

export interface TrustPassResult {
  name: string;
  score: number; // 0–100
  findings: Array<{ severity: string; message: string; file?: string; line?: number }>;
  duration_ms: number;
}

export interface TrustResultResponse {
  job_id: string;
  status: string;
  score: number; // 0–100
  tier: TrustTier;
  passResults: TrustPassResult[];
  categoryScores: Record<string, number>;
  artifacts: Record<string, unknown>;
  duration_ms: number;
}

// ─── Quality Score API (POST /api/quality) ───────────────────────────────────
// 5 passes: EXCELLENT (85+) GOOD (70-84) FAIR (50-69) POOR (<50)

export type QualityTier = 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR';

export interface QualityRequest {
  path?: string;
  files?: Record<string, string>;
}

export interface QualityPassResult {
  name: string; // code-complexity | test-coverage | documentation-coverage | maintainability-index | performance-patterns
  score: number; // 0–100
  findings: Array<{ severity: string; message: string }>;
}

export interface QualityResultResponse {
  job_id: string;
  status: string;
  score: number; // 0–100
  tier: QualityTier;
  passResults: QualityPassResult[];
  duration_ms: number;
}

// ─── Semantic Understanding API (POST /api/understand) ───────────────────────

export interface UnderstandRequest {
  path?: string;
  files?: Record<string, string>;
}

export interface UnderstandResultResponse {
  job_id: string;
  status: string;
  modules: Array<{
    file: string;
    role: string; // controller | service | model | utility | ...
    summary: string;
    exports: string[];
    dependencies: string[];
  }>;
  functions: Array<{
    name: string;
    file: string;
    effects: string[]; // network | filesystem | database | logging | ...
    summary: string;
  }>;
  securitySurface: {
    sources: string[];
    sinks: string[];
    sensitive: string[];
  };
  duration_ms: number;
}

// ─── Spec-Gap Analysis API (POST /api/spec-diff) ─────────────────────────────

export interface SpecDiffRequest {
  path?: string;
  specDir?: string;
  files?: Record<string, string>;
}

export interface SpecDiffResultResponse {
  job_id: string;
  status: string;
  alignmentScore: number; // 0–100
  gaps: Array<{
    type: 'uncovered_requirement' | 'extra_code' | 'mismatch';
    description: string;
    file?: string;
    severity: 'high' | 'medium' | 'low';
  }>;
  duration_ms: number;
}

// ─── Component Clustering API (POST /api/cluster) ────────────────────────────

export interface ClusterRequest {
  path?: string;
  files?: Record<string, string>;
  llm?: boolean;
}

export interface ClusterResultResponse {
  job_id: string;
  status: string;
  components: Array<{ name: string; files: string[]; role: string }>;
  clusters: Array<{ name: string; components: string[]; description: string }>;
  features: Array<{ name: string; description: string; components: string[] }>;
  duration_ms: number;
}

// ─── Dead Code Detection (POST /api/dead-code — synchronous) ─────────────────

export interface DeadCodeRequest {
  code: string;
  filename: string;
  language?: string;
}

export interface DeadCodeResponse {
  deadFunctions: Array<{ name: string; file: string; line: number; reason: string }>;
  unusedImports: Array<{ name: string; file: string; line: number }>;
  unusedVariables: Array<{ name: string; file: string; line: number }>;
  summary: { total_dead: number; files_analyzed: number };
}

// ─── Persisted Findings API (GET /api/findings) ──────────────────────────────

export type PersistedFindingStatus = 'open' | 'confirmed' | 'dismissed' | 'fixed';

export interface FindingsListResponse {
  findings: CircleIRFinding[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
  };
}

export interface FindingsStatsResponse {
  total: number;
  by_severity: Record<string, number>;
  by_cwe: Record<string, number>;
  by_status: Record<string, number>;
}

// ─── Runics Internal Types ───────────────────────────────────────────────────

export interface ScanFinding {
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  cweId?: string;
  tool: string;
  phase?: CircleIRAnalysisPhase;
  title: string;
  description: string;
  confidence: number;
  verdict: 'VULNERABLE' | 'SAFE' | 'NEEDS_REVIEW';
  llmVerified: boolean;
  remediationHint?: string;
  remediationUrl?: string;
  capabilityMismatch?: boolean;
}

// ─── DB Skill Row (subset used by Cognium client) ────────────────────────────

export interface SkillRow {
  id: string;
  slug: string;
  version: string;
  name: string;
  description: string;
  source: string;
  status: SkillStatus;
  executionLayer: string;
  skillMd?: string | null;
  r2BundleKey?: string | null;
  sourceUrl?: string | null;
  repositoryUrl?: string | null;
  rootSource?: string | null;
  skillType?: string | null;
  compositionSkillIds?: string[] | null;
  schemaJson?: Record<string, unknown> | null;
  capabilitiesRequired?: string[] | null;
  agentSummary?: string | null;
  changelog?: string | null;
}
