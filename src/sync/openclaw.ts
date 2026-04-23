// ════════════���════════════════════════���═════════════════════════════════��══════
// OpenClaw Sync — Ingests skills directly from openclaw/skills GitHub repo
// ═══════════════════���════════════════════════════════��═════════════════════════
//
// Source: github.com/openclaw/skills (~19K+ skills with structured metadata)
// Frequency: Every 10 minutes (cron, paginated by offset cursor)
// Auth: None required (public GitHub raw content)
//
// Each skill has:
//   skills/{owner}/{slug}/_meta.json  — metadata (displayName, version, history)
//   skills/{owner}/{slug}/SKILL.md    — frontmatter description + documentation
//
// The adapter fetches the repo tree once per run() to get the full path list,
// then pages through skills in batches, fetching _meta.json for each.
//
// ══════════════════════════════════════════════════════════════════════════════

import { BaseSyncWorker } from './base-sync';
import { slugify } from './utils';
import type { SkillUpsert } from '../types';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────��────────────────────────

interface OpenClawMeta {
  owner: string;
  slug: string;
  displayName: string;
  latest: {
    version: string;
    publishedAt: number;
    commit: string;
  };
  history?: Array<{
    version: string;
    publishedAt: number;
    commit: string;
  }>;
}

interface SkillMdFrontmatter {
  name?: string;
  description?: string;
  homepage?: string;
}

interface FetchedSkill {
  owner: string;
  slug: string;
  meta: OpenClawMeta;
  description: string;
  repositoryUrl?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────���─────────────────────────

const TREE_URL = 'https://api.github.com/repos/openclaw/skills/git/trees/main?recursive=1';
const RAW_BASE = 'https://raw.githubusercontent.com/openclaw/skills/main';
const PAGE_SIZE = 50;
const CONCURRENT_FETCHES = 10;

// Spam patterns in displayName (case-insensitive)
const SPAM_PATTERNS = /\b(casino|gambling|porn|xxx|crypto.?trading|forex.?signal|onlyfans|betting)\b/i;

// ───────────────────────────────────────���──────────────────────────────────────
// Helpers
// ──────────────────────���─────────────────────────────���─────────────────────────

/** Parse YAML-like frontmatter from SKILL.md (simple key: value extraction) */
function parseFrontmatter(md: string): SkillMdFrontmatter {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const fm: SkillMdFrontmatter = {};
  const block = match[1];

  // Extract simple single-line values
  const nameMatch = block.match(/^name:\s*(.+)$/m);
  if (nameMatch) fm.name = nameMatch[1].trim();

  const homepageMatch = block.match(/^homepage:\s*(.+)$/m);
  if (homepageMatch) fm.homepage = homepageMatch[1].trim();

  // Description can be multiline (YAML block scalar)
  const descMatch = block.match(/^description:\s*[|>]?\s*\n?([\s\S]*?)(?=\n\w|\n---)/m);
  if (descMatch) {
    fm.description = descMatch[1].replace(/\n\s*/g, ' ').trim();
  } else {
    const simpleDesc = block.match(/^description:\s*(.+)$/m);
    if (simpleDesc) fm.description = simpleDesc[1].trim().replace(/^["']|["']$/g, '');
  }

  return fm;
}

/** Fetch with concurrency limiter */
async function fetchConcurrent<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<unknown>
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// ──────────────────────────────��──────────────────────────────���────────────────
// Sync Adapter
// ────────────────────────────────────────────────���─────────────────────────────

export class OpenClawSync extends BaseSyncWorker {
  private skillPaths: Array<{ owner: string; slug: string }> | null = null;

  protected get sourceName() {
    return 'openclaw';
  }

  /** Parse the repo tree to extract all skill paths (owner/slug pairs) */
  private async loadSkillPaths(): Promise<Array<{ owner: string; slug: string }>> {
    if (this.skillPaths) return this.skillPaths;

    const res = await fetch(TREE_URL, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'runics-sync/1.0',
      },
    });

    if (!res.ok) {
      throw new Error(`GitHub tree API returned ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as { tree: Array<{ path: string; type: string }> };

    // Extract unique owner/slug pairs from _meta.json paths
    const pathSet = new Map<string, { owner: string; slug: string }>();
    for (const entry of data.tree) {
      const match = entry.path.match(/^skills\/([^/]+)\/([^/]+)\/_meta\.json$/);
      if (match) {
        const key = `${match[1]}/${match[2]}`;
        pathSet.set(key, { owner: match[1], slug: match[2] });
      }
    }

    // Sort for deterministic pagination
    this.skillPaths = [...pathSet.values()].sort((a, b) =>
      `${a.owner}/${a.slug}`.localeCompare(`${b.owner}/${b.slug}`)
    );

    console.log(`[SYNC:openclaw] Loaded ${this.skillPaths.length} skill paths from tree`);
    return this.skillPaths;
  }

  async fetchBatch(cursor?: string): Promise<{ skills: unknown[]; nextCursor?: string }> {
    const offset = parseInt(cursor ?? '0', 10);
    const paths = await this.loadSkillPaths();

    if (offset >= paths.length) {
      return { skills: [] };
    }

    const batch = paths.slice(offset, offset + PAGE_SIZE);
    const skills: FetchedSkill[] = [];

    // Fetch _meta.json + SKILL.md for each skill (concurrent)
    await fetchConcurrent(batch, CONCURRENT_FETCHES, async (entry) => {
      try {
        // Fetch _meta.json
        const metaUrl = `${RAW_BASE}/skills/${entry.owner}/${entry.slug}/_meta.json`;
        const metaRes = await fetch(metaUrl);
        if (!metaRes.ok) return;

        const meta = (await metaRes.json()) as OpenClawMeta;

        // Skip spam
        if (SPAM_PATTERNS.test(meta.displayName ?? '')) return;

        // Fetch SKILL.md for description
        let description = '';
        let repositoryUrl: string | undefined;

        const mdUrl = `${RAW_BASE}/skills/${entry.owner}/${entry.slug}/SKILL.md`;
        const mdRes = await fetch(mdUrl);
        if (mdRes.ok) {
          const mdText = await mdRes.text();
          const fm = parseFrontmatter(mdText);
          description = fm.description ?? '';
          if (fm.homepage && fm.homepage.includes('github.com')) {
            repositoryUrl = fm.homepage;
          }
        }

        // Fallback: use displayName as description if SKILL.md had none
        if (!description) {
          description = meta.displayName ?? '';
        }

        // Skip if still no meaningful description
        if (!description || description.length < 5) return;

        skills.push({
          owner: entry.owner,
          slug: entry.slug,
          meta,
          description,
          repositoryUrl,
        });
      } catch (e: any) {
        console.warn(`[SYNC:openclaw] Error fetching ${entry.owner}/${entry.slug}: ${e.message}`);
      }
    });

    const nextOffset = offset + PAGE_SIZE;
    const nextCursor = nextOffset < paths.length ? String(nextOffset) : undefined;

    console.log(`[SYNC:openclaw] Batch offset=${offset}: fetched ${skills.length}/${batch.length} skills`);

    return { skills, nextCursor };
  }

  normalize(raw: unknown): SkillUpsert {
    const skill = raw as FetchedSkill;

    return {
      name: skill.meta.displayName || skill.slug,
      slug: slugify(`${skill.owner}-${skill.slug}`),
      description: skill.description,
      version: skill.meta.latest?.version ?? '1.0.0',
      executionLayer: 'instructions',
      runtimeEnv: 'llm',
      capabilitiesRequired: [],
      source: 'openclaw',
      sourceUrl: `https://github.com/openclaw/skills/tree/main/skills/${skill.owner}/${skill.slug}`,
      sourceHash: '', // Set by base class
      trustScore: 0.55,
      repositoryUrl: skill.repositoryUrl,
    };
  }
}
