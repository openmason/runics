// ══════════════════════════════════════════════════════════════════════════════
// MCP Registry Sync — Polls the official MCP Registry for MCP servers
// ══════════════════════════════════════════════════════════════════════════════
//
// Source: https://registry.modelcontextprotocol.io
// Frequency: Every 5 minutes (cron)
// Auth: None required
// Trust: 0.7 default (upstream registry vets submissions)
//
// ══════════════════════════════════════════════════════════════════════════════

import { BaseSyncWorker } from './base-sync';
import { slugify, isGitHubRepoUrl } from './utils';
import type { SkillUpsert } from '../types';

// ──────────────────────────────────────────────────────────────────────────────
// API Response Types
// ──────────────────────────────────────────────────────────────────────────────

interface McpRegistryResponse {
  servers: McpRegistryEntry[];
  metadata: {
    nextCursor?: string;
    count: number;
  };
}

interface McpRegistryEntry {
  server: {
    name: string;
    description?: string;
    title?: string;
    version?: string;
    repository?: {
      url: string;
      source: string;
      id?: string;
      subfolder?: string;
    };
    remotes?: Array<{
      type: string;
      url: string;
      headers?: Array<{
        name: string;
        description?: string;
        isRequired?: boolean;
        isSecret?: boolean;
      }>;
    }>;
    websiteUrl?: string;
    icons?: Array<{
      src: string;
      mimeType?: string;
    }>;
  };
  _meta?: {
    'io.modelcontextprotocol.registry/official'?: {
      status: string;
      publishedAt: string;
      updatedAt: string;
      isLatest: boolean;
    };
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Sync Adapter
// ──────────────────────────────────────────────────────────────────────────────

export class McpRegistrySync extends BaseSyncWorker {
  protected get sourceName() {
    return 'mcp-registry';
  }

  async fetchBatch(cursor?: string): Promise<{ skills: unknown[]; nextCursor?: string }> {
    const url = new URL('https://registry.modelcontextprotocol.io/v0/servers');
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`MCP Registry API error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as McpRegistryResponse;

    return {
      skills: data.servers,
      nextCursor: data.metadata?.nextCursor ?? undefined,
    };
  }

  normalize(raw: unknown): SkillUpsert {
    const entry = raw as McpRegistryEntry;
    const server = entry.server;

    // Use the first remote URL as the MCP endpoint
    const mcpUrl = server.remotes?.[0]?.url ?? undefined;

    // Extract GitHub repo URL from registry metadata (enables Mode A code scanning)
    const repoUrl = server.repository?.url;
    const repositoryUrl = repoUrl && isGitHubRepoUrl(repoUrl) ? repoUrl : undefined;

    return {
      name: server.title ?? server.name,
      slug: slugify(server.name),
      description: server.description ?? '',
      version: server.version ?? '1.0.0',
      executionLayer: 'mcp-remote',
      runtimeEnv: 'api', // v5.2: MCP servers are API calls
      mcpUrl,
      repositoryUrl,
      capabilitiesRequired: [],
      source: 'mcp-registry',
      sourceUrl: `https://registry.modelcontextprotocol.io/v0/servers/${encodeURIComponent(server.name)}`,
      sourceHash: '', // Set by base class
      trustScore: 0.7,
    };
  }
}
