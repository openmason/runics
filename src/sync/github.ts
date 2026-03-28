// ══════════════════════════════════════════════════════════════════════════════
// GitHub Sync — Polls GitHub for repositories tagged as MCP/agent skills
// ══════════════════════════════════════════════════════════════════════════════
//
// Source: GitHub Search API (topics: mcp-skill, agent-skill)
// Frequency: Every 15 minutes (cron)
// Auth: GITHUB_TOKEN required for 5000 req/hr (unauthenticated: 10 req/min)
// Trust: 0.5 default (unscanned GitHub repos)
//
// Note: GitHub Search API returns max 1000 results. Sorting by 'updated'
// ensures we always see the most recently changed repos first.
//
// ══════════════════════════════════════════════════════════════════════════════

import { BaseSyncWorker } from './base-sync';
import { slugify } from './utils';
import type { SkillUpsert } from '../types';

// ──────────────────────────────────────────────────────────────────────────────
// API Response Types
// ──────────────────────────────────────────────────────────────────────────────

interface GitHubSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GitHubRepo[];
}

interface GitHubRepo {
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  topics: string[];
  language: string | null;
  stargazers_count: number;
  updated_at: string;
  license?: {
    spdx_id: string;
  } | null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Sync Adapter
// ──────────────────────────────────────────────────────────────────────────────

export class GitHubSync extends BaseSyncWorker {
  protected get sourceName() {
    return 'github';
  }

  async fetchBatch(cursor?: string): Promise<{ skills: unknown[]; nextCursor?: string }> {
    if (!this.env.GITHUB_TOKEN) {
      console.warn('[SYNC:github] GITHUB_TOKEN not set, skipping sync');
      return { skills: [] };
    }

    const query = 'topic:mcp-server';
    const url = new URL('https://api.github.com/search/repositories');
    url.searchParams.set('q', query);
    url.searchParams.set('sort', 'updated');
    url.searchParams.set('per_page', '100');
    const page = cursor ?? '1';
    url.searchParams.set('page', page);

    const res = await fetch(url.toString(), {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
        'User-Agent': 'Runics-Search/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    // Respect rate limits
    if (res.status === 403 || res.status === 429) {
      const retryAfter = res.headers.get('Retry-After');
      console.warn(
        `[SYNC:github] Rate limited (${res.status}), retry after: ${retryAfter ?? 'unknown'}`
      );
      return { skills: [] };
    }

    if (!res.ok) {
      throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as GitHubSearchResponse;
    const pageNum = parseInt(page);

    return {
      skills: data.items,
      // GitHub search API caps at 1000 results (10 pages of 100)
      nextCursor:
        data.items.length === 100 && pageNum < 10 ? String(pageNum + 1) : undefined,
    };
  }

  normalize(raw: unknown): SkillUpsert {
    const repo = raw as GitHubRepo;

    return {
      name: repo.name,
      slug: slugify(repo.full_name.replace('/', '-')),
      description: repo.description ?? '',
      executionLayer: 'container', // GitHub repos generally need clone + run
      runtimeEnv: 'vm', // v5.2: GitHub repos run in sandbox
      capabilitiesRequired: ['git'],
      source: 'github',
      sourceUrl: repo.html_url,
      sourceHash: '', // Set by base class
      trustScore: 0.5,
    };
  }
}
