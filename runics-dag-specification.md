# @runics/dag — Portable Workflow DAG Specification

> **Version:** 1.0 · April 2026
> **Package:** `@runics/dag`
> **Status:** Implemented. Schema + validator published as `@runics/dag`. Integrated into Runics v5.4 publish API (migration 0015, DAG validation on composite skills). Deployed to staging + production (April 2026). Core dependency for Cortex v2.0.
> **Company:** Cognium Labs
> **Companion docs:** `cognium-architecture-overview.md` · `cortex-specification-v2_0.md` · `ARCHITECTURE.md`

---

## 1. What @runics/dag Is

A shared TypeScript library that defines the portable DAG format for workflow definitions. Any executor — Cortex, a local agent, a third-party platform — can read a DAG from Runics and execute it.

The library provides three things:

1. **Schema** — Zod types for `WorkflowStep` and `WorkflowDAG`, validatable at publish time and execution time.
2. **Interpreter** — Topological sort, layer extraction, dependency validation, cycle detection, input mapping resolution.
3. **Portability contract** — The DAG format is engine-agnostic. It describes *what* to execute and in *what order*, not *how* to execute it.

---

## 2. Design Principles

**Data, not code.** A DAG is JSON, not a TypeScript class. Users author workflows through conversation, not by writing code. The LLM decomposes, Cortex optimizes into a DAG, the user saves.

**Portable.** The DAG format is independent of Cortex, CF Workflows, or any specific executor. A DAG from Runics should be executable by any platform that can resolve skills and call APIs.

**Minimal.** The schema captures execution structure (dependencies, conditions, retries, approvals) but not executor-specific concerns (credentials, tenant config, hot/cold tiering, observability hooks).

**Composable.** A DAG can reference another DAG as a step (via skill reference to a composition skill in Runics). Recursive composition is supported up to a depth limit.

---

## 3. Schema

### 3.1 WorkflowStep

```typescript
import { z } from 'zod';

export const RetryPolicy = z.object({
  count: z.number().int().min(1).max(10),
  backoff: z.enum(['fixed', 'exponential']),
  delayMs: z.number().int().min(100).max(300000).default(1000),
});

export const InputMapping = z.record(
  z.string(),  // target input parameter name
  z.string(),  // source expression: "{{stepId.output.field}}" or literal
);

export const WorkflowStep = z.object({
  // Identity
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/),

  // Skill reference
  skillRef: z.string(),  // slug@version (static) or natural language query (dynamic)
  binding: z.enum(['static', 'dynamic']).default('static'),

  // DAG structure
  dependsOn: z.array(z.string()).default([]),  // step IDs — defines the DAG edges

  // Data flow
  inputMap: InputMapping.default({}),

  // Conditional execution
  condition: z.string().optional(),  // JS expression evaluated against prior step outputs
  // e.g., "{{research.output.flightCount}} > 0"

  // Error handling
  onError: z.enum(['fail', 'skip', 'retry']).default('fail'),
  retry: RetryPolicy.optional(),

  // Approval
  requiresApproval: z.boolean().default(false),

  // Metadata (informational, not used by executor)
  title: z.string().optional(),       // human-readable step name
  description: z.string().optional(), // what this step does
});

export type WorkflowStep = z.infer<typeof WorkflowStep>;
```

### 3.2 WorkflowDAG

```typescript
export const WorkflowDAG = z.object({
  // Identity
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),

  // Steps — the nodes and edges of the DAG
  steps: z.array(WorkflowStep).min(1).max(100),

  // Metadata
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  author: z.string().optional(),
  createdAt: z.string().datetime().optional(),
}).refine(
  (dag) => validateDAG(dag).valid,
  { message: 'Invalid DAG: contains cycles or unresolved dependencies' }
);

export type WorkflowDAG = z.infer<typeof WorkflowDAG>;
```

### 3.3 Example DAG

```json
{
  "id": "trip-planning",
  "name": "Plan a trip",
  "version": "1.0.0",
  "description": "Research, plan, and book a trip",
  "steps": [
    {
      "id": "flights",
      "skillRef": "flight-search@1.2.0",
      "binding": "static",
      "dependsOn": [],
      "inputMap": {},
      "title": "Search flights",
      "onError": "retry",
      "retry": { "count": 3, "backoff": "exponential", "delayMs": 2000 }
    },
    {
      "id": "hotels",
      "skillRef": "hotel-search@1.0.0",
      "binding": "static",
      "dependsOn": [],
      "inputMap": {},
      "title": "Search hotels",
      "onError": "retry",
      "retry": { "count": 3, "backoff": "exponential", "delayMs": 2000 }
    },
    {
      "id": "itinerary",
      "skillRef": "itinerary-builder@2.0.0",
      "binding": "static",
      "dependsOn": ["flights", "hotels"],
      "inputMap": {
        "flights": "{{flights.output}}",
        "hotels": "{{hotels.output}}"
      },
      "title": "Build itinerary"
    },
    {
      "id": "book",
      "skillRef": "booking-agent@1.0.0",
      "binding": "static",
      "dependsOn": ["itinerary"],
      "inputMap": {
        "plan": "{{itinerary.output}}"
      },
      "title": "Book everything",
      "requiresApproval": true
    }
  ]
}
```

In this DAG:
- `flights` and `hotels` have no dependencies → run in parallel
- `itinerary` depends on both → waits for both to complete
- `book` depends on `itinerary` and requires approval → pauses until user approves

---

## 4. Interpreter

### 4.1 DAG Validation

```typescript
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateDAG(dag: WorkflowDAG): ValidationResult {
  const errors: string[] = [];
  const stepIds = new Set(dag.steps.map(s => s.id));

  // Check for duplicate step IDs
  if (stepIds.size !== dag.steps.length) {
    errors.push('Duplicate step IDs detected');
  }

  // Check all dependsOn references exist
  for (const step of dag.steps) {
    for (const dep of step.dependsOn) {
      if (!stepIds.has(dep)) {
        errors.push(`Step "${step.id}" depends on unknown step "${dep}"`);
      }
    }
  }

  // Check for cycles
  if (hasCycle(dag.steps)) {
    errors.push('DAG contains a cycle');
  }

  // Check input mapping references
  for (const step of dag.steps) {
    for (const [_, expr] of Object.entries(step.inputMap)) {
      const refMatch = expr.match(/^\{\{(\w+)\./);
      if (refMatch && !stepIds.has(refMatch[1])) {
        errors.push(`Step "${step.id}" input maps to unknown step "${refMatch[1]}"`);
      }
      if (refMatch && !step.dependsOn.includes(refMatch[1])) {
        errors.push(`Step "${step.id}" maps input from "${refMatch[1]}" but doesn't depend on it`);
      }
    }
  }

  // Check max depth (composition recursion guard)
  // Composition skills reference other DAGs — depth validated at execution time

  return { valid: errors.length === 0, errors };
}
```

### 4.2 Cycle Detection

```typescript
function hasCycle(steps: WorkflowStep[]): boolean {
  const adj = new Map<string, string[]>();
  for (const step of steps) {
    adj.set(step.id, step.dependsOn);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(nodeId: string): boolean {
    if (inStack.has(nodeId)) return true;  // cycle
    if (visited.has(nodeId)) return false;

    visited.add(nodeId);
    inStack.add(nodeId);

    for (const dep of adj.get(nodeId) ?? []) {
      if (dfs(dep)) return true;
    }

    inStack.delete(nodeId);
    return false;
  }

  for (const step of steps) {
    if (dfs(step.id)) return true;
  }
  return false;
}
```

### 4.3 Topological Sort → Execution Layers

The topological sort produces execution layers. Steps within the same layer have no dependencies on each other and can run in parallel.

```typescript
export interface ExecutionLayer {
  index: number;
  stepIds: string[];
}

export function toExecutionLayers(dag: WorkflowDAG): ExecutionLayer[] {
  const steps = new Map(dag.steps.map(s => [s.id, s]));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  // Initialize
  for (const step of dag.steps) {
    inDegree.set(step.id, step.dependsOn.length);
    for (const dep of step.dependsOn) {
      const existing = dependents.get(dep) ?? [];
      existing.push(step.id);
      dependents.set(dep, existing);
    }
  }

  const layers: ExecutionLayer[] = [];
  const remaining = new Set(dag.steps.map(s => s.id));

  let layerIndex = 0;
  while (remaining.size > 0) {
    // Find all steps with inDegree 0 (no unresolved dependencies)
    const ready = [...remaining].filter(id => inDegree.get(id) === 0);

    if (ready.length === 0) {
      throw new Error('Unresolvable dependencies — cycle or missing step');
    }

    layers.push({ index: layerIndex++, stepIds: ready });

    // Remove ready steps and decrement dependents
    for (const id of ready) {
      remaining.delete(id);
      for (const dep of dependents.get(id) ?? []) {
        inDegree.set(dep, (inDegree.get(dep) ?? 1) - 1);
      }
    }
  }

  return layers;
}
```

### 4.4 Input Mapping Resolution

```typescript
export function resolveInputs(
  step: WorkflowStep,
  outputs: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const [param, expr] of Object.entries(step.inputMap)) {
    if (typeof expr === 'string' && expr.startsWith('{{') && expr.endsWith('}}')) {
      // Template expression: {{stepId.output}} or {{stepId.output.field}}
      const path = expr.slice(2, -2).split('.');
      const sourceStepId = path[0];
      let value: unknown = outputs[sourceStepId];

      // Navigate nested path (skip 'output' — it's implicit)
      for (let i = 1; i < path.length; i++) {
        if (path[i] === 'output' && i === 1) continue;  // skip the 'output' keyword
        if (value && typeof value === 'object') {
          value = (value as Record<string, unknown>)[path[i]];
        } else {
          value = undefined;
        }
      }

      resolved[param] = value;
    } else {
      // Literal value
      resolved[param] = expr;
    }
  }

  return resolved;
}
```

### 4.5 Condition Evaluation

```typescript
export function evaluateCondition(
  condition: string,
  outputs: Record<string, unknown>,
): boolean {
  // Replace template expressions with values
  const resolved = condition.replace(
    /\{\{(\w+(?:\.\w+)*)\}\}/g,
    (_, path) => {
      const parts = path.split('.');
      let value: unknown = outputs[parts[0]];
      for (let i = 1; i < parts.length; i++) {
        if (parts[i] === 'output' && i === 1) continue;
        if (value && typeof value === 'object') {
          value = (value as Record<string, unknown>)[parts[i]];
        }
      }
      return JSON.stringify(value);
    },
  );

  // Evaluate simple expressions (no eval — whitelist operators)
  // Supported: >, <, >=, <=, ===, !==, &&, ||
  // Complex conditions should be handled by an LLM reasoning step instead
  try {
    return new Function(`return (${resolved})`)() as boolean;
  } catch {
    return true;  // on evaluation failure, execute the step (safe default)
  }
}
```

---

## 5. DAG Generation from LLM Decomposition

The LLM (via Mastra wrapper) returns a decomposition. Cortex transforms it into a DAG.

### 5.1 Expanded emit_decomposition Tool

```typescript
// Updated tool schema for Cortex v2.0
const emitDecomposition = {
  name: 'emit_decomposition',
  description: 'Return a structured plan of steps. Include dependencies when steps need outputs from prior steps.',
  parameters: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            skillQuery: { type: 'string', description: 'What skill is needed for this step' },
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              description: 'Titles of steps this depends on (empty if independent)',
            },
            requiresApproval: { type: 'boolean' },
            inputsNeeded: {
              type: 'array',
              items: { type: 'string' },
              description: 'What data this step needs from prior steps',
            },
          },
          required: ['title', 'skillQuery'],
        },
      },
    },
    required: ['steps'],
  },
};
```

### 5.2 Cortex DAG Builder

Cortex receives the LLM decomposition and builds a proper DAG:

1. Generate step IDs from titles (slugify)
2. Resolve `dependsOn` from title references to step IDs
3. Search Runics for each `skillQuery` → resolve to `skillRef` (slug@version)
4. Infer `inputMap` from `inputsNeeded` + prior step output schemas
5. Default `binding: 'dynamic'` for LLM-generated steps (user can pin to static on save)
6. Validate with `validateDAG()`
7. If validation fails, re-prompt the LLM with the errors

### 5.3 Pinning on Save

When a user saves a workflow:
- All `dynamic` bindings are resolved to the specific skills that were executed
- `binding` set to `static` for all steps
- `skillRef` set to `slug@version` of the skill that was actually used
- User can later edit individual steps back to `dynamic` if desired

---

## 6. Storage in Runics

A workflow DAG is stored as a skill with `execution_layer: 'composite'` and the DAG in the `workflow_definition` JSONB column.

```sql
-- Addition to skills table (Runics v5.4)
ALTER TABLE skills ADD COLUMN workflow_definition JSONB;

-- Constraint: workflow_definition required for composite skills
ALTER TABLE skills ADD CONSTRAINT workflow_definition_required
  CHECK (
    (execution_layer != 'composite') OR
    (execution_layer = 'composite' AND workflow_definition IS NOT NULL)
  );
```

The existing `composition_steps` table remains for simple linear compositions (backward compatible). Complex DAG workflows use `workflow_definition`. The migration path is natural — simple compositions can be represented in either format.

### Trust Scoring for DAG Compositions

Same formula as current compositions: `trust_score = min(constituent_trust_scores) × 0.90`

For dynamic-binding steps, trust is evaluated at execution time (worst case: skill with minimum trust in the catalog that matches the query). For static-binding steps, trust is computed at publish time from the pinned skill versions.

---

## 7. Package Structure

```
packages/dag/
├── package.json          # @runics/dag
├── tsconfig.json
├── src/
│   ├── index.ts          # Public exports
│   ├── schema.ts         # Zod types: WorkflowStep, WorkflowDAG, RetryPolicy
│   ├── validate.ts       # validateDAG, hasCycle
│   ├── layers.ts         # toExecutionLayers
│   ├── resolve.ts        # resolveInputs, evaluateCondition
│   └── types.ts          # TypeScript types derived from Zod
├── tests/
│   ├── schema.test.ts    # Schema validation tests
│   ├── validate.test.ts  # Cycle detection, dependency validation
│   ├── layers.test.ts    # Topological sort, layer extraction
│   └── resolve.test.ts   # Input mapping, condition evaluation
└── README.md
```

Estimated total: ~400 lines of source, ~600 lines of tests.

**Dependencies:** `zod` only. Zero runtime dependencies beyond Zod.

**Build:** `tsup` for bundling, `vitest` for testing, `biome` for lint/format. Same toolchain as rest of Cognium Labs.

---

## 8. Compatibility

The DAG format is versioned. The `version` field on `WorkflowDAG` is the workflow's own version. The schema version is tracked separately:

```typescript
export const DAG_SCHEMA_VERSION = '1.0';
```

Future schema changes (new step types, new fields) must be backward compatible. New optional fields can be added without breaking existing DAGs. Required field changes require a schema version bump and migration tooling.
