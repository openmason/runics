# Cognium Client — Runics Integration Spec

> **Purpose:** Single source of truth for how Runics integrates with Circle-IR (Cognium Server) as an external skill analysis service. Covers the async job flow, Circle-IR finding mapping, Runics scoring policy, status application, and composite cascade.
> **Audience:** Runics team
> **Depends on:** Circle-IR (circle.phantoms.workers.dev — already deployed), Cloudflare Queues, Cloudflare KV (job state), Neon Postgres (Runics DB)
> **Stack:** TypeScript · Cloudflare Workers · Cloudflare Queues · Cloudflare KV · Neon Postgres
> **Date:** April 2026 · v4.1
> **Status:** Fully implemented. 526 tests passing. Deployed to staging + production (April 2026). Supersedes v4.0.
> **v4.1 changes:** Positioning clarified — Cognium client is the sole integration point between the Cognium verification engine and the rest of the platform. Cortex never calls Cognium directly; it reads cached trust scores from Runics skill metadata. Skill revocation/vulnerability events now emitted to `runics-skill-events` queue (see Runics v5.4 §24), enabling Cortex to react to revocations in running workflows.
>
> **Positioning (v4.1):** The Cognium client is the sole integration point between the Cognium verification engine and the rest of the platform. It lives inside the Runics codebase because:
> 1. Scanning is triggered by Runics (on skill ingestion/publish)
> 2. Trust scores are written to Runics tables (skills.trust_score, skills.status)
> 3. Composite cascade logic operates on Runics composition data
> 4. Notification triggers use Runics event infrastructure
>
> No other service calls Cognium. Cortex (the workflow engine) reads trust scores via Runics skill metadata (cached in KV and Postgres). There are zero HTTP calls from Cortex to Cognium during workflow execution.

---

## Table of Contents

1. [Integration Model](#1-integration-model)
2. [Configuration](#2-configuration)
3. [Queue Architecture](#3-queue-architecture)
4. [Async Job Flow](#4-async-job-flow)
5. [Circle-IR Skill Request](#5-circle-ir-skill-request)
6. [Circle-IR Response Schemas](#6-circle-ir-response-schemas)
7. [Finding Mapping](#7-finding-mapping)
8. [Scan Report Handling](#8-scan-report-handling)
9. [Runics Scoring Policy](#9-runics-scoring-policy)
10. [Composite Cascade](#10-composite-cascade)
11. [Schema Changes](#11-schema-changes)
12. [Search Response Changes](#12-search-response-changes)
13. [Appetite Filtering Enhancements](#13-appetite-filtering-enhancements)
14. [Error Handling](#14-error-handling)
15. [Sync Pipeline Changes](#15-sync-pipeline-changes)
16. [Project Structure](#16-project-structure)
17. [Build Plan](#17-build-plan)
18. [Testing](#18-testing)

---

## 1. Integration Model

Circle-IR (`circle.phantoms.workers.dev`) is an already-deployed skill analysis service. It provides a dedicated **skill analysis endpoint** (`POST /api/analyze/skill`) that runs a four-phase security pipeline:

1. **SAST** — Taint analysis on code files (analyzeFilesSwarm)
2. **MCP Permissions** — Static permission validation (if mcp-config.json present)
3. **Instruction Safety** — LLM classification of SKILL.md threats
4. **Capability Mismatch** — NL extraction vs code taint IR comparison

Circle-IR is **async** — it returns a `job_id` immediately and runs analysis in the background. Runics must poll for completion before applying results.

**Key difference from v3.0:** Circle-IR now computes `trust_score` and `verdict` server-side. Runics can use these directly or apply its own scoring policy on top of the raw findings.

```
Skill arrives (sync worker / Forge / manual publish / human-distill)
    │
    ▼
COGNIUM_QUEUE.send({ skillId, priority, timestamp })
    │
    ▼
Submit Consumer — PHASE 1: Submit job to Circle-IR
    ├─ Fetch skill metadata from DB
    ├─ POST /api/analyze/skill  →  { job_id, status: 'pending' }
    ├─ Store job state in KV: cognium:job:{skillId} → { jobId, submittedAt }
    ├─ msg.ack()
    └─ Enqueue to COGNIUM_POLL_QUEUE: { skillId, jobId, attempt: 1 } (delayed 15s)
    │
    ▼
Poll Consumer — PHASE 2: Poll until complete
    │
    ├─ GET /api/analyze/{job_id}/status
    │
    ├─ status = 'completed'
    │     ├─ GET /api/analyze/{job_id}/skill-result  → trust_score, verdict, phase_counts
    │     ├─ GET /api/analyze/{job_id}/findings      → Finding[]
    │     ├─ Map Circle-IR findings → Runics ScanFindings (normalizeFindings)
    │     ├─ Apply Runics scoring policy (optional override)
    │     ├─ deriveStatus() / deriveTier()
    │     ├─ update skills table
    │     ├─ cascadeStatusToComposites() if revoked/vulnerable
    │     ├─ triggerNotification() if revoked/HIGH
    │     ├─ delete KV job state
    │     └─ msg.ack()
    │
    ├─ status = 'analyzing' | 'pending'
    │     └─ re-enqueue with exponential backoff delay
    │
    ├─ status = 'failed' | 'cancelled'
    │     ├─ mark skill: verification_tier = 'scan_failed'
    │     └─ msg.ack()
    │
    └─ attempt > MAX_POLL_ATTEMPTS (12)
          ├─ mark skill scan_failed
          └─ msg.ack()
```

---

## 2. Configuration

```toml
# wrangler.toml
[vars]
COGNIUM_URL = "https://circle.phantoms.workers.dev"
COGNIUM_POLL_DELAY_MS = "15000"   # initial poll delay after job submission
COGNIUM_MAX_POLL_ATTEMPTS = "12"  # ~30 min total at exponential backoff

# COGNIUM_API_KEY set via wrangler secret
# wrangler secret put COGNIUM_API_KEY

[[kv_namespaces]]
binding = "COGNIUM_JOBS"
id = "..."      # stores job state: cognium:job:{skillId}

[[queues.producers]]
binding = "COGNIUM_POLL_QUEUE"
queue = "runics-cognium-poll"
```

```typescript
interface Env {
  COGNIUM_URL: string;
  COGNIUM_API_KEY: string;
  COGNIUM_QUEUE: Queue;
  COGNIUM_POLL_QUEUE: Queue;
  COGNIUM_JOBS: KVNamespace;
  COGNIUM_POLL_DELAY_MS?: string;
  COGNIUM_MAX_POLL_ATTEMPTS?: string;
}
```

Environment switching:
- **Dev:** `COGNIUM_URL = "http://localhost:5002"`
- **Staging:** `COGNIUM_URL = "https://circle-staging.phantoms.workers.dev"`
- **Production:** `COGNIUM_URL = "https://circle.phantoms.workers.dev"`

---

## 3. Queue Architecture

Two queues handle the async job lifecycle:

```toml
# SUBMIT queue: ingest path → Circle-IR job submission
[[queues.producers]]
binding = "COGNIUM_QUEUE"
queue = "runics-cognium"

[[queues.consumers]]
queue = "runics-cognium"
max_batch_size = 5
max_batch_timeout = 30
max_retries = 2
dead_letter_queue = "cognium-dlq"

# POLL queue: delayed polling until job completes
[[queues.producers]]
binding = "COGNIUM_POLL_QUEUE"
queue = "runics-cognium-poll"

[[queues.consumers]]
queue = "runics-cognium-poll"
max_batch_size = 10
max_batch_timeout = 30
max_retries = 0           # self-manages retries via re-enqueue with delay
dead_letter_queue = "cognium-poll-dlq"
```

### Submit Message Schema

```typescript
interface CogniumSubmitMessage {
  skillId: string;
  priority: 'normal' | 'high';    // high = Forge-generated or human-distilled
  timestamp: number;
}
```

### Poll Message Schema

```typescript
interface CogniumPollMessage {
  skillId: string;
  jobId: string;                   // Circle-IR job_id
  attempt: number;                 // current poll attempt (1-based)
}
```

### Backoff Schedule

| Attempt | Delay before poll |
|---|---|
| 1 | 15s |
| 2 | 30s |
| 3 | 60s |
| 4–8 | 120s |
| 9–12 | 300s |
| >12 | give up → mark scan_failed |

---

## 4. Async Job Flow

### Phase 1: Submit Consumer

```typescript
// src/cognium/submit-consumer.ts

export async function handleCogniumSubmitQueue(
  batch: MessageBatch<CogniumSubmitMessage>,
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const skill = await fetchSkillById(env, msg.body.skillId);
      if (!skill) { msg.ack(); continue; }

      // Submit to Circle-IR skill analysis endpoint
      const response = await fetch(`${env.COGNIUM_URL}/api/analyze/skill`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.COGNIUM_API_KEY}`,
        },
        body: JSON.stringify(buildSkillRequest(skill)),
      });

      if (!response.ok) {
        if (response.status >= 500) { msg.retry(); continue; }
        console.error(`Circle-IR rejected ${skill.id}: ${response.status}`);
        msg.ack();
        continue;
      }

      const { job_id } = await response.json() as { job_id: string; status: 'pending' };

      // Persist job state in KV (1h TTL — safety net)
      await env.COGNIUM_JOBS.put(
        `cognium:job:${skill.id}`,
        JSON.stringify({ jobId: job_id, skillId: skill.id, submittedAt: Date.now() }),
        { expirationTtl: 3600 },
      );

      // Enqueue first poll with initial delay
      const initialDelay = parseInt(env.COGNIUM_POLL_DELAY_MS ?? '15000', 10);
      await env.COGNIUM_POLL_QUEUE.send(
        { skillId: skill.id, jobId: job_id, attempt: 1 },
        { delaySeconds: Math.floor(initialDelay / 1000) },
      );

      msg.ack();
    } catch (err) {
      console.error(`Submit error for ${msg.body.skillId}: ${err.message}`);
      msg.retry();
    }
  }
}
```

### Phase 2: Poll Consumer

```typescript
// src/cognium/poll-consumer.ts

const POLL_DELAYS_MS = [15000, 30000, 60000, 120000, 120000, 120000, 120000, 120000, 300000, 300000, 300000, 300000];
const MAX_ATTEMPTS = 12;

export async function handleCogniumPollQueue(
  batch: MessageBatch<CogniumPollMessage>,
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    const { skillId, jobId, attempt } = msg.body;

    try {
      // Check job status
      const statusRes = await fetch(`${env.COGNIUM_URL}/api/analyze/${jobId}/status`, {
        headers: { 'Authorization': `Bearer ${env.COGNIUM_API_KEY}` },
      });

      if (!statusRes.ok) { msg.retry(); continue; }

      const statusData = await statusRes.json() as CircleIRStatusResponse;

      if (statusData.status === 'completed') {
        // Fetch skill result (includes trust_score, verdict, phase_counts)
        const skillResultRes = await fetch(`${env.COGNIUM_URL}/api/analyze/${jobId}/skill-result`, {
          headers: { 'Authorization': `Bearer ${env.COGNIUM_API_KEY}` },
        });
        const skillResult = await skillResultRes.json() as CircleIRSkillResultResponse;

        // Fetch detailed findings
        const findingsRes = await fetch(`${env.COGNIUM_URL}/api/analyze/${jobId}/findings`, {
          headers: { 'Authorization': `Bearer ${env.COGNIUM_API_KEY}` },
        });
        const findingsData = await findingsRes.json() as CircleIRFindingsResponse;

        const skill = await fetchSkillById(env, skillId);
        if (skill) {
          await applyScanReport(env, skill, skillResult, findingsData.findings);
        }

        await env.COGNIUM_JOBS.delete(`cognium:job:${skillId}`);
        msg.ack();

      } else if (statusData.status === 'failed' || statusData.status === 'cancelled') {
        await markScanFailed(env, skillId, `Circle-IR job ${statusData.status}`);
        await env.COGNIUM_JOBS.delete(`cognium:job:${skillId}`);
        msg.ack();

      } else if (attempt >= MAX_ATTEMPTS) {
        await markScanFailed(env, skillId, 'Poll timeout after 12 attempts');
        await env.COGNIUM_JOBS.delete(`cognium:job:${skillId}`);
        msg.ack();

      } else {
        // Still running — re-enqueue with backoff
        const nextDelay = POLL_DELAYS_MS[Math.min(attempt - 1, POLL_DELAYS_MS.length - 1)];
        await env.COGNIUM_POLL_QUEUE.send(
          { skillId, jobId, attempt: attempt + 1 },
          { delaySeconds: Math.floor(nextDelay / 1000) },
        );
        msg.ack();
      }

    } catch (err) {
      console.error(`Poll error for job ${jobId}: ${err.message}`);
      msg.retry();
    }
  }
}
```

---

## 5. Circle-IR Skill Request

Circle-IR's `POST /api/analyze/skill` accepts a rich skill bundle request with multiple input modes.

```typescript
// src/cognium/request-builder.ts

export function buildSkillRequest(skill: Skill): CircleIRSkillRequest {
  return {
    // Input mode: bundle_url (preferred for ClawHub skills)
    bundle_url: skill.r2BundleUrl,

    // Fallback: inline files dict
    files: skill.inlineFiles,

    // Required: skill context
    skill_context: {
      name: skill.name,
      description: skill.description,
      source_registry: skill.source as 'clawhub' | 'github' | 'mcp-registry',
      source_url: skill.sourceUrl,
      execution_layer: skill.executionLayer,
    },

    // Analysis options
    options: {
      enable_sast: true,
      enable_instruction_analysis: true,
      enable_capability_mismatch: true,
      enable_llm_verification: true,
      max_files: 50,
      max_concurrent: 5,
      fast_mode: false,  // Set true for quick scans without LLM
    },

    // LLM config (optional — Circle-IR has defaults)
    // llm_config: { ... },
  };
}

interface CircleIRSkillRequest {
  /** Option A: Git repository URL */
  repo_url?: string;
  branch?: string;

  /** Option B: Bundle archive URL (ClawHub bundles) */
  bundle_url?: string;

  /** Option C: Inline files dict { "path": "content" } */
  files?: Record<string, string>;

  /** Required: Skill metadata */
  skill_context: {
    name: string;
    description?: string;
    source_registry?: 'clawhub' | 'github' | 'mcp-registry';
    source_url?: string;
    execution_layer?: string;
  };

  /** Analysis options */
  options?: {
    enable_sast?: boolean;              // default: true
    enable_enrichment?: boolean;        // default: false (slower)
    enable_llm_verification?: boolean;  // default: true
    enable_instruction_analysis?: boolean;  // default: true
    enable_capability_mismatch?: boolean;   // default: true
    max_files?: number;                 // default: 50
    max_concurrent?: number;            // default: 5
    fast_mode?: boolean;                // default: false (skip LLM phases)
    file_timeout_ms?: number;           // default: adaptive
  };

  /** LLM configuration (optional) */
  llm_config?: {
    api_key?: string;
    base_url?: string;
    model?: string;
  };
}
```

---

## 6. Circle-IR Response Schemas

### Job Created Response (POST /api/analyze/skill)

```typescript
interface CircleIRJobCreatedResponse {
  job_id: string;
  status: 'pending';
}
```

### Status Response (GET /api/analyze/{job_id}/status)

```typescript
interface CircleIRStatusResponse {
  job_id: string;
  status: 'pending' | 'analyzing' | 'completed' | 'failed' | 'cancelled';
  progress: number;           // 0-100
  metrics: {
    files_total: number;
    files_analyzed: number;
    files_failed: number;
    files_skipped: number;
    llm_calls_made: number;
  };
  current?: {
    phase: string;            // 'sast' | 'instruction_safety' | 'capability_mismatch'
    step: string;
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

### Skill Result Response (GET /api/analyze/{job_id}/skill-result)

```typescript
interface CircleIRSkillResultResponse {
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

  // Client integration fields (new in v4.0)
  scanned_at: string;              // ISO 8601 timestamp (e.g., "2026-04-15T10:30:00.000Z")
  engine_version: string;          // Server version (e.g., "circle-pack/1.16.3")
  content_safe: boolean;           // false if CRITICAL instruction_safety finding detected
  scan_coverage: 'partial' | 'full';  // 'partial' if fast_mode or phases skipped

  errors: number;
  warnings: number;
}
```

### Findings Response (GET /api/analyze/{job_id}/findings)

```typescript
interface CircleIRFindingsResponse {
  job_id: string;
  findings: CircleIRFinding[];
  total: number;
}

interface CircleIRFinding {
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
  track1_detected: boolean;
  enrichment_ran: boolean;
  llm_verified: boolean | null;
  dfg_verified: boolean;

  // Verification
  verification_status: 'verified' | 'failed' | 'pending' | 'skipped';
  verification_error: string | null;

  // LLM result (if verified)
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
    location: {
      line: number;
      column: number | null;
      code_snippet: string;
      context_before: string[];
      context_after: string[];
    };
  };
  sink?: {
    type: string;
    method: string | null;
    cwe: string;
    location: {
      line: number;
      column: number | null;
      code_snippet: string;
      context_before: string[];
      context_after: string[];
    };
  };
  taint_flow: Array<{
    step: number;
    line: number;
    code_snippet: string;
    description: string;
  }>;
}
```

---

## 7. Finding Mapping

Circle-IR findings are already rich and include phase attribution. Runics normalizes them for internal use and display.

```typescript
// src/cognium/finding-mapper.ts

// Runics internal format
interface ScanFinding {
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  cweId?: string;
  tool: string;
  title: string;
  description: string;
  confidence: number;
  verdict: 'VULNERABLE' | 'SAFE' | 'NEEDS_REVIEW';
  phase: 'sast' | 'instruction_safety' | 'capability_mismatch';
  llmVerified: boolean;
  remediationHint?: string;
  remediationUrl?: string;
  file?: string;
  lineStart?: number;
  lineEnd?: number;
}

export function normalizeFindings(raw: CircleIRFinding[]): ScanFinding[] {
  return raw
    .filter(f => f.verdict !== 'SAFE')   // SAFE findings don't affect trust
    .map(f => ({
      severity: f.severity.toUpperCase() as ScanFinding['severity'],
      cweId: f.cwe_id,
      tool: 'circle-ir',
      title: f.description.slice(0, 80),
      description: f.description,
      confidence: f.confidence,
      verdict: f.verdict,
      phase: f.phase ?? 'sast',
      llmVerified: f.verification_status === 'verified' && f.llm_result?.verdict === 'TRUE_POSITIVE',
      file: f.file,
      lineStart: f.line_start ?? undefined,
      lineEnd: f.line_end ?? undefined,
      remediationHint: f.sink
        ? `${f.sink.type} via ${f.sink.method} at line ${f.line_end}`
        : undefined,
      remediationUrl: f.cwe_id
        ? `https://cwe.mitre.org/data/definitions/${f.cwe_id.replace('CWE-', '')}.html`
        : undefined,
    }));
}

export function deriveWorstSeverity(findings: ScanFinding[]): ScanFinding['severity'] | null {
  const order: ScanFinding['severity'][] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  for (const sev of order) {
    if (findings.some(f => f.severity === sev)) return sev;
  }
  return null;
}

export function isContentUnsafe(findings: ScanFinding[]): boolean {
  // CRITICAL instruction_safety findings indicate content safety failure
  return findings.some(
    f => f.severity === 'CRITICAL'
      && f.phase === 'instruction_safety'
      && f.llmVerified
  );
}
```

---

## 8. Scan Report Handling

```typescript
// src/cognium/scan-report-handler.ts

export async function applyScanReport(
  env: Env,
  skill: Skill,
  skillResult: CircleIRSkillResultResponse,
  rawFindings: CircleIRFinding[],
): Promise<void> {
  const findings = normalizeFindings(rawFindings);
  const worstSeverity = deriveWorstSeverity(findings);

  // Use server-provided content_safe flag (more reliable than client-side derivation)
  const contentUnsafe = !skillResult.content_safe;

  // Content safety failure: absolute override
  if (contentUnsafe) {
    await db.update(skills).set({
      trustScore: 0.0,
      verificationTier: 'scanned',
      contentSafetyPassed: false,
      status: 'revoked',
      revokedAt: new Date(),
      revokedReason: 'content_safety_failed',
      remediationMessage: 'Revoked: skill contains instruction injection or prompt hijacking risk.',
      cogniumFindings: rawFindings,   // store raw for display
      cogniumScannedAt: new Date(skillResult.scanned_at),  // use server timestamp
      scanCoverage: skillResult.scan_coverage,              // use server coverage
      phaseCounts: skillResult.phase_counts,
      engineVersion: skillResult.engine_version,            // track which version scanned
      updatedAt: new Date(),
    }).where(eq(skills.id, skill.id));

    await cascadeStatusToComposites(env, skill.id, 'revoked');
    await triggerNotification(env, skill.id, 'revoked', 'Content safety failure');
    return;
  }

  // Use server-computed trust_score or apply Runics policy
  const trustScore = applyRunicsScoringPolicy(skill, findings, skillResult.trust_score);
  const newStatus = deriveStatus(worstSeverity);
  const tier = deriveTier(worstSeverity, trustScore);
  const worstFinding = findings.find(f => f.severity === worstSeverity);
  const remediationMessage = worstFinding ? buildRemediationMessage(worstFinding, skill) : null;

  await db.update(skills).set({
    trustScore,
    verificationTier: tier,
    contentSafetyPassed: skillResult.content_safe,
    scanCoverage: skillResult.scan_coverage,
    status: newStatus,
    revokedAt: newStatus === 'revoked' ? new Date() : null,
    revokedReason: newStatus === 'revoked' ? (worstFinding?.cweId ?? worstFinding?.title ?? null) : null,
    remediationMessage,
    remediationUrl: worstFinding?.remediationUrl ?? null,
    cogniumFindings: rawFindings,
    phaseCounts: skillResult.phase_counts,
    cogniumScannedAt: new Date(skillResult.scanned_at),
    serverTrustScore: skillResult.trust_score,
    serverVerdict: skillResult.verdict,
    engineVersion: skillResult.engine_version,
    updatedAt: new Date(),
  }).where(eq(skills.id, skill.id));

  if (newStatus === 'revoked' || newStatus === 'vulnerable') {
    await cascadeStatusToComposites(env, skill.id, newStatus);
  }

  if (newStatus === 'published' && ['vulnerable', 'revoked'].includes(skill.status)) {
    await repairCompositeStatus(env, skill.id);
  }

  if (newStatus === 'revoked') {
    await triggerNotification(env, skill.id, 'revoked', worstFinding?.cweId ?? worstFinding?.title);
  } else if (newStatus === 'vulnerable' && worstSeverity === 'HIGH') {
    await triggerNotification(env, skill.id, 'vulnerable', worstFinding?.cweId ?? worstFinding?.title);
  }
}

async function markScanFailed(env: Env, skillId: string, reason: string): Promise<void> {
  await db.update(skills).set({
    verificationTier: 'unverified',
    cogniumScannedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(skills.id, skillId));
  console.error(`Scan failed for ${skillId}: ${reason}`);
}
```

---

## 9. Runics Scoring Policy

Runics can use Circle-IR's server-computed `trust_score` directly or apply its own policy for source-based adjustments.

```typescript
// src/cognium/scoring-policy.ts

// Base trust by source (registry provenance) — applied on top of server score
const SOURCE_ADJUSTMENT: Record<string, number> = {
  'mcp-registry':    +0.10,   // boost for curated registry
  'clawhub':         +0.00,   // neutral
  'github':          -0.05,   // slight penalty for uncurated
  'manual':          +0.00,   // neutral
  'forge':           -0.10,   // penalty for machine-generated
};

export function applyRunicsScoringPolicy(
  skill: Skill,
  findings: ScanFinding[],
  serverTrustScore: number,
): number {
  // Start with server-computed score
  let score = serverTrustScore;

  // Apply source-based adjustment
  const sourceAdj = SOURCE_ADJUSTMENT[skill.source] ?? 0;
  score += sourceAdj;

  // Clamp to 0.0–1.0
  return Math.max(0.0, Math.min(1.0, score));
}

// Severity → status (Runics policy)
export function deriveStatus(worstSeverity: string | null): SkillStatus {
  if (worstSeverity === 'CRITICAL') return 'revoked';
  if (worstSeverity === 'HIGH' || worstSeverity === 'MEDIUM') return 'vulnerable';
  return 'published';
}

// Verification tier (Runics criteria)
export function deriveTier(
  worstSeverity: ScanFinding['severity'] | null,
  trustScore: number,
): 'unverified' | 'scanned' | 'verified' | 'certified' {
  if (worstSeverity === 'CRITICAL') return 'scanned';
  if (trustScore >= 0.70 && worstSeverity !== 'HIGH') return 'verified';
  return 'scanned';
  // 'certified' requires human review sign-off — future
}

// Remediation message
export function buildRemediationMessage(finding: ScanFinding, skill: Skill): string {
  const lines = [
    `${finding.severity} finding: ${finding.cweId ?? finding.title}`,
  ];
  if (finding.phase) {
    lines.push(`Detected in phase: ${finding.phase}`);
  }
  if (finding.remediationHint) {
    lines.push(`Fix: ${finding.remediationHint}`);
  }
  return lines.join('\n');
}
```

---

## 10. Composite Cascade

When a skill is revoked or flagged, all composite skills containing it must update their derived status.

```typescript
// src/cognium/composite-cascade.ts

export async function cascadeStatusToComposites(
  env: Env,
  constituentSkillId: string,
  newStatus: 'revoked' | 'vulnerable',
): Promise<void> {
  const composites = await db
    .select({ id: skills.id, slug: skills.slug, version: skills.version, status: skills.status })
    .from(skills)
    .where(
      and(
        inArray(skills.skillType, ['auto-composite', 'human-composite']),
        sql`composition_skill_ids @> ARRAY[${constituentSkillId}]::uuid[]`,
        not(inArray(skills.status, ['revoked', 'draft'])),
      )
    );

  const derivedStatus = newStatus === 'revoked' ? 'degraded' : 'contains-vulnerable';

  for (const composite of composites) {
    await db.update(skills).set({
      status: derivedStatus,
      updatedAt: new Date(),
    }).where(eq(skills.id, composite.id));

    console.log(`Composite ${composite.slug}@${composite.version} → ${derivedStatus}`);
  }
}

export async function repairCompositeStatus(
  env: Env,
  repairedSkillId: string,
): Promise<void> {
  const composites = await db
    .select({ id: skills.id, compositionSkillIds: skills.compositionSkillIds })
    .from(skills)
    .where(
      and(
        inArray(skills.skillType, ['auto-composite', 'human-composite']),
        sql`composition_skill_ids @> ARRAY[${repairedSkillId}]::uuid[]`,
        eq(skills.status, 'contains-vulnerable'),
      )
    );

  for (const composite of composites) {
    const constituents = await db
      .select({ status: skills.status })
      .from(skills)
      .where(inArray(skills.id, composite.compositionSkillIds ?? []));

    const allClean = constituents.every(c =>
      ['published', 'deprecated'].includes(c.status)
    );

    if (allClean) {
      await db.update(skills).set({
        status: 'published',
        updatedAt: new Date(),
      }).where(eq(skills.id, composite.id));
    }
  }
}
```

---

## 11. Schema Changes

### New columns on `skills` table

```sql
-- Migration: add Circle-IR skill analysis fields

ALTER TABLE skills
  -- Status lifecycle
  ADD COLUMN status TEXT NOT NULL DEFAULT 'published'
    CHECK (status IN ('draft','published','deprecated','vulnerable',
                      'revoked','degraded','contains-vulnerable')),
  ADD COLUMN revoked_at TIMESTAMPTZ,
  ADD COLUMN revoked_reason TEXT,
  ADD COLUMN remediation_message TEXT,
  ADD COLUMN remediation_url TEXT,

  -- Circle-IR attestation fields
  ADD COLUMN verification_tier TEXT DEFAULT 'unverified'
    CHECK (verification_tier IN ('unverified','scanned','verified','certified')),
  ADD COLUMN scan_coverage TEXT
    CHECK (scan_coverage IN ('full','partial')),
  ADD COLUMN cognium_findings JSONB,
  ADD COLUMN phase_counts JSONB,
  ADD COLUMN cognium_scanned_at TIMESTAMPTZ,

  -- Server-computed values (for reference)
  ADD COLUMN server_trust_score REAL,
  ADD COLUMN server_verdict TEXT,
  ADD COLUMN engine_version TEXT,              -- e.g., "circle-pack/1.16.3"

  -- Composition
  ADD COLUMN skill_type TEXT NOT NULL DEFAULT 'atomic'
    CHECK (skill_type IN ('atomic','auto-composite','human-composite','forked')),
  ADD COLUMN composition_skill_ids UUID[];

-- Index for composite cascade queries
CREATE INDEX idx_skills_composition ON skills USING GIN (composition_skill_ids);
CREATE INDEX idx_skills_status ON skills (status);
```

---

## 12. Search Response Changes

```typescript
interface ScoredSkill {
  skillId: string;
  slug: string;
  version: string;

  // Trust
  trustScore: number;
  verificationTier: 'unverified' | 'scanned' | 'verified' | 'certified';

  // Status
  status: SkillStatus;
  revokedReason?: string;
  remediationMessage?: string;

  // Phase breakdown
  phaseCounts?: {
    sast: number;
    instruction_safety: number;
    capability_mismatch: number;
  };

  // Server values
  serverTrustScore?: number;
  serverVerdict?: 'VULNERABLE' | 'SAFE';
}
```

---

## 13. Appetite Filtering Enhancements

```sql
SELECT DISTINCT ON (s.slug)
  s.id AS skill_id,
  s.slug,
  s.version,
  1 - (se.embedding <=> :queryEmbedding) AS score,
  s.trust_score,
  s.verification_tier,
  s.status,
  s.phase_counts
FROM skill_embeddings se
JOIN skills s ON se.skill_id = s.id
WHERE s.trust_score >= :minTrust
  AND s.content_safety_passed IS NOT FALSE
  AND s.status NOT IN ('revoked', 'draft', 'degraded')
  AND (s.tenant_id IS NULL OR s.tenant_id = :tenantId)
  AND (:allowVulnerable OR s.status NOT IN ('vulnerable', 'contains-vulnerable'))
ORDER BY s.slug, s.trust_score DESC
LIMIT :limit;
```

---

## 14. Error Handling

| Scenario | Action |
|---|---|
| Job completed with findings | `applyScanReport()` → `msg.ack()` |
| 400 bad input | Log + `msg.ack()` |
| 401/403 auth failure | Log + alert + `msg.ack()` |
| 429 rate limited | `msg.retry()` |
| 5xx server error | `msg.retry()` |
| Network error/timeout | `msg.retry()` |
| Skill deleted before consume | `msg.ack()` |

---

## 15. Sync Pipeline Changes

All skill ingest paths enqueue to `COGNIUM_QUEUE`:

```typescript
await env.COGNIUM_QUEUE.send({
  skillId: skill.id,
  priority: ['forge', 'human-distilled'].includes(skill.source) ? 'high' : 'normal',
  timestamp: Date.now(),
});
```

---

## 16. Project Structure

```
src/cognium/
├── submit-consumer.ts         # Submit queue → POST /api/analyze/skill
├── poll-consumer.ts           # Poll queue → GET status → GET skill-result + findings → apply
├── request-builder.ts         # Skill → CircleIRSkillRequest
├── finding-mapper.ts          # Circle-IR Finding → Runics ScanFinding
├── scan-report-handler.ts     # applyScanReport() + markScanFailed()
├── scoring-policy.ts          # applyRunicsScoringPolicy, deriveStatus, deriveTier
├── composite-cascade.ts       # cascadeStatusToComposites, repairCompositeStatus
├── notification-trigger.ts    # Webhook on revoke/flag + skill events queue emission (v4.1)
└── types.ts                   # All TypeScript interfaces
```

### Skill Events Integration (v4.1)

When `applyScanReport()` marks a skill as `revoked` or `vulnerable`, `notification-trigger.ts` also emits to the `runics-skill-events` queue, enabling Cortex to react to revocations in running workflows:

```typescript
export async function triggerNotification(
  env: Env,
  skillId: string,
  status: 'revoked' | 'vulnerable',
  reason: string,
) {
  // Existing: webhook to Activepieces
  await sendWebhook(env, skillId, status, reason);

  // v4.1: emit skill event for Cortex consumption
  await env.SKILL_EVENTS.send({
    type: `skill.${status}`,
    skillId,
    reason,
    timestamp: new Date().toISOString(),
  });
}
```

This requires adding `SKILL_EVENTS` queue binding to wrangler.toml:

```toml
[[queues.producers]]
binding = "SKILL_EVENTS"
queue = "runics-skill-events"
```

And adding to the `Env` interface:

```typescript
interface Env {
  // ... existing bindings ...
  SKILL_EVENTS: Queue;  // v4.1: skill revocation/vulnerability events
}
```

Cortex subscribes to the `runics-skill-events` queue as a consumer. When it receives an event, it identifies affected running workflow instances and pushes notifications to product DOs. See `cortex-specification-v2_0.md` §13 for the consumer side.

---

## 17. Build Plan

All items implemented and deployed to staging + production (April 2026).

### Foundation
- [x] Add new `skills` table columns (migrations 0007–0015)
- [x] `submit-consumer.ts` — POST `/api/analyze/skill`
- [x] `poll-consumer.ts` — GET status, skill-result, findings
- [x] `finding-mapper.ts` — `normalizeFindings()`
- [x] `request-builder.ts` — `buildSkillRequest()`

### Scoring + Cascade
- [x] `scan-report-handler.ts` — `applyScanReport()`
- [x] `scoring-policy.ts` — `applyRunicsScoringPolicy()`, `deriveStatus()`, `deriveTier()`
- [x] `composite-cascade.ts` — cascade and repair logic
- [x] `notification-trigger.ts` — webhook + skill events queue emission (v4.1)

### Testing
- [x] Unit tests: 118+ cognium-specific tests (submit, poll, request-builder, scan-report-handler, notification-trigger)
- [x] Integration verification suite (10 scenarios)
- [x] Scan backpressure + failure tracking
- [x] SKILL_EVENTS queue emission (v4.1)

---

## 18. Testing

### Integration Test Matrix

| Test Case | Circle-IR Response | Expected DB State |
|---|---|---|
| CRITICAL SAST finding | severity: 'critical', phase: 'sast' | `status: 'revoked'` |
| HIGH instruction finding | severity: 'high', phase: 'instruction_safety' | `status: 'vulnerable'` |
| Clean skill | empty findings, verdict: 'SAFE' | `status: 'published'`, `tier: 'verified'` |
| Capability mismatch | phase: 'capability_mismatch' | Findings stored, status based on severity |
| Bundle download fails | fallback_used: 'inline_files' | Analysis proceeds with inline files |

### Mock Circle-IR for Dev

```typescript
// test/mock-circle-ir.ts
import { Hono } from 'hono';

const app = new Hono();
const jobs = new Map<string, { name: string; completedAt: number }>();

app.post('/api/analyze/skill', async (c) => {
  const body = await c.req.json();
  const job_id = `mock-${crypto.randomUUID()}`;
  jobs.set(job_id, { name: body.skill_context?.name ?? 'unknown', completedAt: Date.now() + 500 });
  return c.json({ job_id, status: 'pending' }, 202);
});

app.get('/api/analyze/:id/status', (c) => {
  const id = c.req.param('id');
  const job = jobs.get(id);
  if (!job) return c.json({ error: 'not found' }, 404);
  const done = Date.now() >= job.completedAt;
  return c.json({
    job_id: id,
    status: done ? 'completed' : 'analyzing',
    progress: done ? 100 : 50,
    metrics: { files_total: 1, files_analyzed: done ? 1 : 0, files_failed: 0, files_skipped: 0, llm_calls_made: 1 },
    errors: [],
    warnings: [],
  });
});

app.get('/api/analyze/:id/skill-result', (c) => {
  const id = c.req.param('id');
  const job = jobs.get(id);
  if (!job) return c.json({ error: 'not found' }, 404);
  return c.json({
    job_id: id,
    status: 'completed',
    trust_score: 0.85,
    verdict: 'SAFE',
    skill_context: { name: job.name },
    phase_counts: { sast: 0, instruction_safety: 0, capability_mismatch: 0 },
    findings_total: 0,
    by_phase: { sast: { findings: 0 }, instruction_safety: { findings: 0 }, capability_mismatch: { findings: 0 } },
    by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
    // New client integration fields
    scanned_at: new Date().toISOString(),
    engine_version: 'circle-pack/mock-4.0.0',
    content_safe: true,
    scan_coverage: 'full',
    errors: 0,
    warnings: 0,
  });
});

app.get('/api/analyze/:id/findings', (c) => {
  const id = c.req.param('id');
  if (!jobs.has(id)) return c.json({ error: 'not found' }, 404);
  return c.json({ job_id: id, findings: [], total: 0 });
});

app.get('/health', (c) => c.json({ status: 'healthy', version: 'mock-4.0.0' }));

export default app;
```

---

*Runics asks Circle-IR to analyze skills. Circle-IR returns trust scores, verdicts, and detailed findings. Runics applies its own policy and cascades status to composites.*
