# Cognium Labs — Architecture Overview

> **Version:** 1.0 · April 2026
> **Status:** All architectural decisions locked. Core specs complete. Runics v5.4 deployed to production.
> **Company:** Cognium Labs
> **Companion docs:** `cortex-specification-v2_0.md` · `ARCHITECTURE.md` · `bombastic-specification-v2_3.md` · `cognium-server-specification-v2_1.md` · `cognium-client-specification-v2_1.md` · `cognium-specification-v2_1.md` · `forge-specification-v1_3.md` · `runics-dag-specification.md` · `api-key-middleware-specification.md`

---

## 1. Mission

Cognium Labs builds the foundational infrastructure that makes autonomous AI agents reliable, discoverable, and trustworthy. The platform provides skill discovery, trust verification, and durable workflow execution — infrastructure built for agents and LLMs, not humans.

---

## 2. Product Portfolio

Four products, identical architecture pattern. Two are spec'd, two are parked for future.

| Product | Domain | Audience | Item type | Status |
|---|---|---|---|---|
| Bombastic / Clove | clove.run | Consumer — everyone | Todos, life tasks | Spec'd (v2.2) |
| CoStaff | costaff.app | B2B — teams | Business processes | Parked |
| ControlDeck | controldeck.dev | Developers | Features, PRs, specs | Parked |
| Akrobatos | TBD | Ops / SRE | Incidents, environments | Parked |

Customer support is a configuration of CoStaff, not a separate product. Gamayun is reserved as a future cross-product knowledge layer brand.

### Universal UX Pattern

Every product follows the same interaction model:

```
Board (items) → Scoped chat (refine) → Execute (workflows) → Save as skill
```

The "item" type changes per product (todo, task, feature, incident). The architecture is identical:

- Product DO extends `@specifica/store` for board state, chat, memory, settings, git sync
- Product DO calls Cortex for workflow execution
- Cortex executes DAGs, calls Mastra wrapper for LLM reasoning
- User saves successful workflows as skills in Runics
- Skill discovery happens through chat ("find me a skill for X"), not a browse UI

### Product Differentiation

| Product | Unique additions on top of @specifica/store |
|---|---|
| Bombastic | Auth (passkeys + magic link), anonymous-first, approval cards, rate limiting |
| CoStaff | Team policies, department scoping, audit logs, role-based access |
| ControlDeck | Policy engine, workflow authoring, human review gates, pluggable code gen tool |
| Akrobatos | Escalation policies, runbook import, high-approval-stakes for production ops |

---

## 3. Architecture Layers

```
┌────────────────────────────────────────────────────────────────┐
│  Products: Clove · CoStaff · ControlDeck · Akrobatos           │
│  Board → Chat → Execute → Save as skill                        │
├────────────────────────────────────────────────────────────────┤
│  @specifica/store · Product DOs                                 │
│  Board state · Chat · Memory · Settings · Git sync              │
│  Skill event handling (product decides: pause/notify/update)    │
├────────────────────────────────────────────────────────────────┤
│  HTTP ↓  ·  WebSocket ↑                                        │
├────────────────────────────────────────────────────────────────┤
│  Cortex — Workflow Engine (Cloudflare Workflows)                │
│  ┌──────────────┬──────────────┬──────────────────────────┐    │
│  │ Workflow DOs  │ Triggers     │ Forge                    │    │
│  │ DAG executor  │ Cron/Webhook │ Trace → skill            │    │
│  │ Hot/cold auto │ Event/Spawn  │ Async distillation       │    │
│  ├──────────────┴──────────────┴──────────────────────────┤    │
│  │ Mastra wrapper          │ Approval engine               │    │
│  │ LLM reasoning           │ Events → products route       │    │
│  │ Service binding          │ Batch approvals (future)      │    │
│  ├────────────────────────────────────────────────────────┤    │
│  │ Activepieces connectors (code dependency, not service)  │    │
│  ├────────────────────────────────────────────────────────┤    │
│  │ API: /v1/chat · /v1/workflows · /v1/workflows/:id       │    │
│  │      /v1/approvals/:id · /v1/webhooks/:t/:w              │    │
│  └────────────────────────────────────────────────────────┘    │
├────────────────────────────────────────────────────────────────┤
│  External Services                                              │
│  ┌──────────────────────────┬─────────────────────────────┐    │
│  │ Runics                    │ Cognium                      │    │
│  │ Skills · DAG compositions │ Trust verification           │    │
│  │ Search · Trust cache      │ Scan-time only               │    │
│  │ Revocation events → Cortex│ Runics dependency            │    │
│  └──────────────────────────┴─────────────────────────────┘    │
├────────────────────────────────────────────────────────────────┤
│  Shared Packages                                                │
│  @specifica/store · @specifica/format · @runics (SDK+CLI)       │
│  @runics/dag (DAG schema + interpreter)                         │
└────────────────────────────────────────────────────────────────┘
```

---

## 4. Component Specifications

### 4.1 Cortex — Workflow Engine

**What it is:** A generic DAG executor built on Cloudflare Workflows. The spine of all execution.

**What changed (v1.5 → v2.0):**
- Mastra pieces extracted to a library/wrapper (separate Worker, service binding)
- Cortex becomes a durable workflow engine, not an LLM orchestration proxy
- Forge absorbed as an internal async subsystem
- Activepieces demoted from "event/trigger layer" to code dependency (connector library)
- CF Workflows provides durable execution, retries, sleep, events — no custom DO engine needed
- DAG definitions stored in Runics, read at execution time

**Dual execution mode:**
- Conversational mode: ephemeral, direct to Mastra wrapper, no durable state. For real-time chat.
- Workflow mode: durable, CF Workflow instance per DAG. For multi-step execution.
- Auto-promotion: when conversational mode detects a decomposition, Cortex instantiates a durable workflow.

**API surface:**

| Endpoint | Purpose |
|---|---|
| `POST /v1/chat` | Conversational mode (backward compatible) |
| `POST /v1/workflows` | Create a durable workflow instance from a DAG |
| `GET /v1/workflows/:id` | Query workflow instance state |
| `POST /v1/approvals/:id/approve\|reject` | Resolve a paused approval step |
| `POST /v1/webhooks/:tenantId/:workflowId` | External event delivery to a workflow instance |

**Product ↔ Cortex communication:**
- Product → Cortex: HTTP (create workflows, resolve approvals)
- Cortex → Product: WebSocket push (step completion, approval requests, failures)
- Workflow completion/error: executor's final step notifies product DO via HTTP

**Cortex session config (per product):**

| Product | Appetite | Min Trust | Approval Mode |
|---|---|---|---|
| Bombastic | `balanced` | 0.50 | `side-effects-only` |
| CoStaff | `cautious` | 0.70 | `policy-defined` |
| ControlDeck | `cautious` | 0.70 | `side-effects-only` |
| Akrobatos | `strict` | 0.85 | `always` |

### 4.2 Mastra Wrapper

**What it is:** A stateless LLM reasoning service. Separate Cloudflare Worker connected to Cortex via service binding (zero-latency, same colo).

**What it does:**
- Mastra orchestration with system prompt + model routing
- Conversation memory (per userId + conversationId)
- `emit_decomposition` tool (expanded to emit DAG with dependencies + input mapping)
- LLM calls routed through existing LLM proxy (not CF AI Gateway)

**What it doesn't do:** skill execution, approval management, workflow state, trust gating — all moved to Cortex.

### 4.3 Forge — Cortex Internal Subsystem

**What it is:** Trace capture and skill distillation. Lives inside the Cortex codebase, consumes from an internal queue.

**What changed:**
- No longer a peer infrastructure layer — internal to Cortex
- Captures execution traces from workflow steps
- Distills skills only (not knowledge — Gamayun's future scope)
- DAG is built by Cortex at decomposition time, not reconstructed from traces by Forge

**Scope:** skills only. When a user "saves as skill," Cortex serializes the DAG and publishes to Runics. Forge captures the trace for analytics and quality improvement, but the DAG is a Cortex artifact.

### 4.4 Runics — Skill Registry + DAG Store

**What it is:** The universal skill registry and workflow DAG store. Discoverable, forkable, trust-scored.

**What changed (v5.3 → v5.4):**
- Composition schema expanded to portable DAG format (conditions, branches, retry policies, parallel deps)
- `runtime_env: device` removed (Thingz out of scope)
- Skill revocation events emitted to Cortex (Cortex pushes to product DO, product handles)
- Cognium relationship clarified: Cognium is a Runics-only dependency, called at ingestion time, never at runtime

**Skill ownership:** user owns skills. Enterprise tenants add org-level governance on top. Skill modification events flow: Runics → Cortex → Product (product handles per their own logic).

**Skill binding in workflows:**
- Default: static binding (pin skill ID + version at save time)
- Optional: `dynamic: true` per step for late binding (Cortex searches Runics with step description at execution time)

### 4.5 Cognium — Trust Engine

**What it is:** Verification engine for AI agent tools. Scans skill bundles, returns trust attestations.

**What changed:** Scope clarified. Cognium is called by Runics at skill ingestion/publish time. Trust scores are cached in Runics skill metadata. Cortex reads cached scores — never calls Cognium directly. Zero HTTP calls to Cognium during workflow execution.

**Relationship:** Cognium is exclusively a Runics dependency.

### 4.6 @runics/dag — DAG Schema Library

**What it is:** New shared package. Portable DAG format for workflow definitions.

**Contains:**
- Zod schema for `WorkflowStep` and `WorkflowDAG`
- Topological sort algorithm
- DAG interpreter (maps DAG steps to CF Workflow `step.do()` calls)
- Validation (cycle detection, dependency resolution, input mapping validation)

**Key design:** DAG is data, not code. Stored in Runics as a composition skill. Any executor can read it — Cortex is the first executor, not the only one. User-authored through conversation, not hand-written.

```typescript
const WorkflowStep = z.object({
  id: z.string(),
  skillRef: z.string(),
  binding: z.enum(['static', 'dynamic']).default('static'),
  dependsOn: z.array(z.string()).default([]),
  inputMap: z.record(z.string()).default({}),
  condition: z.string().optional(),
  onError: z.enum(['fail', 'skip', 'retry']).default('fail'),
  retry: z.object({
    count: z.number(),
    backoff: z.enum(['fixed', 'exponential'])
  }).optional(),
  requiresApproval: z.boolean().default(false),
});

const WorkflowDAG = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  steps: z.array(WorkflowStep),
});
```

### 4.7 API Key Middleware

**What it is:** Shared auth layer across Cognium, Runics, and Cortex API surfaces. Blocking requirement for partner launch.

**Provides:**
- API key creation, rotation, revocation (stored in KV: hash → metadata)
- Tenant resolution from API key
- Scope checking (which surfaces this key can access)
- Rate limiting per key (KV counter, per minute)
- Partner onboarding (even if manual CLI/script initially)

```typescript
interface APIKeyMetadata {
  tenantId: string;
  partnerName: string;
  scopes: ('cognium' | 'runics' | 'cortex')[];
  rateLimit: { rpm: number };
  createdAt: string;
  expiresAt?: string;
}
```

### 4.8 @specifica/store + format

**What it is:** Shared product state layer. Unchanged from current spec.

**Provides:** Item CRUD, content management (spec.md, design.md, tasks.md), user memory (product-scoped), chat history, settings, git sync.

**Memory ownership:** product-scoped memory stays in @specifica/store. Cross-product/org knowledge deferred to Gamayun (future).

---

## 5. Runtime Dispatch

When a workflow step executes a skill, Cortex routes to the appropriate executor based on `runtime_env`:

| `runtime_env` | Executor | CF Product | Session State |
|---|---|---|---|
| `llm` | Inject `skill_md` into LLM context | Workers AI | Context window |
| `api` | HTTP call to `mcp_url` or MCP server | Workers (native fetch) | Stateless |
| `browser` | Interactive web session | Browser Rendering | DO-managed browser session |
| `vm` (light) | Code snippet execution | Dynamic Workers | Ephemeral |
| `vm` (heavy) | Full environment with deps | CF Sandbox SDK | Container filesystem |
| `local` | Forward to user's machine | CF Tunnel | User-controlled |

### CF Sandbox SDK replaces Daytona

Previous spec used Daytona for sandboxed code execution. CF Sandbox SDK provides the same capabilities natively: full Linux environment, shell, file system, Git, Python/Node.js, background processes — all from Workers. No external infrastructure.

### Dynamic Workers (evaluate)

For lightweight skill execution (code snippets, data transforms, API call wrappers), Dynamic Workers provide V8 isolate-based sandboxing with millisecond startup — 100x faster and more memory-efficient than containers. Evaluate for `runtime_env: vm` skills that don't need a full Linux environment.

---

## 6. Cloudflare Stack

| CF Product | Our use | Status |
|---|---|---|
| Workers | All service code | Active |
| Durable Objects | Product DOs (@specifica/store) | Active |
| Workflows | Cortex DAG executor | **New — core** |
| Sandbox SDK | `runtime_env: vm` heavy execution | **New — replaces Daytona** |
| Dynamic Workers | `runtime_env: vm` light execution | **Evaluate** |
| Browser Rendering | `runtime_env: browser` | Committed |
| Workers AI | Embeddings (bge-small-en-v1.5), deep search (Llama 3.3 70B), content safety (Llama Guard) | Active |
| KV | Cache (60s TTL), session tokens, API key storage, credential vault | Active |
| R2 | Skill bundles, large artifacts | Active |
| Queues | Cognium scan pipeline, analytics ingestion (future ClickHouse feed) | Active |
| Hyperdrive | Postgres connection pooling | Active |
| Neon Postgres | Skills DB, search index (pgvector), tenant records | Active |

---

## 7. External Services

| Service | Our use | Status |
|---|---|---|
| LLM Proxy (own) | All LLM calls from Mastra wrapper | Active |
| ClickHouse Cloud | All analytics: search, execution, billing, security reports | **Todo — fed from CF Queues** |

---

## 8. Data Flows

### 8.1 User types a message (real-time)

```
User → Product DO → POST /v1/chat → Cortex (conversational mode)
  → Mastra wrapper → LLM reasons
  → Response streams back to user
  → If decomposition detected → promote to durable workflow (8.2)
```

### 8.2 Durable workflow execution

```
Cortex creates CF Workflow instance with DAG payload
  → For each layer (topological sort):
    → Parallel: Promise.all(steps in layer)
      → Per step:
        1. Resolve skill (static: from DAG, dynamic: search Runics)
        2. Read trust score from skill metadata (cached)
        3. Check trust against product appetite
        4. If requiresApproval → step.waitForEvent() → push to product DO
        5. Execute via runtime dispatch (api/browser/vm/llm)
        6. Return result (persisted by CF Workflows)
    → Forge captures trace (internal queue)
  → Final step: notify product DO (completion or error)
```

### 8.3 Save as skill

```
User taps "save as skill" in product
  → Product DO → Cortex serializes DAG in @runics/dag format
  → POST to Runics publish API
  → Runics stores as composition skill (status: draft → published)
  → Cognium scans async (via queue)
  → Skill discoverable by other users
```

### 8.4 Skill revocation

```
Cognium scan finds CRITICAL issue → Runics marks skill as revoked
  → Runics emits revocation event
  → Cortex receives → finds affected workflow instances
  → Cortex pushes to product DOs
  → Each product handles per its own logic:
    - Clove: notification on board
    - CoStaff: escalate to admin
    - ControlDeck: auto-substitute with best version
    - Akrobatos: pause incident workflow
```

### 8.5 Partner API call

```
Partner → API key middleware (shared)
  → Validate key (KV lookup)
  → Resolve tenant
  → Check scope (cognium? runics? cortex?)
  → Rate limit check
  → Route to service
  → Response
```

---

## 9. Key Architectural Decisions

| # | Decision | Resolution |
|---|---|---|
| 1 | Cortex identity | Evolve from LLM proxy to workflow engine. Mastra → internal library/wrapper. |
| 2 | Workflow engine | Cloudflare Workflows (GA). No custom DO-based engine. |
| 3 | DAG format | Own library (@runics/dag). Portable JSON, stored in Runics. No ecosystem standard exists. |
| 4 | DAG authoring | LLM generates sequence, Cortex infers parallelization. User refines via chat. |
| 5 | Forge position | Cortex-internal async subsystem. Skills-only output. |
| 6 | Activepieces role | Code dependency (connector library). Build critical connectors natively for MVP. |
| 7 | Cognium at runtime | Never. Scan-time only. Trust scores cached in Runics skill metadata. |
| 8 | Skill binding | Static default (pin at save time). Optional `dynamic: true` per step. |
| 9 | Approval routing | Products own RBAC and escalation. Cortex emits events, products route. Batch approvals future. |
| 10 | Tenant isolation | Application-level enforcement in executor. Both Cortex and products validate. |
| 11 | Hot/cold tiering | Automatic via CF Workflows. Sleeping instances hibernate, cost nothing. |
| 12 | Bidirectional sync | Product → Cortex: HTTP. Cortex → Product: WebSocket push. |
| 13 | Workflow templates in Runics | Expanded composition schema (DAG), not third entity type. |
| 14 | Memory ownership | Product-scoped in @specifica/store. Cross-product deferred to Gamayun (future). |
| 15 | Customer support product | Configuration of CoStaff, not a dedicated surface. |
| 16 | VM execution | CF Sandbox SDK replaces Daytona. Dynamic Workers for lightweight execution. |
| 17 | Analytics | ClickHouse Cloud via CF Queues (todo). Workers AE considered, rejected for billing precision. |
| 18 | Org policy filters | Gamayun (future) → Cortex → enriched SearchFilters → Runics. Runics stays a pure discovery service. |

---

## 10. CF Workflows Constraints

| Constraint | Value | Mitigation |
|---|---|---|
| Concurrent running instances | 10,000/account | Sleeping/waiting don't count. Request increase at scale. |
| Instance creation rate | 100/second | Queue buffer (1M capacity). Request increase at scale. |
| Steps per workflow | 10,000 (configurable to 25,000) | Sufficient for any DAG. |
| State per step | 1 MiB | Large results → R2, return reference. |
| State per instance | 1 GB | Generous. |
| State retention | 30 days (paid) | Archive completed workflows externally. |
| Step names | Must be deterministic | Step IDs from DAG definition — deterministic by design. |
| In-memory state | Lost on hibernation | All state persisted via step return values. Executor handles replay. |

---

## 11. Known Gaps

All gaps identified during architecture review have been resolved in their respective specs.

| # | Gap | Severity | Resolution | Status |
|---|---|---|---|---|
| 1 | `emit_decomposition` → DAG output | Medium | Expanded tool schema with dependencies + input mapping. Cross-referenced between Cortex v2.0 §11.2 and DAG spec §5.1. | **Resolved** |
| 2 | DAG built at decomposition time | Medium | Cortex builds DAG from LLM decomposition. Forge receives DAG in trace, does not reconstruct. | **Resolved** |
| 3 | Dynamic skill binding resolution | Medium | Cortex searches Runics with step description. Documented in Cortex v2.0 §6.2. | **Resolved** |
| 4 | Skill discovery is chat-first | Low | No browse UI in products. Documented in Bombastic v2.3 §8 (Chat-First Skill Discovery). | **Resolved** |
| 5 | Webhook routing to workflow DOs | Medium | `POST /v1/webhooks/:tenantId/:workflowId` with HMAC-SHA256 auth. Documented in Cortex v2.0 §4.5. | **Resolved** |
| 6 | Runbook/doc import as DAG | Low | Upload → LLM converts → publish. Documented as Akrobatos-specific authoring path. | **Deferred** (Akrobatos parked) |
| 7 | Activepieces Workers compatibility | High | 15 MVP native connectors defined in Cortex v2.0 §15. Full Activepieces catalog deferred. | **Resolved** |
| 8 | Executor replay semantics | Medium | 4-point implementation guidance added to Cortex v2.0 §5 (per-step `step.do()` in `Promise.all`, deterministic names, R2 for large outputs). | **Resolved** |
| 9 | Workflow completion notification | Medium | Executor's final step notifies product DO via HTTP callback. Error handler does same. Documented in Cortex v2.0 §5. | **Resolved** |
| 10 | Skill metadata caching at scale | Low | Cache by skill ID after resolution, not by search query. Optimization for later. | **Deferred** (optimization) |
| 11 | Save-as-skill pinning responsibility | Low | Cortex pins dynamic bindings to static when returning DAG for save. Documented in Bombastic v2.3 §8 and DAG spec §5.3. | **Resolved** |
| 12 | Bombastic MVP scope table | Low | Added workflow tracking, save-as-skill, chat-first discovery rows to §18. | **Resolved** |

---

## 12. Parked Items

| Item | When | Evaluation criteria |
|---|---|---|
| Identity provider (Clerk/Logto/Kinde) | Before CoStaff | Org/team/RBAC, M2M tokens, enterprise SSO, agent-aware |
| ClickHouse Cloud | After first product, before billing | Precision metering, complex analytics, security reports |
| Workers for Platforms | Enterprise tenant isolation hardening | CF Workflows WfP support status |
| Cloudflare for SaaS | Enterprise custom domains | When enterprise customers need `ops.acme.com` |
| Gamayun (knowledge layer) | When per-product memory is limiting | Cross-product context, org knowledge, RAG via CF AI Search |
| CF Vectorize | Evaluate vs pgvector | If Neon becomes bottleneck |
| CF AI Search | Gamayun's RAG foundation | When Gamayun materializes |
| Activepieces full catalog | When 200+ connectors needed | Workers compatibility audit |
| Workers Analytics Engine | If ClickHouse is overkill for ops metrics | Operational dashboards only (sampling OK) |

---

## 13. Spec Generation Queue

| Order | Artifact | Type | Priority | Status |
|---|---|---|---|---|
| 1 | Architecture overview (this document) | New | **P0** | ✅ Done |
| 2 | @runics/dag specification | New | **P0** | ✅ Done |
| 3 | API key middleware specification | New | **P0 — partner blocking** | ✅ Done (spec) |
| 4 | Cortex v2.0 specification | Rewrite | **P0** | Pending |
| 5 | Runics v5.4 patch | Update | P1 | ✅ Done + deployed |
| 6 | Forge v1.3 patch | Update | P1 | Pending |
| 7 | Bombastic v2.3 patch | Update | P1 | Pending |
| 8 | Cognium specs (server v3.0 + client v4.1) | Minor updates | P2 | ✅ Done |

---

## 14. Brand Registry

| Name | Type | Meaning |
|---|---|---|
| Cognium Labs | Company | From cognition |
| Clove | Agent | Sharp, careful |
| Bombastic | Product brand | Bold, attention-grabbing |
| CoStaff | Product | Co + staff |
| ControlDeck | Product | Command center |
| Akrobatos | Product | Greek: acrobat — balance under pressure |
| Gamayun | Future knowledge layer | Slavic mythological bird — knows everything |
| Runics | Infrastructure | From runes — discovery |
| Cognium | Infrastructure | Trust verification — SSL for agents |
| Cortex | Infrastructure | The core — workflow engine |
| Forge | Infrastructure (Cortex internal) | To create, to shape |
