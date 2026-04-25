// ══════════════════════════════════════════════════════════════════════════════
// PulseMCP Sync — Polls PulseMCP directory for MCP servers
// ══════════════════════════════════════════════════════════════════════════════
//
// Source: https://api.pulsemcp.com/v0beta/servers
// Frequency: Every 15 minutes (cron)
// Auth: None
// Trust: 0.65 (editorially curated, ~13K servers)
//
// ══════════════════════════════════════════════════════════════════════════════

import { BaseSyncWorker } from './base-sync';
import { slugify, isGitHubRepoUrl } from './utils';
import type { SkillUpsert } from '../types';

// ──────────────────────────────────────────────────────────────────────────────
// API Response Types (v0beta — verified April 2026)
// ──────────────────────────────────────────────────────────────────────────────

interface PulseMCPResponse {
  servers: PulseMCPServer[];
  total_count: number;
  next?: string; // Full URL for next page, or absent at end
}

interface PulseMCPServer {
  name: string;
  url: string; // PulseMCP page URL (e.g. https://www.pulsemcp.com/servers/foo)
  external_url?: string;
  short_description?: string;
  source_code_url?: string;
  github_stars?: number;
  package_registry?: string;
  package_name?: string;
  package_download_count?: number;
  EXPERIMENTAL_ai_generated_description?: string;
  remotes?: Array<{ url: string; transport: string }>;
}

const PAGE_SIZE = 100;
const BASE_URL = 'https://api.pulsemcp.com/v0beta/servers';

// ──────────────────────────────────────────────────────────────────────────────
// Sync Adapter
// ──────────────────────────────────────────────────────────────────────────────

export class PulseMCPSync extends BaseSyncWorker {
  protected get sourceName() {
    return 'pulsemcp';
  }

  async fetchBatch(cursor?: string): Promise<{ skills: unknown[]; nextCursor?: string }> {
    const offset = parseInt(cursor ?? '0', 10);
    const url = new URL(BASE_URL);
    url.searchParams.set('count_per_page', String(PAGE_SIZE));
    url.searchParams.set('offset', String(offset));

    const res = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Runics-Search/1.0',
      },
    });

    if (!res.ok) {
      throw new Error(`PulseMCP API error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as PulseMCPResponse;

    return {
      skills: data.servers ?? [],
      nextCursor: data.next ? String(offset + PAGE_SIZE) : undefined,
    };
  }

  normalize(raw: unknown): SkillUpsert {
    const server = raw as PulseMCPServer;
    // Extract slug from the PulseMCP page URL (last path segment)
    const urlSlug = server.url?.split('/').pop() ?? '';

    // Prefer the AI-generated description (more detailed), fall back to short_description
    const description = server.EXPERIMENTAL_ai_generated_description
      ?? server.short_description ?? '';

    return {
      name: server.name,
      slug: slugify(urlSlug || server.name),
      description,
      executionLayer: 'mcp-remote',
      runtimeEnv: 'api',
      repositoryUrl: server.source_code_url && isGitHubRepoUrl(server.source_code_url)
        ? server.source_code_url
        : undefined,
      capabilitiesRequired: [],
      source: 'pulsemcp',
      sourceUrl: server.url ?? `https://www.pulsemcp.com/servers/${urlSlug}`,
      sourceHash: '', // Set by base class
      trustScore: 0.65,
    };
  }
}
