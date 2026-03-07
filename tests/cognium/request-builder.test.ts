import { describe, it, expect } from 'vitest';
import { buildCircleIRRequest } from '../../src/cognium/request-builder';
import type { SkillRow } from '../../src/cognium/types';

function makeSkill(overrides?: Partial<SkillRow>): SkillRow {
  return {
    id: 'test-id',
    slug: 'test-skill',
    version: '1.0.0',
    name: 'Test Skill',
    description: 'A test skill for testing',
    source: 'github',
    status: 'published',
    executionLayer: 'mcp-remote',
    ...overrides,
  };
}

describe('buildCircleIRRequest', () => {
  it('should use skillMd as code when available', () => {
    const skill = makeSkill({ skillMd: '# Skill\nSome markdown content' });
    const req = buildCircleIRRequest(skill);
    expect(req.code).toBe('# Skill\nSome markdown content');
  });

  it('should fall back to description when no skillMd', () => {
    const skill = makeSkill({ skillMd: null });
    const req = buildCircleIRRequest(skill);
    expect(req.code).toBe('A test skill for testing');
  });

  it('should set filename from slug', () => {
    const skill = makeSkill({ slug: 'my-cool-skill', version: '2.1.0' });
    const req = buildCircleIRRequest(skill);
    expect(req.filename).toBe('my-cool-skill');
  });

  it('should infer typescript language for mcp-remote', () => {
    const skill = makeSkill({ executionLayer: 'mcp-remote' });
    const req = buildCircleIRRequest(skill);
    expect(req.language).toBe('typescript');
  });

  it('should infer python language for worker execution layer', () => {
    const skill = makeSkill({ executionLayer: 'worker', slug: 'data-processor' });
    const req = buildCircleIRRequest(skill);
    // Default for worker is typescript unless slug contains python hints
    expect(req.language).toBeDefined();
  });

  it('should produce valid CircleIRAnalyzeRequest shape', () => {
    const skill = makeSkill();
    const req = buildCircleIRRequest(skill);
    expect(req).toHaveProperty('code');
    expect(req).toHaveProperty('filename');
    expect(typeof req.code).toBe('string');
    expect(typeof req.filename).toBe('string');
  });
});
