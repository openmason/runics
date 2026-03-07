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

// ─── Circle-IR API Types ─────────────────────────────────────────────────────

export interface CircleIRAnalyzeRequest {
  code: string;
  filename?: string;
  language?: 'java' | 'typescript' | 'javascript' | 'python' | 'rust';
}

export interface CircleIRJobStatus {
  job_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  metrics?: {
    files_total: number;
    files_analyzed: number;
    files_failed: number;
    files_skipped: number;
  };
}

export interface CircleIRFinding {
  id: string;
  cwe_id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  confidence: number;
  verdict: 'VULNERABLE' | 'SAFE' | 'NEEDS_REVIEW';
  verification_status: 'verified' | 'failed' | 'pending' | 'skipped';
  file: string;
  line_start: number;
  line_end: number;
  description: string;
  source?: { type: string; variable: string; location: { line: number; code_snippet: string } };
  sink?: { type: string; method: string; cwe: string };
  taint_flow?: Array<{ step: number; line: number; code_snippet: string; description: string }>;
  llm_result?: {
    verdict: 'TRUE_POSITIVE' | 'FALSE_POSITIVE' | 'UNCERTAIN';
    confidence: number;
    reasoning: string;
    exploitability: 'high' | 'medium' | 'low' | 'none';
  };
}

// ─── Runics Internal Types ───────────────────────────────────────────────────

export interface ScanFinding {
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  cweId?: string;
  tool: string;
  title: string;
  description: string;
  confidence: number;
  verdict: 'VULNERABLE' | 'SAFE' | 'NEEDS_REVIEW';
  llmVerified: boolean;
  remediationHint?: string;
  remediationUrl?: string;
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
  rootSource?: string | null;
  skillType?: string | null;
  compositionSkillIds?: string[] | null;
}
