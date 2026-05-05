# Runics — Codebase Guide

> Implementation-specific details for the Runics codebase. For architecture and design, see the canonical specs below.
> **Last updated:** May 2026

---

## 1. Canonical Specs (source of truth)

All design, architecture, and protocol decisions live in `/Users/eyal/work/openmason/`:

| File | What it covers |
|------|---------------|
| `runics.md` | Full Runics architecture — search, ingestion, trust, composition, DAG, events, API surface (v5.5) |
| `cognium-engine.md` | Cognium scanning engine — Circle-IR integration, trust scoring, scan pipeline |
| `architecture.md` | Platform-level architecture — Cortex, Runics, Forge, Mandate, deployment topology |
| `principles.md` | Cross-product design principles — authoring, gates, trust, tenant isolation, deployment |
| `skill-convention.md` | First-party skill format — handler pattern, SKILL.md schema, sandbox contract, versioning |

This file covers **what's deployed, how the code is organized, and implementation patterns** — things the specs don't track.

---

## 2. Current State

| Metric | Value |
|--------|-------|
| Spec version | v5.4 deployed, v5.5 canonical |
| Tests | 532 |
| Endpoints | 73 (39 OpenAPI + 26 admin + 8 publish/authors) |
| Migrations | 16 (0001–0015 + 0018) |
| Published skills | 56.6K across 7 sources (62.8K total) |
| Eval | 91 fixtures, R@1=100%, R@5=100%, MRR=1.000 |
| Cognium scanning | ENABLED — `COGNIUM_ENABLED=true`, no auth needed, processing 56K backlog |
| Content safety | DISABLED — `DISABLE_CONTENT_SAFETY=true`, llama-guard model broke |
| Staging | DEAD — Neon free-tier data transfer quota exceeded |

v5.3 features (portable, pull, export, API keys) are spec'd but not implemented — deferred to Step 2.

---

## 3. Project Structure

```
runics/
├── wrangler.toml / wrangler.production.toml
├── package.json / tsconfig.json / drizzle.config.ts
├── src/
│   ├── index.ts                          # Worker entry, OpenAPIHono, Scalar docs, admin routes (~25)
│   ├── components.ts                     # initComponents(env), createPool(env) — shared service init
│   ├── types.ts                          # All shared types
│   │
│   ├── routes/                           # OpenAPI route modules (@hono/zod-openapi)
│   │   ├── search.ts                     # GET /health, POST /v1/search, POST /v1/search/feedback
│   │   ├── skills.ts                     # DELETE, GET by slug/version
│   │   ├── analytics.ts                  # 8 endpoints (tiers, latency, cost, etc.)
│   │   ├── eval.ts                       # run, results, compare
│   │   ├── composition.ts                # fork, copy, extend, CRUD, publish (7)
│   │   ├── lineage.ts                    # lineage, forks, dependents (3)
│   │   ├── social.ts                     # star, unstar, stars, invocations, cooccurrence (5)
│   │   └── leaderboards.ts              # human, agents, trending, most-forked/composed (5)
│   │
│   ├── schemas/                          # Shared Zod schemas for OpenAPI
│   │   ├── common.ts                     # SkillIdParam, SkillSlugParam, HoursQuery
│   │   └── responses.ts                  # ~30 response schemas with .openapi() annotations
│   │
│   ├── providers/
│   │   ├── search-provider.ts            # SearchProvider interface
│   │   └── pgvector-provider.ts          # Vector + full-text + status filter + version ranking
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
│   │   └── content-safety.ts             # Llama Guard (disabled)
│   │
│   ├── cognium/
│   │   ├── poll-consumer.ts              # HTTP client → Circle-IR (poll + apply)
│   │   ├── request-builder.ts            # Skill → ScanRequest
│   │   ├── scoring-policy.ts             # Trust formula, severity→status, tier, remediation
│   │   ├── scan-report-handler.ts        # Apply findings → trust + status
│   │   ├── composite-cascade.ts          # Cascade status to composites
│   │   ├── notification-trigger.ts       # Webhook on revoke/flag
│   │   └── types.ts
│   │
│   ├── composition/
│   │   ├── fork.ts / compose.ts / extend.ts / lineage.ts / publish.ts / schema.ts
│   │
│   ├── social/
│   │   ├── stars.ts / invocations.ts / cooccurrence.ts / leaderboards.ts
│   │
│   ├── authors/handler.ts
│   │
│   ├── publish/
│   │   ├── handler.ts                    # POST /v1/skills, PUT trust, PATCH status, bundle, publish
│   │   ├── dag-validator.ts              # v5.4: DAG workflow validation
│   │   └── schema.ts                     # publishSkillSchema
│   │
│   ├── sync/
│   │   ├── base-sync.ts                  # BaseSyncWorker
│   │   ├── mcp-registry.ts / clawhub.ts / github.ts
│   │
│   ├── monitoring/
│   │   ├── search-logger.ts / quality-tracker.ts / perf-monitor.ts
│   │
│   ├── cache/kv-cache.ts                 # Search + query embedding cache
│   │
│   ├── db/
│   │   ├── schema.ts                     # Drizzle schema
│   │   └── migrations/
│   │       ├── 0001_skill_embeddings.sql
│   │       ├── 0002_search_logs.sql
│   │       ├── 0003_quality_feedback.sql
│   │       ├── 0004_sync_columns.sql
│   │       ├── 0005_skills_v4.sql
│   │       ├── 0006_authors.sql
│   │       ├── 0007_compositions.sql
│   │       ├── 0008_invocation_graph.sql
│   │       ├── 0009_leaderboards.sql
│   │       ├── 0010_skill_lifecycle.sql
│   │       ├── 0011_cognium_job_tracking.sql
│   │       ├── 0012_scan_coverage_v2.sql
│   │       ├── 0013_scan_failure_reason.sql
│   │       ├── 0014_v52_columns.sql
│   │       ├── 0015_workflow_definition.sql
│   │       └── 0018_scan_retry_count.sql
│   │
│   ├── eval/
│   │   ├── runner.ts / fixtures.ts / metrics.ts
│   │
│   └── resilience/                       # Circuit breaker
│
├── scripts/
│   ├── seed-eval-skills.ts / bootstrap-production.sql
│   ├── smoke-test.ts / perf-test.ts
│
├── tests/                                # vitest, mirrors src/ structure
│
└── web/                                  # Astro frontend (deployed as CF Worker "web")
    ├── wrangler.jsonc / astro.config.mjs / package.json
    └── src/
        ├── layouts/Layout.astro
        ├── styles/global.css             # Tailwind + design tokens (theme source of truth)
        └── pages/
            ├── index.astro               # Landing: search, stats, features, FAQ
            └── skills/[slug].astro       # Skill detail page
```

---

## 4. API Surface

### OpenAPI Routes (39 endpoints — api.runics.net/docs)

Route modules in `src/routes/`, schemas in `src/schemas/`. Uses `@hono/zod-openapi` with `createRoute()` + `app.openapi()`.

| Tag | Routes | File |
|-----|--------|------|
| Health | `GET /health` | search.ts |
| Search | `POST /v1/search`, `POST /v1/search/feedback` | search.ts |
| Skills | `DELETE /v1/skills/:skillId`, `GET /v1/skills/:slug[/versions/:version]` | skills.ts |
| Composition | fork, copy, extend, compositions CRUD, publish (7) | composition.ts |
| Lineage | lineage, forks, dependents (3) | lineage.ts |
| Social | star, unstar, stars, invocations, cooccurrence (5) | social.ts |
| Leaderboards | human, agents, trending, most-forked, most-composed (5) | leaderboards.ts |
| Analytics | tiers, match-sources, latency, cost, failed-queries, tier3-patterns, revoked-impact, vulnerable-usage (8) | analytics.ts |
| Eval | run, results, results/:runId, compare (4) | eval.ts |

### Publish & Authors (8 endpoints — src/publish/ + src/authors/)

`POST/PUT/PATCH/DELETE /v1/skills/*`, `PUT /v1/skills/:id/bundle`, `POST /v1/skills/:id/publish`, `GET /v1/authors/:handle[/skills]`

### Admin Routes (25 endpoints — src/index.ts, no OpenAPI)

Cognium admin (scan, apply-job, scan-test, stats, preview, analyze, analyze-batch), maintenance (clear-stale, deprecate-failed, fix-safety-nulls, restore-revoked, skill-inventory, embed-backfill, embed-queue-backfill, reset-trust, backfill), dedup (analysis, repo-url, name), sync triggers (clawhub, glama, smithery, pulsemcp, openclaw, regenerate-summaries).

### Unimplemented (v5.3 — deferred)

`GET /v1/skills/:slug/pull`, `GET /v1/catalog/export`

---

## 5. Implementation Patterns

### OpenAPI Route Pattern

```typescript
// src/routes/<module>.ts
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Env } from '../types';
import { initComponents } from '../components';

const app = new OpenAPIHono<{ Bindings: Env }>();

const route = createRoute({
  method: 'post',
  path: '/v1/search',              // path params use {id} syntax
  tags: ['Search'],
  summary: 'Semantic skill search',
  request: { body: { content: { 'application/json': { schema: RequestSchema } }, required: true } },
  responses: { 200: { content: { 'application/json': { schema: ResponseSchema } }, description: '...' } },
});

app.openapi(route, async (c) => {
  const body = c.req.valid('json');
  const { gate } = initComponents(c.env);
  // ... handler logic ...
  return c.json(result, 200);      // always specify status code
});

export { app as searchRoutes };
```

### Service Initialization

`src/components.ts` exports `initComponents(env)` (returns gate, provider, embedPipeline, qualityTracker, searchCache, pool) and `createPool(env)` (returns bare Neon pool). Every route file imports from here.

### Non-blocking Logging

All monitoring writes use `c.executionCtx.waitUntil()` — never inline awaits for search_logs/quality_feedback.

### Database Access

`@neondatabase/serverless` only (NOT `pg`). Connection pooling via Hyperdrive. Drizzle for schema/migrations. Never import Postgres types outside `pgvector-provider.ts`.

### Index.ts Structure

```
OpenAPIHono setup → middleware (cors, publicGuard, rateLimiter, adminAuth)
→ app.doc31('/openapi.json', ...) + app.get('/docs', Scalar(...))
→ mount route modules: app.route('/', searchRoutes), etc.
→ mount subrouters: app.route('/v1/skills', publishRoutes), app.route('/v1/authors', authorRoutes)
→ admin routes (plain app.post/get, no OpenAPI)
→ export { fetch, scheduled, queue }
```

---

## 6. Known Issues

| Issue | Detail |
|-------|--------|
| Content safety disabled | `DISABLE_CONTENT_SAFETY=true`. Cloudflare llama-guard-3-8b rejects `system` role, flagging all descriptions as unsafe. |
| Staging dead | Neon free-tier data transfer quota exceeded. Needs plan upgrade or new project. |
| Cold query latency | ~4s on first uncached query (Workers AI embedding warm-up). Keep-alive mitigates Worker cold start but not AI model cold start. |
| `cognium_scanned` legacy column | Boolean still referenced in some code paths; actual code uses `cognium_scanned_at`. |

---

## 7. Key Design Decisions

1. **SearchProvider interface is sacred.** Never import Postgres types outside `pgvector-provider.ts`.
2. **Every threshold is configurable** via env vars (tier boundaries, fusion weights, cache TTL).
3. **Content safety runs on ingest, not query.** Excluded via WHERE filter.
4. **Status filter is not optional.** `revoked`, `draft`, `degraded` always excluded.
5. **Version ranking, not newest.** `ORDER BY trust×0.7 + min(run_count/100, 1.0)×0.3`.
6. **Trust is Cognium's responsibility.** Sync workers set `0.5 / unverified` until scanned.
7. **`runtime_env` is orthogonal to `execution_layer`.** Layer = how Cortex invokes. Env = what infra it needs.
8. **OpenAPI for public routes, plain Hono for admin.** Route modules in `src/routes/`, admin inline in `src/index.ts`.

---

## 8. Commands

### API (root directory)

```
npm run dev               — wrangler dev (local)
npm run deploy:staging    — wrangler deploy (staging)
npm run deploy:production — wrangler deploy -c wrangler.production.toml
npm run db:migrate        — run drizzle migrations
npm run typecheck         — tsc --noEmit
npm run test:run          — run vitest (single run)
npm run smoke:production  — smoke test against api.runics.net
npm run smoke:staging     — smoke test against staging
npm run perf -- --endpoint https://api.runics.net  — latency benchmark
npx tsx scripts/run-eval.ts --endpoint https://api.runics.net/v1/search  — eval suite
```

### Web (web/ directory)

```
npm run dev               — astro dev (local)
npm run deploy            — astro build && wrangler deploy (production via Worker "web")
```

**Note:** The web deploys as a Cloudflare Worker (name: "web"), NOT Pages. Always use `cd web && npm run deploy`.

---

*This file covers implementation details. For architecture and design, see the canonical specs in `/Users/eyal/work/openmason/`. — Cognium Labs*
