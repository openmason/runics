// ══════════════════════════════════════════════════════════════════════════════
// Cognium Client — Finding Mapper
// ══════════════════════════════════════════════════════════════════════════════
//
// Maps Circle-IR findings → Runics ScanFinding format.
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
      title: f.description.slice(0, 80),
      description: f.description,
      confidence: f.confidence,
      verdict: f.verdict,
      llmVerified: f.verification_status === 'verified' && f.llm_result?.verdict === 'TRUE_POSITIVE',
      remediationHint: f.sink
        ? `${f.sink.type} via ${f.sink.method} at line ${f.line_end}`
        : undefined,
      remediationUrl: f.cwe_id
        ? `https://cwe.mitre.org/data/definitions/${f.cwe_id.replace('CWE-', '')}.html`
        : undefined,
    }));
}

export function deriveWorstSeverity(findings: ScanFinding[]): ScanFinding['severity'] | null {
  const order: ScanFinding['severity'][] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  for (const sev of order) {
    if (findings.some(f => f.severity === sev)) return sev;
  }
  return null;
}

export function isContentUnsafe(findings: ScanFinding[]): boolean {
  return findings.some(
    f => f.severity === 'CRITICAL'
      && f.llmVerified
      && ['CWE-77', 'CWE-78', 'CWE-79', 'CWE-89', 'CWE-94'].includes(f.cweId ?? '')
  );
}
