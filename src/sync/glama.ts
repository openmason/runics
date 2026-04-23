// ══════════════════════════════════════════════════════════════════════════════
// Glama Sync — Polls Glama registry for MCP servers
// ══════════════════════════════════════════════════════════════════════════════
//
// Source: https://glama.ai/api/mcp/v1/servers
// Frequency: Every 10 minutes (cron, paginated — 30 pages per invocation)
// Auth: None required
// Trust: 0.6 (aggregator, not primary registry)
//
// Glama is the largest MCP server aggregator (~21K servers). Uses cursor-based
// pagination. Many servers overlap with MCP Registry and GitHub — each source
// maintains its own entries via ON CONFLICT (source, source_url).
//
// ══════════════════════════════════════════════════════════════════════════════

import { BaseSyncWorker } from './base-sync';
import { slugify, isGitHubRepoUrl } from './utils';
import type { SkillUpsert } from '../types';

// ──────────────────────────────────────────────────────────────────────────────
// API Response Types
// ──────────────────────────────────────────────────────────────────────────────

interface GlamaResponse {
  pageInfo: {
    endCursor: string | null;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
  };
  servers: GlamaServer[];
}

interface GlamaServer {
  id: string;
  name: string;
  namespace: string;
  slug: string;
  description: string;
  url: string;
  attributes: string[];
  repository?: { url: string };
  spdxLicense?: { name: string; url: string } | null;
  tools: unknown[];
  environmentVariablesJsonSchema?: Record<string, unknown>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Sync Adapter
// ──────────────────────────────────────────────────────────────────────────────

export class GlamaSync extends BaseSyncWorker {
  protected get sourceName() {
    return 'glama';
  }

  async fetchBatch(cursor?: string): Promise<{ skills: unknown[]; nextCursor?: string }> {
    const url = new URL('https://glama.ai/api/mcp/v1/servers');
    if (cursor) url.searchParams.set('after', cursor);

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`Glama API error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as GlamaResponse;

    return {
      skills: data.servers,
      nextCursor: data.pageInfo.hasNextPage && data.pageInfo.endCursor
        ? data.pageInfo.endCursor
        : undefined,
    };
  }

  normalize(raw: unknown): SkillUpsert {
    const server = raw as GlamaServer;
    const repoUrl = server.repository?.url;

    return {
      name: server.name,
      slug: slugify(`${server.namespace}-${server.slug}`),
      description: server.description ?? '',
      executionLayer: 'mcp-remote',
      runtimeEnv: 'api',
      repositoryUrl: repoUrl && isGitHubRepoUrl(repoUrl) ? repoUrl : undefined,
      capabilitiesRequired: [],
      source: 'glama',
      sourceUrl: server.url ?? `https://glama.ai/mcp/servers/${server.id}`,
      sourceHash: '', // Set by base class
      trustScore: 0.6,
    };
  }
}
