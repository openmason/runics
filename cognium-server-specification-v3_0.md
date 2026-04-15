# Cognium Server — Skill Analysis Engine Spec

> **Purpose:** Single source of truth for Cognium (Circle-IR) as a skill analysis service. Covers the API, analysis phases, trust scoring, response format, and deployment.
> **Audience:** Cognium team
> **Implementation:** circle-pack (Node.js Hono server)
> **Deployment:** `https://circle.phantoms.workers.dev` (Node.js port 5002)
> **Date:** April 2026 · v3.0
> **Status:** Implemented. Aligned with circle-pack actual API.
> **v3.0 changes:** Updated to match circle-pack's actual implementation. Renamed from "Verification Engine" to "Skill Analysis Engine". API paths, request/response schemas, and phases now reflect deployed code.

---

## Table of Contents

1. [What Cognium Is](#1-what-cognium-is)
2. [Design Principles](#2-design-principles)
3. [Architecture Overview](#3-architecture-overview)
4. [API Surface](#4-api-surface)
5. [Skill Analysis Request](#5-skill-analysis-request)
6. [Response Schemas](#6-response-schemas)
7. [Analysis Phases](#7-analysis-phases)
8. [Trust Score Formula](#8-trust-score-formula)
9. [Finding Schema](#9-finding-schema)
10. [Technology Stack](#10-technology-stack)
11. [Cost Model](#11-cost-model)
12. [Project Structure](#12-project-structure)

---

## 1. What Cognium Is

Cognium (Circle-IR) is a **skill analysis engine for AI agent tools**. It answers one question: how much should you trust this skill/tool/agent?

A skill is not just code. It's a bundle of artifacts — source code, natural language instructions (SKILL.md), MCP configurations, capability declarations. Traditional security tools only scan code. Cognium scans **everything** through a multi-phase pipeline.

Cognium is a standalone HTTP service. It receives a skill bundle, runs a four-phase analysis pipeline, and returns a trust score with detailed findings. It has no knowledge of who calls it or what they do with the result.

**Sole current consumer:** Runics (skill registry). All trust data flows through Runics skill metadata. Other services (Cortex, products) consume trust scores via Runics, never by calling Cognium directly.

---

## 2. Design Principles

**Async job model.** Cognium returns a `job_id` immediately. Callers poll for completion. This allows analysis of large bundles without HTTP timeouts.

**Multi-phase analysis.** Code is ~40% of the attack surface. Instructions, schemas, and capability declarations make up the rest. All get dedicated analysis phases.

**LLM-enhanced where it matters, SAST at core.** The SAST phase uses Tree-sitter taint analysis with LLM enrichment/verification. The Instruction Safety phase uses LLM classification. The Capability Mismatch phase correlates NL extraction with code IR.

**Defense in depth.** Multiple phases check different things. A skill that passes SAST but has malicious SKILL.md still gets flagged.

**Rich findings.** Each finding includes CWE, severity, confidence, LLM verification status, and full taint flow. Callers get everything they need to make informed decisions.

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    COGNIUM SERVER (circle-pack)                  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  POST /api/analyze/skill                                    │ │
│  │  Receives skill bundle, returns job_id                      │ │
│  └──────────────┬─────────────────────────────────────────────┘ │
│                 │                                                │
│                 ▼                                                │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  BUNDLE FETCHER                                             │ │
│  │  Downloads bundle_url or extracts inline files              │ │
│  └──────────────┬─────────────────────────────────────────────┘ │
│                 │                                                │
│                 ▼                                                │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  FOUR-PHASE PIPELINE                                        │ │
│  │                                                              │ │
│  │  ┌──────────────────────────────────────────────────────┐  │ │
│  │  │ Phase 1: SAST (analyzeFilesSwarm)                     │  │ │
│  │  │ • Tree-sitter taint analysis                          │  │ │
│  │  │ • LLM enrichment (optional)                           │  │ │
│  │  │ • LLM verification (optional)                         │  │ │
│  │  └──────────────────────────────────────────────────────┘  │ │
│  │                          ↓                                  │ │
│  │  ┌──────────────────────────────────────────────────────┐  │ │
│  │  │ Phase 1.5: MCP Permissions (if mcp-config.json)       │  │ │
│  │  │ • Static permission validation                        │  │ │
│  │  └──────────────────────────────────────────────────────┘  │ │
│  │                          ↓                                  │ │
│  │  ┌──────────────────────────────────────────────────────┐  │ │
│  │  │ Phase 2: Instruction Safety (if SKILL.md)             │  │ │
│  │  │ • LLM classification of instruction threats           │  │ │
│  │  │ • Content safety (S1–S13 harm categories)             │  │ │
│  │  └──────────────────────────────────────────────────────┘  │ │
│  │                          ↓                                  │ │
│  │  ┌──────────────────────────────────────────────────────┐  │ │
│  │  │ Phase 3: Capability Mismatch                          │  │ │
│  │  │ • NL extraction from SKILL.md                         │  │ │
│  │  │ • Compare declared vs detected capabilities           │  │ │
│  │  └──────────────────────────────────────────────────────┘  │ │
│  │                                                              │ │
│  └──────────────┬─────────────────────────────────────────────┘ │
│                 │                                                │
│                 ▼                                                │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  RESULT BUILDER                                             │ │
│  │  • Compute trust_score                                      │ │
│  │  • Derive verdict (VULNERABLE/SAFE)                         │ │
│  │  • Aggregate phase_counts, by_severity                      │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 4. API Surface

Cognium exposes a skill analysis endpoint with async job polling. Authentication via Bearer token (optional).

### Core Endpoints

```
POST /api/analyze/skill           Submit skill for analysis, returns job_id
GET  /api/analyze/{job_id}/status Get job status and progress
GET  /api/analyze/{job_id}/findings  Get detailed findings
GET  /api/analyze/{job_id}/skill-result  Get trust score, verdict, phase counts
GET  /api/analyze/{job_id}/results    Get full results (findings + skill_result)
GET  /health                       Service health check
```

### Additional Endpoints (Single File / Repository)

```
POST /api/analyze                 Single file analysis
POST /api/analyze/repository      Full repository analysis via git_url
GET  /api/analyze/{job_id}/stream SSE progress stream
```

---

## 5. Skill Analysis Request

```typescript
// POST /api/analyze/skill
interface SkillRequest {
  // Input Mode A: Git repository URL
  repo_url?: string;
  branch?: string;  // default: tries 'main' then 'master'

  // Input Mode B: Bundle archive URL (ClawHub bundles)
  bundle_url?: string;

  // Input Mode C: Inline files dict
  files?: Record<string, string>;  // { "path": "content" }

  // Required: Skill metadata
  skill_context: {
    name: string;
    description?: string;
    source_registry?: 'clawhub' | 'github' | 'mcp-registry';
    source_url?: string;
    execution_layer?: string;
  };

  // Analysis options
  options?: SkillAnalysisOptions;

  // LLM configuration (optional — server has defaults)
  llm_config?: LLMConfig;
}

interface SkillAnalysisOptions {
  enable_sast?: boolean;                    // default: true
  enable_enrichment?: boolean;              // default: false (slower)
  enable_llm_verification?: boolean;        // default: true
  enable_instruction_analysis?: boolean;    // default: true
  enable_capability_mismatch?: boolean;     // default: true
  max_files?: number;                       // default: 50
  max_concurrent?: number;                  // default: 5
  fast_mode?: boolean;                      // default: false (skip LLM phases)
  file_timeout_ms?: number;                 // default: adaptive
}

interface LLMConfig {
  api_key?: string;
  base_url?: string;
  model?: string;
  provider?: string;
}
```

**Input priority:** `repo_url` > `bundle_url` > `files` > `skill_context` only

---

## 6. Response Schemas

### Job Created Response

```typescript
// Response from POST /api/analyze/skill (202 Accepted)
interface JobCreatedResponse {
  job_id: string;
  status: 'pending';
}
```

### Status Response

```typescript
// GET /api/analyze/{job_id}/status
interface JobStatusResponse {
  job_id: string;
  status: 'pending' | 'analyzing' | 'completed' | 'failed' | 'cancelled';
  progress: number;  // 0-100
  metrics: {
    files_total: number;
    files_analyzed: number;
    files_failed: number;
    files_skipped: number;
    llm_calls_made: number;
    llm_calls_failed: number;
    llm_tokens_used: number;
    cost: {
      total_usd: number;
      track1_usd: number;
      llm_verification_usd: number;
      llm_enrichment_usd: number;
    };
  };
  current?: {
    phase: string;  // 'sast' | 'instruction_safety' | 'capability_mismatch'
    file?: string;
    step: string;
  };
  results: {
    findings_found: number;
    components_found: number;
    flows_extracted: number;
    requirements_inferred: number;
    calls_count: number;
  };
  errors: Array<{
    phase: string;
    error: string;
    timestamp: string;
    file?: string;
  }>;
  warnings: string[];
  bundle_metadata?: {
    bundle_download: 'success' | 'failed' | 'skipped';
    bundle_download_status?: number;
    fallback_used?: 'inline_files' | 'skill_context_only';
  };
}
```

### Skill Result Response

```typescript
// GET /api/analyze/{job_id}/skill-result
interface SkillResultResponse {
  job_id: string;
  status: 'pending' | 'analyzing' | 'completed' | 'failed' | 'cancelled';

  // Server-computed trust score (0.0-1.0)
  trust_score: number;

  // Server-computed verdict
  verdict: 'VULNERABLE' | 'SAFE';

  // Skill context echo
  skill_context: {
    name: string;
    description?: string;
    source_registry?: string;
    source_url?: string;
    execution_layer?: string;
  };

  // Findings by phase
  phase_counts: {
    sast: number;
    instruction_safety: number;
    capability_mismatch: number;
  };

  // Summary stats
  findings_total: number;
  by_phase: {
    sast: { findings: number };
    instruction_safety: { findings: number };
    capability_mismatch: { findings: number };
  };
  by_severity: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };

  // Client integration fields
  scanned_at: string;              // ISO 8601 timestamp (e.g., "2026-04-15T10:30:00.000Z")
  engine_version: string;          // Server version (e.g., "circle-pack/1.16.3")
  content_safe: boolean;           // false if CRITICAL instruction_safety finding detected
  scan_coverage: 'partial' | 'full';  // 'partial' if fast_mode or phases skipped

  errors: number;
  warnings: number;
}
```

### Findings Response

```typescript
// GET /api/analyze/{job_id}/findings
interface JobFindingsResponse {
  job_id: string;
  findings: Finding[];
  total: number;
}
```

---

## 7. Analysis Phases

### Phase 1: SAST (Static Application Security Testing)

**Input:** Code files from bundle/repo
**Languages:** Java, TypeScript, JavaScript, Python, Rust, Bash
**Method:** Tree-sitter taint analysis (circle-ir) with optional LLM enrichment/verification

**Detects:**
- SQL injection (CWE-89)
- Command injection (CWE-78)
- Path traversal (CWE-22)
- XSS (CWE-79)
- Code injection (CWE-94)
- SSRF (CWE-918)
- Weak cryptography (CWE-327, CWE-328)
- Hardcoded secrets (CWE-798)
- 15+ additional vulnerability types

**Sub-phases:**
1. Track 1: Pattern-based taint analysis
2. Enrichment (optional): LLM discovers additional sources/sinks
3. Verification (optional): LLM validates taint paths as exploitable

### Phase 1.5: MCP Permissions

**Input:** `mcp-config.json` (if present)
**Method:** Static permission validation

**Detects:**
- Overly broad permissions
- Dangerous permission combinations
- Missing required permissions

### Phase 2: Instruction Safety

**Input:** `SKILL.md`, `description`
**Method:** LLM classification with security-focused prompt

**Detects:**
- Prompt injection patterns
- Data exfiltration instructions
- Capability escalation requests
- Social engineering
- Content safety violations (S1–S13 harm categories)

### Phase 3: Capability Mismatch

**Input:** SKILL.md NL extraction + code taint IR
**Method:** Compare declared vs detected capabilities

**Detects:**
- Undeclared network access
- Undeclared filesystem access
- Undeclared process spawning
- Hidden capabilities not mentioned in instructions

---

## 8. Trust Score Formula

```typescript
function computeTrustScore(findings: Finding[]): number {
  // Start at 1.0 (perfect trust)
  let score = 1.0;

  // Deduct based on severity
  const IMPACT: Record<string, number> = {
    critical: -0.25,
    high: -0.15,
    medium: -0.05,
    low: -0.02,
  };

  for (const finding of findings) {
    if (finding.verdict === 'SAFE') continue;  // Skip non-issues
    const impact = IMPACT[finding.severity] ?? 0;
    // Scale by confidence for LLM-based findings
    const adjustedImpact = finding.llm_verified
      ? impact
      : impact * finding.confidence;
    score += adjustedImpact;
  }

  return Math.max(0.0, Math.min(1.0, score));
}

function computeVerdict(findings: Finding[]): 'VULNERABLE' | 'SAFE' {
  const hasVulnerable = findings.some(
    f => f.verdict === 'VULNERABLE' || f.verdict === 'NEEDS_REVIEW'
  );
  return hasVulnerable ? 'VULNERABLE' : 'SAFE';
}
```

---

## 9. Finding Schema

```typescript
interface Finding {
  id: string;
  cwe_id: string;                     // e.g. "CWE-89"
  severity: 'critical' | 'high' | 'medium' | 'low';
  confidence: number;                 // 0.0–1.0
  verdict: 'VULNERABLE' | 'SAFE' | 'NEEDS_REVIEW';
  file: string;
  line_start: number | null;
  line_end: number | null;
  description: string;

  // Phase attribution
  phase?: 'sast' | 'instruction_safety' | 'capability_mismatch';

  // Detection layers
  track1_detected: boolean;           // Pattern match found
  enrichment_ran: boolean;            // LLM enrichment executed
  llm_verified: boolean | null;       // LLM verification executed
  dfg_verified: boolean;              // Data flow verified

  // Verification status
  verification_status: 'verified' | 'failed' | 'pending' | 'skipped';
  verification_error: string | null;

  // LLM verification result
  llm_result?: {
    verdict: 'TRUE_POSITIVE' | 'FALSE_POSITIVE' | 'UNCERTAIN';
    confidence: number;
    reasoning: string;
    exploitability: 'high' | 'medium' | 'low' | 'none';
    severity: string;
    exploit_scenario: string | null;
  };

  // Taint flow details
  source?: {
    type: string;
    variable: string | null;
    annotation: string | null;
    location: CodeLocation;
  };
  sink?: {
    type: string;
    method: string | null;
    cwe: string;
    location: CodeLocation;
  };
  taint_flow: TaintFlowStep[];
}

interface CodeLocation {
  line: number;
  column: number | null;
  code_snippet: string;
  context_before: string[];
  context_after: string[];
}

interface TaintFlowStep {
  step: number;
  line: number;
  code_snippet: string;
  description: string;
}
```

---

## 10. Technology Stack

| Component | Technology | Purpose |
|---|---|---|
| HTTP server | Node.js + Hono | REST API |
| SAST engine | circle-ir (Tree-sitter WASM) | Taint analysis |
| LLM client | ax-llm (DSPy-style) | Enrichment, verification |
| File analysis | circle-ir-ai | Mastra workflows, skill runner |
| Languages | Java, TS, JS, Python, Rust, Bash | Multi-language support |

---

## 11. Cost Model

### Per-Skill Analysis Cost

| Component | Cost | Notes |
|---|---|---|
| SAST (static) | ~$0 | No LLM calls |
| LLM enrichment | ~$0.005–0.02 | Per-file, optional |
| LLM verification | ~$0.005–0.02 | Per-finding, optional |
| Instruction safety | ~$0.005 | Single LLM call |
| Capability mismatch | ~$0.005 | Single LLM call |
| **Total per skill** | **$0.005–0.05** | Depends on code size, options |

### Fast Mode

With `fast_mode: true`, skip all LLM phases:
- Cost: ~$0 (pure static analysis)
- Speed: ~1-2s for typical skill
- Coverage: SAST only (no instruction/capability analysis)

---

## 12. Project Structure

```
circle-pack/src/
├── api/
│   ├── server.ts                    # Hono app, routes, middleware
│   ├── types.ts                     # All TypeScript interfaces
│   ├── routes/
│   │   ├── skill.ts                 # POST /api/analyze/skill
│   │   ├── jobs.ts                  # GET /{job_id}/status, findings, etc.
│   │   ├── analyze.ts               # POST /api/analyze (single file)
│   │   ├── repository.ts            # POST /api/analyze/repository
│   │   └── health.ts                # GET /health
│   ├── analysis/
│   │   ├── skill-runner.ts          # Four-phase skill analysis pipeline
│   │   ├── bundle-fetcher.ts        # Download/extract bundles
│   │   └── instruction-analyzer.ts  # SKILL.md safety classification
│   └── jobs/
│       ├── store.ts                 # In-memory job store
│       └── types.ts                 # Job, SkillResult interfaces
└── shared/
    └── analysis-engine.ts           # circle-ir-ai integration
```

---

*Cognium: the trust layer for the agent economy.*
