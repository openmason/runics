import { describe, it, expect } from 'vitest';
import { buildCircleIRRequest } from '../../src/cognium/request-builder';
import type { SkillRow } from '../../src/cognium/types';

function makeSkill(overrides?: Partial<SkillRow>): SkillRow {
  return {
    id: 'test-id',
    slug: 'test-skill',
    version: '1.0.0',
    name: 'Test Skill',
    description: 'A test skill for testing purposes',
    source: 'github',
    status: 'published',
    executionLayer: 'mcp-remote',
    ...overrides,
  };
}

describe('buildCircleIRRequest', () => {
  describe('skill_context', () => {
    it('should include name, description, source_registry, execution_layer', () => {
      const skill = makeSkill();
      const req = buildCircleIRRequest(skill);
      expect(req.skill_context).toEqual({
        name: 'Test Skill',
        description: 'A test skill for testing purposes',
        source_registry: 'github',
        source_url: undefined,
        execution_layer: 'mcp-remote',
      });
    });

    it('should include source_url when available', () => {
      const skill = makeSkill({ sourceUrl: 'https://github.com/owner/repo' });
      const req = buildCircleIRRequest(skill);
      expect(req.skill_context.source_url).toBe('https://github.com/owner/repo');
    });
  });

  describe('options', () => {
    it('should enable all analysis phases by default', () => {
      const skill = makeSkill();
      const req = buildCircleIRRequest(skill);
      expect(req.options).toEqual({
        enable_sast: true,
        enable_instruction_analysis: true,
        enable_capability_mismatch: true,
        enable_llm_verification: true,
      });
    });
  });

  describe('Mode A — GitHub repo URL', () => {
    it('should use repo_url for GitHub skills', () => {
      const skill = makeSkill({ sourceUrl: 'https://github.com/owner/repo' });
      const req = buildCircleIRRequest(skill);
      expect(req.repo_url).toBe('https://github.com/owner/repo');
      expect(req.files).toBeUndefined();
    });

    it('should not use repo_url for non-GitHub URLs', () => {
      const skill = makeSkill({ sourceUrl: 'https://clawhub.ai/skills/my-skill' });
      const req = buildCircleIRRequest(skill);
      expect(req.repo_url).toBeUndefined();
      expect(req.files).toBeDefined();
    });

    it('should not use repo_url for invalid URLs', () => {
      const skill = makeSkill({ sourceUrl: 'not-a-url' });
      const req = buildCircleIRRequest(skill);
      expect(req.repo_url).toBeUndefined();
      expect(req.files).toBeDefined();
    });

    it('should reject GitHub URLs without owner/repo path', () => {
      const skill = makeSkill({ sourceUrl: 'https://github.com/' });
      const req = buildCircleIRRequest(skill);
      expect(req.repo_url).toBeUndefined();
      expect(req.files).toBeDefined();
    });
  });

  describe('Mode B — inline files', () => {
    it('should include SKILL.md when skillMd is available', () => {
      const skill = makeSkill({ skillMd: '# Skill\nSome markdown content', sourceUrl: null });
      const req = buildCircleIRRequest(skill);
      expect(req.files?.['SKILL.md']).toBe('# Skill\nSome markdown content');
    });

    it('should include DESCRIPTION.md for descriptions longer than 20 chars', () => {
      const skill = makeSkill({ skillMd: null, sourceUrl: null });
      const req = buildCircleIRRequest(skill);
      expect(req.files?.['DESCRIPTION.md']).toBe('A test skill for testing purposes');
    });

    it('should not include DESCRIPTION.md for short descriptions', () => {
      const skill = makeSkill({ description: 'Short desc', skillMd: '# Skill', sourceUrl: null });
      const req = buildCircleIRRequest(skill);
      expect(req.files?.['DESCRIPTION.md']).toBeUndefined();
    });

    it('should include schema.json when schemaJson is available', () => {
      const schema = { type: 'object', properties: { url: { type: 'string' } } };
      const skill = makeSkill({ schemaJson: schema, sourceUrl: null });
      const req = buildCircleIRRequest(skill);
      expect(req.files?.['schema.json']).toBe(JSON.stringify(schema, null, 2));
    });

    it('should fall back to description as SKILL.md when no other files', () => {
      const skill = makeSkill({ skillMd: null, description: 'tiny', sourceUrl: null, schemaJson: null });
      const req = buildCircleIRRequest(skill);
      expect(req.files?.['SKILL.md']).toBe('tiny');
    });

    it('should include _metadata.json when r2BundleKey is present', () => {
      const skill = makeSkill({ r2BundleKey: 'bundles/abc123.zip', sourceUrl: null });
      const req = buildCircleIRRequest(skill);
      expect(req.files?.['_metadata.json']).toBeDefined();
      const meta = JSON.parse(req.files!['_metadata.json']);
      expect(meta.r2_bundle_key).toBe('bundles/abc123.zip');
    });

    it('should fall back to name when description is empty', () => {
      const skill = makeSkill({ description: '', skillMd: null, sourceUrl: null, schemaJson: null });
      const req = buildCircleIRRequest(skill);
      expect(req.files?.['SKILL.md']).toBe('Test Skill');
    });

    it('should produce valid request with all optional fields null', () => {
      const skill = makeSkill({
        skillMd: null, sourceUrl: null, repositoryUrl: null,
        schemaJson: null, r2BundleKey: null, description: '',
      });
      const req = buildCircleIRRequest(skill);
      expect(req.skill_context.name).toBe('Test Skill');
      expect(req.files).toBeDefined();
      expect(Object.keys(req.files!).length).toBeGreaterThan(0);
    });
  });

  describe('Mode A — repositoryUrl fallback', () => {
    it('should fall back to repositoryUrl when sourceUrl is not GitHub', () => {
      const skill = makeSkill({
        sourceUrl: 'https://clawhub.ai/skills/my-skill',
        repositoryUrl: 'https://github.com/owner/repo',
      });
      const req = buildCircleIRRequest(skill);
      expect(req.repo_url).toBe('https://github.com/owner/repo');
      expect(req.files).toBeUndefined();
    });

    it('should prefer sourceUrl over repositoryUrl when both are GitHub', () => {
      const skill = makeSkill({
        sourceUrl: 'https://github.com/primary/repo',
        repositoryUrl: 'https://github.com/secondary/repo',
      });
      const req = buildCircleIRRequest(skill);
      expect(req.repo_url).toBe('https://github.com/primary/repo');
    });

    it('should use Mode B when neither sourceUrl nor repositoryUrl is GitHub', () => {
      const skill = makeSkill({
        sourceUrl: 'https://clawhub.ai/skills/my-skill',
        repositoryUrl: 'https://gitlab.com/owner/repo',
      });
      const req = buildCircleIRRequest(skill);
      expect(req.repo_url).toBeUndefined();
      expect(req.files).toBeDefined();
    });
  });

  describe('size limits', () => {
    it('should truncate oversized skillMd', () => {
      const bigMd = 'x'.repeat(300_000); // 300 KB > 256 KB limit
      const skill = makeSkill({ sourceUrl: null, skillMd: bigMd });
      const req = buildCircleIRRequest(skill);
      expect(req.files!['SKILL.md'].length).toBeLessThan(bigMd.length);
      expect(req.files!['SKILL.md']).toContain('[truncated]');
    });

    it('should truncate oversized schemaJson', () => {
      // Build a schema larger than 64 KB
      const bigSchema: Record<string, string> = {};
      for (let i = 0; i < 2000; i++) bigSchema[`field_${i}`] = 'x'.repeat(50);
      const skill = makeSkill({ sourceUrl: null, schemaJson: bigSchema });
      const req = buildCircleIRRequest(skill);
      expect(req.files!['schema.json'].length).toBeLessThanOrEqual(64 * 1024 + 20);
      expect(req.files!['schema.json']).toContain('[truncated]');
    });

    it('should NOT truncate normal-sized content', () => {
      const skill = makeSkill({ sourceUrl: null, skillMd: '# Normal doc\n\nSome instructions.' });
      const req = buildCircleIRRequest(skill);
      expect(req.files!['SKILL.md']).not.toContain('[truncated]');
    });
  });
});
