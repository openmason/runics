# Runics Search

Semantic skill registry search service for the Runics platform.

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

## Build Order (Measure-First)

Phase 1: Single-vector search + eval suite (baseline)
Phase 2: Confidence gating + LLM fallback (measure lift)
Phase 3: Multi-vector validation via A/B test (measure lift, decide)
Phase 4: Production polish

## Project Structure

See ARCHITECTURE.md Section 19 for the full tree. Key directories:
- src/providers/     — SearchProvider interface + PgVectorProvider
- src/intelligence/  — Confidence gate, deep search, composition detector
- src/ingestion/     — Embed pipeline, agent summary, content safety
- src/monitoring/    — Search logger, quality tracker, perf monitor
- src/cache/         — KV cache
- src/db/            — Drizzle schema + SQL migrations
- src/eval/          — Eval suite (fixtures, runner, metrics)

## Commands

npm run dev        — wrangler dev (local)
npm run deploy     — wrangler deploy
npm run db:migrate — run drizzle migrations
npm run eval       — run eval suite against live endpoint
npm run typecheck  — tsc --noEmit

## Testing

vitest for unit tests. Tests live in tests/ mirroring src/ structure.

