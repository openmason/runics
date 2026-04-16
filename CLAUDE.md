# Runics Search

Semantic skill registry search service for the Runics platform.

## Status

v5.4 spec. 526 tests, 57 endpoints, 15 migrations. Deployed to staging + production (April 2026).
v5.3 features (portable, pull, export, API keys) are spec'd but not implemented — deferred to Step 2.
Known SDK issues documented in ARCHITECTURE.md §17 Known Issues table.

## Architecture

Read ARCHITECTURE.md for the complete spec. It is the single source of truth.

## Stack

- TypeScript on Cloudflare Workers (Hono framework)
- Neon Postgres with pgvector (HNSW) + tsvector for search
- Cloudflare Workers AI for embeddings (bge-small-en-v1.5), reranking, and LLM fallback
- Cloudflare KV for caching
- Hyperdrive for Postgres connection pooling
- @neondatabase/serverless for the Postgres driver (NOT pg — standard pg doesn't work in Workers)
- Drizzle ORM for schema/migrations

## Key Principles

- SearchProvider interface is the sacred abstraction boundary
- Intelligence layer (confidence gating, LLM fallback) sits ABOVE the provider
- Never import Postgres types outside pgvector-provider.ts
- Every threshold is configurable via env vars (never hardcode)
- Logging is non-blocking (use executionCtx.waitUntil)
- Eval suite runs before and after every change — numbers only, no "feels better"

## Project Structure

See ARCHITECTURE.md for the full tree. Key directories:
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
- src/cache/         — KV cache
- src/db/            — Drizzle schema + SQL migrations (0001-0015)
- src/eval/          — Eval suite (fixtures, runner, metrics)
- src/resilience/    — Circuit breaker

## Commands

npm run dev               — wrangler dev (local)
npm run deploy:staging    — wrangler deploy (staging)
npm run deploy:production — wrangler deploy -c wrangler.production.toml
npm run db:migrate        — run drizzle migrations
npm run eval              — run eval suite against live endpoint
npm run typecheck         — tsc --noEmit
npm run test:run          — run vitest (single run, no watch)
npm run smoke:production  — smoke test against api.runics.net
npm run smoke:staging     — smoke test against staging
npm run perf              — latency benchmark with SLOs

## Testing

vitest for unit tests. Tests live in tests/ mirroring src/ structure.

