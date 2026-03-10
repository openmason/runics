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
  // Mode B: inline files for ClawHub / registry skills
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
    enable_instruction_analysis?: boolean;
    enable_capability_mismatch?: boolean;
    enable_llm_verification?: boolean;
    max_files?: number;
    max_concurrent?: number;
  };
}

export type CircleIRAnalysisPhase = 'sast' | 'instruction_safety' | 'capability_mismatch';

export interface CircleIRJobStatus {
  job_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  current?: {
    phase: CircleIRAnalysisPhase;
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
}

export interface CircleIRScanSummary {
  sast_findings: number;
  instruction_findings: number;
  capability_mismatches: number;
  critical_and_high: number;
  verdict: 'VULNERABLE' | 'SAFE';
}

export interface CircleIRSkillResult {
  trust_score: number;
  verdict: 'VULNERABLE' | 'SAFE';
  skill_context: {
    name: string;
    description?: string;
    source_registry?: string;
    source_url?: string;
    execution_layer?: string;
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
}
