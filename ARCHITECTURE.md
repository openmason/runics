# Runics — Full Architecture & Implementation Spec

> **Purpose:** Single source of truth for Runics: search, sync pipelines, publish API, lifecycle management, and implementation spec for Claude Code.
> **Parent doc:** `cortex-specification.md`
> **Stack:** TypeScript · Cloudflare Workers · Neon Postgres (pgvector) · Workers AI · KV · R2 · Queues · Hyperdrive
> **Date:** March 2026 · v5.0
> **Status:** DECIDED — measure-first, provider-abstracted. Sprint 3a in progress.
> **v5.0 changes:** Status lifecycle (vulnerable/revoked/degraded), version ranking by trust×usage, Circle-IR async scanning, composite trust formula, human-distilled source.

---

## Table of Contents

1. [What Runics Is](#1-what-runics-is)
2. [The Problem](#2-the-problem)
3. [Architecture Overview](#3-architecture-overview)
4. [SearchProvider Abstraction](#4-searchprovider-abstraction)
5. [Layer A: Index-Time Enrichment](#5-layer-a-index-time-enrichment)
6. [Layer B: Query-Time Intelligence](#6-layer-b-query-time-intelligence)
7. [Platform Integration: Skills Table](#7-platform-integration-skills-table)
8. [Database Schema](#8-database-schema)
9. [Ingestion Pipeline](#9-ingestion-pipeline)
10. [Sync Pipelines](#10-sync-pipelines)
11. [Publish API](#11-publish-api)
12. [Query Pipeline](#12-query-pipeline)
13. [Monitoring & Quality Learning](#13-monitoring--quality-learning)
14. [API Surface](#14-api-surface)
15. [Caching Strategy](#15-caching-strategy)
16. [Technology Stack & Cost Model](#16-technology-stack--cost-model)
17. [MVP Build Plan](#17-mvp-build-plan)
18. [Eval Suite](#18-eval-suite)
19. [Migration Triggers](#19-migration-triggers)
20. [Risks & Mitigations](#20-risks--mitigations)
21. [Project Structure](#21-project-structure)
22. [Implementation Notes for Claude Code](#22-implementation-notes-for-claude-code)
23. [Composition & Social Layer](#23-composition--social-layer)

---

## 1. What Runics Is

Runics is the semantic skill registry for the Cortex platform. AI agents discover, evaluate, and compose reusable skills through natural language search.

Skills come from multiple sources: `mcp-registry`, `clawhub`, `github`, `forge`, `human-distilled`, `manual`. Each skill has a schema, auth requirements, trust score, execution layer, verification tier, and lifecycle status.

Agents call `findSkill("make sure we're not shipping GPL code in proprietary product")` and get back ranked, trust-filtered, status-aware results with confidence signals — fast enough to be inline in agent reasoning loops.

**Status awareness (v5.0):** Search automatically excludes `revoked` and `degraded` skills. `vulnerable` skills surface with warning badges, filtered by appetite. The best version per slug is surfaced by trust × usage signal, not newest. Skills are immutable after publish — modifications require a fork.

**Composition & Social layer:** Skills and compositions are first-class registry entities. Any skill or composition can be forked (copy + modify) by humans or agents. Published compositions carry full provenance lineage, creator attribution, and dual-track engagement signals (human and agent metrics kept strictly separate).

---

## 2. The Problem

**The vocabulary gap.** A developer searching for "make sure we're not shipping GPL code" needs to find `cargo-deny`, whose description says "check Rust crate licenses and advisories." A single embedding of the skill description yields only 0.58 cosine similarity against that query.

Target: 0.85+ match quality across diverse phrasing patterns — direct queries, problem descriptions, business language, alternate terminology, and composition contexts.

**Why this is hard:**
- Agents phrase queries as problems, not tool names
- Non-technical users use business language
- Composition queries span multiple skills
- The same capability has many names across ecosystems

---

## 3. Architecture Overview

### Two-Layer Intelligence

```
┌─────────────────────────────────────────────────────────┐
│                    API (Hono Router)                     │
├─────────────────────────────────────────────────────────┤
│              INTELLIGENCE LAYER (we own this)            │
│  ┌──────────────┬──────────────┬──────────────────────┐ │
│  │  Confidence   │  Deep Search │  Composition         │ │
│  │  Gate         │  (Tier 3)    │  Detector            │ │
│  └──────┬───────┴──────┬───────┴──────────┬───────────┘ │
├─────────┼──────────────┼──────────────────┼─────────────┤
│         │    SEARCH PROVIDER INTERFACE     │             │
│         │  search() · index() · delete()  │             │
├─────────┼──────────────┼──────────────────┼─────────────┤
│  ┌──────┴──────────────┴──────────────────┴───────────┐ │
│  │  PgVectorProvider (MVP)                             │ │
│  │  Vector search · Full-text · Score fusion           │ │
│  │  Status-aware filter · Version ranking              │ │
│  └────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────┤
│  Neon Postgres (pgvector) · Workers AI · KV Cache       │
└─────────────────────────────────────────────────────────┘
```

**Layer A (Index-Time):** When a skill is ingested, generate multiple representations (agent summary + alternate query phrasings), embed all of them.

**Layer B (Query-Time):** Confidence-gated LLM fallback. Only fires when vector search results are weak.

### Measure-First Strategy

1. **Phase 1:** Single-vector (agent_summary only) + eval suite → measure baseline
2. **Phase 2:** Intelligence layer (confidence gating, LLM fallback) → measure lift
3. **Phase 3:** Multi-vector, A/B test → measure lift, decide
4. **Phase 4:** Production polish

Every phase has exit criteria based on measured numbers.

---

## 4. SearchProvider Abstraction

```typescript
// src/providers/search-provider.ts

export interface SearchProvider {
  search(
    query: string,
    embedding: number[],
    filters: SearchFilters,
    options?: SearchOptions
  ): Promise<SearchResult>;

  index(skill: SkillInput, embeddings: EmbeddingSet): Promise<void>;

  delete(skillId: string): Promise<void>;

  healthCheck(): Promise<{ ok: boolean; latencyMs: number }>;
}

export interface SearchFilters {
  tenantId: string;
  tags?: string[];
  category?: string;
  minTrustScore?: number;           // from appetite
  executionLayer?: string;
  contentSafetyRequired?: boolean;  // default true

  // v5.0: status lifecycle filters
  allowVulnerable?: boolean;        // default: depends on appetite (balanced=true, cautious=false)
  statusFilter?: SkillStatus[];     // override: specific statuses to include
}

export type SkillStatus =
  | 'draft'
  | 'published'
  | 'deprecated'
  | 'vulnerable'
  | 'revoked'
  | 'degraded'
  | 'contains-vulnerable';

export interface SearchOptions {
  limit?: number;               // default 10
  offset?: number;
  includeMatchText?: boolean;
  slug?: string;                // restrict to versions of a specific slug
  version?: string;             // pin to exact version
}

export interface SearchResult {
  results: ScoredSkill[];
  confidence: ConfidenceSignal;
  meta: SearchMeta;
}

export interface ScoredSkill {
  skillId: string;
  slug: string;
  version: string;
  score: number;                // cosine similarity (0–1)
  fullTextScore: number;        // tsvector rank (0–1)
  fusedScore: number;           // final after fusion
  matchSource: string;          // which embedding type matched
  matchText?: string;

  // v5.0: trust provenance
  trustScore: number;
  verificationTier: 'unverified' | 'scanned' | 'verified' | 'certified';
  trustBadge: 'human-verified' | 'auto-distilled' | 'upstream' | null;

  // v5.0: status
  status: SkillStatus;
  revokedReason?: string;
  remediationMessage?: string;
  remediationUrl?: string;

  // v5.0: composition
  skillType: 'atomic' | 'auto-composite' | 'human-composite' | 'forked';
  forkedFrom?: string;          // 'slug@version'

  // v5.0: usage signal (used for version ranking)
  runCount: number;
  lastRunAt?: string;
}

export interface ConfidenceSignal {
  topScore: number;
  gapToSecond: number;
  clusterDensity: number;
  keywordHits: number;
  tier: 1 | 2 | 3;
}

export interface SearchMeta {
  latencyMs: number;
  vectorSearchMs: number;
  fullTextSearchMs: number;
  fusionStrategy: 'score_blend' | 'rrf';
  totalCandidates: number;
  cacheHit: boolean;
}
```

---

## 5. Layer A: Index-Time Enrichment

### What It Does

When a skill is ingested, generate multiple text representations and embed all of them. Each skill has N vectors in `skill_embeddings` (1 in Phase 1, up to 6 in Phase 3).

### Alternate Query Generation

```typescript
// src/ingestion/alternate-queries.ts — Phase 3 only

const ALTERNATE_QUERY_PROMPT = `You generate search queries that developers or AI agents would use
to find this skill. Generate exactly 5 queries, each using a DIFFERENT strategy:

1. DIRECT: How someone who knows exactly what they want would ask
2. PROBLEM-BASED: How someone describing their problem (not the solution) would ask
3. BUSINESS LANGUAGE: How a non-technical person or PM would describe the need
4. ALTERNATE TERMINOLOGY: Different words for the same concept
5. COMPOSITION: When this skill would be part of a larger workflow

Return exactly 5 queries as a JSON array of strings. Each query 4-10 words. No explanations.`;
```

Human-distilled skills (from Forge Mode 3) skip LLM alt-query generation — the user's own description drives the embedding directly, which produces better queries than LLM inference.

### How the layers multiply

```
SINGLE VECTOR ONLY:
  Query: "make sure we're not shipping GPL code"
  → Matches agent_summary: "check Rust crate licenses" → 0.58 ❌

WITH LAYER A (multi-vector):
  → Matches alt_query_2: "ensure open source compliance" → 0.88 ✅
  → Tier 1, no LLM needed, 50ms

WITH BOTH LAYERS (Layer A missed, Layer B rescues):
  Query: "find out if our code would survive an Oracle audit"
  → Layer A: nothing anticipated "Oracle audit" → top score 0.61
  → Layer B: LLM reasons "Oracle audit = license compliance, commercial/copyleft risk"
  → Re-search finds: license-checker (0.89), spdx-scanner (0.84)
```

---

## 6. Layer B: Query-Time Intelligence

### Confidence-Gated Routing

| Tier | Condition | Latency | ~% | Behavior |
|---|---|---|---|---|
| **Tier 1: High** | Top score > threshold, clear gap | ~50ms | ~70% | Return immediately. $0 LLM cost. |
| **Tier 2: Medium** | Score in middle band | ~50ms initial | ~18% | Return results, stream LLM enrichment async. |
| **Tier 3: Low** | Score below threshold | 500–1000ms | ~9% | Full LLM deep search. |
| **No match** | Tier 3 still poor | 500–1000ms | ~3% | Return generation hints. |

**Thresholds are configurable via env vars and derived from eval data in Phase 1.** The TDR assumed 0.85/0.70 — this may be wrong. Measure first.

### Deep Search (Tier 3)

```typescript
// src/intelligence/deep-search.ts

const DEEP_SEARCH_PROMPT = `You are a search intelligence layer for a skill/tool registry.
A user query got low-confidence results from vector search. Your job:

1. INTENT DECOMPOSITION: Break the query into sub-intents if complex
2. TERMINOLOGY TRANSLATION: Map colloquial/business terms to technical terms
3. CAPABILITY REASONING: Infer what kind of tool would solve this
4. COMPOSITION DETECTION: Detect if this needs multiple skills in sequence

Context: match_source shows WHICH embedding matched best:
- "agent_summary" = matched the skill's main description
- "alt_query_N" = matched a pre-generated alternate query phrasing
If even alternate queries didn't match, the query uses truly novel terminology.

Respond as JSON:
{
  "alternate_queries": string[],
  "terminology_map": Record<string,string>,
  "needs_composition": boolean,
  "composition_parts": string[],
  "capability_hints": string[],
  "reasoning": string
}`;
```

---

## 7. Platform Integration: Skills Table

The `skills` table is the source of truth. Search operates against `skill_embeddings` which references it. **v5.0** expands the status enum, adds skill_type, version lineage, trust provenance, and Cognium scan result fields.

```sql
CREATE TABLE IF NOT EXISTS skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity & versioning
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  changelog JSONB DEFAULT '[]',

  -- v5.0: Expanded status
  -- draft | published | deprecated | vulnerable | revoked | degraded | contains-vulnerable
  -- deprecated = owner-controlled soft deprecation
  -- vulnerable  = Cognium: HIGH/MEDIUM severity finding
  -- revoked     = Cognium: CRITICAL finding or content safety failure
  -- degraded    = derived: composite with a revoked constituent
  -- contains-vulnerable = derived: composite with a vulnerable constituent
  status TEXT NOT NULL DEFAULT 'published'
    CHECK (status IN (
      'draft', 'published', 'deprecated',
      'vulnerable', 'revoked',
      'degraded', 'contains-vulnerable'
    )),

  -- v5.0: Skill type
  skill_type TEXT NOT NULL DEFAULT 'atomic'
    CHECK (skill_type IN ('atomic', 'auto-composite', 'human-composite', 'forked')),

  -- Source & provenance
  source TEXT NOT NULL,
  -- mcp-registry | clawhub | github | forge | human-distilled | manual
  source_url TEXT,
  source_hash TEXT,

  -- Author attribution
  author_id UUID,
  author_type TEXT DEFAULT 'human'
    CHECK (author_type IN ('human', 'bot', 'org')),
  author_bot_model TEXT,
  author_bot_prompt_hash TEXT,

  -- v5.0: Version lineage (immutable after publish)
  forked_from TEXT,             -- 'slug@version' of parent (NULL if original)
  forked_by TEXT,               -- user ID or 'forge'
  fork_changes JSONB,           -- list of human-readable changes
  root_source TEXT,             -- original registry source preserved across forks
                                -- (set at first fork from parent.source; copied from parent.root_source on re-fork)
                                -- used for trust floor lookup to prevent floor regression on fork-of-fork
  fork_changes JSONB,           -- list of human-readable changes from parent

  -- v5.0: Composition
  composition_skill_ids UUID[], -- ordered constituent skill IDs (for composites)

  -- v5.0: Human distillation
  human_distilled_by TEXT,
  human_distilled_at TIMESTAMPTZ,

  -- Content
  description TEXT,
  readme TEXT,
  agent_summary TEXT,           -- LLM-generated, search-optimized
  alternate_queries TEXT[],
  schema_json JSONB,
  auth_requirements JSONB,
  install_method JSONB,
  skill_md TEXT,                -- SKILL.md instructions (L1 skills)
  mcp_url TEXT,                 -- MCP endpoint URL (L0 skills)
  r2_bundle_key TEXT,           -- R2 path for code bundle (L2/L3)
  environment_variables TEXT[], -- declared env vars needed
  capabilities_required TEXT[],
  execution_layer TEXT NOT NULL
    CHECK (execution_layer IN ('mcp-remote', 'instructions', 'worker', 'container', 'composite')),

  -- Discoverability
  tags TEXT[] DEFAULT '{}',
  categories TEXT[] DEFAULT '{}',
  ecosystem TEXT,
  language TEXT,
  license TEXT,

  -- Presentation
  logo_url TEXT,
  homepage_url TEXT,
  demo_url TEXT,
  share_url TEXT GENERATED ALWAYS AS (
    'https://runics.dev/skills/' || slug
  ) STORED,

  -- v5.0: Lifecycle management
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,          -- CVE ID or 'content_safety_failed'
  deprecated_at TIMESTAMPTZ,
  deprecated_reason TEXT,
  remediation_message TEXT,     -- human-readable path forward (from Cognium)
  remediation_url TEXT,         -- link to CVE advisory

  -- v5.0: Trust & Cognium scan results
  trust_score NUMERIC(3,2) DEFAULT 0.5,
  verification_tier TEXT DEFAULT 'unverified'
    CHECK (verification_tier IN ('unverified', 'scanned', 'verified', 'certified')),
  scan_coverage TEXT
    CHECK (scan_coverage IN ('full', 'partial', 'text-only')),
  trust_badge TEXT
    CHECK (trust_badge IN ('human-verified', 'auto-distilled', 'upstream', NULL)),
  cognium_scanned_at TIMESTAMPTZ,
  cognium_findings JSONB,       -- [{severity, cwe_id, tool, title, description, confidence, verdict}]
  analyzer_summary JSONB,       -- per-analyzer result summary
  content_safety_passed BOOLEAN,
  adversarial_tested BOOLEAN DEFAULT FALSE,
  provenance_attested BOOLEAN DEFAULT FALSE,

  -- v5.0: Run signal (for version ranking)
  run_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,

  -- Agent quality signals
  avg_execution_time_ms REAL,
  p95_execution_time_ms REAL,
  error_rate REAL,
  agent_consumption_pattern TEXT
    CHECK (agent_consumption_pattern IN ('standalone', 'always-composed', 'mixed', NULL)),
  schema_compatibility_score REAL,
  replacement_skill_id UUID REFERENCES skills(id),

  -- Human social metrics (separate from agent — never polluted by bots)
  human_star_count INTEGER DEFAULT 0,
  human_fork_count INTEGER DEFAULT 0,
  human_copy_count INTEGER DEFAULT 0,
  human_use_count INTEGER DEFAULT 0,

  -- Agent metrics (raw from live invocations)
  agent_invocation_count BIGINT DEFAULT 0,
  agent_fork_count INTEGER DEFAULT 0,
  composition_inclusion_count INTEGER DEFAULT 0,
  dependent_count INTEGER DEFAULT 0,
  weekly_agent_invocation_count INTEGER DEFAULT 0,

  -- Hybrid/editorial
  featured BOOLEAN DEFAULT FALSE,
  verified_creator BOOLEAN DEFAULT FALSE,
  collection_ids UUID[] DEFAULT '{}',
  tenant_id UUID,

  -- Lifecycle timestamps
  published_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Core search indices
CREATE INDEX idx_skills_trust_score ON skills(trust_score);
CREATE INDEX idx_skills_status ON skills(status);
CREATE INDEX idx_skills_source ON skills(source);
CREATE INDEX idx_skills_slug ON skills(slug);
CREATE INDEX idx_skills_slug_version ON skills(slug, version);
CREATE INDEX idx_skills_execution_layer ON skills(execution_layer);
CREATE INDEX idx_skills_skill_type ON skills(skill_type);
CREATE INDEX idx_skills_tags ON skills USING gin(tags);
CREATE INDEX idx_skills_categories ON skills USING gin(categories);
CREATE INDEX idx_skills_composition_ids ON skills USING gin(composition_skill_ids);
CREATE INDEX idx_skills_run_count ON skills(run_count DESC);
CREATE INDEX idx_skills_weekly_agent ON skills(weekly_agent_invocation_count DESC);
CREATE INDEX idx_skills_human_stars ON skills(human_star_count DESC);
```

### Version Ranking

The default search surfaces the best version per slug using trust × run signal, not newest:

```sql
-- Best version per slug query (used in PgVectorProvider)
SELECT DISTINCT ON (s.slug)
  s.id, s.slug, s.version, s.trust_score, s.run_count, s.status
FROM skills s
WHERE s.slug = :slug
  AND s.status NOT IN ('revoked', 'draft', 'degraded')
  AND (s.tenant_id IS NULL OR s.tenant_id = :tenantId)
ORDER BY
  s.slug,
  (s.trust_score * 0.7 + LEAST(s.run_count::float / 100, 0.3)) DESC;
```

Users can pin to a specific version by including `version` in search options.

### Status Filtering in Search

```typescript
// appetite → status filter policy
function buildStatusFilter(appetite: Appetite): {
  excludedStatuses: SkillStatus[];
  allowVulnerable: boolean;
} {
  const alwaysExclude: SkillStatus[] = ['revoked', 'draft', 'degraded'];

  switch (appetite) {
    case 'strict':
    case 'cautious':
      return {
        excludedStatuses: [...alwaysExclude, 'vulnerable', 'contains-vulnerable'],
        allowVulnerable: false,
      };
    case 'balanced':
    case 'adventurous':
      return {
        excludedStatuses: alwaysExclude,
        allowVulnerable: true,  // vulnerable surfaces with warning badge
      };
  }
}
```

### Trust-Based Filtering

```typescript
export type Appetite = 'strict' | 'cautious' | 'balanced' | 'adventurous';

export function appetiteToTrustThreshold(appetite: Appetite): number {
  switch (appetite) {
    case 'strict':      return 0.85;
    case 'cautious':    return 0.70;
    case 'balanced':    return 0.50;
    case 'adventurous': return 0.20;
  }
}
```

---

## 8. Database Schema

### Migration 0001: skill_embeddings

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS skill_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  embedding vector(384) NOT NULL,
  source TEXT NOT NULL DEFAULT 'agent_summary',
  source_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT valid_source CHECK (
    source IN (
      'agent_summary',
      'alt_query_0', 'alt_query_1', 'alt_query_2',
      'alt_query_3', 'alt_query_4'
    )
  )
);

CREATE INDEX idx_skill_embeddings_hnsw
  ON skill_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);

CREATE INDEX idx_skill_embeddings_skill_id ON skill_embeddings (skill_id);
CREATE INDEX idx_skill_embeddings_tenant_id ON skill_embeddings (tenant_id);

ALTER TABLE skill_embeddings ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', source_text)) STORED;

CREATE INDEX idx_skill_embeddings_tsv ON skill_embeddings USING gin(tsv);
```

### Migration 0002: search_logs

```sql
CREATE TABLE IF NOT EXISTS search_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  query TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  appetite TEXT,
  tier SMALLINT NOT NULL CHECK (tier IN (1, 2, 3)),
  cache_hit BOOLEAN DEFAULT FALSE,
  top_score REAL,
  gap_to_second REAL,
  cluster_density SMALLINT,
  keyword_hits SMALLINT,
  result_count SMALLINT,
  match_source TEXT,
  result_skill_ids TEXT[],
  total_latency_ms REAL,
  vector_search_ms REAL,
  full_text_search_ms REAL,
  fusion_strategy TEXT,
  llm_invoked BOOLEAN DEFAULT FALSE,
  llm_latency_ms REAL,
  llm_model TEXT,
  llm_tokens_used INTEGER,
  embedding_cost REAL DEFAULT 0,
  llm_cost REAL DEFAULT 0,
  alternate_queries_used TEXT[],
  composition_detected BOOLEAN DEFAULT FALSE,
  generation_hint_returned BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_search_logs_timestamp ON search_logs (timestamp DESC);
CREATE INDEX idx_search_logs_tenant ON search_logs (tenant_id, timestamp DESC);
CREATE INDEX idx_search_logs_tier ON search_logs (tier);
CREATE INDEX idx_search_logs_match_source ON search_logs (match_source);
```

### Migration 0003: quality_feedback

```sql
CREATE TABLE IF NOT EXISTS quality_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_event_id UUID REFERENCES search_logs(id),
  skill_id UUID NOT NULL,
  feedback_type TEXT NOT NULL CHECK (
    feedback_type IN ('click', 'use', 'dismiss', 'explicit_good', 'explicit_bad')
  ),
  position SMALLINT NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_feedback_event ON quality_feedback (search_event_id);
CREATE INDEX idx_feedback_skill ON quality_feedback (skill_id);
CREATE INDEX idx_feedback_type ON quality_feedback (feedback_type, timestamp DESC);

CREATE MATERIALIZED VIEW search_quality_summary AS
SELECT
  date_trunc('hour', sl.timestamp) AS hour,
  sl.tier,
  sl.match_source,
  sl.fusion_strategy,
  COUNT(*) AS query_count,
  AVG(sl.top_score) AS avg_top_score,
  AVG(sl.total_latency_ms) AS avg_latency_ms,
  AVG(sl.llm_latency_ms) FILTER (WHERE sl.llm_invoked) AS avg_llm_latency_ms,
  SUM(sl.embedding_cost + sl.llm_cost) AS total_cost,
  COUNT(qf.id) FILTER (WHERE qf.feedback_type = 'use') AS use_count,
  COUNT(qf.id) FILTER (WHERE qf.feedback_type = 'explicit_bad') AS bad_count,
  AVG(qf.position) FILTER (WHERE qf.feedback_type IN ('click', 'use')) AS avg_click_position
FROM search_logs sl
LEFT JOIN quality_feedback qf ON qf.search_event_id = sl.id
GROUP BY 1, 2, 3, 4;

CREATE UNIQUE INDEX idx_quality_summary_pk
  ON search_quality_summary (hour, tier, match_source, fusion_strategy);
```

### Migration 0004: authors

```sql
CREATE TABLE IF NOT EXISTS authors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle TEXT UNIQUE NOT NULL,
  display_name TEXT,
  author_type TEXT NOT NULL DEFAULT 'human'
    CHECK (author_type IN ('human', 'bot', 'org')),
  bio TEXT,
  avatar_url TEXT,
  homepage_url TEXT,
  bot_model TEXT,
  bot_operator_id UUID,
  total_skills_published INTEGER DEFAULT 0,
  total_human_stars_received INTEGER DEFAULT 0,
  total_human_forks_received INTEGER DEFAULT 0,
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_authors_handle ON authors(handle);
CREATE INDEX idx_authors_type ON authors(author_type);
```

### Migration 0005: composition_steps

```sql
CREATE TABLE IF NOT EXISTS composition_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  composition_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  step_order SMALLINT NOT NULL,
  skill_id UUID NOT NULL REFERENCES skills(id),
  step_name TEXT,
  input_mapping JSONB,
  condition JSONB,
  on_error TEXT DEFAULT 'fail'
    CHECK (on_error IN ('fail', 'skip', 'retry')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(composition_id, step_order)
);

CREATE INDEX idx_composition_steps_composition ON composition_steps(composition_id);
CREATE INDEX idx_composition_steps_skill ON composition_steps(skill_id);
```

### Migration 0006: invocation_graph

```sql
CREATE TABLE IF NOT EXISTS skill_invocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id UUID NOT NULL REFERENCES skills(id),
  composition_id UUID REFERENCES skills(id),
  tenant_id TEXT NOT NULL,
  caller_type TEXT NOT NULL DEFAULT 'agent'
    CHECK (caller_type IN ('agent', 'human')),
  duration_ms INTEGER,
  succeeded BOOLEAN NOT NULL,
  invoked_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_invocations_skill ON skill_invocations(skill_id, invoked_at DESC);
CREATE INDEX idx_invocations_composition ON skill_invocations(composition_id);
CREATE INDEX idx_invocations_tenant ON skill_invocations(tenant_id, invoked_at DESC);

CREATE MATERIALIZED VIEW skill_cooccurrence AS
SELECT
  cs1.skill_id AS skill_a,
  cs2.skill_id AS skill_b,
  COUNT(DISTINCT cs1.composition_id) AS composition_count,
  SUM(si.agent_invocation_count) AS total_paired_invocations
FROM composition_steps cs1
JOIN composition_steps cs2
  ON cs1.composition_id = cs2.composition_id
  AND cs1.skill_id < cs2.skill_id
JOIN skills si ON si.id = cs1.composition_id
GROUP BY cs1.skill_id, cs2.skill_id
HAVING COUNT(DISTINCT cs1.composition_id) >= 2;

CREATE UNIQUE INDEX idx_cooccurrence_pk ON skill_cooccurrence(skill_a, skill_b);
CREATE INDEX idx_cooccurrence_skill_a ON skill_cooccurrence(skill_a, total_paired_invocations DESC);
```

### Migration 0007: leaderboards

```sql
CREATE MATERIALIZED VIEW leaderboard_human AS
SELECT
  s.id, s.slug, s.name, s.type,
  a.handle AS author_handle, a.author_type,
  s.human_star_count, s.human_fork_count, s.human_copy_count, s.human_use_count,
  s.fork_depth, s.origin_id, s.trust_score, s.verified_creator, s.featured,
  (s.human_star_count * 3 + s.human_fork_count * 5 + s.human_copy_count * 2 + s.human_use_count) AS human_score
FROM skills s
LEFT JOIN authors a ON a.id = s.author_id
WHERE s.status = 'published'
  AND s.author_type = 'human';

CREATE UNIQUE INDEX idx_leaderboard_human_pk ON leaderboard_human(id);
CREATE INDEX idx_leaderboard_human_score ON leaderboard_human(human_score DESC);

CREATE MATERIALIZED VIEW leaderboard_agent AS
SELECT
  s.id, s.slug, s.name,
  a.handle AS author_handle, a.author_type, a.bot_model,
  s.agent_invocation_count, s.weekly_agent_invocation_count,
  s.composition_inclusion_count, s.dependent_count, s.agent_fork_count,
  s.avg_execution_time_ms, s.error_rate, s.trust_score, s.trust_badge,
  (s.agent_invocation_count * 1
   + s.composition_inclusion_count * 10
   + s.dependent_count * 8
   - COALESCE(s.error_rate, 0) * 1000) AS agent_score
FROM skills s
LEFT JOIN authors a ON a.id = s.author_id
WHERE s.status NOT IN ('revoked', 'degraded', 'draft');

CREATE UNIQUE INDEX idx_leaderboard_agent_pk ON leaderboard_agent(id);
CREATE INDEX idx_leaderboard_agent_score ON leaderboard_agent(agent_score DESC);
CREATE INDEX idx_leaderboard_agent_weekly ON leaderboard_agent(weekly_agent_invocation_count DESC);
```

### Migration 0008: skill lifecycle (v5.0)

```sql
-- 0008_skill_lifecycle.sql
-- Adds status lifecycle, version lineage, trust provenance, Cognium attestation fields.
-- Run after 0007. The skills table may already have trust_score and cognium_scanned_at
-- from earlier migrations — this migration adds the new v5.0 fields.

ALTER TABLE skills
  -- Status lifecycle
  ALTER COLUMN status TYPE TEXT,
  ALTER COLUMN status SET DEFAULT 'published',
  ADD CONSTRAINT skills_status_check CHECK (status IN (
    'draft', 'published', 'deprecated',
    'vulnerable', 'revoked',
    'degraded', 'contains-vulnerable'
  )),
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_reason TEXT,
  ADD COLUMN IF NOT EXISTS deprecated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deprecated_reason TEXT,
  ADD COLUMN IF NOT EXISTS remediation_message TEXT,
  ADD COLUMN IF NOT EXISTS remediation_url TEXT,

  -- Skill type
  ADD COLUMN IF NOT EXISTS skill_type TEXT NOT NULL DEFAULT 'atomic'
    CHECK (skill_type IN ('atomic', 'auto-composite', 'human-composite', 'forked')),

  -- Version lineage (immutable after publish)
  ADD COLUMN IF NOT EXISTS forked_from TEXT,
  ADD COLUMN IF NOT EXISTS forked_by TEXT,
  ADD COLUMN IF NOT EXISTS fork_changes JSONB,
  ADD COLUMN IF NOT EXISTS root_source TEXT,    -- original source preserved across forks, for trust floor lookup

  -- Composition
  ADD COLUMN IF NOT EXISTS composition_skill_ids UUID[],

  -- Human distillation
  ADD COLUMN IF NOT EXISTS human_distilled_by TEXT,
  ADD COLUMN IF NOT EXISTS human_distilled_at TIMESTAMPTZ,

  -- Trust provenance
  ADD COLUMN IF NOT EXISTS verification_tier TEXT DEFAULT 'unverified'
    CHECK (verification_tier IN ('unverified', 'scanned', 'verified', 'certified')),
  ADD COLUMN IF NOT EXISTS scan_coverage TEXT
    CHECK (scan_coverage IN ('full', 'partial', 'text-only')),
  ADD COLUMN IF NOT EXISTS trust_badge TEXT
    CHECK (trust_badge IN ('human-verified', 'auto-distilled', 'upstream', NULL)),
  ADD COLUMN IF NOT EXISTS cognium_findings JSONB,
  ADD COLUMN IF NOT EXISTS analyzer_summary JSONB,

  -- Run signal
  ADD COLUMN IF NOT EXISTS run_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ;

-- New indices
CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status);
CREATE INDEX IF NOT EXISTS idx_skills_slug_version ON skills(slug, version);
CREATE INDEX IF NOT EXISTS idx_skills_skill_type ON skills(skill_type);
CREATE INDEX IF NOT EXISTS idx_skills_composition_ids ON skills USING gin(composition_skill_ids);
CREATE INDEX IF NOT EXISTS idx_skills_run_count ON skills(run_count DESC);
```

---

## 9. Ingestion Pipeline

```typescript
// src/ingestion/embed-pipeline.ts

export class EmbedPipeline {
  constructor(private env: Env) {}

  async processSkill(skill: SkillInput): Promise<EmbeddingSet> {
    const agentSummaryText = skill.agentSummary ?? await this.generateAgentSummary(skill);
    const embedding = await this.embed(agentSummaryText);
    return { agentSummary: { text: agentSummaryText, embedding } };
  }

  // Phase 3 only — multi-vector
  async processSkillMultiVector(skill: SkillInput): Promise<EmbeddingSet> {
    const base = await this.processSkill(skill);

    // Human-distilled: use user-provided alt queries directly (better quality than LLM inference)
    const alternateTexts = skill.source === 'human-distilled' && skill.altQueries
      ? skill.altQueries
      : await this.generateAlternateQueries(skill);

    const embedResult = await this.env.AI.run(this.env.EMBEDDING_MODEL as BaseAiTextEmbeddingModels, {
      text: alternateTexts,
    });

    const alternates = alternateTexts.map((text, i) => ({
      source: `alt_query_${i}`,
      text,
      embedding: (embedResult as any).data[i],
    }));

    return { ...base, alternates };
  }

  async checkContentSafety(skill: SkillInput): Promise<boolean> {
    const textToCheck = `${skill.name} ${skill.description} ${skill.agentSummary ?? ''}`;
    const result = await this.env.AI.run(
      '@cf/meta/llama-guard-3-8b' as BaseAiTextClassificationModels,
      { text: textToCheck }
    );
    return (result as any).response?.toLowerCase().startsWith('safe') ?? false;
  }

  private async generateAgentSummary(skill: SkillInput): Promise<string> { /* ... */ }
  private async generateAlternateQueries(skill: SkillInput): Promise<string[]> { /* ... */ }
  private async embed(text: string): Promise<number[]> { /* ... */ }
}
```

### Full ingestion flow

```
Skill arrives (sync worker / publish API / forge / human-distill)
  │
  ├─ 1. Generate agent_summary (LLM, ~500ms)
  │
  ├─ 2. Content safety check (Workers AI Llama Guard 3 8B, ~50ms)
  │     If unsafe → mark skill content_safety_passed=false, do not index
  │     (interim: pending Circle-IR native content safety support)
  │
  ├─ 3. [Phase 3] Generate 5 alternate queries
  │     Human-distilled: use user's description directly (skip LLM)
  │     Others: LLM generation
  │
  ├─ 4. Embed all texts (Workers AI bge-small, ~30ms batch)
  │     → 1 vector (Phase 1) or up to 6 vectors (Phase 3)
  │
  ├─ 5. Atomic upsert: delete old embeddings, insert new
  │
  └─ 6. Cache TTL handles invalidation (60s)
```

---

## 10. Sync Pipelines

Sync workers poll upstream registries and normalize into the `skills` table. Each adapter runs on a Cloudflare Cron Trigger.

**v5.0 change:** Sync workers no longer set `trust_score` directly. They set `trust_score = 0.5` and `verification_tier = 'unverified'` on insert. Cognium owns all trust score updates after that.

### Common Infrastructure

```typescript
// src/sync/base-sync.ts

export abstract class BaseSyncWorker {
  constructor(protected env: Env) {}

  abstract fetchBatch(cursor?: string): Promise<{ skills: RawSkill[]; nextCursor?: string }>;
  abstract normalize(raw: RawSkill): SkillUpsert;

  async run(): Promise<SyncResult> {
    let cursor: string | undefined;
    let synced = 0, skipped = 0;

    do {
      const batch = await this.fetchBatch(cursor);

      for (const raw of batch.skills) {
        const existing = await this.findBySourceUrl(raw.sourceUrl);
        const hash = sha256(JSON.stringify(raw));
        if (existing?.source_hash === hash) { skipped++; continue; }

        const skill = this.normalize(raw);
        skill.source_hash = hash;
        // v5.0: trust_score NOT set here — Cognium owns it
        // skill arrives at default (0.5, 'unverified') until Cognium scans

        await this.upsertSkill(skill);
        await this.env.EMBED_QUEUE.send({ skillId: skill.id, action: 'embed' });
        await this.env.COGNIUM_QUEUE.send({
          skillId: skill.id,
          priority: 'normal',
          timestamp: Date.now(),
        });

        synced++;
      }

      cursor = batch.nextCursor;
    } while (cursor);

    return { synced, skipped, source: this.sourceName };
  }

  protected abstract get sourceName(): string;

  private async upsertSkill(skill: SkillUpsert): Promise<void> {
    await db.insert(skills)
      .values({
        ...skill,
        trustScore: 0.5,               // default until Cognium scans
        verificationTier: 'unverified', // default until Cognium scans
        status: 'published',           // searchable immediately at default trust
        // trustBadge: set by normalize() — 'upstream' for mcp-registry/clawhub, null for github
      })
      .onConflictDoUpdate({
        target: [skills.source, skills.sourceUrl],
        set: {
          name: skill.name,
          description: skill.description,
          schemaJson: skill.schemaJson,
          executionLayer: skill.executionLayer,
          capabilitiesRequired: skill.capabilitiesRequired,
          sourceHash: skill.sourceHash,
          updatedAt: new Date(),
          // NOTE: do NOT reset trust_score, status, or trust_badge on re-sync
          // Cognium's values are authoritative once set
          // trust_badge reflects provenance — set once at ingest, never changed
        },
      });
  }
}

interface SkillUpsert {
  id?: string;
  name: string;
  slug: string;
  version?: string;
  description: string;
  schemaJson?: Record<string, unknown>;
  executionLayer: string;
  mcpUrl?: string;
  skillMd?: string;
  capabilitiesRequired?: string[];
  source: string;
  sourceUrl: string;
  sourceHash: string;
}
```

### 10.1 MCP Registry Sync

```typescript
export class McpRegistrySync extends BaseSyncWorker {
  protected get sourceName() { return 'mcp-registry'; }

  normalize(raw: McpRegistrySkill): SkillUpsert {
    return {
      name: raw.name,
      slug: slugify(raw.name),
      description: raw.description,
      executionLayer: 'mcp-remote',
      mcpUrl: raw.endpoint,
      capabilitiesRequired: raw.requiredScopes ?? [],
      source: 'mcp-registry',
      sourceUrl: raw.registryUrl,
      sourceHash: '',
      trustBadge: 'upstream',   // mcp-registry skills carry upstream provenance badge
    };
  }
}
```

### 10.2 ClawHub Sync

```typescript
export class ClawHubSync extends BaseSyncWorker {
  protected get sourceName() { return 'clawhub'; }

  normalize(raw: ClawHubSkill): SkillUpsert {
    return {
      name: raw.name,
      slug: slugify(raw.name),
      description: raw.description ?? '',
      executionLayer: raw.hasCode ? 'worker' : 'instructions',
      skillMd: raw.skillMd,
      schemaJson: raw.schema,
      source: 'clawhub',
      sourceUrl: raw.pageUrl,
      sourceHash: '',
      trustBadge: 'upstream',   // clawhub skills carry upstream provenance badge
    };
  }
}
```

### 10.3 GitHub Sync

```typescript
export class GitHubSync extends BaseSyncWorker {
  protected get sourceName() { return 'github'; }

  normalize(raw: GitHubRepo): SkillUpsert {
    return {
      name: raw.name,
      slug: slugify(raw.full_name.replace('/', '-')),
      description: raw.description ?? '',
      executionLayer: 'container',
      capabilitiesRequired: ['git'],
      source: 'github',
      sourceUrl: raw.html_url,
      sourceHash: '',
    };
  }
}
```

### Cron Configuration

```toml
# wrangler.toml
[triggers]
crons = [
  "*/5 * * * *",    # sync-mcp-registry (every 5 min)
  "*/10 * * * *",   # sync-clawhub (every 10 min)
  "*/15 * * * *",   # sync-github (every 15 min)
  "0 3 * * 0",      # weekly prune cron (Sunday 3am)
]
```

### Sync Summary

| Source | Frequency | Trust Default | Notes |
|---|---|---|---|
| MCP Registry | 5 min | 0.5 (Cognium updates) | `mcp-remote` execution layer |
| ClawHub | 10 min | 0.5 (Cognium updates) | ~3,000 skills |
| GitHub | 15 min | 0.5 (Cognium updates) | `container` layer |
| Direct publish | Immediate | 0.5 (Cognium updates) | Forge / manual |
| Human-distilled | Immediate | min(sub-skills)×0.90 | Forge Mode 3 |

---

## 11. Publish API

The Publish API is the write path for Forge (generated/distilled/human-distilled), Cognium (trust + status updates), and manual uploads.

### Endpoints

```typescript
POST   /v1/skills                    // publish a new skill
PUT    /v1/skills/:id                // update existing skill (draft only)
// (no PUT /v1/skills/:id/trust — Cognium Client writes trust directly to DB)
PATCH  /v1/skills/:id/status         // owner-initiated status changes (deprecate/restore)
DELETE /v1/skills/:id                // remove skill (draft only; published = deprecate)
```

### POST /v1/skills

```typescript
app.post('/v1/skills', zValidator('json', publishSkillSchema), async (c) => {
  const input = c.req.valid('json');

  let r2BundleKey: string | undefined;
  if (input.bundle) {
    r2BundleKey = `skills/${input.slug}/${input.version ?? '1.0.0'}/bundle.tar.gz`;
    await c.env.R2_BUCKET.put(r2BundleKey, input.bundle);
  }

  const [inserted] = await db.insert(skills).values({
    name: input.name,
    slug: input.slug,
    version: input.version ?? '1.0.0',
    description: input.description,
    schemaJson: input.schemaJson,
    executionLayer: input.executionLayer,
    mcpUrl: input.mcpUrl,
    skillMd: input.skillMd,
    capabilitiesRequired: input.capabilitiesRequired,
    source: input.source ?? 'manual',
    sourceUrl: input.sourceUrl,
    tenantId: input.tenantId ?? null,
    r2BundleKey,

    // v5.0: skill type and lineage
    skillType: input.skillType ?? 'atomic',
    compositionSkillIds: input.compositionSkillIds,
    forkedFrom: input.forkedFrom,
    forkedBy: input.forkedBy,
    forkChanges: input.forkChanges,
    humanDistilledBy: input.humanDistilledBy,
    humanDistilledAt: input.humanDistilledBy ? new Date() : undefined,
    trustBadge: input.trustBadge,

    // v5.0: trust starts at default — Cognium owns updates
    trustScore: input.trustScore ?? 0.5,
    verificationTier: 'unverified',
    status: 'published',
  }).returning();

  await c.env.EMBED_QUEUE.send({ skillId: inserted.id, action: 'embed' });

  // Enqueue for Cognium (high priority for forge/human-distilled)
  await c.env.COGNIUM_QUEUE.send({
    skillId: inserted.id,
    priority: ['forge', 'human-distilled'].includes(input.source ?? '') ? 'high' : 'normal',
    timestamp: Date.now(),
  });

  return c.json({ id: inserted.id, slug: inserted.slug, version: inserted.version }, 201);
});
```

### Trust Update — Internal (no HTTP callback)

Trust scores, status, and findings are applied directly to the DB by the Cognium poll consumer via `applyScanReport()` in `src/cognium/scan-report-handler.ts`. There is no `PUT /v1/skills/:id/trust` HTTP endpoint — Cognium does not push to Runics; Runics pulls from Circle-IR.


### PATCH /v1/skills/:id/status — Owner-Initiated Status Changes

Owner can only deprecate or restore to published. Cognium controls vulnerable/revoked.

```typescript
app.patch('/v1/skills/:id/status', async (c) => {
  const skillId = c.req.param('id');
  const { status, reason } = await c.req.json();

  // Only owners can deprecate/restore. Cognium controls vulnerable/revoked.
  if (!['deprecated', 'published'].includes(status)) {
    return c.json({ error: 'owners can only set deprecated or published' }, 400);
  }

  await db.update(skills).set({
    status,
    deprecatedAt: status === 'deprecated' ? new Date() : null,
    deprecatedReason: status === 'deprecated' ? reason : null,
    updatedAt: new Date(),
  }).where(eq(skills.id, skillId));

  return c.json({ id: skillId, status });
});
```

### Validation Schema

```typescript
export const publishSkillSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string().optional(),
  description: z.string().min(10).max(2000),
  schemaJson: z.record(z.unknown()).optional(),
  executionLayer: z.enum(['mcp-remote', 'instructions', 'worker', 'container', 'composite']),
  mcpUrl: z.string().url().optional(),
  skillMd: z.string().optional(),
  capabilitiesRequired: z.array(z.string()).optional(),
  source: z.enum(['manual', 'forge', 'human-distilled', 'mcp-registry', 'clawhub', 'github']).optional(),
  sourceUrl: z.string().optional(),
  tenantId: z.string().uuid().optional(),

  // v5.0: new fields
  skillType: z.enum(['atomic', 'auto-composite', 'human-composite', 'forked']).optional(),
  compositionSkillIds: z.array(z.string().uuid()).optional(),
  forkedFrom: z.string().optional(),       // 'slug@version'
  forkedBy: z.string().optional(),
  forkChanges: z.array(z.string()).optional(),
  humanDistilledBy: z.string().optional(),
  trustBadge: z.enum(['human-verified', 'auto-distilled', 'upstream']).optional(),
  trustScore: z.number().min(0).max(1).optional(),
  altQueries: z.array(z.string()).optional(), // provided by Forge Mode 3
  bundle: z.instanceof(ArrayBuffer).optional(),
});
```

---

## 12. Query Pipeline

### Status-Aware Search Query (PgVectorProvider)

The core SQL query is now fully status-aware with version ranking:

```typescript
// src/providers/pgvector-provider.ts

export class PgVectorProvider implements SearchProvider {
  async search(
    query: string,
    embedding: number[],
    filters: SearchFilters,
    options?: SearchOptions,
  ): Promise<SearchResult> {
    const {
      tenantId,
      minTrustScore = 0.5,
      allowVulnerable = true,
      statusFilter,
    } = filters;

    // Build status exclusion list
    const alwaysExclude = ['revoked', 'draft', 'degraded'];
    const excludeStatuses = allowVulnerable
      ? alwaysExclude
      : [...alwaysExclude, 'vulnerable', 'contains-vulnerable'];

    // Full text search for keyword hits
    const tsQuery = plainto_tsquery(query);

    const rows = await db.execute(sql`
      WITH vector_search AS (
        SELECT DISTINCT ON (s.slug)
          se.skill_id,
          s.slug,
          s.version,
          1 - (se.embedding <=> ${embedding}::vector) AS vector_score,
          ts_rank(se.tsv, to_tsquery('english', ${query})) AS ft_score,
          se.source AS match_source,
          se.source_text AS match_text,

          -- Trust × usage rank (best version per slug)
          (s.trust_score * 0.7 + LEAST(s.run_count::float / 100, 0.3)) AS version_rank,

          -- Pass-through fields for ScoredSkill
          s.trust_score,
          s.verification_tier,
          s.trust_badge,
          s.status,
          s.revoked_reason,
          s.remediation_message,
          s.remediation_url,
          s.skill_type,
          s.forked_from,
          s.run_count,
          s.last_run_at

        FROM skill_embeddings se
        JOIN skills s ON se.skill_id = s.id

        WHERE
          -- Status filter (always)
          s.status NOT IN (${sql.join(excludeStatuses.map(s => sql`${s}`), sql`,`)})

          -- Content safety (always)
          AND (s.content_safety_passed IS NOT FALSE)

          -- Trust threshold (appetite)
          AND s.trust_score >= ${minTrustScore}

          -- Tenant scope
          AND (s.tenant_id IS NULL OR s.tenant_id = ${tenantId})

          -- Optional: pin to specific slug
          ${options?.slug ? sql`AND s.slug = ${options.slug}` : sql``}

          -- Optional: pin to specific version
          ${options?.version ? sql`AND s.version = ${options.version}` : sql``}

        ORDER BY
          s.slug,
          version_rank DESC,     -- best version per slug first
          vector_score DESC      -- then best embedding match
      )
      SELECT
        skill_id,
        slug,
        version,
        vector_score,
        ft_score,
        -- Score fusion: vector 70%, full-text 30%
        (vector_score * ${VECTOR_WEIGHT} + COALESCE(ft_score, 0) * ${FULLTEXT_WEIGHT}) AS fused_score,
        match_source,
        match_text,
        trust_score,
        verification_tier,
        trust_badge,
        status,
        revoked_reason,
        remediation_message,
        remediation_url,
        skill_type,
        forked_from,
        run_count,
        last_run_at
      FROM vector_search
      ORDER BY fused_score DESC
      LIMIT ${options?.limit ?? 10}
    `);

    return this.buildSearchResult(rows, embedding);
  }
}
```

### FindSkill Response

```typescript
export interface FindSkillResponse {
  results: SkillResult[];
  confidence: 'high' | 'medium' | 'low_enriched' | 'no_match';
  enriched: boolean;
  enrichmentPromise?: Promise<FindSkillResponse>;
  composition?: CompositionResult;
  searchTrace?: {
    originalQuery: string;
    alternateQueries?: string[];
    terminologyMap?: Record<string, string>;
    reasoning?: string;
  };
  generationHints?: {
    intent: string;
    capabilities: string[];
    complexity: string;
  };
  meta: {
    matchSources: string[];
    latencyMs: number;
    tier: 1 | 2 | 3;
    cacheHit: boolean;
    llmInvoked: boolean;
  };
}

export interface SkillResult {
  id: string;
  name: string;
  slug: string;
  version: string;
  agentSummary: string;

  // Trust
  trustScore: number;
  verificationTier: 'unverified' | 'scanned' | 'verified' | 'certified';
  trustBadge: 'human-verified' | 'auto-distilled' | 'upstream' | null;

  // Status
  status: SkillStatus;
  revokedReason?: string;
  remediationMessage?: string;
  remediationUrl?: string;

  // Execution
  executionLayer: string;
  capabilitiesRequired: string[];

  // Composition
  skillType: 'atomic' | 'auto-composite' | 'human-composite' | 'forked';
  forkedFrom?: string;

  // Usage
  runCount: number;
  lastRunAt?: string;

  // Search signals
  score: number;
  matchSource: string;
  matchText?: string;

  // Deprecation auto-migration
  replacementSkillId?: string;
  replacementSlug?: string;
}
```

### Query flow diagram

```
findSkill("make sure we're not shipping GPL code in proprietary product")
  │
  ├─ Cache check (KV, <5ms) → miss
  │
  ├─ Embed query (Workers AI bge-small, ~5ms)
  │
  ├─ Provider.search() (Neon/Hyperdrive, ~30ms)
  │   Status filter: exclude revoked/draft/degraded
  │   Appetite (balanced): allowVulnerable = true
  │   Trust threshold: >= 0.50
  │   Version ranking: trust×0.7 + usage×0.3 per slug
  │   DISTINCT ON slug: best version per skill surfaced
  │   Includes match_source, status, trustBadge
  │
  ├─ Score fusion: vector (0.7) + full-text (0.3)
  │
  ├─ Confidence assessment:
  │   Top: 0.88, Gap: 0.12, Cluster: 3 above 0.80
  │   → TIER 1: HIGH CONFIDENCE
  │
  └─ Return ~50ms:
      {
        results: [
          { slug: "cargo-deny", version: "1.0.0", score: 0.88,
            trustScore: 0.92, verificationTier: "verified",
            trustBadge: "upstream", status: "published",
            matchSource: "alt_query_2" }
        ],
        confidence: "high",
        meta: { tier: 1, llmInvoked: false, latencyMs: 48 }
      }
```

---

## 13. Monitoring & Quality Learning

### Search Logger

Every search event logged to `search_logs`. Non-blocking via `waitUntil()`.

### Quality Tracker

```typescript
export class QualityTracker {
  // Record feedback
  async recordFeedback(feedback: QualityFeedback): Promise<void>;

  // Analytics
  async getTierDistribution(hours: number): Promise<TierDistribution>;
  async getMatchSourceStats(hours: number): Promise<MatchSourceStats[]>;
  async getLatencyPercentiles(hours: number): Promise<LatencyPercentiles>;
  async getCostBreakdown(hours: number): Promise<CostBreakdown>;
  async getFailedQueries(hours: number, limit: number): Promise<FailedQuery[]>;
  async getTier3Patterns(hours: number): Promise<Tier3Pattern[]>;

  // v5.0: status-related analytics
  async getRevokedSkillImpact(): Promise<{ revokedCount: number; affectedSearches30d: number }>;
  async getVulnerableSkillUsage(): Promise<{ vulnerableCount: number; appearedInSearch30d: number }>;
  async refreshSummary(): Promise<void>;
}
```

### Quality Learning Loop

```
search_logs + quality_feedback
  │
  ├─ match_source stats → Which alt_query types drive usage?
  ├─ Tier distribution → Are confidence thresholds correct?
  ├─ Failed queries → Vocabulary gaps → new alt query categories
  ├─ Cost breakdown → LLM spend within budget?
  ├─ Latency percentiles → SLOs met?
  │
  └─ v5.0 additions:
      ├─ Revoked skill impact → How many searches were disrupted?
      │   (helps prioritize fix speed)
      └─ Vulnerable skill usage → Are users knowingly using flagged skills?
```

---

## 14. API Surface

```typescript
// ── Search ──
POST   /v1/search                       // findSkill — main endpoint
POST   /v1/search/feedback              // record quality feedback

// ── Publish ──
POST   /v1/skills                       // publish a new skill
PUT    /v1/skills/:id                   // update skill (draft only)
// (no PUT /v1/skills/:id/trust — Cognium poll consumer writes via applyScanReport())
PATCH  /v1/skills/:id/status            // owner: deprecate / restore to published
DELETE /v1/skills/:id                   // remove (draft only; published = deprecate)

// ── Versions ──
GET    /v1/skills/:slug/versions        // all versions of a skill slug
GET    /v1/skills/:slug/:version        // specific version

// ── Composition ──
POST   /v1/skills/:id/fork              // fork → new version, trust resets
POST   /v1/skills/:id/copy              // shallow copy (no lineage tracking)
POST   /v1/skills/:id/extend            // add steps to existing composition
POST   /v1/compositions                 // create named composition from skill list
GET    /v1/compositions/:id             // get composition with steps
PUT    /v1/compositions/:id/steps       // replace step list
POST   /v1/compositions/:id/publish     // publish a draft composition

// ── Lineage ──
GET    /v1/skills/:id/lineage           // full fork ancestry tree
GET    /v1/skills/:id/forks             // direct forks
GET    /v1/skills/:id/dependents        // compositions that include this skill

// ── Social (human only) ──
POST   /v1/skills/:id/star
DELETE /v1/skills/:id/star
GET    /v1/skills/:id/stars

// ── Agent Signals ──
POST   /v1/invocations                  // record skill invocations (bulk)
GET    /v1/skills/:id/cooccurrence      // top skills used alongside this one

// ── Leaderboards ──
GET    /v1/leaderboards/human
GET    /v1/leaderboards/agents
GET    /v1/leaderboards/trending
GET    /v1/leaderboards/most-forked
GET    /v1/leaderboards/most-composed

// ── Authors ──
GET    /v1/authors/:handle
GET    /v1/authors/:handle/skills

// ── Ingestion (internal) ──
POST   /v1/skills/:skillId/index        // re-index a skill

// ── Analytics (internal/admin) ──
GET    /v1/analytics/tiers
GET    /v1/analytics/match-sources
GET    /v1/analytics/latency
GET    /v1/analytics/cost
GET    /v1/analytics/failed-queries
GET    /v1/analytics/tier3-patterns
GET    /v1/analytics/revoked-impact     // v5.0
GET    /v1/analytics/vulnerable-usage   // v5.0

// ── Eval ──
POST   /v1/eval/run
GET    /v1/eval/results/:runId

// ── Health ──
GET    /health
```

### Search request/response

```typescript
// POST /v1/search
{
  "query": "make sure we're not shipping GPL code in proprietary product",
  "tenantId": "tenant-123",
  "appetite": "balanced",    // optional, default "balanced"
  "tags": ["rust"],
  "category": "security",
  "limit": 10,
  "version": "1.0.0"         // optional: pin to specific version
}

// Response: FindSkillResponse
```

---

## 15. Caching Strategy

```typescript
// src/cache/kv-cache.ts

export class SearchCache {
  // Key: SHA-256 of normalized (tenantId + query + appetite + allowVulnerable)
  // Value: serialized FindSkillResponse

  async get(query: string, tenantId: string, appetite: string): Promise<FindSkillResponse | null>;
  async set(query: string, tenantId: string, appetite: string, result: FindSkillResponse): Promise<void>;

  // v5.0: invalidate when a skill's status changes
  // Called by trust update endpoint after revocation
  async invalidateBySlug(slug: string): Promise<void>;
}
```

**TTL strategy:**
- Tier 1 results: 60s
- Tier 2/3 results: 30s
- **v5.0: Status changes (revoke/flag) invalidate cache for affected slug immediately**. KV doesn't support prefix-delete, so maintain a `revoked_slugs` KV key (set) updated on revoke; cache reads check this list first.

---

## 16. Technology Stack & Cost Model

### Stack

| Component | Technology | Purpose |
|---|---|---|
| Search index | Neon Postgres + pgvector (HNSW) + tsvector | Vector + full-text search |
| Embeddings | Workers AI bge-small-en-v1.5 (384 dim) | Query + skill embedding |
| Reranker | Workers AI bge-reranker-base | Cross-encoder reranking (Phase 4) |
| LLM | Workers AI Llama 3.3 70B Instruct FP8 | Agent summary, alt queries, deep search |
| Content safety | Workers AI Llama Guard 3 8B | Ingest-time check (interim; pending Circle-IR support) |
| API layer | Cloudflare Workers + Hono | Request handling |
| Connection pool | Hyperdrive | Postgres connection pooling |
| Cache | Cloudflare KV (60s TTL) | Query result caching |

### Monthly cost (100K skills, 10K queries/day)

| Component | Cost |
|---|---|
| Neon Postgres Pro (10GB) | $19/mo |
| Workers AI (embeddings + LLM) | ~$18/mo |
| Cloudflare Workers compute | ~$5/mo |
| **Total** | **~$42/month** |

### Query-time cost breakdown

| Tier | Daily queries | Per-query cost | Daily cost |
|---|---|---|---|
| Tier 1 (70%) | 7,000 | ~$0.0000004 | ~$0.003 |
| Tier 2 (18%) | 1,800 | ~$0.0001 | ~$0.18 |
| Tier 3 (9%) | 900 | ~$0.0003 | ~$0.27 |
| No match (3%) | 300 | ~$0.0005 | ~$0.15 |
| **Daily total** | | | **~$0.60** |

### Storage

```
Phase 1:  100K skills × 1 embedding  × 384d × 4B = ~150MB + HNSW ~300MB
Phase 3:  100K skills × 6 embeddings × 384d × 4B = ~920MB + HNSW ~1.8GB
Both within Neon Pro 10GB limit.
```

---

## 17. MVP Build Plan

### Phase 1: Foundation + Eval (Week 1)

- [ ] `wrangler.toml` with all Cloudflare bindings
- [ ] Drizzle schema + migrations 0001–0003
- [ ] `SearchProvider` interface (with v5.0 `SearchFilters`)
- [ ] `PgVectorProvider` — single-vector, status-aware filter, version ranking
- [ ] `EmbedPipeline.processSkill()`
- [ ] `EmbedPipeline.checkContentSafety()`
- [ ] `SearchCache` — KV with TTL + slug invalidation
- [ ] `SearchLogger` — log every search event (non-blocking)
- [ ] `PerfMonitor` — structured timing
- [ ] Hono router: `/v1/search`, `/v1/skills/:id/index`, `/health`
- [ ] Trust filtering (`appetite` → `minTrustScore` + status exclusion)
- [ ] **Eval suite: 100+ query/skill pairs, Recall@1, Recall@5, MRR**
- [ ] **Run eval → record baseline numbers**
- [ ] **Derive tier thresholds from actual score distribution**

**Exit criteria:** Baseline measured. Status filter tested. Version ranking verified. p50 < 60ms.

### Phase 2: Intelligence Layer (Week 2)

- [ ] `ConfidenceGate` — full tier routing
- [ ] Tier 2 async enrichment
- [ ] Tier 3 deep search
- [ ] `CompositionDetector`
- [ ] `QualityTracker.recordFeedback()` + feedback endpoint
- [ ] Analytics endpoints
- [ ] **Re-run eval with LLM fallback → measure lift**

### Phase 3: Multi-Vector Validation (Week 3)

- [ ] `EmbedPipeline.processSkillMultiVector()`
- [ ] Human-distilled alt query passthrough (skip LLM generation)
- [ ] **A/B test: single-vector vs multi-vector vs single + query expansion**
- [ ] **Decision: keep multi-vector if lift ≥ 5% over query expansion**

### Phase 4: Production Polish (Week 4)

- [ ] Cross-encoder reranking (bge-reranker-base, optional per-query)
- [ ] Score-based fusion vs RRF A/B test
- [ ] Rate limiting on search endpoint
- [ ] Error handling: retries, circuit breaker
- [ ] Load test: p50 < 60ms, p99 < 500ms

### Phase 5: Sync Pipelines & Publish API (Weeks 5–6)

- [ ] `BaseSyncWorker` — v5.0: no trust_score set on sync
- [ ] `McpRegistrySync`, `ClawHubSync`, `GitHubSync` adapters
- [ ] `POST /v1/skills` — full publishSkillSchema with v5.0 fields
- [ ] Cognium poll consumer writes trust scores directly via `applyScanReport()` — no HTTP callback endpoint
- [ ] `PATCH /v1/skills/:id/status` — owner deprecate/restore
- [ ] `GET /v1/skills/:slug/versions` — version listing
- [ ] Queue integration: EMBED_QUEUE + COGNIUM_QUEUE (submit) + COGNIUM_POLL_QUEUE producers; COGNIUM_JOBS KV namespace
- [ ] Migration 0008 (lifecycle columns)
- [ ] Cache invalidation on status change

### Phase 6: Lifecycle & Composition (Sprint 4, alongside Cognium)

- [ ] Migrations 0004–0008
- [ ] `POST /v1/skills/:id/fork` — v5.0: trust resets, provenance set
- [ ] `POST /v1/compositions` — v5.0: trust = min(constituents) × 0.90
- [ ] `POST /v1/compositions/:id/publish` — composition status machine
- [ ] Dual-track social model (stars, invocations)
- [ ] Leaderboard materialized views
- [ ] Co-occurrence map

---

## 18. Eval Suite

The eval suite is a Phase 1 deliverable. No match quality number drives architecture decisions until validated here.

```typescript
export interface EvalFixture {
  id: string;
  query: string;
  expectedSkillId: string;
  pattern: 'direct' | 'problem' | 'business' | 'alternate' | 'composition';
}

export interface EvalMetrics {
  recall1: number;
  recall5: number;
  mrr: number;
  avgTopScore: number;
  tierDistribution: Record<1 | 2 | 3, number>;
  byPattern: Record<string, { recall5: number; mrr: number }>;

  // v5.0 additions
  statusFilterAccuracy: number;    // % of vulnerable/revoked correctly excluded
  versionRankingAccuracy: number;  // % of queries where best-trust version surfaced first
}
```

The eval runner hits the live search endpoint and computes metrics. Results stored for comparison across phases.

---

## 19. Migration Triggers

### Add Meilisearch when:
- User-facing search UI needed (InstantSearch.js)
- Typo tolerance critical
- Faceted/filtered search with counts

### Swap to Qdrant when:
- pgvector HNSW latency > 30ms consistently
- Scale past 1M skills

### Upgrade embedding model when:
- Eval shows baseline match rate < 65% with bge-small
- Newer models close vocabulary gap meaningfully

---

## 20. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Baseline match rate < 60% | Tier 3 over-triggered, cost breaks | Eval catches in Week 1. Investigate model upgrade or HyDE. |
| Multi-vector lift < 5% | 6x storage for marginal gain | Phase 3 A/B test validates. Query expansion as alternative. |
| Status filter false exclusions | Good skills excluded when vulnerable | `allowVulnerable=true` for balanced/adventurous. Vulnerable skills searchable with badge, not hidden. |
| Version ranking surfacing wrong version | Old/low-trust version shown despite better newer version | Formula is trust×0.7 + usage×0.3. New versions catch up quickly once they earn runs. |
| Cache staleness after revocation | Revoked skill appears in search results up to 60s | Slug-based KV invalidation on revoke. Acceptable window for MVP; reduce TTL if needed. |
| Confidence thresholds wrong | Over/under-triggering Tier 3 | Derive from eval data. Monitor daily. |
| LLM cost escalation | Tier 2/3 more expensive than projected | Conservative thresholds. KV caching deduplicates. |

---

## 21. Project Structure

```
runics/
├── wrangler.toml
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── src/
│   ├── index.ts                          # Worker entry, Hono router, scheduled handler
│   ├── types.ts                          # All shared types (SkillStatus, SearchFilters, etc.)
│   │
│   ├── providers/
│   │   ├── search-provider.ts            # SearchProvider interface (v5.0)
│   │   └── pgvector-provider.ts          # PgVector: status filter, version ranking
│   │
│   ├── intelligence/
│   │   ├── confidence-gate.ts            # Tier routing + findSkill orchestration
│   │   ├── deep-search.ts                # Tier 3 LLM reasoning
│   │   └── composition-detector.ts       # Multi-skill query detection
│   │
│   ├── ingestion/
│   │   ├── embed-pipeline.ts             # Skill → embedding pipeline
│   │   ├── agent-summary.ts              # LLM summary generation
│   │   ├── alternate-queries.ts          # Multi-vector query generation
│   │   └── content-safety.ts            # Llama Guard classification (interim — remove when Circle-IR adds native content safety)
│   │
│   ├── composition/
│   │   ├── fork.ts                       # Fork: lineage + trust reset
│   │   ├── compose.ts                    # Composition: trust = min×0.90
│   │   ├── extend.ts                     # Extend: append steps
│   │   ├── lineage.ts                    # Ancestry tree queries
│   │   ├── publish.ts                    # Draft → published state machine
│   │   └── schema.ts                     # Zod schemas
│   │
│   ├── social/
│   │   ├── stars.ts                      # Human only, rate-limited
│   │   ├── invocations.ts                # Agent invocation (bulk)
│   │   ├── cooccurrence.ts               # Co-occurrence map
│   │   └── leaderboards.ts               # Human / agent / trending
│   │
│   ├── authors/
│   │   └── handler.ts
│   │
│   ├── sync/
│   │   ├── base-sync.ts                  # BaseSyncWorker (v5.0: no trust_score on sync)
│   │   ├── mcp-registry.ts
│   │   ├── clawhub.ts
│   │   └── github.ts
│   │
│   ├── publish/
│   │   ├── handler.ts                    # POST /v1/skills, PUT trust, PATCH status
│   │   └── schema.ts                     # publishSkillSchema
│   │
│   ├── cognium/
│   │   ├── queue-consumer.ts             # HTTP client → Cognium Server
│   │   ├── request-builder.ts            # Skill → ScanRequest (no source/priority/composite)
│   │   ├── scoring-policy.ts             # Runics trust formula, severity→status, tier, remediation
│   │   ├── scan-report-handler.ts        # Apply Circle-IR findings → trust + status (in src/cognium/)
│   │   ├── composite-cascade.ts          # Cascade status to composites
│   │   ├── notification-trigger.ts       # Webhook to Activepieces on revoke/flag
│   │   └── types.ts                      # CogniumSubmitMessage, CogniumPollMessage, ScanFinding, CircleIRFinding
│   │
│   ├── monitoring/
│   │   ├── search-logger.ts
│   │   ├── quality-tracker.ts            # + v5.0 status analytics
│   │   └── perf-monitor.ts
│   │
│   ├── cache/
│   │   └── kv-cache.ts                   # + slug-based invalidation (v5.0)
│   │
│   ├── db/
│   │   ├── schema.ts                     # Drizzle schema (v5.0 columns)
│   │   └── migrations/
│   │       ├── 0001_skill_embeddings.sql
│   │       ├── 0002_search_logs.sql
│   │       ├── 0003_quality_feedback.sql
│   │       ├── 0004_authors.sql
│   │       ├── 0005_compositions.sql
│   │       ├── 0006_invocation_graph.sql
│   │       ├── 0007_leaderboards.sql
│   │       └── 0008_skill_lifecycle.sql  ← NEW (v5.0)
│   │
│   └── eval/
│       ├── runner.ts
│       ├── fixtures.ts                   # 100+ query/skill pairs + v5.0 status fixtures
│       └── metrics.ts                    # + statusFilterAccuracy, versionRankingAccuracy
│
├── scripts/
│   ├── seed-eval-corpus.ts
│   └── run-eval.ts
│
└── tests/
    ├── providers/pgvector-provider.test.ts  # + status filter + version ranking tests
    ├── intelligence/confidence-gate.test.ts
    ├── composition/fork.test.ts             # + trust reset test
    ├── composition/compose.test.ts          # + min×0.90 trust test
    ├── cognium/scan-report-handler.test.ts  # + cascade test
    ├── cognium/composite-cascade.test.ts    ← NEW (v5.0)
    ├── publish/handler.test.ts              # + publish schema test (v5.0)
    ├── social/leaderboards.test.ts
    ├── social/invocations.test.ts
    ├── sync/mcp-registry.test.ts
    ├── sync/clawhub.test.ts
    └── monitoring/quality-tracker.test.ts
```

---

## 22. Implementation Notes for Claude Code

### Critical decisions

1. **Use `@neondatabase/serverless` or Hyperdrive HTTP driver**, not `pg`. Standard `pg` doesn't work in Workers.

2. **SearchProvider interface is sacred.** Never import Postgres types outside `pgvector-provider.ts`.

3. **Logging is non-blocking.** Use `c.executionCtx.waitUntil()` for all writes to `search_logs`.

4. **Every threshold is configurable.** Tier boundaries, fusion weights, cache TTL — all from env vars.

5. **Content safety runs on ingest, not query.** Llama Guard sets `content_safety_passed = false` at ingest → excluded via WHERE filter. Interim until Circle-IR adds native content safety.

6. **The skills table already exists.** The search service creates `skill_embeddings`, `search_logs`, `quality_feedback`. It reads from `skills` but adds columns via migration 0008.

7. **Status filter is not optional.** `revoked`, `draft`, `degraded` are always excluded. `vulnerable` exclusion depends on appetite.

8. **Version ranking, not newest.** `ORDER BY trust×0.7 + min(run_count/100, 1.0)×0.3`. Never `ORDER BY created_at DESC`.

9. **Trust is Cognium's responsibility.** Sync workers do NOT set trust_score. `0.5 / unverified` is the default until Cognium scans.

10. **Eval runs before and after every change.** Numbers only — no "feels better."

### Cloudflare bindings

```toml
name = "runics"
main = "src/index.ts"
compatibility_date = "2025-02-01"

[observability]
enabled = true

[[kv_namespaces]]
binding = "SEARCH_CACHE"
id = "<kv-namespace-id>"

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<hyperdrive-id>"

[[r2_buckets]]
binding = "R2_BUCKET"
bucket_name = "runics-skills"

[[queues.producers]]
binding = "EMBED_QUEUE"
queue = "runics-embed"

[[queues.producers]]
binding = "COGNIUM_QUEUE"
queue = "runics-cognium"

[[queues.producers]]
binding = "COGNIUM_POLL_QUEUE"
queue = "runics-cognium-poll"

[[queues.consumers]]
queue = "runics-embed"
max_batch_size = 10
max_batch_timeout = 30

[[queues.consumers]]
queue = "runics-cognium"
max_batch_size = 5
max_batch_timeout = 30
max_retries = 2
dead_letter_queue = "cognium-dlq"

[[queues.consumers]]
queue = "runics-cognium-poll"
max_batch_size = 10
max_batch_timeout = 30
max_retries = 0                     # self-manages retries via delayed re-enqueue
dead_letter_queue = "cognium-poll-dlq"

[[kv_namespaces]]
binding = "COGNIUM_JOBS"
id = "..."                          # stores job state: cognium:job:{skillId}

[triggers]
crons = [
  "*/5 * * * *",
  "*/10 * * * *",
  "*/15 * * * *",
  "0 3 * * 0",     # weekly prune (Forge auto-distilled cleanup)
]

[ai]
binding = "AI"

[vars]
ENVIRONMENT = "production"
EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5"
RERANKER_MODEL = "@cf/baai/bge-reranker-base"
LLM_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
SAFETY_MODEL = "@cf/meta/llama-guard-3-8b"
CONFIDENCE_TIER1_THRESHOLD = "0.85"
CONFIDENCE_TIER2_THRESHOLD = "0.70"
CACHE_TTL_SECONDS = "60"
DEFAULT_APPETITE = "balanced"
VECTOR_WEIGHT = "0.7"
FULLTEXT_WEIGHT = "0.3"
VERSION_TRUST_WEIGHT = "0.7"
VERSION_USAGE_WEIGHT = "0.3"
COGNIUM_URL = "https://circle.cognium.net"
COGNIUM_POLL_DELAY_MS = "15000"
COGNIUM_MAX_POLL_ATTEMPTS = "12"
```

### Dependencies

```json
{
  "dependencies": {
    "hono": "^4.0.0",
    "@neondatabase/serverless": "^0.10.0",
    "drizzle-orm": "^0.38.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.0.0",
    "drizzle-kit": "^0.30.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "wrangler": "^3.100.0"
  }
}
```

### HNSW performance reference

```
100K skills × 1 embedding:   ~5ms query,   ~300MB memory
100K skills × 6 embeddings:  ~8-12ms query, ~1.8GB memory
HNSW: m=16, ef_construction=128 — scales O(log N)
```

---

## 23. Composition & Social Layer

### Overview

Skills and compositions are the same entity stored in the `skills` table (`skill_type: 'atomic' | 'auto-composite' | 'human-composite' | 'forked'`). A composition is a named, versioned, ordered set of skill references stored in `composition_steps`.

**v5.0 key changes:**
- Fork trust always resets — no inheritance from parent
- Composition trust = min(constituent scores) × 0.90 (not min() alone)
- Human-distilled composites get `trustBadge: 'human-verified'`
- Revoked/vulnerable status cascades to composites

### 23.1 Operations

| Operation | Lineage | Author | Trust |
|---|---|---|---|
| **Fork** | Yes — `forked_from` set | Forker | Resets to source floor |
| **Copy** | No — `forked_from = null` | Copier | Resets to source floor |
| **Extend** | Yes — fork + append | Extender | Resets to source floor |
| **Compose** | N/A | Composer | min(constituents) × 0.90 |
| **Human-distill** | Yes — `forked_from` if applicable | User | min(constituents) × 0.90 |

### 23.2 Fork Handler (v5.0)

Trust resets on fork. No parent trust inheritance.

```typescript
// src/composition/fork.ts

export async function forkSkill(
  sourceId: string,
  authorId: string,
  changes: string[],
  db: Pool,
): Promise<ForkResult> {
  const source = await db.query(`SELECT * FROM skills WHERE id = $1`, [sourceId]);
  if (!source.rows[0]) throw new NotFoundError();

  // v5.0: trust resets to source floor — no inheritance
  // root_source tracks the original registry source across all fork generations.
  // Fork of mcp-registry skill: root_source = 'mcp-registry' (floor: 0.80)
  // Fork-of-fork: root_source still = 'mcp-registry' (no regression to 0.50)
  const BASE_TRUST: Record<string, number> = {
    'mcp-registry': 0.80, 'clawhub': 0.65, 'github': 0.55,
    'forge': 0.40, 'human-distilled': 0.50, 'manual': 0.60,
  };
  const originSource = source.rows[0].root_source ?? source.rows[0].source;
  const resetTrust = BASE_TRUST[originSource] ?? 0.40;

  // Increment version
  const nextVersion = incrementPatch(source.rows[0].version);  // 1.0.0 → 1.0.1

  const fork = await db.query(`
    INSERT INTO skills (
      name, slug, version, skill_type, status,
      description, readme, schema_json, execution_layer,
      tags, categories, ecosystem, license,
      author_id, author_type,
      forked_from, forked_by, fork_changes,
      root_source,
      trust_score, verification_tier, trust_badge,
      run_count,
      capabilities_required, source
    ) VALUES (
      $1, $2, $3, 'forked', 'draft',
      $4, $5, $6, $7,
      $8, $9, $10, $11,
      $12, 'human',
      $13, $14, $15,
      $16,
      $17, 'unverified', NULL,
      0,
      $18, 'human-distilled'
    ) RETURNING id, slug, version`,
    [
      `${source.rows[0].name}`,           // keep original name
      source.rows[0].slug,                // same slug, different version
      nextVersion,
      source.rows[0].description,
      source.rows[0].readme,
      source.rows[0].schema_json,
      source.rows[0].execution_layer,
      source.rows[0].tags,
      source.rows[0].categories,
      source.rows[0].ecosystem,
      source.rows[0].license,
      authorId,
      `${source.rows[0].slug}@${source.rows[0].version}`,  // forked_from
      authorId,
      JSON.stringify(changes),            // fork_changes
      originSource,                       // root_source: preserved across all fork generations
      resetTrust,                         // trust reset — not inherited
      source.rows[0].capabilities_required,
    ]
  );

  // Copy composition steps if source is composite.
  // INVARIANT: composition_skill_ids array must match composition_steps rows.
  // Always update both together — the array is a denorm for fast cascade queries.
  if (['auto-composite', 'human-composite'].includes(source.rows[0].skill_type)) {
    await db.query(`
      INSERT INTO composition_steps (composition_id, step_order, skill_id, input_mapping, condition, on_error)
      SELECT $1, step_order, skill_id, input_mapping, condition, on_error
      FROM composition_steps WHERE composition_id = $2`,
      [fork.rows[0].id, sourceId]
    );
    // Sync composition_skill_ids array from the copied steps
    await db.query(`
      UPDATE skills SET composition_skill_ids = (
        SELECT ARRAY_AGG(skill_id ORDER BY step_order)
        FROM composition_steps WHERE composition_id = $1
      ) WHERE id = $1`,
      [fork.rows[0].id]
    );
  }
      FROM composition_steps WHERE composition_id = $2`,
      [fork.rows[0].id, sourceId]
    );
  }

  // Increment human fork count on source
  await db.query(
    `UPDATE skills SET human_fork_count = human_fork_count + 1 WHERE id = $1`,
    [sourceId]
  );

  return {
    id: fork.rows[0].id,
    slug: fork.rows[0].slug,
    version: fork.rows[0].version,
    forkedFrom: `${source.rows[0].slug}@${source.rows[0].version}`,
    trustScore: resetTrust,
    status: 'draft',
  };
}
```

### 23.3 Composition Builder (v5.0)

Composition trust = min(constituent scores) × 0.90.

```typescript
// src/composition/compose.ts

export async function createComposition(
  input: CompositionInput,
  db: Pool,
): Promise<{ id: string; slug: string }> {
  // 1. Validate all constituent skills exist, are published or deprecated (not revoked)
  const constituents = await db.query(
    `SELECT id, trust_score, status FROM skills WHERE id = ANY($1)`,
    [input.steps.map(s => s.skillId)]
  );

  const invalidConstituents = constituents.rows.filter(c =>
    ['revoked', 'degraded', 'draft'].includes(c.status)
  );
  if (invalidConstituents.length > 0) {
    throw new Error(`Cannot compose revoked or draft skills: ${invalidConstituents.map(c => c.id).join(', ')}`);
  }

  // 2. v5.0: trust = min(constituents) × 0.90 (composition discount)
  const minTrust = Math.min(...constituents.rows.map(c => parseFloat(c.trust_score)));
  const compositionTrust = Math.round(minTrust * 0.90 * 100) / 100;

  // 3. Trust badge based on author type
  const trustBadge = input.authorType === 'human' ? 'human-verified' : 'auto-distilled';

  // 4. Determine composition status — if any constituent is vulnerable, start as contains-vulnerable
  const hasVulnerable = constituents.rows.some(c =>
    ['vulnerable', 'contains-vulnerable'].includes(c.status)
  );

  // 5. Insert skill row
  const composition = await db.query(`
    INSERT INTO skills (
      name, slug, version, skill_type, status,
      description, execution_layer,
      author_id, author_type,
      trust_score, verification_tier, trust_badge,
      composition_skill_ids,
      human_distilled_by, human_distilled_at,
      run_count, source, tenant_id
    ) VALUES (
      $1, $2, '1.0.0', $3, $4,
      $5, 'composite',
      $6, $7,
      $8, 'scanned', $9,
      $10,
      $11, $12,
      0, $13, $14
    ) RETURNING id, slug`,
    [
      input.name,
      slugify(input.name),
      input.authorType === 'human' ? 'human-composite' : 'auto-composite',
      hasVulnerable ? 'contains-vulnerable' : 'published',
      input.description,
      input.authorId,
      input.authorType,
      compositionTrust,           // min × 0.90
      trustBadge,
      input.steps.map(s => s.skillId),
      input.authorType === 'human' ? input.authorId : null,
      input.authorType === 'human' ? new Date() : null,
      input.authorType === 'human' ? 'human-distilled' : 'forge',
      input.tenantId ?? null,
    ]
  );

  // 6. Insert composition steps, then sync composition_skill_ids array.
  // INVARIANT: composition_skill_ids must always match composition_steps rows (in order).
  // The array is a denorm used for fast O(1) cascade queries.
  // Always update both together — never write to one without updating the other.
  for (const [i, step] of input.steps.entries()) {
    await db.query(`
      INSERT INTO composition_steps (composition_id, step_order, skill_id, step_name, input_mapping, on_error)
      VALUES ($1, $2, $3, $4, $5, $6)`,
      [composition.rows[0].id, i, step.skillId, step.stepName, step.inputMapping, step.onError ?? 'fail']
    );
  }
  // Sync array from authoritative steps table (order guaranteed)
  await db.query(`
    UPDATE skills SET composition_skill_ids = (
      SELECT ARRAY_AGG(skill_id ORDER BY step_order)
      FROM composition_steps WHERE composition_id = $1
    ) WHERE id = $1`,
    [composition.rows[0].id]
  );

  // 7. Enqueue for embedding and Cognium
  // (Cognium will verify via constituent skills — composite trust is pre-computed)

  return { id: composition.rows[0].id, slug: composition.rows[0].slug };
}
```

### 23.4 Dual-Track Social Model

Human and agent actions write to entirely different columns and materialize into entirely different leaderboard views. There is no combined score.

```typescript
// src/social/stars.ts — HUMAN ONLY
export async function starSkill(skillId: string, userId: string, db: Pool): Promise<void> {
  // Idempotent upsert into user_stars
  // Rate-limited: max 100 stars/day per user
  // Bot detection: reject if caller has author_type = 'bot'
}

// src/social/invocations.ts — AGENT ONLY
export async function recordInvocations(batch: InvocationBatch, db: Pool): Promise<void> {
  // Bulk insert into skill_invocations
  // Update agent_invocation_count, weekly_agent_invocation_count
  // Update run_count (used in version ranking)  ← v5.0
  // Update avg_execution_time_ms, error_rate
  // Update last_run_at, last_used_at
}
```

### 23.5 Status Cascade

When Cognium updates a skill's status, Runics cascades to composites. This is handled by `src/cognium/composite-cascade.ts`:

```typescript
// revoked constituent → composite becomes 'degraded'
// vulnerable constituent → composite becomes 'contains-vulnerable'
// repaired constituent → re-evaluate composite, restore if all clean
```

The cascade is triggered within `scan-report-handler.ts` (`applyScanReport()`) after the primary skill's status is updated. See `src/cognium/composite-cascade.ts` for full implementation.

### 23.6 Deprecation & Auto-Migration

```typescript
// Owner-initiated: PATCH /v1/skills/:id/status { status: 'deprecated', reason: '...' }
// Cognium-initiated: poll consumer calls applyScanReport() → status: 'revoked' (internal, no HTTP callback)

interface SkillResult {
  // ...
  status: SkillStatus;
  replacementSkillId?: string;    // for deprecated: agent auto-migrates
  replacementSlug?: string;
  remediationMessage?: string;    // for revoked: human-readable path forward + CVE
  remediationUrl?: string;        // CVE advisory link
}
```

Deprecated skills show `replacementSkillId` — agents auto-substitute. Revoked skills show `remediationMessage` — agents and users get the CVE + path forward.

### 23.7 Version Surfacing Rules

```
timon-security-review
  ├── @1.0.0  trust: 0.81  runs: 47  ← default (trust×0.7 + usage×0.3 highest)
  ├── @1.1.0  trust: 0.71  runs: 12
  └── @2.0.0  trust: 0.63  runs: 2   (recently forked, hasn't earned usage yet)
```

- `GET /v1/search` always returns best version per slug by default
- `GET /v1/search?version=2.0.0` pins to that version
- `GET /v1/skills/timon-security-review/versions` lists all versions
- Workflows that pinned a specific version are unaffected when new versions publish

### 23.8 Viral Mechanics Summary

| Mechanic | Signal type | Anti-gaming |
|---|---|---|
| Star | Human only | Rate-limited, bot-rejected |
| Human fork | Human only | author_type check |
| Agent invocation | Agent only | tenant-scoped, bulk API |
| run_count | Agent only | Used in version ranking |
| Weekly trending | Agent only | Rolling window, not cumulative |
| Co-occurrence | Agent only | Min 2 compositions required |
| Fork lineage | Both | Factual — no score attached |
| Trust badge | Provenance | Set at publish, not earned |

---

*End of document. This is the single source of truth for Runics search implementation.*
