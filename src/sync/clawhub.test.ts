import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClawHubSync } from './clawhub';
import type { Env } from '../types';

function createMockEnv(): Env {
  return {
    NEON_CONNECTION_STRING: 'postgresql://test:test@localhost/test',
    EMBED_QUEUE: { send: vi.fn() } as any,
    COGNIUM_QUEUE: { send: vi.fn() } as any,
  } as any;
}

describe('ClawHubSync', () => {
  let sync: ClawHubSync;

  beforeEach(() => {
    sync = new ClawHubSync(createMockEnv());
  });

  describe('normalize', () => {
    it('should normalize a parsed entry', () => {
      const raw = {
        slug: 'my-cool-skill',
        authorSlug: 'steipete-my-cool-skill',
        description: 'A useful skill for doing things',
        sourceUrl: 'https://clawskills.sh/skills/steipete-my-cool-skill',
        category: 'coding-agents-and-ides',
      };

      const result = sync.normalize(raw);

      expect(result.name).toBe('my-cool-skill');
      expect(result.slug).toBe('steipete-my-cool-skill');
      expect(result.description).toBe('A useful skill for doing things');
      expect(result.source).toBe('clawhub');
      expect(result.trustScore).toBe(0.6);
      expect(result.sourceUrl).toBe('https://clawskills.sh/skills/steipete-my-cool-skill');
      expect(result.executionLayer).toBe('instructions');
      expect(result.runtimeEnv).toBe('llm');
    });

    it('should use slug when authorSlug is empty', () => {
      const raw = {
        slug: 'orphan-skill',
        authorSlug: '',
        description: 'No author in URL',
        sourceUrl: 'https://clawskills.sh/skills/orphan-skill',
        category: 'cli-utilities',
      };

      const result = sync.normalize(raw);
      expect(result.slug).toBe('orphan-skill');
    });

    it('should set all expected fields', () => {
      const raw = {
        slug: 'test-skill',
        authorSlug: 'author-test-skill',
        description: 'Test description',
        sourceUrl: 'https://clawskills.sh/skills/author-test-skill',
        category: 'ai-and-llms',
      };

      const result = sync.normalize(raw);
      expect(result.capabilitiesRequired).toEqual([]);
      expect(result.sourceHash).toBe('');
    });
  });

  describe('fetchBatch', () => {
    it('should return empty for out-of-range cursor', async () => {
      const result = await sync.fetchBatch('999');
      expect(result.skills).toEqual([]);
      expect(result.nextCursor).toBeUndefined();
    });
  });
});
