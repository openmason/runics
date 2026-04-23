// ══════════════════════════════════════════════════════════════════════════════
// PulseMCP Sync — Polls PulseMCP directory for MCP servers
// ══════════════════════════════════════════════════════════════════════════════
//
// Source: https://www.pulsemcp.com/api/servers
// Frequency: Every 15 minutes (cron, disabled by default)
// Auth: None, but Cloudflare bot protection blocks CLI/Workers fetch
// Trust: 0.65 (editorially curated)
//
// PulseMCP is the largest hand-reviewed MCP directory (~12K servers).
// Currently disabled (SYNC_PULSEMCP_ENABLED = "false") because their API
// is behind Cloudflare challenge pages that block non-browser requests.
// Enable once access is resolved (API key, allowlisting, etc.).
//
// ══════════════════════════════════════════════════════════════════════════════

import { BaseSyncWorker } from './base-sync';
import { slugify, isGitHubRepoUrl } from './utils';
import type { SkillUpsert } from '../types';

// ──────────────────────────────────────────────────────────────────────────────
// API Response Types (based on expected shape — unverified)
// ──────────────────────────────────────────────────────────────────────────────

interface PulseMCPResponse {
  servers: PulseMCPServer[];
  pagination?: {
    page: number;
    totalPages: number;
    totalCount: number;
  };
}

interface PulseMCPServer {
  id: string;
  name: string;
  slug: string;
  description: string;
  url?: string;
  github_url?: string;
  category?: string;
  is_top_pick?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Sync Adapter
// ──────────────────────────────────────────────────────────────────────────────

export class PulseMCPSync extends BaseSyncWorker {
  protected get sourceName() {
    return 'pulsemcp';
  }

  async fetchBatch(cursor?: string): Promise<{ skills: unknown[]; nextCursor?: string }> {
    const page = parseInt(cursor ?? '1', 10);
    const url = new URL('https://www.pulsemcp.com/api/servers');
    url.searchParams.set('page', String(page));
    url.searchParams.set('limit', '100');

    const res = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Runics-Search/1.0',
      },
    });

    if (!res.ok) {
      // Cloudflare challenge returns HTML with 403
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('text/html')) {
        console.warn(`[SYNC:pulsemcp] Cloudflare challenge detected (${res.status}), aborting`);
        return { skills: [] };
      }
      throw new Error(`PulseMCP API error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as PulseMCPResponse;

    return {
      skills: data.servers ?? [],
      nextCursor: data.pagination && page < data.pagination.totalPages
        ? String(page + 1)
        : undefined,
    };
  }

  normalize(raw: unknown): SkillUpsert {
    const server = raw as PulseMCPServer;

    return {
      name: server.name,
      slug: slugify(server.slug ?? server.name),
      description: server.description ?? '',
      executionLayer: 'mcp-remote',
      runtimeEnv: 'api',
      repositoryUrl: server.github_url && isGitHubRepoUrl(server.github_url)
        ? server.github_url
        : undefined,
      capabilitiesRequired: [],
      source: 'pulsemcp',
      sourceUrl: server.url ?? `https://www.pulsemcp.com/servers/${server.slug}`,
      sourceHash: '', // Set by base class
      trustScore: 0.65,
    };
  }
}
