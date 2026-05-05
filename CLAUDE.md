# Runics Search

Semantic skill registry search service for the Runics platform.

## Status

v5.4 deployed, v5.5 canonical spec. 528 tests, 72 endpoints (39 OpenAPI + 25 admin + 8 publish/authors), 15 migrations.
Deployed to production (May 2026). Interactive API docs at api.runics.net/docs (Scalar + OpenAPI 3.1).
56.6K published skills across 7 sources (62.8K total). 91 eval fixtures, R@1=100%, R@5=100%, MRR=1.000.
Eval uses name-pattern matching to auto-accept cross-source duplicates — no more UUID treadmill.
Cognium scanning DISABLED — missing Circle-IR API key. Content safety DISABLED — llama-guard model broke.
Staging DEAD — Neon free-tier data transfer quota exceeded.
v5.3 features (portable, pull, export, API keys) are spec'd but not implemented — deferred to Step 2.

## Canonical Specs (source of truth)

Architecture and design decisions live in `/Users/eyal/work/openmason/`:

| File | Covers |
|------|--------|
| `runics.md` | Full Runics architecture — search, ingestion, trust, composition, DAG, events, API (v5.5) |
| `cognium-engine.md` | Cognium scanning engine — Circle-IR, trust scoring, scan pipeline |
| `architecture.md` | Platform-level architecture — Cortex, Runics, Forge, Mandate, deployment |
| `principles.md` | Cross-product design principles — authoring, gates, trust, tenant isolation |
| `skill-convention.md` | First-party skill format — handler pattern, SKILL.md, sandbox contract |

ARCHITECTURE.md in this repo is the **codebase guide** — project structure, API surface, implementation patterns, known issues. Not a spec.

## URLs

**Production:**
- API: `https://api.runics.net` / `https://runics.cognium.workers.dev`
- API Docs: `https://api.runics.net/docs` (Scalar — OpenAPI 3.1, themed to match website)
- OpenAPI spec: `https://api.runics.net/openapi.json` (38 paths, 39 endpoints)
- Web: `https://runics.net` / `https://web.cognium.workers.dev`

**Staging:**
- API: `https://runics.phantoms.workers.dev`
- Web: `https://runics-web-brm.pages.dev`

## Stack

- TypeScript on Cloudflare Workers (OpenAPIHono framework — @hono/zod-openapi)
- @scalar/hono-api-reference for interactive API docs at /docs
- Neon Postgres with pgvector (HNSW) + tsvector for search
- Cloudflare Workers AI for embeddings (bge-small-en-v1.5), reranking, and LLM fallback
- Cloudflare KV for caching (search results + query embedding cache)
- Hyperdrive for Postgres connection pooling
- @neondatabase/serverless for the Postgres driver (NOT pg — standard pg doesn't work in Workers)
- Drizzle ORM for schema/migrations
- Astro + Cloudflare Workers for the web frontend (web/ directory)

## Key Principles

- SearchProvider interface is the sacred abstraction boundary
- Intelligence layer (confidence gating, LLM fallback) sits ABOVE the provider
- Never import Postgres types outside pgvector-provider.ts
- Every threshold is configurable via env vars (never hardcode)
- Logging is non-blocking (use executionCtx.waitUntil)
- Eval suite runs before and after every change — numbers only, no "feels better"

## Performance

All SLOs passing (April 30, 2026 benchmark):
- Search T1 p50: 43ms, p95: 204ms (SLO < 300ms)
- Search T2 p50: 40ms, p95: 101ms (SLO < 600ms)
- Skill lookup p50: 26ms, p95: 28ms (SLO < 400ms)
- Leaderboard p50: 27ms, p95: 116ms (SLO < 400ms)
- Cold query: ~4s (Workers AI embedding warm-up, architectural limit)
- Query embedding cache in KV saves ~1000ms on repeat queries
- T1 reranker skip (SKIP_RERANKER_GAP) saves ~120ms when top result is dominant
- Cron keep-alive self-ping every minute prevents Worker cold starts

## Project Structure

See ARCHITECTURE.md for the full tree. Key directories:
- src/routes/        — OpenAPI route modules (search, skills, analytics, eval, composition, lineage, social, leaderboards)
- src/schemas/       — Shared Zod schemas for OpenAPI (responses.ts, common.ts)
- src/components.ts  — Shared service initialization (initComponents, createPool)
- src/providers/     — SearchProvider interface + PgVectorProvider
- src/intelligence/  — Confidence gate, deep search, composition detector, reranker
- src/ingestion/     — Embed pipeline, agent summary, content safety
- src/cognium/       — Circle-IR scanning, trust scoring, composite cascade
- src/composition/   — Fork, copy, compose, extend, lineage, publish
- src/social/        — Stars, invocations, cooccurrence, leaderboards
- src/authors/       — Author profiles and skill listings
- src/publish/       — Publish API (CRUD + trust + bundle)
- src/sync/          — MCP Registry, ClawHub, GitHub sync adapters
- src/queues/        — Queue consumers (embed)
- src/monitoring/    — Search logger, quality tracker, perf monitor
- src/cache/         — KV cache (search results + query embeddings)
- src/db/            — Drizzle schema + SQL migrations (0001-0015)
- src/eval/          — Eval suite (fixtures, runner, metrics)
- src/resilience/    — Circuit breaker
- web/               — Astro frontend (deployed as Cloudflare Worker "web")

## Commands

### API (root directory)
npm run dev               — wrangler dev (local)
npm run deploy:staging    — wrangler deploy (staging)
npm run deploy:production — wrangler deploy -c wrangler.production.toml
npm run db:migrate        — run drizzle migrations
npx tsx scripts/run-eval.ts --endpoint https://api.runics.net/v1/search  — run eval suite
npm run typecheck         — tsc --noEmit
npm run test:run          — run vitest (single run, no watch)
npm run smoke:production  — smoke test against api.runics.net
npm run smoke:staging     — smoke test against staging
npm run perf -- --endpoint https://api.runics.net  — latency benchmark with SLOs

### Web (web/ directory)
npm run dev               — astro dev (local)
npm run deploy            — astro build && wrangler deploy (production via Worker "web")

**Note:** The web deploys as a Cloudflare Worker (name: "web"), NOT Pages.
The `runics-web` Pages project exists but is NOT wired to `runics.net`.
Always use `cd web && npm run deploy` to deploy the frontend.

## Testing

vitest for unit tests. Tests live in tests/ mirroring src/ structure.

## Design Tokens (Theme)

All Runics surfaces (website, API docs, future dashboards) share this palette:

| Token | Value | Usage |
|-------|-------|-------|
| `--color-bg` | `#0a0a0b` | Page background |
| `--color-bg-elevated` | `#111113` | Elevated surfaces |
| `--color-bg-card` | `#16161a` | Cards, panels |
| `--color-bg-card-hover` | `#1c1c21` | Card hover state |
| `--color-border` | `#27272a` | Primary borders |
| `--color-border-subtle` | `#1e1e22` | Subtle separators |
| `--color-text-primary` | `#ededed` | Body text |
| `--color-text-secondary` | `#a0a0a6` | Secondary text |
| `--color-text-muted` | `#6b6b72` | Muted / placeholder |
| `--color-accent` | `#6ee7b7` | Emerald accent (links, highlights, buttons) |
| `--color-accent-dim` | `#34d399` | Hover/active accent |
| `--color-accent-glow` | `rgba(110,231,183,0.12)` | Glow backgrounds |
| Font sans | Inter | Body text |
| Font mono | JetBrains Mono | Code, metrics |

Scalar API docs (api.runics.net/docs) are themed via `customCss` in `src/index.ts` mapping these tokens to `--scalar-*` variables. When adding new surfaces, use these tokens — not arbitrary hex values.

## Known Issues

- **Cognium scanning disabled** — `COGNIUM_ENABLED=false` in wrangler.production.toml. Missing real Circle-IR API key. Set with `wrangler secret put COGNIUM_API_KEY -c wrangler.production.toml` and flip to `true`.
- **Content safety disabled** — `DISABLE_CONTENT_SAFETY=true`. Cloudflare's llama-guard-3-8b no longer accepts the `system` role, causing all dev tool descriptions to be flagged as unsafe. Fix: switch to a model that supports system role, or wait for Cloudflare fix.
- **Staging dead** — Neon free-tier data transfer quota exceeded. Needs plan upgrade or new project.
- **Cold query latency** — ~4s on first uncached query due to Workers AI embedding model warm-up. Architectural limit of `bge-small-en-v1.5` on Cloudflare. Keep-alive mitigates Worker cold start but not AI model cold start.
- **~3,149 unverified skills** — Scanner disabled before scanning these. Root cause: `markScanFailed()` clears findings but doesn't clear `cognium_scanned_at`, and poll consumer treats 404 as terminal failure. Resilience PR needed.
