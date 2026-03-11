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
    phase: 'sast',
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

  it('should carry phase through to ScanFinding', () => {
    const raw = [makeRawFinding({ phase: 'instruction_safety' })];
    const findings = normalizeFindings(raw);
    expect(findings[0].phase).toBe('instruction_safety');
  });

  it('should set capabilityMismatch for capability_mismatch phase', () => {
    const raw = [makeRawFinding({ phase: 'capability_mismatch' })];
    const findings = normalizeFindings(raw);
    expect(findings[0].capabilityMismatch).toBe(true);
  });

  it('should not set capabilityMismatch for sast phase', () => {
    const raw = [makeRawFinding({ phase: 'sast' })];
    const findings = normalizeFindings(raw);
    expect(findings[0].capabilityMismatch).toBe(false);
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

  it('should generate remediation hint for capability mismatch', () => {
    const raw = [makeRawFinding({
      phase: 'capability_mismatch',
      sink: { type: 'capability_mismatch', method: null, cwe: 'CWE-74' },
    })];
    const findings = normalizeFindings(raw);
    expect(findings[0].remediationHint).toBe('Capability mismatch: capability_mismatch');
  });

  it('should generate remediation hint for capability mismatch without sink', () => {
    const raw = [makeRawFinding({
      phase: 'capability_mismatch',
      sink: undefined,
    })];
    const findings = normalizeFindings(raw);
    expect(findings[0].remediationHint).toBe('Capability mismatch: undeclared behavior');
  });

  it('should handle null line_start and line_end', () => {
    const raw = [makeRawFinding({ line_start: null, line_end: null })];
    const findings = normalizeFindings(raw);
    expect(findings).toHaveLength(1);
  });

  it('should handle empty findings array', () => {
    expect(normalizeFindings([])).toEqual([]);
  });

  it('should preserve all non-SAFE findings with mixed severity', () => {
    const raw = [
      makeRawFinding({ id: '1', severity: 'low', verdict: 'NEEDS_REVIEW' }),
      makeRawFinding({ id: '2', severity: 'critical', verdict: 'VULNERABLE' }),
      makeRawFinding({ id: '3', severity: 'medium', verdict: 'VULNERABLE' }),
      makeRawFinding({ id: '4', severity: 'high', verdict: 'SAFE' }),
    ];
    const findings = normalizeFindings(raw);
    expect(findings).toHaveLength(3);
    expect(findings.map(f => f.severity)).toEqual(['LOW', 'CRITICAL', 'MEDIUM']);
  });

  it('should carry through NEEDS_REVIEW verdict with correct fields', () => {
    const raw = [makeRawFinding({ verdict: 'NEEDS_REVIEW', severity: 'medium' })];
    const findings = normalizeFindings(raw);
    expect(findings[0].verdict).toBe('NEEDS_REVIEW');
    expect(findings[0].severity).toBe('MEDIUM');
    expect(findings[0].tool).toBe('circle-ir');
  });

  it('should generate remediation hint for SAST finding with sink and method', () => {
    const raw = [makeRawFinding({
      phase: 'sast',
      sink: { type: 'sql_query', method: 'execute', cwe: 'CWE-89', location: { line: 42, code_snippet: 'db.execute(input)' } },
      line_end: 42,
    })];
    const findings = normalizeFindings(raw);
    expect(findings[0].remediationHint).toBe('sql_query via execute at line 42');
  });

  it('should handle large finding arrays (25 items) without error', () => {
    const raw = Array.from({ length: 25 }, (_, i) =>
      makeRawFinding({ id: `finding-${i}`, severity: i % 2 === 0 ? 'high' : 'medium' })
    );
    const findings = normalizeFindings(raw);
    expect(findings).toHaveLength(25);
  });

  // ── Input validation edge cases ──────────────────────────────────────────
  it('should return empty array when raw is undefined', () => {
    expect(normalizeFindings(undefined as any)).toEqual([]);
  });

  it('should return empty array when raw is null', () => {
    expect(normalizeFindings(null as any)).toEqual([]);
  });

  it('should return empty array when raw is not an array', () => {
    expect(normalizeFindings('not-an-array' as any)).toEqual([]);
    expect(normalizeFindings(42 as any)).toEqual([]);
    expect(normalizeFindings({} as any)).toEqual([]);
  });

  it('should skip findings with null severity', () => {
    const raw = [makeRawFinding({ severity: null as any })];
    const findings = normalizeFindings(raw);
    expect(findings).toHaveLength(0);
  });

  it('should skip findings with undefined severity', () => {
    const raw = [{ ...makeRawFinding(), severity: undefined }];
    const findings = normalizeFindings(raw as any);
    expect(findings).toHaveLength(0);
  });

  it('should skip findings with missing description', () => {
    const raw = [{ ...makeRawFinding(), description: undefined }];
    const findings = normalizeFindings(raw as any);
    expect(findings).toHaveLength(0);
  });

  it('should skip findings with invalid severity value', () => {
    const raw = [makeRawFinding({ severity: 'UNKNOWN' as any })];
    const findings = normalizeFindings(raw);
    expect(findings).toHaveLength(0);
  });

  it('should skip null/undefined entries in the array', () => {
    const raw = [null, undefined, makeRawFinding({ severity: 'high' })];
    const findings = normalizeFindings(raw as any);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('HIGH');
  });

  it('should handle mixed valid and invalid findings', () => {
    const raw = [
      makeRawFinding({ severity: 'critical' }),
      { severity: null, description: 'bad' },      // invalid: null severity
      makeRawFinding({ severity: 'low' }),
      { severity: 'high' },                          // invalid: no description
      makeRawFinding({ verdict: 'SAFE' }),            // filtered: SAFE verdict
    ];
    const findings = normalizeFindings(raw as any);
    expect(findings).toHaveLength(2);
    expect(findings[0].severity).toBe('CRITICAL');
    expect(findings[1].severity).toBe('LOW');
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

  it('should return true for CRITICAL instruction_safety finding with LLM verification', () => {
    const findings: ScanFinding[] = [
      { severity: 'CRITICAL', tool: 'test', phase: 'instruction_safety', title: 'Prompt injection', description: 'd', confidence: 0.95, verdict: 'VULNERABLE', llmVerified: true },
    ];
    expect(isContentUnsafe(findings)).toBe(true);
  });

  it('should return false for HIGH instruction_safety finding', () => {
    const findings: ScanFinding[] = [
      { severity: 'HIGH', tool: 'test', phase: 'instruction_safety', title: 'Prompt injection', description: 'd', confidence: 0.9, verdict: 'VULNERABLE', llmVerified: true },
    ];
    expect(isContentUnsafe(findings)).toBe(false);
  });

  it('should return true for CRITICAL capability mismatch with LLM verification', () => {
    const findings: ScanFinding[] = [
      { severity: 'CRITICAL', tool: 'test', phase: 'capability_mismatch', capabilityMismatch: true, title: 'Undisclosed behavior', description: 'd', confidence: 0.9, verdict: 'VULNERABLE', llmVerified: true },
    ];
    expect(isContentUnsafe(findings)).toBe(true);
  });

  it('should return false for HIGH capability mismatch even with LLM verification', () => {
    const findings: ScanFinding[] = [
      { severity: 'HIGH', tool: 'test', phase: 'capability_mismatch', capabilityMismatch: true, title: 'Mismatch', description: 'd', confidence: 0.9, verdict: 'VULNERABLE', llmVerified: true },
    ];
    expect(isContentUnsafe(findings)).toBe(false);
  });

  it('should detect CWE-77 (command injection) as content unsafe', () => {
    const findings: ScanFinding[] = [
      { severity: 'CRITICAL', cweId: 'CWE-77', tool: 'test', title: 't', description: 'd', confidence: 0.9, verdict: 'VULNERABLE', llmVerified: true },
    ];
    expect(isContentUnsafe(findings)).toBe(true);
  });

  it('should detect CWE-79 (XSS) as content unsafe', () => {
    const findings: ScanFinding[] = [
      { severity: 'CRITICAL', cweId: 'CWE-79', tool: 'test', title: 't', description: 'd', confidence: 0.9, verdict: 'VULNERABLE', llmVerified: true },
    ];
    expect(isContentUnsafe(findings)).toBe(true);
  });

  it('should NOT flag secret exposure CWEs as content unsafe', () => {
    for (const cwe of ['CWE-312', 'CWE-321', 'CWE-522']) {
      const findings: ScanFinding[] = [
        { severity: 'CRITICAL', cweId: cwe, tool: 'test', title: 't', description: 'd', confidence: 0.9, verdict: 'VULNERABLE', llmVerified: true },
      ];
      expect(isContentUnsafe(findings)).toBe(false);
    }
  });

  it('should return false for CRITICAL instruction_safety without LLM verification', () => {
    const findings: ScanFinding[] = [
      { severity: 'CRITICAL', tool: 'test', phase: 'instruction_safety', title: 't', description: 'd', confidence: 0.9, verdict: 'VULNERABLE', llmVerified: false },
    ];
    expect(isContentUnsafe(findings)).toBe(false);
  });

  it('should return false for CRITICAL capability_mismatch without LLM verification', () => {
    const findings: ScanFinding[] = [
      { severity: 'CRITICAL', tool: 'test', phase: 'capability_mismatch', capabilityMismatch: true, title: 't', description: 'd', confidence: 0.9, verdict: 'VULNERABLE', llmVerified: false },
    ];
    expect(isContentUnsafe(findings)).toBe(false);
  });

  it('should detect content unsafe even among many safe findings', () => {
    const findings: ScanFinding[] = [
      { severity: 'LOW', cweId: 'CWE-200', tool: 'test', title: 't', description: 'd', confidence: 0.5, verdict: 'VULNERABLE', llmVerified: false },
      { severity: 'MEDIUM', cweId: 'CWE-400', tool: 'test', title: 't', description: 'd', confidence: 0.6, verdict: 'VULNERABLE', llmVerified: false },
      { severity: 'CRITICAL', cweId: 'CWE-94', tool: 'test', title: 't', description: 'd', confidence: 0.95, verdict: 'VULNERABLE', llmVerified: true },
    ];
    expect(isContentUnsafe(findings)).toBe(true);
  });
});
