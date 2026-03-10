// ══════════════════════════════════════════════════════════════════════════════
// Cognium Client — Finding Mapper
// ══════════════════════════════════════════════════════════════════════════════
//
// Maps Circle-IR findings → Runics ScanFinding format.
// Handles 3 analysis phases: SAST, instruction_safety, capability_mismatch.
// Filters SAFE verdicts, normalizes severity casing, preserves LLM verification.
//
// ══════════════════════════════════════════════════════════════════════════════

import type { CircleIRFinding, ScanFinding } from './types';

export function normalizeFindings(raw: CircleIRFinding[]): ScanFinding[] {
  return raw
    .filter(f => f.verdict !== 'SAFE')
    .map(f => ({
      severity: f.severity.toUpperCase() as ScanFinding['severity'],
      cweId: f.cwe_id,
      tool: 'circle-ir',
      phase: f.phase,
      title: f.description.slice(0, 80),
      description: f.description,
      confidence: f.confidence,
      verdict: f.verdict,
      llmVerified: f.verification_status === 'verified' && f.llm_result?.verdict === 'TRUE_POSITIVE',
      remediationHint: buildRemediationHint(f),
      remediationUrl: f.cwe_id
        ? `https://cwe.mitre.org/data/definitions/${f.cwe_id.replace('CWE-', '')}.html`
        : undefined,
      capabilityMismatch: f.phase === 'capability_mismatch',
    }));
}

function buildRemediationHint(f: CircleIRFinding): string | undefined {
  if (f.phase === 'capability_mismatch') {
    return `Capability mismatch: ${f.sink?.type ?? 'undeclared behavior'}`;
  }
  if (f.sink?.method && f.line_end != null) {
    return `${f.sink.type} via ${f.sink.method} at line ${f.line_end}`;
  }
  return undefined;
}

export function deriveWorstSeverity(findings: ScanFinding[]): ScanFinding['severity'] | null {
  const order: ScanFinding['severity'][] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  for (const sev of order) {
    if (findings.some(f => f.severity === sev)) return sev;
  }
  return null;
}

export function isContentUnsafe(findings: ScanFinding[]): boolean {
  const injectionCwes = ['CWE-77', 'CWE-78', 'CWE-79', 'CWE-89', 'CWE-94'];

  return findings.some(
    f => f.severity === 'CRITICAL'
      && f.llmVerified
      && (
        // SAST injection findings
        injectionCwes.includes(f.cweId ?? '')
        // Instruction safety: prompt injection / hijacking
        || f.phase === 'instruction_safety'
        // Capability mismatch: CRITICAL + verified = unsafe
        || f.capabilityMismatch
      )
  );
}
