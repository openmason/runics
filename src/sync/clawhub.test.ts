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
    it('should normalize a ClawHub skill', () => {
      const raw = {
        slug: 'my-cool-skill',
        displayName: 'My Cool Skill',
        summary: 'A useful skill for doing things',
        version: '1.2.0',
        hasCode: true,
        hasBins: false,
        virusTotalFlagged: false,
      };

      const result = sync.normalize(raw);

      expect(result.name).toBe('My Cool Skill');
      expect(result.slug).toBe('my-cool-skill');
      expect(result.description).toBe('A useful skill for doing things');
      expect(result.version).toBe('1.2.0');
      expect(result.source).toBe('clawhub');
      expect(result.trustScore).toBe(0.6);
      expect(result.sourceUrl).toBe('https://clawhub.ai/skills/my-cool-skill');
    });

    it('should reduce trust score for VirusTotal flagged skills', () => {
      const raw = {
        slug: 'flagged-skill',
        displayName: 'Flagged Skill',
        summary: 'Suspicious skill',
        virusTotalFlagged: true,
      };

      const result = sync.normalize(raw);
      expect(result.trustScore).toBe(0.3);
    });

    it('should infer instructions layer for SKILL.md-only skills', () => {
      const raw = {
        slug: 'instructions-only',
        summary: 'Text-only skill',
        hasCode: false,
        skillMd: '# My Skill\nDo the thing',
      };

      const result = sync.normalize(raw);
      expect(result.executionLayer).toBe('instructions');
    });

    it('should infer container layer for skills with binaries', () => {
      const raw = {
        slug: 'binary-skill',
        summary: 'Needs native binaries',
        hasBins: true,
      };

      const result = sync.normalize(raw);
      expect(result.executionLayer).toBe('container');
      expect(result.capabilitiesRequired).toContain('native-binaries');
    });

    it('should infer container layer for browser capabilities', () => {
      const raw = {
        slug: 'browser-skill',
        summary: 'Needs browser',
        capabilities: ['browser'],
      };

      const result = sync.normalize(raw);
      expect(result.executionLayer).toBe('container');
    });

    it('should default to worker execution layer', () => {
      const raw = {
        slug: 'simple-skill',
        summary: 'Simple function',
      };

      const result = sync.normalize(raw);
      expect(result.executionLayer).toBe('worker');
    });

    it('should use slug as name when displayName is missing', () => {
      const raw = {
        slug: 'unnamed-skill',
        summary: 'No display name',
      };

      const result = sync.normalize(raw);
      expect(result.name).toBe('unnamed-skill');
    });

    it('should fall back through description sources', () => {
      // summary > description > skillMdExcerpt > empty
      const raw1 = { slug: 'a', summary: 'summary text' };
      expect(sync.normalize(raw1).description).toBe('summary text');

      const raw2 = { slug: 'b', description: 'desc text' };
      expect(sync.normalize(raw2).description).toBe('desc text');

      const raw3 = { slug: 'c', skillMdExcerpt: 'excerpt text' };
      expect(sync.normalize(raw3).description).toBe('excerpt text');

      const raw4 = { slug: 'd' };
      expect(sync.normalize(raw4).description).toBe('');
    });
  });
});
