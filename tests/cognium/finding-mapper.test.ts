import { describe, it, expect } from 'vitest';
import { normalizeFindings, deriveWorstSeverity, isContentUnsafe } from '../../src/cognium/finding-mapper';
import type { CircleIRFinding, ScanFinding } from '../../src/cognium/types';

function makeRawFinding(overrides?: Partial<CircleIRFinding>): CircleIRFinding {
  return {
    id: 'finding-1',
    cwe_id: 'CWE-89',
    severity: 'high',
    confidence: 0.85,
    verdict: 'VULNERABLE',
    verification_status: 'verified',
    file: 'src/index.ts',
    line_start: 10,
    line_end: 15,
    description: 'SQL injection vulnerability found in user input handler',
    ...overrides,
  };
}

describe('normalizeFindings', () => {
  it('should normalize severity to uppercase', () => {
    const raw = [makeRawFinding({ severity: 'high' })];
    const findings = normalizeFindings(raw);
    expect(findings[0].severity).toBe('HIGH');
  });

  it('should filter out SAFE verdicts', () => {
    const raw = [
      makeRawFinding({ verdict: 'VULNERABLE' }),
      makeRawFinding({ id: 'safe-one', verdict: 'SAFE' }),
    ];
    const findings = normalizeFindings(raw);
    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe('VULNERABLE');
  });

  it('should include NEEDS_REVIEW findings', () => {
    const raw = [makeRawFinding({ verdict: 'NEEDS_REVIEW' })];
    const findings = normalizeFindings(raw);
    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe('NEEDS_REVIEW');
  });

  it('should set tool to circle-ir', () => {
    const raw = [makeRawFinding()];
    const findings = normalizeFindings(raw);
    expect(findings[0].tool).toBe('circle-ir');
  });

  it('should set llmVerified correctly', () => {
    const raw = [makeRawFinding({
      verification_status: 'verified',
      llm_result: {
        verdict: 'TRUE_POSITIVE',
        confidence: 0.95,
        reasoning: 'Confirmed',
        exploitability: 'high',
      },
    })];
    const findings = normalizeFindings(raw);
    expect(findings[0].llmVerified).toBe(true);
  });

  it('should not set llmVerified for non-verified findings', () => {
    const raw = [makeRawFinding({ verification_status: 'pending' })];
    const findings = normalizeFindings(raw);
    expect(findings[0].llmVerified).toBe(false);
  });

  it('should truncate title to 80 chars', () => {
    const longDesc = 'A'.repeat(200);
    const raw = [makeRawFinding({ description: longDesc })];
    const findings = normalizeFindings(raw);
    expect(findings[0].title.length).toBe(80);
  });

  it('should generate remediation URL from CWE ID', () => {
    const raw = [makeRawFinding({ cwe_id: 'CWE-89' })];
    const findings = normalizeFindings(raw);
    expect(findings[0].remediationUrl).toBe('https://cwe.mitre.org/data/definitions/89.html');
  });

  it('should handle empty findings array', () => {
    expect(normalizeFindings([])).toEqual([]);
  });
});

describe('deriveWorstSeverity', () => {
  it('should return CRITICAL as worst', () => {
    const findings: ScanFinding[] = [
      { severity: 'MEDIUM', cweId: 'CWE-200', tool: 'test', title: 't', description: 'd', confidence: 0.8, verdict: 'VULNERABLE', llmVerified: false },
      { severity: 'CRITICAL', cweId: 'CWE-78', tool: 'test', title: 't', description: 'd', confidence: 0.9, verdict: 'VULNERABLE', llmVerified: true },
      { severity: 'HIGH', cweId: 'CWE-89', tool: 'test', title: 't', description: 'd', confidence: 0.7, verdict: 'VULNERABLE', llmVerified: false },
    ];
    expect(deriveWorstSeverity(findings)).toBe('CRITICAL');
  });

  it('should return HIGH when no CRITICAL', () => {
    const findings: ScanFinding[] = [
      { severity: 'MEDIUM', cweId: 'CWE-200', tool: 'test', title: 't', description: 'd', confidence: 0.8, verdict: 'VULNERABLE', llmVerified: false },
      { severity: 'HIGH', cweId: 'CWE-89', tool: 'test', title: 't', description: 'd', confidence: 0.7, verdict: 'VULNERABLE', llmVerified: false },
    ];
    expect(deriveWorstSeverity(findings)).toBe('HIGH');
  });

  it('should return null for empty findings', () => {
    expect(deriveWorstSeverity([])).toBeNull();
  });

  it('should return LOW for only LOW findings', () => {
    const findings: ScanFinding[] = [
      { severity: 'LOW', cweId: 'CWE-200', tool: 'test', title: 't', description: 'd', confidence: 0.5, verdict: 'VULNERABLE', llmVerified: false },
    ];
    expect(deriveWorstSeverity(findings)).toBe('LOW');
  });
});

describe('isContentUnsafe', () => {
  it('should return true for CRITICAL LLM-verified injection', () => {
    const findings: ScanFinding[] = [
      { severity: 'CRITICAL', cweId: 'CWE-78', tool: 'test', title: 't', description: 'd', confidence: 0.95, verdict: 'VULNERABLE', llmVerified: true },
    ];
    expect(isContentUnsafe(findings)).toBe(true);
  });

  it('should return false for CRITICAL non-injection', () => {
    const findings: ScanFinding[] = [
      { severity: 'CRITICAL', cweId: 'CWE-200', tool: 'test', title: 't', description: 'd', confidence: 0.9, verdict: 'VULNERABLE', llmVerified: true },
    ];
    expect(isContentUnsafe(findings)).toBe(false);
  });

  it('should return false for CRITICAL injection without LLM verification', () => {
    const findings: ScanFinding[] = [
      { severity: 'CRITICAL', cweId: 'CWE-78', tool: 'test', title: 't', description: 'd', confidence: 0.9, verdict: 'VULNERABLE', llmVerified: false },
    ];
    expect(isContentUnsafe(findings)).toBe(false);
  });

  it('should return false for HIGH injection even with LLM verification', () => {
    const findings: ScanFinding[] = [
      { severity: 'HIGH', cweId: 'CWE-78', tool: 'test', title: 't', description: 'd', confidence: 0.9, verdict: 'VULNERABLE', llmVerified: true },
    ];
    expect(isContentUnsafe(findings)).toBe(false);
  });

  it('should return false for empty findings', () => {
    expect(isContentUnsafe([])).toBe(false);
  });

  it('should detect CWE-89 (SQL injection) as content unsafe', () => {
    const findings: ScanFinding[] = [
      { severity: 'CRITICAL', cweId: 'CWE-89', tool: 'test', title: 't', description: 'd', confidence: 0.9, verdict: 'VULNERABLE', llmVerified: true },
    ];
    expect(isContentUnsafe(findings)).toBe(true);
  });

  it('should detect CWE-94 (code injection) as content unsafe', () => {
    const findings: ScanFinding[] = [
      { severity: 'CRITICAL', cweId: 'CWE-94', tool: 'test', title: 't', description: 'd', confidence: 0.95, verdict: 'VULNERABLE', llmVerified: true },
    ];
    expect(isContentUnsafe(findings)).toBe(true);
  });
});
