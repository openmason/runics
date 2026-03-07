// ══════════════════════════════════════════════════════════════════════════════
// Cognium Client — Scoring Policy
// ══════════════════════════════════════════════════════════════════════════════
//
// Runics business logic for trust scoring, status derivation, tier assignment,
// and remediation messaging. Circle-IR has no knowledge of any of this.
//
// ══════════════════════════════════════════════════════════════════════════════

import type { ScanFinding, SkillRow } from './types';
import type { SkillStatus, VerificationTier } from '../types';

// Base trust by source (registry provenance)
export const BASE_TRUST: Record<string, number> = {
  'mcp-registry':    0.80,
  'clawhub':         0.65,
  'github':          0.55,
  'manual':          0.60,
  'forge':           0.40,
  'human-distilled': 0.50,
};

// Trust impact per finding category
const TRUST_IMPACT: Record<string, number> = {
  CRITICAL_INJECTION: -0.25,
  CRITICAL_SAST:      -0.20,
  HIGH_INJECTION:     -0.20,
  HIGH_SAST:          -0.15,
  SECRET_EXPOSURE:    -0.30,
};

export function computeTrustScore(skill: SkillRow, findings: ScanFinding[]): number {
  const originSource = skill.rootSource ?? skill.source;
  const baseScore = BASE_TRUST[originSource] ?? 0.40;

  let adjustment = 0;
  for (const finding of findings) {
    const key = classifyFinding(finding);
    adjustment += TRUST_IMPACT[key] ?? (finding.severity === 'MEDIUM' ? -0.05 : 0);
  }

  return Math.max(0.0, Math.min(1.0, Math.round((baseScore + adjustment) * 100) / 100));
}

function classifyFinding(f: ScanFinding): string {
  const cwe = f.cweId ?? '';

  const isInjection = ['CWE-77', 'CWE-78', 'CWE-79', 'CWE-89', 'CWE-94'].some(c => cwe.startsWith(c));
  const isSecretExposure = ['CWE-312', 'CWE-321', 'CWE-522', 'CWE-798'].some(c => cwe.startsWith(c));

  if (isSecretExposure) return 'SECRET_EXPOSURE';
  if (f.severity === 'CRITICAL' && isInjection) return 'CRITICAL_INJECTION';
  if (f.severity === 'CRITICAL') return 'CRITICAL_SAST';
  if (f.severity === 'HIGH' && isInjection) return 'HIGH_INJECTION';
  if (f.severity === 'HIGH') return 'HIGH_SAST';
  return '';
}

export function deriveStatus(worstSeverity: ScanFinding['severity'] | null): SkillStatus {
  if (worstSeverity === 'CRITICAL') return 'revoked';
  if (worstSeverity === 'HIGH' || worstSeverity === 'MEDIUM') return 'vulnerable';
  return 'published';
}

export function deriveTier(
  worstSeverity: ScanFinding['severity'] | null,
  trustScore: number,
): VerificationTier {
  if (worstSeverity === 'CRITICAL') return 'scanned';
  if (trustScore >= 0.70 && worstSeverity !== 'HIGH') return 'verified';
  return 'scanned';
}

export function buildRemediationMessage(finding: ScanFinding, skill: SkillRow): string {
  return [
    `${finding.severity} finding: ${finding.cweId ?? finding.title}`,
    finding.remediationHint ? `Fix: ${finding.remediationHint}` : '',
  ].filter(Boolean).join('\n');
}
