import { describe, it, expect } from 'vitest';
import {
  computeTrustScore,
  deriveStatus,
  deriveTier,
  buildRemediationMessage,
  BASE_TRUST,
} from '../../src/cognium/scoring-policy';
import type { ScanFinding, SkillRow } from '../../src/cognium/types';

function makeSkill(overrides?: Partial<SkillRow>): SkillRow {
  return {
    id: 'test-id',
    slug: 'test-skill',
    version: '1.0.0',
    name: 'Test Skill',
    description: 'A test skill',
    source: 'github',
    status: 'published',
    executionLayer: 'mcp-remote',
    ...overrides,
  };
}

function makeFinding(overrides?: Partial<ScanFinding>): ScanFinding {
  return {
    severity: 'MEDIUM',
    cweId: 'CWE-200',
    tool: 'circle-ir',
    title: 'Test finding',
    description: 'Test finding description',
    confidence: 0.8,
    verdict: 'VULNERABLE',
    llmVerified: false,
    ...overrides,
  };
}

describe('computeTrustScore', () => {
  it('should return base trust when no findings', () => {
    const skill = makeSkill({ source: 'mcp-registry' });
    const score = computeTrustScore(skill, []);
    expect(score).toBe(BASE_TRUST['mcp-registry']);
  });

  it('should use rootSource when available', () => {
    const skill = makeSkill({ source: 'direct', rootSource: 'clawhub' });
    const score = computeTrustScore(skill, []);
    expect(score).toBe(BASE_TRUST['clawhub']);
  });

  it('should default to 0.40 for unknown sources', () => {
    const skill = makeSkill({ source: 'unknown-source' });
    const score = computeTrustScore(skill, []);
    expect(score).toBe(0.40);
  });

  it('should apply CRITICAL_INJECTION impact', () => {
    const skill = makeSkill({ source: 'github' }); // base: 0.55
    const findings = [makeFinding({ severity: 'CRITICAL', cweId: 'CWE-78' })]; // -0.25
    const score = computeTrustScore(skill, findings);
    expect(score).toBe(0.3); // 0.55 - 0.25 = 0.30, rounded to 2dp
  });

  it('should apply SECRET_EXPOSURE impact', () => {
    const skill = makeSkill({ source: 'github' }); // base: 0.55
    const findings = [makeFinding({ severity: 'HIGH', cweId: 'CWE-798' })]; // -0.30
    const score = computeTrustScore(skill, findings);
    expect(score).toBe(0.25); // 0.55 - 0.30 = 0.25, rounded to 2dp
  });

  it('should apply MEDIUM finding default impact', () => {
    const skill = makeSkill({ source: 'mcp-registry' });
    const findings = [makeFinding({ severity: 'MEDIUM', cweId: 'CWE-200' })];
    const score = computeTrustScore(skill, findings);
    expect(score).toBe(BASE_TRUST['mcp-registry'] - 0.05);
  });

  it('should clamp score to 0.0 floor', () => {
    const skill = makeSkill({ source: 'forge' });
    const findings = [
      makeFinding({ severity: 'CRITICAL', cweId: 'CWE-78' }),
      makeFinding({ severity: 'CRITICAL', cweId: 'CWE-89' }),
    ];
    const score = computeTrustScore(skill, findings);
    expect(score).toBe(0.0);
  });

  it('should clamp score to 1.0 ceiling', () => {
    const skill = makeSkill({ source: 'mcp-registry' });
    const score = computeTrustScore(skill, []);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it('should accumulate multiple finding impacts', () => {
    const skill = makeSkill({ source: 'mcp-registry' }); // base: 0.80
    const findings = [
      makeFinding({ severity: 'HIGH', cweId: 'CWE-79' }), // HIGH_INJECTION: -0.20
      makeFinding({ severity: 'MEDIUM', cweId: 'CWE-200' }), // MEDIUM: -0.05
    ];
    const score = computeTrustScore(skill, findings);
    expect(score).toBe(0.55);
  });

  it('should apply CRITICAL_INJECTION for CWE-77 (command injection)', () => {
    const skill = makeSkill({ source: 'github' }); // base: 0.55
    const findings = [makeFinding({ severity: 'CRITICAL', cweId: 'CWE-77' })];
    expect(computeTrustScore(skill, findings)).toBe(0.30);
  });

  it('should apply HIGH_INJECTION for CWE-79 at HIGH severity', () => {
    const skill = makeSkill({ source: 'mcp-registry' }); // base: 0.80
    const findings = [makeFinding({ severity: 'HIGH', cweId: 'CWE-79' })];
    expect(computeTrustScore(skill, findings)).toBe(0.60);
  });

  it('should apply SECRET_EXPOSURE for CWE-312', () => {
    const skill = makeSkill({ source: 'github' }); // base: 0.55
    const findings = [makeFinding({ severity: 'HIGH', cweId: 'CWE-312' })];
    expect(computeTrustScore(skill, findings)).toBe(0.25);
  });

  it('should apply SECRET_EXPOSURE for CWE-321 and CWE-522', () => {
    const skill = makeSkill({ source: 'mcp-registry' }); // base: 0.80
    expect(computeTrustScore(skill, [makeFinding({ severity: 'MEDIUM', cweId: 'CWE-321' })])).toBe(0.50);
    expect(computeTrustScore(skill, [makeFinding({ severity: 'LOW', cweId: 'CWE-522' })])).toBe(0.50);
  });

  it('should accumulate impacts across SAST + instruction + capability', () => {
    const skill = makeSkill({ source: 'mcp-registry' }); // base: 0.80
    const findings = [
      makeFinding({ severity: 'HIGH', cweId: 'CWE-79' }),                // HIGH_INJECTION: -0.20
      makeFinding({ severity: 'HIGH', phase: 'instruction_safety' }),     // HIGH_INSTRUCTION: -0.20
      makeFinding({ severity: 'HIGH', phase: 'capability_mismatch' }),    // HIGH_CAPABILITY_MISMATCH: -0.15
    ];
    expect(computeTrustScore(skill, findings)).toBe(0.25);
  });

  it('should apply -0.05 for MEDIUM finding with no phase-specific classification', () => {
    const skill = makeSkill({ source: 'mcp-registry' }); // base: 0.80
    const findings = [makeFinding({ severity: 'MEDIUM', cweId: 'CWE-200', phase: undefined })];
    expect(computeTrustScore(skill, findings)).toBe(0.75);
  });

  it('should apply 0 impact for LOW finding with no matching classification', () => {
    const skill = makeSkill({ source: 'github' }); // base: 0.55
    const findings = [makeFinding({ severity: 'LOW', cweId: 'CWE-200', phase: undefined })];
    expect(computeTrustScore(skill, findings)).toBe(0.55);
  });

  it('should return correct base trust for all known sources', () => {
    const cases: [string, number][] = [
      ['mcp-registry', 0.80], ['clawhub', 0.65], ['github', 0.55],
      ['manual', 0.60], ['forge', 0.40], ['human-distilled', 0.50],
    ];
    for (const [source, expected] of cases) {
      expect(computeTrustScore(makeSkill({ source }), [])).toBe(expected);
    }
  });

  it('should apply CRITICAL_INSTRUCTION impact for instruction_safety phase', () => {
    const skill = makeSkill({ source: 'clawhub' }); // base: 0.65
    const findings = [makeFinding({ severity: 'CRITICAL', phase: 'instruction_safety' })]; // -0.30
    const score = computeTrustScore(skill, findings);
    expect(score).toBe(0.35);
  });

  it('should apply HIGH_INSTRUCTION impact for instruction_safety phase', () => {
    const skill = makeSkill({ source: 'clawhub' }); // base: 0.65
    const findings = [makeFinding({ severity: 'HIGH', phase: 'instruction_safety' })]; // -0.20
    const score = computeTrustScore(skill, findings);
    expect(score).toBe(0.45);
  });

  it('should apply CRITICAL_CAPABILITY_MISMATCH impact', () => {
    const skill = makeSkill({ source: 'clawhub' }); // base: 0.65
    const findings = [makeFinding({ severity: 'CRITICAL', phase: 'capability_mismatch' })]; // -0.25
    const score = computeTrustScore(skill, findings);
    expect(score).toBe(0.40);
  });

  it('should apply HIGH_CAPABILITY_MISMATCH impact', () => {
    const skill = makeSkill({ source: 'clawhub' }); // base: 0.65
    const findings = [makeFinding({ severity: 'HIGH', phase: 'capability_mismatch' })]; // -0.15
    const score = computeTrustScore(skill, findings);
    expect(score).toBe(0.50);
  });
});

describe('deriveStatus', () => {
  it('should return revoked for CRITICAL', () => {
    expect(deriveStatus('CRITICAL')).toBe('revoked');
  });

  it('should return vulnerable for HIGH', () => {
    expect(deriveStatus('HIGH')).toBe('vulnerable');
  });

  it('should return vulnerable for MEDIUM', () => {
    expect(deriveStatus('MEDIUM')).toBe('vulnerable');
  });

  it('should return published for LOW', () => {
    expect(deriveStatus('LOW')).toBe('published');
  });

  it('should return published for null', () => {
    expect(deriveStatus(null)).toBe('published');
  });
});

describe('deriveTier', () => {
  it('should return scanned for CRITICAL severity', () => {
    expect(deriveTier('CRITICAL', 0.9)).toBe('scanned');
  });

  it('should return verified for code-full + high trust and non-HIGH severity', () => {
    expect(deriveTier('LOW', 0.75, 'code-full')).toBe('verified');
    expect(deriveTier(null, 0.80, 'code-full')).toBe('verified');
  });

  it('should return scanned for high trust but HIGH severity', () => {
    expect(deriveTier('HIGH', 0.75)).toBe('scanned');
  });

  it('should return scanned for low trust', () => {
    expect(deriveTier('LOW', 0.50)).toBe('scanned');
    expect(deriveTier(null, 0.60)).toBe('scanned');
  });

  it('should return verified for code-full + high trust + no findings', () => {
    expect(deriveTier(null, 0.80, 'code-full')).toBe('verified');
  });

  it('should return scanned for instructions-only even with high trust', () => {
    expect(deriveTier(null, 0.90, 'instructions-only')).toBe('scanned');
    expect(deriveTier('LOW', 0.85, 'instructions-only')).toBe('scanned');
  });

  it('should return scanned for metadata-only even with high trust', () => {
    expect(deriveTier(null, 0.90, 'metadata-only')).toBe('scanned');
  });

  it('should return scanned for code-partial even with high trust', () => {
    expect(deriveTier(null, 0.90, 'code-partial')).toBe('scanned');
    expect(deriveTier('LOW', 0.80, 'code-partial')).toBe('scanned');
  });

  it('should return verified at exactly 0.70 trust boundary with code-full', () => {
    expect(deriveTier('LOW', 0.70, 'code-full')).toBe('verified');
    expect(deriveTier(null, 0.70, 'code-full')).toBe('verified');
  });

  it('should return scanned at 0.69 trust with code-full', () => {
    expect(deriveTier('LOW', 0.69, 'code-full')).toBe('scanned');
    expect(deriveTier(null, 0.69, 'code-full')).toBe('scanned');
  });

  it('should return scanned for HIGH severity even with code-full and high trust', () => {
    expect(deriveTier('HIGH', 0.80, 'code-full')).toBe('scanned');
  });

  it('should return verified for MEDIUM severity with code-full and high trust', () => {
    expect(deriveTier('MEDIUM', 0.75, 'code-full')).toBe('verified');
  });
});

describe('end-to-end scoring scenarios', () => {
  it('clean GitHub skill: trust=0.55, published, scanned (0.55 < 0.70)', () => {
    const skill = makeSkill({ source: 'github' });
    const trust = computeTrustScore(skill, []);
    const status = deriveStatus(null);
    const tier = deriveTier(null, trust, 'code-full');
    expect(trust).toBe(0.55);
    expect(status).toBe('published');
    expect(tier).toBe('scanned');
  });

  it('clean mcp-registry metadata-only: trust=0.80, published, scanned', () => {
    const skill = makeSkill({ source: 'mcp-registry' });
    const trust = computeTrustScore(skill, []);
    const tier = deriveTier(null, trust, 'metadata-only');
    expect(trust).toBe(0.80);
    expect(tier).toBe('scanned');
  });

  it('mcp-registry with repo (code-full): trust=0.80, published, verified', () => {
    const skill = makeSkill({ source: 'mcp-registry' });
    const trust = computeTrustScore(skill, []);
    const tier = deriveTier(null, trust, 'code-full');
    expect(trust).toBe(0.80);
    expect(tier).toBe('verified');
  });

  it('CRITICAL CWE-78 on forge: trust=0.15, revoked, scanned', () => {
    const skill = makeSkill({ source: 'forge' }); // base: 0.40
    const findings = [makeFinding({ severity: 'CRITICAL', cweId: 'CWE-78' })]; // -0.25
    const trust = computeTrustScore(skill, findings);
    const status = deriveStatus('CRITICAL');
    const tier = deriveTier('CRITICAL', trust, 'code-full');
    expect(trust).toBe(0.15);
    expect(status).toBe('revoked');
    expect(tier).toBe('scanned');
  });

  it('multiple severe findings: trust floors at 0.0', () => {
    const skill = makeSkill({ source: 'forge' }); // base: 0.40
    const findings = [
      makeFinding({ severity: 'CRITICAL', cweId: 'CWE-78' }),            // -0.25
      makeFinding({ severity: 'HIGH', cweId: 'CWE-798' }),               // -0.30
      makeFinding({ severity: 'HIGH', phase: 'instruction_safety' }),     // -0.20
    ];
    const trust = computeTrustScore(skill, findings);
    expect(trust).toBe(0.0);
  });
});

describe('buildRemediationMessage', () => {
  it('should build message with CWE ID', () => {
    const finding = makeFinding({ severity: 'HIGH', cweId: 'CWE-89', remediationHint: 'Use parameterized queries' });
    const skill = makeSkill();
    const msg = buildRemediationMessage(finding, skill);
    expect(msg).toContain('HIGH');
    expect(msg).toContain('CWE-89');
    expect(msg).toContain('Use parameterized queries');
  });

  it('should build message without remediation hint', () => {
    const finding = makeFinding({ severity: 'CRITICAL', cweId: 'CWE-78' });
    const skill = makeSkill();
    const msg = buildRemediationMessage(finding, skill);
    expect(msg).toBe('CRITICAL finding: CWE-78');
  });

  it('should fall back to title when no CWE ID', () => {
    const finding = makeFinding({ severity: 'MEDIUM', cweId: undefined, title: 'Insecure config' });
    const skill = makeSkill();
    const msg = buildRemediationMessage(finding, skill);
    expect(msg).toContain('Insecure config');
  });

  it('should include phase in remediation message when present', () => {
    const finding = makeFinding({ severity: 'CRITICAL', cweId: 'CWE-78', phase: 'instruction_safety' });
    const skill = makeSkill();
    const msg = buildRemediationMessage(finding, skill);
    expect(msg).toContain('Phase: instruction_safety');
  });

  it('should include mismatch indicator in remediation message when present', () => {
    const finding = makeFinding({
      severity: 'HIGH',
      phase: 'capability_mismatch',
      capabilityMismatch: true,
      remediationHint: 'Capability mismatch: capability_mismatch',
    });
    const skill = makeSkill();
    const msg = buildRemediationMessage(finding, skill);
    expect(msg).toContain('Mismatch: capability mismatch detected');
  });
});
