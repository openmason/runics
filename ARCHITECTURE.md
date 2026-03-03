# Runics — Unified Architecture & MVP Implementation Spec

> **Purpose:** Single source of truth for Runics search. Covers architecture decisions, platform integration, and implementation spec for Claude Code.  
> **Stack:** TypeScript · Cloudflare Workers · Neon Postgres (pgvector) · Workers AI · KV · Hyperdrive  
> **Date:** February 2026 · v2.0  
> **Status:** DECIDED — measure-first, provider-abstracted

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
10. [Query Pipeline](#10-query-pipeline)
11. [Monitoring & Quality Learning](#11-monitoring--quality-learning)
12. [API Surface](#12-api-surface)
13. [Caching Strategy](#13-caching-strategy)
14. [Technology Stack & Cost Model](#14-technology-stack--cost-model)
15. [MVP Build Plan](#15-mvp-build-plan)
16. [Eval Suite](#16-eval-suite)
17. [Migration Triggers](#17-migration-triggers)
18. [Risks & Mitigations](#18-risks--mitigations)
19. [Project Structure](#19-project-structure)
20. [Implementation Notes for Claude Code](#20-implementation-notes-for-claude-code)

---

## 1. What Runics Is

Runics is the semantic skill registry for the Runics platform. AI agents discover, evaluate, and compose reusable skills through natural language search.

Skills come from multiple sources: `mcp-registry`, `clawhub`, `skills-sh`, `direct`, `distilled`, `generated`. Each skill has a schema, auth requirements, trust score, execution layer, and content safety classification.

Agents call `findSkill("make sure we're not shipping GPL code in proprietary product")` and get back ranked, trust-filtered results with confidence signals — fast enough to be inline in agent reasoning loops.

---

## 2. The Problem

**The vocabulary gap.** A developer searching for a way to "make sure we're not shipping GPL code" needs to find `cargo-deny`, whose description says "check Rust crate licenses and advisories." A single embedding of the skill description yields only 0.58 cosine similarity against that query.

Target: 0.85+ match quality across diverse phrasing patterns — direct queries, problem descriptions, business language, alternate terminology, and composition contexts.

**Why this is hard:**
- Agents phrase queries as problems, not tool names
- Non-technical users use business language
- Composition queries span multiple skills
- The same capability has many names across ecosystems

---

## 3. Architecture Overview

### Two-Layer Intelligence

The system has two complementary layers with a clean abstraction boundary between infrastructure and intelligence:

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
│  └────────────────────────────────────────────────────┘ │
│  ┌────────────────────┐  ┌─────────────────────────────┐│
│  │ MeilisearchProvider│  │ QdrantProvider              ││
│  │ (future)           │  │ (future)                    ││
│  └────────────────────┘  └─────────────────────────────┘│
├─────────────────────────────────────────────────────────┤
│  Neon Postgres (pgvector) · Workers AI · KV Cache       │
└─────────────────────────────────────────────────────────┘
```

**Layer A (Index-Time):** When a skill is ingested, generate multiple representations (agent summary + alternate query phrasings), embed all of them. More queries hit Tier 1 without any LLM cost at query time.

**Layer B (Query-Time):** Confidence-gated LLM fallback. Only fires when vector search results are weak. Intent decomposition, terminology translation, composition detection.

**Key insight:** Layer A reduces how often Layer B fires. Without Layer A, ~30% of queries need LLM fallback. With Layer A, ~10%. That's 3x less LLM cost and 3x fewer users waiting 500ms+.

### Measure-First Strategy

We do NOT commit to multi-vector (Layer A) upfront. The build plan:

1. **Phase 1:** Single-vector (agent_summary only) + eval suite → measure baseline
2. **Phase 2:** Add intelligence layer (confidence gating, LLM fallback) → measure lift
3. **Phase 3:** Add multi-vector, A/B test against single-vector + query expansion → measure lift, decide
4. **Phase 4:** Production polish with the winning strategy

Every phase has exit criteria based on measured numbers, not assumptions.

---

## 4. SearchProvider Abstraction

This is the boundary between commodity infrastructure and our intelligence layer. The provider owns retrieval strategy entirely. The intelligence layer only sees scored results.

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
  minTrustScore?: number;       // trust-based filtering
  executionLayer?: string;       // filter by execution capability
  contentSafetyRequired?: boolean; // default true
}

export interface SearchOptions {
  limit?: number;               // default 10
  offset?: number;
  includeMatchText?: boolean;   // include source_text for debugging
}

export interface SearchResult {
  results: ScoredSkill[];
  confidence: ConfidenceSignal;
  meta: SearchMeta;
}

export interface ScoredSkill {
  skillId: string;
  score: number;                // cosine similarity (0–1)
  fullTextScore: number;        // tsvector rank (normalized 0–1)
  fusedScore: number;           // final score after fusion
  matchSource: string;          // which embedding type matched
  matchText?: string;           // the text that matched
}

export interface ConfidenceSignal {
  topScore: number;
  gapToSecond: number;
  clusterDensity: number;       // count of results above tier2 threshold
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

**Why PgVectorProvider uses multi-vector internally but a future MeilisearchProvider would use query expansion:**

The PgVectorProvider stores 1–6 rows per skill in `skill_embeddings` and uses `DISTINCT ON (skill_id)` to return the best match per skill. A MeilisearchProvider would store 1 document per skill and instead expand the query into multiple reformulations, searching each. Different mechanics, same `SearchResult` interface.

The confidence gating layer doesn't know or care which strategy the provider uses.

---

## 5. Layer A: Index-Time Enrichment

### What It Does

When a skill is ingested, we generate multiple text representations and embed all of them. Each skill has N vectors in `skill_embeddings` (1 in Phase 1, up to 6 in Phase 3).

### Alternate Query Generation

The LLM generates queries that real agents would send:

```typescript
// src/ingestion/alternate-queries.ts

// Phase 3 only — not used until validated

const ALTERNATE_QUERY_PROMPT = `You generate search queries that developers or AI agents would use
to find this skill. Generate exactly 5 queries, each using a DIFFERENT strategy:

1. DIRECT: How someone who knows exactly what they want would ask
2. PROBLEM-BASED: How someone describing their problem (not the solution) would ask
3. BUSINESS LANGUAGE: How a non-technical person or PM would describe the need
4. ALTERNATE TERMINOLOGY: Different words for the same concept
5. COMPOSITION: When this skill would be part of a larger workflow

Return exactly 5 queries as a JSON array of strings. Each query 4-10 words. No explanations.`;

// Example output for cargo-deny:
// [
//   "check rust dependency licenses",                 // DIRECT
//   "are my crate dependencies safe to ship",         // PROBLEM-BASED
//   "ensure open source compliance rust project",     // BUSINESS LANGUAGE
//   "cargo ban crate security advisory check",        // ALTERNATE TERMINOLOGY
//   "rust supply chain security audit pipeline"       // COMPOSITION CONTEXT
// ]
```

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
  → Correct result, ~500ms

KEY: Layer B's expanded queries ALSO search against Layer A's enriched index.
LLM-generated query vocabulary × index query vocabulary = multiplicative.
```

### Impact Numbers (to be validated by eval)

These are projections from the TDR. They become real numbers only after the eval suite runs.

| Configuration | Projected Match Rate |
|---|---|
| Single embedding, no LLM fallback | ~70% (baseline to measure) |
| Multi-vector (6/skill), no LLM fallback | ~85% (Phase 3 validates) |
| Single embedding + LLM fallback | ~82% (Phase 2 validates) |
| Multi-vector + LLM fallback | ~95% (Phase 3+4 validates) |

**These numbers are targets, not commitments. The eval suite is the source of truth.**

---

## 6. Layer B: Query-Time Intelligence

### Confidence-Gated Routing

Not every query needs LLM assistance. The confidence gate evaluates results and routes to three tiers:

| Tier | Condition | Latency | Projected % | Behavior |
|---|---|---|---|---|
| **Tier 1: High** | Top score > threshold, clear gap | ~50ms | ~70% | Return immediately. $0 LLM cost. |
| **Tier 2: Medium** | Score in middle band | ~50ms initial | ~18% | Return results, stream LLM enrichment async. |
| **Tier 3: Low** | Score below threshold | 500–1000ms | ~9% | Full LLM deep search. |
| **No match** | Tier 3 results still poor | 500–1000ms | ~3% | Return generation hints. |

Confidence signals: top cosine similarity, gap between #1 and #2, cluster density above threshold, query specificity, full-text keyword hit count.

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
  "alternate_queries": string[],           // 2-4 rephrased search queries
  "terminology_map": Record<string,string>, // colloquial → technical
  "needs_composition": boolean,
  "composition_parts": string[],           // if composition, ordered sub-tasks
  "capability_hints": string[],            // inferred execution requirements
  "reasoning": string                      // brief explanation
}`;
```

Deep search flow:
1. LLM analyzes the query + initial results (including which `match_source` matched)
2. Generates alternate queries + terminology translations
3. Each alternate query is embedded and searched against the full index (including Layer A's enriched vectors)
4. If composition detected, each sub-task is searched independently
5. Results merged, deduplicated by skill ID (keep best score per skill)
6. Optionally re-ranked via cross-encoder
7. If still no good match → return generation hints for skill creation

### Composition Detection

```typescript
// src/intelligence/composition-detector.ts

// Detects multi-skill queries and returns ordered skill sequences.
// Example: "lint my rust code, check licenses, then deploy to staging"
// → [{purpose: "lint rust", skill: "clippy"}, 
//    {purpose: "check licenses", skill: "cargo-deny"},
//    {purpose: "deploy staging", skill: "deploy-worker"}]

export interface CompositionResult {
  detected: boolean;
  parts: {
    purpose: string;
    skill: ScoredSkill | null;
  }[];
  reasoning: string;
}
```

---

## 7. Platform Integration: Skills Table

The skills table is the source of truth for the Runics platform. Search operates against `skill_embeddings` which references skills. Key platform fields that affect search:

```sql
-- This table is managed by the broader Runics platform, not the search service.
-- Included here for context on what fields search filters against.

CREATE TABLE IF NOT EXISTS skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  source TEXT NOT NULL,                     -- mcp-registry | clawhub | skills-sh | direct | distilled | generated
  description TEXT,                         -- human-readable, author-provided
  agent_summary TEXT,                       -- LLM-generated, search-optimized
  alternate_queries TEXT[],                 -- stored for debugging/analytics
  schema_json JSONB,
  auth_requirements JSONB,
  install_method JSONB,
  trust_score NUMERIC(3,2) DEFAULT 0.5,    -- 0.00–1.00
  cognium_scanned BOOLEAN DEFAULT FALSE,
  cognium_report JSONB,
  capabilities_required TEXT[],            -- e.g. ['network', 'filesystem', 'container']
  execution_layer TEXT NOT NULL,            -- mcp-remote | worker | container | container-heavy
  source_execution_id UUID,
  reuse_count INTEGER DEFAULT 0,
  content_safety_passed BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_skills_trust_score ON skills(trust_score);
CREATE INDEX idx_skills_source ON skills(source);
CREATE INDEX idx_skills_slug ON skills(slug);
CREATE INDEX idx_skills_execution_layer ON skills(execution_layer);
```

### Trust-Based Filtering

Agents have a risk appetite that maps to a minimum trust score:

```typescript
// src/types.ts

export type Appetite = 'strict' | 'cautious' | 'balanced' | 'adventurous';

export function appetiteToTrustThreshold(appetite: Appetite): number {
  switch (appetite) {
    case 'strict':      return 0.85;
    case 'cautious':    return 0.70;
    case 'balanced':    return 0.50;  // default
    case 'adventurous': return 0.20;
  }
}
```

This is passed through `SearchFilters.minTrustScore` and applied as a WHERE clause in the provider.

---

## 8. Database Schema

### Migration 0001: skill_embeddings

```sql
-- 0001_skill_embeddings.sql
-- Search index. Starts with 1 row per skill (agent_summary).
-- Multi-vector adds additional rows — no schema change needed.

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

-- HNSW index for vector similarity search
CREATE INDEX idx_skill_embeddings_hnsw
  ON skill_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);

CREATE INDEX idx_skill_embeddings_skill_id
  ON skill_embeddings (skill_id);

CREATE INDEX idx_skill_embeddings_tenant_id
  ON skill_embeddings (tenant_id);

-- Full-text search on source_text
ALTER TABLE skill_embeddings ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', source_text)) STORED;

CREATE INDEX idx_skill_embeddings_tsv ON skill_embeddings USING gin(tsv);
```

### Migration 0002: search_logs

```sql
-- 0002_search_logs.sql
-- Every search event logged. Drives quality learning and cost tracking.

CREATE TABLE IF NOT EXISTS search_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ DEFAULT NOW(),

  -- Query
  query TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  appetite TEXT,                           -- risk appetite used

  -- Routing
  tier SMALLINT NOT NULL CHECK (tier IN (1, 2, 3)),
  cache_hit BOOLEAN DEFAULT FALSE,

  -- Results
  top_score REAL,
  gap_to_second REAL,
  cluster_density SMALLINT,
  keyword_hits SMALLINT,
  result_count SMALLINT,
  match_source TEXT,
  result_skill_ids TEXT[],

  -- Performance
  total_latency_ms REAL,
  vector_search_ms REAL,
  full_text_search_ms REAL,
  fusion_strategy TEXT,

  -- LLM usage
  llm_invoked BOOLEAN DEFAULT FALSE,
  llm_latency_ms REAL,
  llm_model TEXT,
  llm_tokens_used INTEGER,

  -- Cost tracking (USD estimates)
  embedding_cost REAL DEFAULT 0,
  llm_cost REAL DEFAULT 0,

  -- Deep search trace (Tier 3 only)
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
-- 0003_quality_feedback.sql
-- Closes the quality learning loop.

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

-- Materialized view for hourly quality metrics (refresh via cron)
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

---

## 9. Ingestion Pipeline

```typescript
// src/ingestion/embed-pipeline.ts

export class EmbedPipeline {
  constructor(private env: Env) {}

  // ── Phase 1: Single embedding ──
  async processSkill(skill: SkillInput): Promise<EmbeddingSet> {
    // Generate agent summary if not provided
    const agentSummaryText = skill.agentSummary ?? await this.generateAgentSummary(skill);

    // Embed
    const embedding = await this.embed(agentSummaryText);

    return {
      agentSummary: { text: agentSummaryText, embedding },
    };
  }

  // ── Phase 3: Multi-vector (enabled after validation) ──
  async processSkillMultiVector(skill: SkillInput): Promise<EmbeddingSet> {
    const base = await this.processSkill(skill);

    const alternateTexts = await this.generateAlternateQueries(skill);

    // Batch embed all alternates in single API call
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

  // ── Content safety check ──
  async checkContentSafety(skill: SkillInput): Promise<boolean> {
    const textToCheck = `${skill.name} ${skill.description} ${skill.agentSummary ?? ''}`;
    // Llama Guard classification via Workers AI
    const result = await this.env.AI.run(
      '@cf/meta/llama-guard-3-8b' as BaseAiTextClassificationModels,
      { text: textToCheck }
    );
    // Llama Guard returns "safe" or "unsafe" with category
    return (result as any).response?.toLowerCase().startsWith('safe') ?? false;
  }

  private async generateAgentSummary(skill: SkillInput): Promise<string> {
    const response = await this.env.AI.run(this.env.LLM_MODEL as BaseAiTextGenerationModels, {
      messages: [
        {
          role: 'system',
          content: `Generate a concise search-optimized description of this tool/skill for AI agents.
Focus on: what it does, what problems it solves, what inputs/outputs it has, when to use it.
Start with "Use this tool when you need to..."
2-3 sentences max. Return only the description.`,
        },
        {
          role: 'user',
          content: `Name: ${skill.name}\nDescription: ${skill.description}\nTags: ${skill.tags.join(', ')}\nCategory: ${skill.category}\nCapabilities: ${skill.capabilitiesRequired?.join(', ') ?? 'none'}`,
        },
      ],
    });
    return (response as any).response;
  }

  private async generateAlternateQueries(skill: SkillInput): Promise<string[]> {
    const response = await this.env.AI.run(this.env.LLM_MODEL as BaseAiTextGenerationModels, {
      messages: [
        { role: 'system', content: ALTERNATE_QUERY_PROMPT },
        {
          role: 'user',
          content: `Name: ${skill.name}\nAgent summary: ${skill.agentSummary}\nCapabilities: ${skill.capabilitiesRequired?.join(', ') ?? 'none'}\nSchema: ${JSON.stringify(skill.schemaJson ?? {}).slice(0, 500)}`,
        },
      ],
      max_tokens: 200,
    });

    try {
      const parsed = JSON.parse((response as any).response);
      return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
    } catch {
      return [];
    }
  }

  private async embed(text: string): Promise<number[]> {
    const result = await this.env.AI.run(this.env.EMBEDDING_MODEL as BaseAiTextEmbeddingModels, {
      text: [text],
    });
    return (result as any).data[0];
  }
}

const ALTERNATE_QUERY_PROMPT = `You generate search queries that developers or AI agents would use to find this skill. Think about:

1. DIRECT: How someone who knows exactly what they want would ask
2. PROBLEM-BASED: How someone describing their problem (not the solution) would ask
3. BUSINESS LANGUAGE: How a non-technical person or PM would describe the need
4. ALTERNATE TERMINOLOGY: Different words for the same concept
5. COMPOSITION: When this skill would be part of a larger workflow

Return exactly 5 queries as a JSON array of strings. Each query 4-10 words. No explanations, just the JSON array.`;
```

### Full ingestion flow

```
Skill arrives (sync worker / publish API / distillation)
  │
  ├─ 1. Generate agent_summary (LLM, ~500ms)
  │     "Use this tool when you need to..."
  │
  ├─ 2. Content safety check (Llama Guard, ~50ms)
  │     If unsafe → mark skill, do not index
  │
  ├─ 3. [Phase 3] Generate 5 alternate queries (LLM, ~300ms)
  │     ["direct", "problem-based", "business", "alt terminology", "composition"]
  │
  ├─ 4. Embed all texts (Workers AI bge-small, ~30ms batch)
  │     → 1 vector (Phase 1) or 6 vectors (Phase 3)
  │
  ├─ 5. Atomic upsert: delete old embeddings, insert new (Neon, ~20ms)
  │
  └─ 6. Cache TTL handles invalidation (60s)
```

---

## 10. Query Pipeline

### The complete findSkill flow

```typescript
// src/intelligence/confidence-gate.ts

export class ConfidenceGate {
  constructor(
    private env: Env,
    private provider: SearchProvider,
    private logger: SearchLogger
  ) {}

  async findSkill(
    query: string,
    filters: SearchFilters,
    options?: SearchOptions & { appetite?: Appetite }
  ): Promise<FindSkillResponse> {

    // Apply trust threshold from appetite
    if (options?.appetite) {
      filters.minTrustScore = appetiteToTrustThreshold(options.appetite);
    }
    filters.contentSafetyRequired ??= true;

    // 1. Embed query
    const embedding = await this.embed(query);

    // 2. Provider search (vector + full-text + fusion)
    const result = await this.provider.search(query, embedding, filters, options);

    // 3. Route based on confidence tier
    switch (result.confidence.tier) {
      case 1:
        return this.buildResponse(query, result, {
          enriched: false,
          confidence: 'high',
        });

      case 2:
        // Return results now. Enrichment available async.
        const enrichmentPromise = this.asyncEnrich(query, result);
        return this.buildResponse(query, result, {
          enriched: false,
          confidence: 'medium',
          enrichmentPromise,
        });

      case 3:
        // Full LLM deep search
        const deepResult = await this.deepSearch(query, embedding, filters, result);
        return this.buildResponse(query, deepResult.result, {
          enriched: true,
          confidence: deepResult.noMatch ? 'no_match' : 'low_enriched',
          composition: deepResult.composition,
          searchTrace: deepResult.trace,
          generationHints: deepResult.generationHints,
        });
    }
  }

  // ... (deep search, async enrich, composition detection implementations)
}
```

### Response shape (agent-friendly)

```typescript
// src/types.ts

export interface FindSkillResponse {
  results: SkillResult[];
  confidence: 'high' | 'medium' | 'low_enriched' | 'no_match';
  enriched: boolean;

  // Tier 2: available if caller wants to await better results
  enrichmentPromise?: Promise<FindSkillResponse>;

  // Tier 3: composition detection
  composition?: CompositionResult;

  // Tier 3: debug/analytics trace
  searchTrace?: {
    originalQuery: string;
    alternateQueries?: string[];
    terminologyMap?: Record<string, string>;
    reasoning?: string;
  };

  // Tier 3 no-match: hints for skill generation
  generationHints?: {
    intent: string;
    capabilities: string[];
    complexity: string;
  };

  meta: {
    matchSources: string[];     // which embedding types matched top 3
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
  agentSummary: string;
  trustScore: number;
  executionLayer: string;
  capabilitiesRequired: string[];
  score: number;
  matchSource: string;
  matchText?: string;
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
  ├─ Provider.search() against skill_embeddings (Neon/Hyperdrive, ~30ms)
  │   Searches all vectors (100K skills × N embeddings each)
  │   Returns best match per skill (DISTINCT ON skill_id)
  │   Includes match_source: which embedding type matched
  │   Filters: trust_score >= threshold, content_safety_passed = true
  │
  ├─ Score-based fusion: vector (0.7) + full-text (0.3)
  │
  ├─ Confidence assessment:
  │   Top: 0.88, Gap: 0.12, Cluster: 3 above 0.80
  │   → TIER 1: HIGH CONFIDENCE
  │
  ├─ Return immediately (~50ms total):
  │   {
  │     results: [
  │       { name: "cargo-deny", score: 0.88,
  │         matchSource: "alt_query_2",
  │         matchText: "ensure open source compliance rust project" },
  │       { name: "license-checker", score: 0.84,
  │         matchSource: "alt_query_0",
  │         matchText: "check open source license violations" }
  │     ],
  │     confidence: "high",
  │     enriched: false,
  │     meta: { tier: 1, llmInvoked: false, latencyMs: 48 }
  │   }
  │
  └─ Cache result (KV, TTL: 60s)
```

---

## 11. Monitoring & Quality Learning

Three components that work together to make search improve over time.

### 11.1 Search Logger

Every search event logged to `search_logs`. Non-blocking via `waitUntil()`.

```typescript
// src/monitoring/search-logger.ts

export class SearchLogger {
  constructor(private pool: Pool) {}

  async log(event: SearchLogEntry): Promise<string> {
    // Insert into search_logs, return event ID for feedback correlation
    // Includes: query, tier, scores, latency, match_source, cost estimates,
    //           alternate_queries_used (Tier 3), composition_detected, generation_hint_returned
    const { rows } = await this.pool.query(
      `INSERT INTO search_logs (...) VALUES (...) RETURNING id`,
      [/* all fields */]
    );
    return rows[0].id;
  }
}
```

### 11.2 Quality Tracker

Records feedback and exposes analytics for quality learning.

```typescript
// src/monitoring/quality-tracker.ts

export class QualityTracker {
  constructor(private pool: Pool) {}

  // Record implicit/explicit feedback
  async recordFeedback(feedback: QualityFeedback): Promise<void>;

  // ── Analytics queries ──

  // Tier distribution over time — validates confidence thresholds
  async getTierDistribution(hours: number): Promise<TierDistribution>;

  // Which embedding types drive actual usage (not just high scores)
  async getMatchSourceStats(hours: number): Promise<MatchSourceStats[]>;

  // Latency percentiles by tier
  async getLatencyPercentiles(hours: number): Promise<LatencyPercentiles>;

  // Cost breakdown by tier and component
  async getCostBreakdown(hours: number): Promise<CostBreakdown>;

  // Queries where users dismissed all results — candidates for:
  //   1. New skill generation
  //   2. Alternate query prompt tuning
  //   3. New embedding category
  async getFailedQueries(hours: number, limit: number): Promise<FailedQuery[]>;

  // Queries that landed in Tier 3 — patterns here suggest
  // new alternate query categories for Layer A
  async getTier3Patterns(hours: number): Promise<Tier3Pattern[]>;

  // Refresh materialized view (call from cron trigger)
  async refreshSummary(): Promise<void>;
}
```

### 11.3 Performance Monitor

Per-request structured timing for Logpush / tail workers.

```typescript
// src/monitoring/perf-monitor.ts

export class PerfMonitor {
  private marks: Map<string, number> = new Map();
  private startTime = Date.now();

  mark(label: string): void {
    this.marks.set(label, Date.now());
  }

  since(label: string): number {
    return Date.now() - (this.marks.get(label) ?? this.startTime);
  }

  toStructuredLog(extra?: Record<string, unknown>): Record<string, unknown> {
    return {
      _type: 'search_perf',
      totalMs: Date.now() - this.startTime,
      marks: Object.fromEntries(this.marks),
      ...extra,
    };
  }
}
```

### 11.4 Quality Learning Loop

The monitoring system feeds back into architecture decisions:

```
search_logs + quality_feedback
  │
  ├─ match_source stats → Which alt_query types pull their weight?
  │   If alt_query_4 consistently underperforms → drop it or retune prompt
  │   If LLM fallback patterns cluster → add new embedding category
  │
  ├─ Tier distribution → Are confidence thresholds correct?
  │   If tier 3 > 15% → thresholds too high, or Layer A not effective
  │   If tier 1 > 85% and bad feedback high → thresholds too low
  │
  ├─ Failed queries → What vocabulary gaps remain?
  │   Common patterns → new alternate query strategy
  │   Truly novel → skill generation pipeline
  │
  ├─ Cost breakdown → Is LLM spend within budget?
  │   If tier 3 cost escalates → raise thresholds, improve caching
  │
  └─ Latency percentiles → Are we meeting SLOs?
      p50 should be < 60ms (Tier 1 dominates)
      p99 should be < 1000ms (Tier 3 with LLM)
```

---

## 12. API Surface

```typescript
// src/index.ts — Hono router

// ── Search ──
POST   /v1/search                      // findSkill — the main endpoint
POST   /v1/search/feedback              // record quality feedback

// ── Ingestion ──
POST   /v1/skills/:skillId/index        // index a skill (single or multi-vector)
DELETE /v1/skills/:skillId              // remove skill from search index

// ── Analytics (internal/admin) ──
GET    /v1/analytics/tiers              // tier distribution
GET    /v1/analytics/match-sources      // which embedding types drive usage
GET    /v1/analytics/latency            // latency percentiles
GET    /v1/analytics/cost               // cost breakdown
GET    /v1/analytics/failed-queries     // queries with no positive feedback
GET    /v1/analytics/tier3-patterns     // common tier 3 query patterns

// ── Eval ──
POST   /v1/eval/run                     // run eval suite, return metrics
GET    /v1/eval/results/:runId          // get eval run results

// ── Health ──
GET    /health                          // db connectivity + latency
```

### Search request/response

```typescript
// POST /v1/search
{
  "query": "make sure we're not shipping GPL code in proprietary product",
  "tenantId": "tenant-123",
  "appetite": "balanced",            // optional, default "balanced"
  "tags": ["rust"],                  // optional filter
  "category": "security",           // optional filter
  "limit": 10                        // optional, default 10
}

// Response: FindSkillResponse (see Section 10)
```

---

## 13. Caching Strategy

```typescript
// src/cache/kv-cache.ts

export class SearchCache {
  constructor(private kv: KVNamespace, private ttlSeconds: number) {}

  // Key: SHA-256 of normalized (tenantId + query + appetite)
  // Value: serialized FindSkillResponse

  async get(query: string, tenantId: string, appetite: string): Promise<FindSkillResponse | null>;
  async set(query: string, tenantId: string, appetite: string, result: FindSkillResponse): Promise<void>;
}
```

**TTL strategy:**
- Tier 1 results: 60s (stable, high confidence)
- Tier 2/3 results: 30s (may improve as new skills arrive)
- Cache invalidation: rely on TTL. 60s staleness is acceptable.
- Future: tenant version counter in KV for instant invalidation on skill publish

**Why not prefix-delete:** KV doesn't support prefix delete. TTL-based expiry is fine for V1. If staleness becomes a problem, add a version counter to the cache key and bump it on skill publish.

---

## 14. Technology Stack & Cost Model

### Stack

| Component | Technology | Purpose |
|---|---|---|
| Search index | Neon Postgres + pgvector (HNSW) + tsvector | Vector + full-text search |
| Embeddings | Workers AI bge-small-en-v1.5 (384 dim) | Query + skill embedding |
| Reranker | Workers AI bge-reranker-base | Cross-encoder reranking (Phase 4) |
| LLM | Workers AI Llama 3.3 70B Instruct FP8 | Agent summary, alt queries, deep search |
| Content safety | Workers AI Llama Guard 3 8B | Skill content classification |
| API layer | Cloudflare Workers + Hono | Request handling |
| Connection pool | Hyperdrive | Postgres connection pooling |
| Cache | Cloudflare KV (60s TTL) | Query result caching |
| Analytics | Langfuse (Sprint 6) | Search quality dashboards |

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
| Tier 1 (70%) | 7,000 | $0.0000004 (embed only) | $0.003 |
| Tier 2 (18%) | 1,800 | $0.0001 (embed + async LLM) | $0.18 |
| Tier 3 (9%) | 900 | $0.0003 (embed + deep search) | $0.27 |
| No match (3%) | 300 | $0.0005 (deep search + suggest) | $0.15 |
| **Daily total** | | | **~$0.60** |

### Storage

```
Phase 1:  100K skills × 1 embedding  × 384d × 4B = ~150MB + HNSW ~300MB
Phase 3:  100K skills × 6 embeddings × 384d × 4B = ~920MB + HNSW ~1.8GB
Both well within Neon Pro 10GB limit.
```

---

## 15. MVP Build Plan

### Phase 1: Foundation + Eval (Week 1)

**Deliverable:** Working single-vector search endpoint + benchmark suite

- [ ] `wrangler.toml` with all Cloudflare bindings
- [ ] Drizzle schema + migrations 0001, 0002, 0003
- [ ] `SearchProvider` interface
- [ ] `PgVectorProvider` — single-vector search, score-based fusion, confidence assessment
- [ ] `EmbedPipeline.processSkill()` — agent summary generation + single embedding
- [ ] `EmbedPipeline.checkContentSafety()` — Llama Guard on ingest
- [ ] `SearchCache` — KV with TTL
- [ ] `SearchLogger` — log every search event (non-blocking)
- [ ] `PerfMonitor` — structured timing
- [ ] Hono router: `/v1/search`, `/v1/skills/:id/index`, `/v1/skills/:id` DELETE, `/health`
- [ ] Trust-based filtering (`appetite` → `minTrustScore`)
- [ ] **Eval suite: 100+ query/skill pairs, Recall@1, Recall@5, MRR**
- [ ] Seed script with test skills
- [ ] **Run eval → record baseline numbers**
- [ ] **Derive tier thresholds from actual score distribution**

**Exit criteria:** Baseline match rate measured. Tier thresholds set from data. p50 < 60ms.

### Phase 2: Intelligence Layer (Week 2)

**Deliverable:** Three-tier routing with LLM deep search

- [ ] `ConfidenceGate` — full tier routing with configurable thresholds
- [ ] Tier 2 async enrichment (query expansion via LLM)
- [ ] Tier 3 deep search (intent decomposition, terminology translation, capability reasoning)
- [ ] Expanded query → re-embed → re-search → merge + deduplicate
- [ ] Deep search prompt includes `match_source` context
- [ ] `CompositionDetector` — detect multi-skill queries, parallel sub-search
- [ ] No-match → generation hints pipeline
- [ ] `QualityTracker.recordFeedback()` + feedback endpoint
- [ ] Analytics endpoints: tiers, match-sources, latency, cost, failed-queries
- [ ] **Re-run eval with LLM fallback enabled → measure lift per tier**

**Exit criteria:** Measured lift from LLM fallback on Tier 3 queries. Cost per query validated. Tier distribution matches expectations.

### Phase 3: Multi-Vector Validation (Week 3)

**Deliverable:** Data-driven decision on multi-vector vs query expansion

- [ ] `EmbedPipeline.processSkillMultiVector()` — alternate query generation
- [ ] Batch ingest alternates into `skill_embeddings` (6 per skill)
- [ ] `match_source` tracking in search logs (which alt type matched)
- [ ] **A/B test: single-vector vs multi-vector vs single + query expansion**
- [ ] Per-embedding-type lift measurement (which alternates help?)
- [ ] Tier3 pattern analysis → do patterns suggest new alt categories?
- [ ] **Decision: keep multi-vector if lift ≥ 5% over query expansion**
- [ ] If multi-vector wins: which N alternates? (maybe 4 is better than 5)

**Exit criteria:** Quantified lift. Decision documented. Underperforming alternates dropped.

### Phase 4: Production Polish (Week 4)

- [ ] Cross-encoder reranking stage (bge-reranker-base, optional per-query)
- [ ] Score-based fusion vs RRF A/B test
- [ ] Materialized view refresh via cron trigger
- [ ] Rate limiting on search endpoint
- [ ] Error handling: retries, circuit breaker for Workers AI
- [ ] Load test: p50 < 60ms, p99 < 500ms, p99.9 < 1500ms
- [ ] `getTier3Patterns()` analytics for ongoing quality tuning
- [ ] **Final eval run with production config**

**Exit criteria:** Production-ready. SLOs met. Monitoring in place. Quality loop operational.

---

## 16. Eval Suite

The eval suite is a **Phase 1 deliverable**. No match quality number is cited as architecture-driving until validated here.

```typescript
// src/eval/fixtures.ts

export interface EvalFixture {
  id: string;
  query: string;
  expectedSkillId: string;
  pattern: 'direct' | 'problem' | 'business' | 'alternate' | 'composition';
}

// Minimum 100 pairs across all 5 patterns.
// Expand from real query logs after Phase 1.
export const evalFixtures: EvalFixture[] = [
  { id: 'eval-001', query: 'check rust dependency licenses', expectedSkillId: 'cargo-deny', pattern: 'direct' },
  { id: 'eval-002', query: 'make sure we are not shipping GPL code in proprietary product', expectedSkillId: 'cargo-deny', pattern: 'problem' },
  { id: 'eval-003', query: 'ensure open source compliance for rust project', expectedSkillId: 'cargo-deny', pattern: 'business' },
  // ... expand to 100+
];
```

```typescript
// src/eval/metrics.ts

export interface EvalMetrics {
  recall1: number;       // correct skill in top 1
  recall5: number;       // correct skill in top 5
  mrr: number;           // mean reciprocal rank
  avgTopScore: number;
  tierDistribution: Record<1 | 2 | 3, number>;
  byPattern: Record<string, { recall5: number; mrr: number }>;  // per phrasing pattern
}
```

The eval runner hits the live search endpoint and computes metrics. Results stored for comparison across phases.

---

## 17. Migration Triggers

### Add Meilisearch when:
- User-facing search UI needed (InstantSearch.js)
- Typo tolerance critical (human users, not agents)
- Faceted/filtered search with counts
- Multi-language tokenization (CJK, Arabic, Hebrew)

### Swap to Qdrant when:
- pgvector HNSW latency > 30ms consistently
- ColBERT late-interaction reranking needed
- Matryoshka cascade search adds meaningful savings

### Upgrade embedding model when:
- Eval shows baseline match rate < 65% with bge-small
- Newer models (GTE-large, e5-base-v2) close vocabulary gap meaningfully
- HyDE (hypothetical document embeddings) shows significant lift in Phase 2

---

## 18. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Baseline match rate < 60% | Tier distribution skews to Tier 3, cost model breaks | Eval catches in Week 1. Investigate model upgrade or HyDE. |
| Multi-vector lift < 5% | 6x storage for marginal gain | Phase 3 A/B test validates. Query expansion as alternative. |
| Confidence thresholds wrong | Over-triggering Tier 3 (cost) or under-triggering (quality) | Derive from eval data. Monitor daily. Auto-adjust from running averages. |
| LLM cost escalation | Tier 2/3 queries more expensive than projected | Conservative thresholds. KV caching deduplicates. Cap LLM calls/minute. |
| Neon cold starts | Latency spikes | Hyperdrive pooling. Neon Pro = no auto-suspend. |
| Embedding model drift | Workers AI updates bge-small, breaks existing embeddings | Pin model version. Re-embed corpus on model change (batch job). |
| Provider abstraction too leaky | Switching providers still requires significant rework | Keep interface at scored-results level. Provider internals stay contained. |
| Scale past 1M skills | pgvector HNSW degrades | Migrate vector layer to Qdrant. Abstraction makes this clean. |

---

## 19. Project Structure

```
runics-search/
├── wrangler.toml
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── src/
│   ├── index.ts                          # Worker entry, Hono router
│   ├── types.ts                          # All shared types and interfaces
│   │
│   ├── providers/
│   │   ├── search-provider.ts            # SearchProvider interface
│   │   └── pgvector-provider.ts          # PgVector implementation
│   │
│   ├── intelligence/
│   │   ├── confidence-gate.ts            # Tier routing + findSkill orchestration
│   │   ├── deep-search.ts               # Tier 3 LLM reasoning
│   │   └── composition-detector.ts       # Multi-skill query detection
│   │
│   ├── ingestion/
│   │   ├── embed-pipeline.ts             # Skill → embedding pipeline
│   │   ├── agent-summary.ts              # LLM summary generation prompts
│   │   ├── alternate-queries.ts          # Multi-vector query generation (Phase 3)
│   │   └── content-safety.ts             # Llama Guard classification
│   │
│   ├── monitoring/
│   │   ├── search-logger.ts              # Structured search event logging
│   │   ├── quality-tracker.ts            # Feedback + analytics queries
│   │   └── perf-monitor.ts              # Per-request timing
│   │
│   ├── cache/
│   │   └── kv-cache.ts                   # KV caching with TTL
│   │
│   ├── db/
│   │   ├── schema.ts                     # Drizzle schema definitions
│   │   └── migrations/
│   │       ├── 0001_skill_embeddings.sql
│   │       ├── 0002_search_logs.sql
│   │       └── 0003_quality_feedback.sql
│   │
│   └── eval/
│       ├── runner.ts                     # Eval suite runner
│       ├── fixtures.ts                   # Test query/skill pairs (100+)
│       └── metrics.ts                    # Recall@K, MRR, per-pattern breakdown
│
├── scripts/
│   ├── seed-eval-corpus.ts               # Seed test skills
│   └── run-eval.ts                       # CLI eval runner
│
└── tests/
    ├── providers/pgvector-provider.test.ts
    ├── intelligence/confidence-gate.test.ts
    └── monitoring/quality-tracker.test.ts
```

---

## 20. Implementation Notes for Claude Code

### Critical decisions

1. **Use `@neondatabase/serverless` or Hyperdrive HTTP driver**, not `pg`. Standard `pg` doesn't work in Workers. Query patterns stay the same — just the connection method changes.

2. **SearchProvider interface is sacred.** Never import Postgres types outside `pgvector-provider.ts`. The intelligence layer talks only through the interface.

3. **Logging is non-blocking.** Use `c.executionCtx.waitUntil()` for all writes to `search_logs` and `quality_feedback`. Never block the response on analytics.

4. **Every threshold is configurable.** Tier boundaries, fusion weights, cache TTL, trust score mappings — all from env vars. Never hardcode.

5. **Content safety runs on ingest, not query.** Skills that fail Llama Guard get `content_safety_passed = false` and are excluded from search results via WHERE clause.

6. **The skills table already exists.** The search service creates `skill_embeddings`, `search_logs`, and `quality_feedback`. It reads from `skills` but doesn't own it.

7. **Eval runs before and after every change.** The eval suite is the source of truth. No "feels better" — numbers only.

8. **Phase 3 is optional.** If single-vector + LLM fallback achieves acceptable match quality in Phase 2, multi-vector may not be needed. The eval data decides.

### Cloudflare bindings

```toml
# wrangler.toml
name = "runics-search"
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
```

### Dependencies

```json
{
  "dependencies": {
    "hono": "^4.0.0",
    "@neondatabase/serverless": "^0.10.0",
    "drizzle-orm": "^0.38.0"
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
100K skills × 1 embedding:   ~5ms query,  ~300MB memory
100K skills × 6 embeddings:  ~8-12ms query, ~1.8GB memory
150K skills × 6 embeddings:  ~12-15ms query, ~3GB memory

HNSW config: m=16, ef_construction=128
Query scales O(log N) — 6x vectors ≈ +3-5ms
```

---

*End of document. This is the single source of truth for Runics search implementation.*
