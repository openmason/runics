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
    description: string;
    source_registry: string;
    source_url?: string;
    execution_layer: string;
  };
  // Analysis options
  options?: {
    enable_sast?: boolean;
    enable_instruction_safety?: boolean;
    enable_instruction_analysis?: boolean; // deprecated alias — remove once Circle-IR confirms new name is live
    enable_capability_mismatch?: boolean;
    enable_enrichment?: boolean;
    enable_llm_verification?: boolean;
    max_files?: number;
    max_concurrent?: number;
  };
}

export type CircleIRAnalysisPhase = 'sast' | 'instruction_safety' | 'capability_mismatch';

export interface CircleIRJobStatus {
  job_id: string;
  status: 'pending' | 'running' | 'analyzing' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  current?: {
    phase: string;
    step: string;
  };
  metrics?: {
    files_total: number;
    files_analyzed: number;
    files_failed: number;
    files_skipped: number;
  };
  results?: {
    findings_found: number;
  };
  started_at?: string;
  completed_at?: string;
  summary?: CircleIRScanSummary;
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

export interface CircleIRScanSummary {
  sast_findings: number;
  instruction_findings: number;
  capability_mismatches: number;
  critical_and_high: number;
  verdict: 'VULNERABLE' | 'SAFE';
}

export type CircleIRVerdict = 'TRUSTED' | 'REVIEW' | 'UNTRUSTED';

export interface CircleIRSkillResult {
  job_id?: string;
  status?: string;
  trust_score: number;
  verdict: CircleIRVerdict;
  skill_context: {
    name: string;
    description?: string;
    source_registry?: string;
    source_url?: string;
    execution_layer?: string;
    version?: string;
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
  phase: CircleIRAnalysisPhase;
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
  };
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
