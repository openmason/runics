// ══════════════════════════════════════════════════════════════════════════════
// ClawHub Sync — Ingests OpenClaw community skills from curated GitHub dataset
// ══════════════════════════════════════════════════════════════════════════════
//
// Source: github.com/VoltAgent/awesome-openclaw-skills (5,200+ curated skills)
// Frequency: Every 10 minutes (cron, paginated by category)
// Auth: None required (public GitHub raw content)
//
// The ClawHub API (clawhub.ai/api/v1/skills) has been down since early 2026.
// This adapter fetches from the VoltAgent curated dataset instead, which
// contains 5,200+ skills filtered from the 13,700+ on ClawHub (spam, dupes,
// malicious, and low-quality entries removed).
//
// Each "page" processes one category markdown file. There are 30 categories.
// Entry format: `- [slug](https://clawskills.sh/skills/{author}-{slug}) - Description text`
//
// ══════════════════════════════════════════════════════════════════════════════

import { BaseSyncWorker } from './base-sync';
import { slugify } from './utils';
import type { SkillUpsert } from '../types';

// ──────────────────────────────────────────────────────────────────────────────
// Category list (30 categories in the VoltAgent dataset)
// ──────────────────────────────────────────────────────────────────────────────

const CATEGORIES = [
  'ai-and-llms',
  'apple-apps-and-services',
  'browser-and-automation',
  'calendar-and-scheduling',
  'clawdbot-tools',
  'cli-utilities',
  'coding-agents-and-ides',
  'communication',
  'data-and-analytics',
  'devops-and-cloud',
  'gaming',
  'git-and-github',
  'health-and-fitness',
  'image-and-video-generation',
  'ios-and-macos-development',
  'marketing-and-sales',
  'media-and-streaming',
  'moltbook',
  'notes-and-pkm',
  'pdf-and-documents',
  'personal-development',
  'productivity-and-tasks',
  'search-and-research',
  'security-and-passwords',
  'self-hosted-and-automation',
  'shopping-and-e-commerce',
  'smart-home-and-iot',
  'speech-and-transcription',
  'transportation',
  'web-and-frontend-development',
];

const BASE_URL =
  'https://raw.githubusercontent.com/VoltAgent/awesome-openclaw-skills/main/categories';

// ──────────────────────────────────────────────────────────────────────────────
// Entry parsing
// ──────────────────────────────────────────────────────────────────────────────

interface ParsedEntry {
  slug: string;
  authorSlug: string;
  description: string;
  sourceUrl: string;
  category: string;
}

/**
 * Parse a markdown list line into a skill entry.
 * Format: `- [slug](https://clawskills.sh/skills/{author}-{slug}) - Description`
 */
function parseEntry(line: string, category: string): ParsedEntry | null {
  // Match: - [name](url) - description
  const match = line.match(
    /^-\s+\[([^\]]+)\]\(([^)]+)\)\s+-\s+(.+)$/
  );
  if (!match) return null;

  const [, name, url, description] = match;

  // Extract author-slug from URL path: /skills/{author}-{slug} or /skills/{authorSlug}
  let authorSlug = '';
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    // Path: skills/{author-slug}
    if (pathParts.length >= 2 && pathParts[0] === 'skills') {
      authorSlug = pathParts[1];
    }
  } catch {
    // Invalid URL — use name as slug
  }

  return {
    slug: name.trim(),
    authorSlug,
    description: description.trim(),
    sourceUrl: url.trim(),
    category,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Sync Adapter
// ──────────────────────────────────────────────────────────────────────────────

export class ClawHubSync extends BaseSyncWorker {
  protected get sourceName() {
    return 'clawhub';
  }

  async fetchBatch(cursor?: string): Promise<{ skills: unknown[]; nextCursor?: string }> {
    const categoryIndex = parseInt(cursor ?? '0', 10);

    if (categoryIndex >= CATEGORIES.length) {
      return { skills: [] };
    }

    const category = CATEGORIES[categoryIndex];
    const url = `${BASE_URL}/${category}.md`;

    const res = await fetch(url, {
      headers: { Accept: 'text/plain' },
    });

    if (!res.ok) {
      console.warn(`[SYNC:clawhub] Failed to fetch category ${category}: ${res.status}`);
      // Skip this category and move to next
      const nextIndex = categoryIndex + 1;
      return {
        skills: [],
        nextCursor: nextIndex < CATEGORIES.length ? String(nextIndex) : undefined,
      };
    }

    const text = await res.text();
    const lines = text.split('\n');
    const entries: ParsedEntry[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('- [')) continue;
      const entry = parseEntry(trimmed, category);
      if (entry) entries.push(entry);
    }

    console.log(`[SYNC:clawhub] Category ${category}: ${entries.length} entries`);

    const nextIndex = categoryIndex + 1;
    return {
      skills: entries,
      nextCursor: nextIndex < CATEGORIES.length ? String(nextIndex) : undefined,
    };
  }

  normalize(raw: unknown): SkillUpsert {
    const entry = raw as ParsedEntry;

    // Build a unique slug from author + skill name
    const uniqueSlug = entry.authorSlug
      ? slugify(entry.authorSlug)
      : slugify(entry.slug);

    return {
      name: entry.slug,
      slug: uniqueSlug,
      description: entry.description,
      executionLayer: 'instructions',
      runtimeEnv: 'llm',
      capabilitiesRequired: [],
      source: 'clawhub',
      sourceUrl: entry.sourceUrl,
      sourceHash: '', // Set by base class
      trustScore: 0.6,
    };
  }
}
