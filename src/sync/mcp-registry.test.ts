import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpRegistrySync } from './mcp-registry';
import type { Env } from '../types';

// Mock env
function createMockEnv(): Env {
  return {
    NEON_CONNECTION_STRING: 'postgresql://test:test@localhost/test',
    EMBED_QUEUE: { send: vi.fn() } as any,
    COGNIUM_QUEUE: { send: vi.fn() } as any,
  } as any;
}

describe('McpRegistrySync', () => {
  let sync: McpRegistrySync;

  beforeEach(() => {
    sync = new McpRegistrySync(createMockEnv());
  });

  describe('normalize', () => {
    it('should normalize an MCP Registry entry', () => {
      const raw = {
        server: {
          name: 'agency.lona/trading',
          description: 'AI-powered trading strategy development',
          version: '2.0.0',
          remotes: [{ type: 'streamable-http', url: 'https://mcp.lona.agency/mcp' }],
          websiteUrl: 'https://lona.agency',
        },
        _meta: {
          'io.modelcontextprotocol.registry/official': {
            status: 'active',
            publishedAt: '2026-02-24T00:07:27Z',
            updatedAt: '2026-02-24T00:07:27Z',
            isLatest: true,
          },
        },
      };

      const result = sync.normalize(raw);

      expect(result.name).toBe('agency.lona/trading');
      expect(result.slug).toBe('agency-lona-trading');
      expect(result.description).toBe('AI-powered trading strategy development');
      expect(result.version).toBe('2.0.0');
      expect(result.executionLayer).toBe('mcp-remote');
      expect(result.mcpUrl).toBe('https://mcp.lona.agency/mcp');
      expect(result.source).toBe('mcp-registry');
      expect(result.trustScore).toBe(0.7);
      expect(result.sourceUrl).toContain('agency.lona%2Ftrading');
    });

    it('should use title as name when available', () => {
      const raw = {
        server: {
          name: 'ai.adadvisor/mcp-server',
          title: 'AdAdvisor MCP Server',
          description: 'Query Meta Ads data',
          version: '1.0.0',
        },
        _meta: {},
      };

      const result = sync.normalize(raw);
      expect(result.name).toBe('AdAdvisor MCP Server');
    });

    it('should handle missing remotes', () => {
      const raw = {
        server: {
          name: 'test/server',
          description: 'Test server',
        },
        _meta: {},
      };

      const result = sync.normalize(raw);
      expect(result.mcpUrl).toBeUndefined();
    });

    it('should default to empty description', () => {
      const raw = {
        server: { name: 'test/server' },
        _meta: {},
      };

      const result = sync.normalize(raw);
      expect(result.description).toBe('');
    });
  });
});
