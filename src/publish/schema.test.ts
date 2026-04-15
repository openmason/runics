import { describe, it, expect } from 'vitest';
import { publishSkillSchema, updateSkillSchema } from './schema';

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

describe('publishSkillSchema v5.2 fields', () => {
  const validBase = {
    name: 'Test',
    slug: 'test',
    description: 'Valid description text',
    executionLayer: 'worker' as const,
  };

  it('should accept valid runtimeEnv values', () => {
    for (const env of ['llm', 'api', 'browser', 'vm', 'local']) {
      const result = publishSkillSchema.safeParse({ ...validBase, runtimeEnv: env });
      expect(result.success).toBe(true);
    }
  });

  it('should reject invalid runtimeEnv', () => {
    const result = publishSkillSchema.safeParse({ ...validBase, runtimeEnv: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('should accept valid visibility values', () => {
    for (const vis of ['public', 'private', 'unlisted']) {
      const result = publishSkillSchema.safeParse({ ...validBase, visibility: vis });
      expect(result.success).toBe(true);
    }
  });

  it('should reject invalid visibility', () => {
    const result = publishSkillSchema.safeParse({ ...validBase, visibility: 'hidden' });
    expect(result.success).toBe(false);
  });
});

describe('publishSkillSchema environmentVariables', () => {
  const validBase = {
    name: 'Test',
    slug: 'test',
    description: 'Valid description text',
    executionLayer: 'worker' as const,
  };

  it('should accept environmentVariables as string array', () => {
    const result = publishSkillSchema.safeParse({
      ...validBase,
      environmentVariables: ['API_KEY', 'SECRET_TOKEN', 'DATABASE_URL'],
    });
    expect(result.success).toBe(true);
  });

  it('should accept empty environmentVariables array', () => {
    const result = publishSkillSchema.safeParse({
      ...validBase,
      environmentVariables: [],
    });
    expect(result.success).toBe(true);
  });

  it('should reject non-string items in environmentVariables', () => {
    const result = publishSkillSchema.safeParse({
      ...validBase,
      environmentVariables: [123, true],
    });
    expect(result.success).toBe(false);
  });

  it('should accept all v5.2 fields together', () => {
    const result = publishSkillSchema.safeParse({
      ...validBase,
      runtimeEnv: 'browser',
      visibility: 'private',
      environmentVariables: ['API_KEY'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtimeEnv).toBe('browser');
      expect(result.data.visibility).toBe('private');
      expect(result.data.environmentVariables).toEqual(['API_KEY']);
    }
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

  it('should accept categories array', () => {
    const result = updateSkillSchema.safeParse({ categories: ['devops', 'ai'] });
    expect(result.success).toBe(true);
  });

  it('should accept skillMd update', () => {
    const result = updateSkillSchema.safeParse({ skillMd: '# Updated Instructions\nDo something' });
    expect(result.success).toBe(true);
  });

  it('should reject invalid description (too short)', () => {
    const result = updateSkillSchema.safeParse({ description: 'Short' });
    expect(result.success).toBe(false);
  });

  it('should accept v5.2 fields in updates', () => {
    const result = updateSkillSchema.safeParse({
      runtimeEnv: 'vm',
      visibility: 'unlisted',
      environmentVariables: ['DB_URL'],
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid runtimeEnv in updates', () => {
    const result = updateSkillSchema.safeParse({ runtimeEnv: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('should reject invalid visibility in updates', () => {
    const result = updateSkillSchema.safeParse({ visibility: 'hidden' });
    expect(result.success).toBe(false);
  });
});

