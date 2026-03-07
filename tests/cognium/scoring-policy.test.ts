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

  it('should return verified for high trust and non-HIGH severity', () => {
    expect(deriveTier('LOW', 0.75)).toBe('verified');
    expect(deriveTier(null, 0.80)).toBe('verified');
  });

  it('should return scanned for high trust but HIGH severity', () => {
    expect(deriveTier('HIGH', 0.75)).toBe('scanned');
  });

  it('should return scanned for low trust', () => {
    expect(deriveTier('LOW', 0.50)).toBe('scanned');
    expect(deriveTier(null, 0.60)).toBe('scanned');
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
});
