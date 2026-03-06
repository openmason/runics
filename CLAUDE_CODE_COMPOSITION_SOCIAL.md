# Runics — Composition & Social Layer
## Claude Code Implementation Instructions

> **Prereq:** v3.0 architecture is fully implemented (search, sync, publish, ingestion, monitoring).  
> **Spec:** `runics-unified-architecture.md` v4.0 — Section 23 is the authoritative source.  
> **Do not touch:** existing search, sync, or monitoring code. Add only.

---

## Phase 1 — Database Migrations

Run in order. Each migration must succeed before the next.

### 1.1 Update skills table

Add all new columns to the existing `skills` table. Do not recreate it.

```sql
-- migrations/0004_skills_v4.sql

-- Author attribution
ALTER TABLE skills ADD COLUMN IF NOT EXISTS author_id UUID;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS author_type TEXT NOT NULL DEFAULT 'human'
  CHECK (author_type IN ('human', 'bot', 'org'));
ALTER TABLE skills ADD COLUMN IF NOT EXISTS author_bot_model TEXT;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS author_bot_prompt_hash TEXT;

-- Type and status
ALTER TABLE skills ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'skill'
  CHECK (type IN ('skill', 'composition', 'pipeline'));
ALTER TABLE skills ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published'
  CHECK (status IN ('draft', 'published', 'deprecated', 'archived'));

-- Fork lineage
ALTER TABLE skills ADD COLUMN IF NOT EXISTS fork_of UUID REFERENCES skills(id);
ALTER TABLE skills ADD COLUMN IF NOT EXISTS origin_id UUID REFERENCES skills(id);
ALTER TABLE skills ADD COLUMN IF NOT EXISTS fork_depth INTEGER DEFAULT 0;

-- Metadata
ALTER TABLE skills ADD COLUMN IF NOT EXISTS readme TEXT;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';
ALTER TABLE skills ADD COLUMN IF NOT EXISTS categories TEXT[] DEFAULT '{}';
ALTER TABLE skills ADD COLUMN IF NOT EXISTS ecosystem TEXT;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS language TEXT;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS license TEXT;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS homepage_url TEXT;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS demo_url TEXT;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS changelog JSONB DEFAULT '[]';

-- Agent quality signals
ALTER TABLE skills ADD COLUMN IF NOT EXISTS avg_execution_time_ms REAL;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS p95_execution_time_ms REAL;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS error_rate REAL;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS agent_consumption_pattern TEXT
  CHECK (agent_consumption_pattern IN ('standalone', 'always-composed', 'mixed'));
ALTER TABLE skills ADD COLUMN IF NOT EXISTS schema_compatibility_score REAL;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS replacement_skill_id UUID REFERENCES skills(id);
ALTER TABLE skills ADD COLUMN IF NOT EXISTS adversarial_tested BOOLEAN DEFAULT FALSE;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS provenance_attested BOOLEAN DEFAULT FALSE;

-- Human social counters (human actions only — never written by agent paths)
ALTER TABLE skills ADD COLUMN IF NOT EXISTS human_star_count INTEGER DEFAULT 0;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS human_fork_count INTEGER DEFAULT 0;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS human_copy_count INTEGER DEFAULT 0;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS human_use_count INTEGER DEFAULT 0;

-- Agent counters (agent invocations only — never written by human social paths)
ALTER TABLE skills ADD COLUMN IF NOT EXISTS agent_invocation_count BIGINT DEFAULT 0;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS agent_fork_count INTEGER DEFAULT 0;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS composition_inclusion_count INTEGER DEFAULT 0;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS dependent_count INTEGER DEFAULT 0;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS weekly_agent_invocation_count INTEGER DEFAULT 0;

-- Editorial
ALTER TABLE skills ADD COLUMN IF NOT EXISTS featured BOOLEAN DEFAULT FALSE;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS verified_creator BOOLEAN DEFAULT FALSE;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS collection_ids UUID[] DEFAULT '{}';

-- Lifecycle
ALTER TABLE skills ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_skills_tags ON skills USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_skills_categories ON skills USING gin(categories);
CREATE INDEX IF NOT EXISTS idx_skills_fork_of ON skills(fork_of);
CREATE INDEX IF NOT EXISTS idx_skills_origin_id ON skills(origin_id);
CREATE INDEX IF NOT EXISTS idx_skills_author_id ON skills(author_id);
CREATE INDEX IF NOT EXISTS idx_skills_type ON skills(type);
CREATE INDEX IF NOT EXISTS idx_skills_weekly_invocations ON skills(weekly_agent_invocation_count DESC);
CREATE INDEX IF NOT EXISTS idx_skills_human_stars ON skills(human_star_count DESC);
```

### 1.2 New tables

```sql
-- migrations/0005_authors.sql
-- (full SQL from spec Section 8, Migration 0004_authors)

-- migrations/0006_compositions.sql
-- (full SQL from spec Section 8, Migration 0005_compositions)

-- migrations/0007_invocation_graph.sql
-- (full SQL from spec Section 8, Migration 0006_invocation_graph)
-- Note: skill_cooccurrence materialized view — create after table, populate later

-- migrations/0008_leaderboards.sql
-- (full SQL from spec Section 8, Migration 0007_leaderboards)
-- Note: leaderboard_human excludes author_type = 'bot' at the view level
```

Update `db/schema.ts` (Drizzle) to reflect all new columns and tables.

---

## Phase 2 — Composition Module

Create `src/composition/`. Each file is independent. No changes to existing files.

### 2.1 `fork.ts`

Implement `forkSkill(sourceId, authorId, authorType, db)`:
- Load source skill — 404 if not found or not `status = 'published'`
- Deep copy all scalar fields; reset: `status = 'draft'`, `version = '1.0.0'`, all counters to 0, `trust_score = 0.5`
- Set `fork_of = sourceId`, `origin_id = source.origin_id ?? sourceId`, `fork_depth = source.fork_depth + 1`
- Slug: `${source.slug}-fork-${nanoid(6)}`
- If source is `composition` or `pipeline`: copy all rows from `composition_steps` to new `composition_id`
- Increment `human_fork_count` on source (if `authorType = 'human'`) or `agent_fork_count` (if `authorType = 'bot'`)
- Enqueue new skill ID to `EMBED_QUEUE` and `COGNIUM_QUEUE`
- Return `{ id, slug }`

### 2.2 `copy.ts`

Same as fork but: `fork_of = null`, `origin_id = null`, `fork_depth = 0`. Increment `human_copy_count` on source. No lineage tracking.

### 2.3 `compose.ts`

Implement `createComposition(input: CompositionInput, db)`:
- Validate all `step.skillId` values exist and are `status = 'published'`
- Compute `capabilities_required` = union of all step skills' capabilities
- Compute initial `trust_score` = `MIN(trust_score)` across all step skills
- Insert skills row: `type = 'composition'`, `status = 'draft'`
- Insert `composition_steps` rows in order
- Enqueue to `EMBED_QUEUE` (agent_summary = LLM summary of step descriptions joined)
- Enqueue to `COGNIUM_QUEUE`
- Return `{ id, slug }`

### 2.4 `extend.ts`

Implement `extendComposition(compositionId, newSteps, authorId, db)`:
- Fork the composition first (calls `forkSkill`)
- Append new steps to the fork's `composition_steps` starting at `step_order = MAX + 1`
- Recompute `capabilities_required` and `trust_score`
- Return the fork's `{ id, slug }`

### 2.5 `lineage.ts`

Two queries:
- `getAncestry(skillId, db)` → walk `fork_of` chain upward, return ordered array
- `getForks(skillId, db)` → direct children where `fork_of = skillId`
- `getDependents(skillId, db)` → `composition_steps` rows where `skill_id = skillId`, joined to parent composition

### 2.6 `publish.ts`

Implement `publishComposition(compositionId, db)`:
- Validate `status = 'draft'`
- Validate all steps still point to published skills
- Set `status = 'published'`, `published_at = NOW()`
- Return updated skill row

### 2.7 `schema.ts`

Zod schemas for all composition endpoints. Export:
- `forkInputSchema` — `{ authorId, authorType }`
- `compositionInputSchema` — `{ name, description, tags?, steps: [{ skillId, stepName?, inputMapping?, onError? }] }`
- `extendInputSchema` — `{ steps: [...] }`

---

## Phase 3 — Social Module

Create `src/social/`. Strict separation: human paths never touch agent columns and vice versa.

### 3.1 `stars.ts`

- Create `user_stars` join table: `(user_id, skill_id, created_at)`, unique on `(user_id, skill_id)`
- `starSkill(skillId, userId, db)`:
  - Reject if `authorType = 'bot'` — bots cannot star
  - Upsert into `user_stars`; on conflict do nothing
  - `UPDATE skills SET human_star_count = human_star_count + 1 WHERE id = $1` only on INSERT
- `unstarSkill(skillId, userId, db)`:
  - Delete from `user_stars`; decrement `human_star_count` if row existed
- Rate limit: max 200 stars per user per day (check count in `user_stars` with `created_at > NOW() - interval '1 day'`)

### 3.2 `invocations.ts`

- `recordInvocations(batch: InvocationBatch, db)`:
  - Bulk insert into `skill_invocations`
  - Group by `skill_id`; for each group:
    - `UPDATE skills SET agent_invocation_count = agent_invocation_count + $count, last_used_at = NOW()`
    - Rolling avg for `avg_execution_time_ms` (use exponential moving average: `new = old * 0.9 + sample * 0.1`)
    - Update `weekly_agent_invocation_count` (this column is reset by cron, not decremented here)
    - Update `composition_inclusion_count` for each `compositionId` present in batch
  - This endpoint is called by Cortex runtime — must handle up to 500 invocations per batch
  - Non-blocking: wrap in `ctx.waitUntil()`

### 3.3 `cooccurrence.ts`

- `getCoOccurrence(skillId, limit = 5, db)`:
  - Query `skill_cooccurrence` materialized view for `skill_a = skillId OR skill_b = skillId`
  - Join to `skills` for each peer skill
  - Return: `[{ skillId, name, slug, compositionCount, totalPairedInvocations }]`

### 3.4 `leaderboards.ts`

Four query functions, each querying the appropriate materialized view:
- `getHumanLeaderboard(filters, db)` — from `leaderboard_human`
- `getAgentLeaderboard(filters, db)` — from `leaderboard_agent`
- `getTrendingLeaderboard(filters, db)` — from `leaderboard_agent` sorted by `weekly_agent_invocation_count DESC`
- `getMostComposedLeaderboard(filters, db)` — from `leaderboard_agent` sorted by `composition_inclusion_count DESC`

Filters: `type`, `category`, `ecosystem`, `limit` (default 20, max 100).

---

## Phase 4 — Authors Module

Create `src/authors/handler.ts`:
- `GET /v1/authors/:handle` — query `authors` table, join to skills for stats
- `GET /v1/authors/:handle/skills` — paginated, filterable by `type`, `status`

No write endpoints — authors are created implicitly on first skill publish (upsert by `authorId`).

Add author upsert to `src/publish/handler.ts`: on `POST /v1/skills`, upsert into `authors` table from `author_id`, `author_type`, `author_bot_model` in request body.

---

## Phase 5 — API Routes

Add to `src/index.ts` (Hono router). Group clearly with comments. Do not modify existing routes.

```typescript
// ── Composition ──
app.post('/v1/skills/:id/fork',        /* fork handler */)
app.post('/v1/skills/:id/copy',        /* copy handler */)
app.post('/v1/skills/:id/extend',      /* extend handler */)
app.post('/v1/compositions',           /* createComposition */)
app.get( '/v1/compositions/:id',       /* getComposition with steps */)
app.put( '/v1/compositions/:id/steps', /* replaceSteps */)
app.post('/v1/compositions/:id/publish', /* publishComposition */)

// ── Lineage ──
app.get('/v1/skills/:id/lineage',   /* getAncestry */)
app.get('/v1/skills/:id/forks',     /* getForks */)
app.get('/v1/skills/:id/dependents', /* getDependents */)

// ── Social — human only ──
app.post(  '/v1/skills/:id/star', /* starSkill */)
app.delete('/v1/skills/:id/star', /* unstarSkill */)
app.get(   '/v1/skills/:id/stars', /* getStarCount */)

// ── Agent signals ──
app.post('/v1/invocations',           /* recordInvocations — waitUntil */)
app.get( '/v1/skills/:id/cooccurrence', /* getCoOccurrence */)

// ── Leaderboards ──
app.get('/v1/leaderboards/human',        /* getHumanLeaderboard */)
app.get('/v1/leaderboards/agents',       /* getAgentLeaderboard */)
app.get('/v1/leaderboards/trending',     /* getTrendingLeaderboard */)
app.get('/v1/leaderboards/most-composed', /* getMostComposedLeaderboard */)

// ── Authors ──
app.get('/v1/authors/:handle',        /* getAuthor */)
app.get('/v1/authors/:handle/skills', /* getAuthorSkills */)
```

---

## Phase 6 — Cron Jobs

Add to the scheduled handler in `src/index.ts`. Append to existing cron block — do not replace it.

```typescript
// Every hour: refresh materialized views
if (minute === 0) {
  ctx.waitUntil(refreshMaterializedViews(env));
}

// Every day at midnight: reset weekly_agent_invocation_count
// Accumulate into a separate weekly snapshot table first
if (hour === 0 && minute === 0) {
  ctx.waitUntil(rollWeeklyInvocationCounts(env));
}
```

Add to `wrangler.toml` triggers: `"0 * * * *"` (hourly).

`refreshMaterializedViews` issues:
```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY skill_cooccurrence;
REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_human;
REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_agent;
REFRESH MATERIALIZED VIEW CONCURRENTLY search_quality_summary;
```

---

## Phase 7 — SkillResult Update

Update `SkillResult` interface in `src/types.ts`. Append only — do not remove existing fields:

```typescript
export interface SkillResult {
  // ... existing fields unchanged ...

  // Composition & social additions
  type: 'skill' | 'composition' | 'pipeline';
  status: 'published' | 'deprecated' | 'archived';
  replacementSkillId?: string;   // agents auto-substitute on deprecated
  replacementSlug?: string;

  authorHandle?: string;
  authorType?: 'human' | 'bot' | 'org';

  forkOf?: string;
  forkDepth?: number;

  // Human metrics (only in non-search contexts — not returned in findSkill results)
  humanStarCount?: number;
  humanForkCount?: number;

  // Agent metrics
  agentInvocationCount?: number;
  compositionInclusionCount?: number;
  avgExecutionTimeMs?: number;
  errorRate?: number;

  // Discovery
  tags?: string[];
  cooccursWith?: { skillId: string; slug: string; compositionCount: number }[];
}
```

`findSkill` responses: include `type`, `status`, `replacementSkillId`, `tags`, `avgExecutionTimeMs`, `errorRate`. Omit raw counters from search results to keep payload lean.

---

## Tests to Write

- `composition/fork.test.ts` — fork copies steps, increments correct counter, lineage correct
- `composition/compose.test.ts` — trust score = MIN, capabilities = union, invalid skillId → 400
- `composition/publish.test.ts` — draft → published, reject if step skill deprecated
- `social/stars.test.ts` — idempotent, bot rejection, rate limit
- `social/invocations.test.ts` — bulk insert, rolling avg update, waitUntil used
- `social/leaderboards.test.ts` — human leaderboard contains no bots, agent leaderboard contains all types

---

## Constraints

- Human counter columns (`human_*`) are written **only** from `src/social/stars.ts` and `src/composition/fork.ts` (human path). Never from `src/social/invocations.ts`.
- Agent counter columns (`agent_invocation_count`, `weekly_agent_invocation_count`, `composition_inclusion_count`) are written **only** from `src/social/invocations.ts`. Never from social star/fork paths.
- All leaderboard reads go through materialized views — never raw aggregate queries at request time.
- `trust_score` on a composition is always computed, never manually set by publisher.
- Migrations run in order: 0004 → 0005 → 0006 → 0007 → 0008. 0006 depends on 0005 (FK to skills.id for compositions).
