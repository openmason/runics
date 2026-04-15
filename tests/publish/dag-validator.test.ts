import { describe, it, expect } from 'vitest';
import { validateWorkflowDefinition } from '../../src/publish/dag-validator';

// ── Helpers ──────────────────────────────────────────────────────────────────

function validDAG(overrides?: Record<string, unknown>) {
  return {
    id: 'test-dag',
    name: 'Test Workflow',
    version: '1.0.0',
    steps: [
      { id: 'step-a', skillRef: 'skill-a@1.0.0', dependsOn: [], inputMap: {} },
    ],
    ...overrides,
  };
}

function twoStepDAG() {
  return {
    id: 'two-step',
    name: 'Two-step Workflow',
    version: '1.0.0',
    steps: [
      { id: 'step-a', skillRef: 'skill-a@1.0.0', dependsOn: [], inputMap: {} },
      { id: 'step-b', skillRef: 'skill-b@2.0.0', dependsOn: ['step-a'], inputMap: { data: '{{step-a.output.result}}' } },
    ],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('validateWorkflowDefinition', () => {
  // ── Composite + valid DAG ─────────────────────────────────────────────────

  it('should accept valid composite with single-step DAG', () => {
    const result = validateWorkflowDefinition('composite', validDAG());
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should accept valid composite with multi-step DAG', () => {
    const result = validateWorkflowDefinition('composite', twoStepDAG());
    expect(result.valid).toBe(true);
  });

  // ── Composite + missing DAG ───────────────────────────────────────────────

  it('should reject composite without workflowDefinition', () => {
    const result = validateWorkflowDefinition('composite', undefined);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('required');
  });

  it('should reject composite with null workflowDefinition', () => {
    const result = validateWorkflowDefinition('composite', null);
    expect(result.valid).toBe(false);
  });

  // ── Non-composite + present DAG ───────────────────────────────────────────

  it('should reject non-composite with workflowDefinition', () => {
    const result = validateWorkflowDefinition('mcp-remote', validDAG());
    expect(result.valid).toBe(false);
    expect(result.error).toContain('only allowed');
  });

  it('should reject worker with workflowDefinition', () => {
    const result = validateWorkflowDefinition('worker', validDAG());
    expect(result.valid).toBe(false);
  });

  // ── Non-composite + no DAG (normal case) ──────────────────────────────────

  it('should accept mcp-remote without workflowDefinition', () => {
    const result = validateWorkflowDefinition('mcp-remote', undefined);
    expect(result.valid).toBe(true);
  });

  it('should accept instructions without workflowDefinition', () => {
    const result = validateWorkflowDefinition('instructions', undefined);
    expect(result.valid).toBe(true);
  });

  // ── Schema validation failures ────────────────────────────────────────────

  it('should reject DAG missing required id field', () => {
    const result = validateWorkflowDefinition('composite', {
      name: 'Test',
      version: '1.0.0',
      steps: [{ id: 'a', skillRef: 'x@1.0.0' }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid workflow definition');
    expect(result.details).toBeDefined();
  });

  it('should reject DAG missing required name field', () => {
    const result = validateWorkflowDefinition('composite', {
      id: 'test',
      version: '1.0.0',
      steps: [{ id: 'a', skillRef: 'x@1.0.0' }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid workflow definition');
  });

  it('should reject DAG with invalid version format', () => {
    const result = validateWorkflowDefinition('composite', validDAG({ version: 'bad' }));
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid workflow definition');
  });

  it('should reject DAG with empty steps array', () => {
    const result = validateWorkflowDefinition('composite', validDAG({ steps: [] }));
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid workflow definition');
  });

  it('should reject DAG with non-object input', () => {
    const result = validateWorkflowDefinition('composite', 'not a dag');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid workflow definition');
  });

  // ── Structural validation failures ────────────────────────────────────────

  it('should reject DAG with cycle', () => {
    const result = validateWorkflowDefinition('composite', {
      id: 'cyclic',
      name: 'Cyclic DAG',
      version: '1.0.0',
      steps: [
        { id: 'a', skillRef: 'x@1.0.0', dependsOn: ['b'], inputMap: {} },
        { id: 'b', skillRef: 'y@1.0.0', dependsOn: ['a'], inputMap: {} },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Workflow DAG validation failed');
    expect(result.details).toContain('DAG contains a cycle');
  });

  it('should reject DAG with unknown dependency reference', () => {
    const result = validateWorkflowDefinition('composite', {
      id: 'bad-dep',
      name: 'Bad Dep DAG',
      version: '1.0.0',
      steps: [
        { id: 'a', skillRef: 'x@1.0.0', dependsOn: ['nonexistent'], inputMap: {} },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Workflow DAG validation failed');
    expect(result.details!.some(e => e.includes('unknown step'))).toBe(true);
  });

  it('should reject DAG with input mapping to undeclared dependency', () => {
    const result = validateWorkflowDefinition('composite', {
      id: 'bad-map',
      name: 'Bad Map DAG',
      version: '1.0.0',
      steps: [
        { id: 'a', skillRef: 'x@1.0.0', dependsOn: [], inputMap: {} },
        { id: 'b', skillRef: 'y@1.0.0', dependsOn: [], inputMap: { data: '{{a.output.result}}' } },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Workflow DAG validation failed');
    expect(result.details!.some(e => e.includes('dependsOn'))).toBe(true);
  });

  it('should reject DAG with duplicate step IDs', () => {
    const result = validateWorkflowDefinition('composite', {
      id: 'dup-ids',
      name: 'Duplicate IDs',
      version: '1.0.0',
      steps: [
        { id: 'a', skillRef: 'x@1.0.0', dependsOn: [], inputMap: {} },
        { id: 'a', skillRef: 'y@1.0.0', dependsOn: [], inputMap: {} },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Workflow DAG validation failed');
    expect(result.details!.some(e => e.includes('Duplicate'))).toBe(true);
  });

  it('should reject DAG with self-dependency', () => {
    const result = validateWorkflowDefinition('composite', {
      id: 'self-dep',
      name: 'Self Dep',
      version: '1.0.0',
      steps: [
        { id: 'a', skillRef: 'x@1.0.0', dependsOn: ['a'], inputMap: {} },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Workflow DAG validation failed');
  });
});
