// ══════════════════════════════════════════════════════════════════════════════
// Publish API — DAG Validation Helper (v5.4)
// ══════════════════════════════════════════════════════════════════════════════
//
// Validates workflow_definition payloads against the @runics/dag schema and
// structural rules (cycles, dependency refs, input mapping). Extracted from
// the handler for testability.
//
// ══════════════════════════════════════════════════════════════════════════════

import { WorkflowDAG, validateDAG } from '@runics/dag';

export interface DagValidationResult {
  valid: boolean;
  error?: string;
  details?: string[];
}

export function validateWorkflowDefinition(
  executionLayer: string,
  workflowDefinition: unknown | undefined,
): DagValidationResult {
  if (executionLayer === 'composite') {
    if (!workflowDefinition) {
      return { valid: false, error: 'workflowDefinition is required when executionLayer is composite' };
    }

    const dagParse = WorkflowDAG.safeParse(workflowDefinition);
    if (!dagParse.success) {
      return {
        valid: false,
        error: 'Invalid workflow definition',
        details: dagParse.error.issues.map(i => i.message),
      };
    }

    const dagValidation = validateDAG(dagParse.data);
    if (!dagValidation.valid) {
      return {
        valid: false,
        error: 'Workflow DAG validation failed',
        details: dagValidation.errors,
      };
    }

    return { valid: true };
  }

  if (workflowDefinition) {
    return { valid: false, error: 'workflowDefinition is only allowed when executionLayer is composite' };
  }

  return { valid: true };
}
