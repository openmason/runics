// ══════════════════════════════════════════════════════════════════════════════
// Smithery Sync — Polls Smithery registry for MCP servers
// ══════════════════════════════════════════════════════════════════════════════
//
// Source: https://registry.smithery.ai/servers
// Frequency: Every 15 minutes (cron)
// Auth: None required (public endpoint)
// Trust: 0.7 verified, 0.5 unverified
//
// Smithery is a curated MCP server registry (~5K servers). Uses page-number
// pagination with pageSize up to 100.
//
// ══════════════════════════════════════════════════════════════════════════════

import { BaseSyncWorker } from './base-sync';
import { slugify, isGitHubRepoUrl } from './utils';
import type { SkillUpsert } from '../types';

// ──────────────────────────────────────────────────────────────────────────────
// API Response Types
// ──────────────────────────────────────────────────────────────────────────────

interface SmitheryResponse {
  servers: SmitheryServer[];
  pagination: {
    currentPage: number;
    pageSize: number;
    totalPages: number;
    totalCount: number;
  };
}

interface SmitheryServer {
  id: string;
  qualifiedName: string;
  namespace: string;
  slug: string;
  displayName: string;
  description: string;
  iconUrl?: string;
  homepage?: string;
  verified: boolean;
  useCount: number;
  remote: boolean;
  isDeployed: boolean;
  createdAt: string;
  owner?: string;
  score?: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Sync Adapter
// ──────────────────────────────────────────────────────────────────────────────

export class SmitherySync extends BaseSyncWorker {
  protected get sourceName() {
    return 'smithery';
  }

  async fetchBatch(cursor?: string): Promise<{ skills: unknown[]; nextCursor?: string }> {
    const page = parseInt(cursor ?? '1', 10);
    const url = new URL('https://registry.smithery.ai/servers');
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', '100');

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`Smithery API error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as SmitheryResponse;

    return {
      skills: data.servers,
      nextCursor: page < data.pagination.totalPages
        ? String(page + 1)
        : undefined,
    };
  }

  normalize(raw: unknown): SkillUpsert {
    const server = raw as SmitheryServer;
    const repoUrl = server.homepage;

    return {
      name: server.displayName || server.qualifiedName,
      slug: slugify(server.qualifiedName),
      description: server.description ?? '',
      executionLayer: server.remote ? 'mcp-remote' : 'container',
      runtimeEnv: server.remote ? 'api' : 'vm',
      repositoryUrl: repoUrl && isGitHubRepoUrl(repoUrl) ? repoUrl : undefined,
      capabilitiesRequired: server.remote ? [] : ['git'],
      source: 'smithery',
      sourceUrl: `https://smithery.ai/server/${server.qualifiedName}`,
      sourceHash: '', // Set by base class
      trustScore: server.verified ? 0.7 : 0.5,
    };
  }
}
