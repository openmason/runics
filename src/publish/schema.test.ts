import { describe, it, expect } from 'vitest';
import { publishSkillSchema, updateSkillSchema, trustUpdateSchema } from './schema';

describe('publishSkillSchema', () => {
  it('should accept valid skill input', () => {
    const input = {
      name: 'My Skill',
      slug: 'my-skill',
      description: 'A useful skill for testing purposes',
      executionLayer: 'worker' as const,
    };

    const result = publishSkillSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should accept full skill input with all fields', () => {
    const input = {
      name: 'Full Skill',
      slug: 'full-skill',
      version: '2.0.0',
      description: 'Complete skill with all fields',
      schemaJson: { type: 'object', properties: {} },
      executionLayer: 'mcp-remote' as const,
      mcpUrl: 'https://example.com/mcp',
      skillMd: '# My Skill\nInstructions here',
      capabilitiesRequired: ['git', 'docker'],
      source: 'forge' as const,
      sourceUrl: 'https://forge.example.com/skills/1',
      tenantId: '550e8400-e29b-41d4-a716-446655440000',
      trustScore: 0.8,
      tags: ['testing', 'development'],
      category: 'devtools',
    };

    const result = publishSkillSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should reject missing required fields', () => {
    const input = { name: 'Test' };
    const result = publishSkillSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('should reject invalid slug format', () => {
    const input = {
      name: 'Test',
      slug: 'Invalid Slug!',
      description: 'Test skill description here',
      executionLayer: 'worker',
    };
    const result = publishSkillSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('should reject description shorter than 10 chars', () => {
    const input = {
      name: 'Test',
      slug: 'test',
      description: 'Short',
      executionLayer: 'worker',
    };
    const result = publishSkillSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('should reject invalid execution layer', () => {
    const input = {
      name: 'Test',
      slug: 'test',
      description: 'Valid description text',
      executionLayer: 'invalid-layer',
    };
    const result = publishSkillSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('should reject trust score out of range', () => {
    const input = {
      name: 'Test',
      slug: 'test',
      description: 'Valid description text',
      executionLayer: 'worker',
      trustScore: 1.5,
    };
    const result = publishSkillSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe('updateSkillSchema', () => {
  it('should accept partial updates', () => {
    const result = updateSkillSchema.safeParse({ name: 'New Name' });
    expect(result.success).toBe(true);
  });

  it('should accept empty object (no fields to update)', () => {
    const result = updateSkillSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe('trustUpdateSchema', () => {
  it('should accept valid trust update', () => {
    const input = {
      trustScore: 0.85,
      cogniumReport: {
        contentSafe: true,
        findings: [
          {
            tool: 'viruscheck',
            severity: 'low' as const,
            message: 'Minor issue found',
          },
        ],
        scannedAt: '2026-03-01T00:00:00Z',
      },
    };

    const result = trustUpdateSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should reject missing cogniumReport', () => {
    const result = trustUpdateSchema.safeParse({ trustScore: 0.5 });
    expect(result.success).toBe(false);
  });

  it('should reject invalid severity', () => {
    const input = {
      trustScore: 0.5,
      cogniumReport: {
        contentSafe: true,
        findings: [{ tool: 'test', severity: 'unknown', message: 'test' }],
        scannedAt: '2026-03-01T00:00:00Z',
      },
    };
    const result = trustUpdateSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});
