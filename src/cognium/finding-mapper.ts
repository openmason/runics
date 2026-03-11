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

/**
 * Validates and normalizes raw Circle-IR findings into Runics ScanFinding format.
 * Malformed findings (missing severity, description, etc.) are silently dropped
 * rather than crashing the pipeline.
 */
export function normalizeFindings(raw: unknown): ScanFinding[] {
  if (!Array.isArray(raw)) return [];

  const results: ScanFinding[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;

    const finding = f as Record<string, unknown>;
    // Required fields — skip finding if missing
    if (typeof finding.severity !== 'string' || !finding.severity) continue;
    if (typeof finding.description !== 'string') continue;

    // Skip SAFE verdicts
    if (finding.verdict === 'SAFE') continue;

    const severity = (finding.severity as string).toUpperCase();
    if (!['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(severity)) continue;

    const cweId = typeof finding.cwe_id === 'string' ? finding.cwe_id : undefined;
    const phase = typeof finding.phase === 'string' ? finding.phase as CircleIRFinding['phase'] : undefined;
    const confidence = typeof finding.confidence === 'number' ? finding.confidence : 0;
    const verdict = typeof finding.verdict === 'string' ? finding.verdict as ScanFinding['verdict'] : 'VULNERABLE';
    const verificationStatus = typeof finding.verification_status === 'string' ? finding.verification_status : undefined;
    const llmResult = finding.llm_result as CircleIRFinding['llm_result'] | undefined;
    const sink = finding.sink as CircleIRFinding['sink'] | undefined;
    const lineEnd = typeof finding.line_end === 'number' ? finding.line_end : null;

    const typedFinding: CircleIRFinding = {
      ...(f as CircleIRFinding),
      severity: finding.severity as CircleIRFinding['severity'],
      description: finding.description as string,
    };

    results.push({
      severity: severity as ScanFinding['severity'],
      cweId,
      tool: 'circle-ir',
      phase,
      title: (finding.description as string).slice(0, 80),
      description: finding.description as string,
      confidence,
      verdict,
      llmVerified: verificationStatus === 'verified' && llmResult?.verdict === 'TRUE_POSITIVE',
      remediationHint: buildRemediationHint(typedFinding),
      remediationUrl: cweId
        ? `https://cwe.mitre.org/data/definitions/${cweId.replace('CWE-', '')}.html`
        : undefined,
      capabilityMismatch: phase === 'capability_mismatch',
    });
  }
  return results;
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
