// ══════════════════════════════════════════════════════════════════════════════
// ClawHub Sync — Polls ClawHub for OpenClaw community skills
// ══════════════════════════════════════════════════════════════════════════════
//
// Source: https://clawhub.ai/api/v1/skills
// Frequency: Every 10 minutes (cron)
// Auth: None required (public read)
// Rate Limits: 120 read/min anonymous
// Trust: 0.6 default, 0.3 for VirusTotal-flagged skills
//
// VirusTotal handling: ~341 of ~5000 skills are flagged by VirusTotal.
// These are still ingested (agents in adventurous mode can find them)
// but with reduced trust score. Cognium will do deeper scanning later.
//
// ══════════════════════════════════════════════════════════════════════════════

import { BaseSyncWorker } from './base-sync';
import { slugify } from './utils';
import type { SkillUpsert } from '../types';

// ──────────────────────────────────────────────────────────────────────────────
// API Response Types
// ──────────────────────────────────────────────────────────────────────────────

interface ClawHubResponse {
  items: ClawHubSkill[];
  nextCursor?: string;
}

interface ClawHubSkill {
  slug: string;
  displayName?: string;
  summary?: string;
  description?: string;
  version?: string;
  updatedAt?: string;
  virusTotalFlagged?: boolean;
  hasCode?: boolean;
  hasBins?: boolean;
  skillMd?: string;
  skillMdExcerpt?: string;
  capabilities?: string[];
  schema?: Record<string, unknown>;
  os?: string[];
}

// ──────────────────────────────────────────────────────────────────────────────
// Sync Adapter
// ──────────────────────────────────────────────────────────────────────────────

export class ClawHubSync extends BaseSyncWorker {
  protected get sourceName() {
    return 'clawhub';
  }

  async fetchBatch(cursor?: string): Promise<{ skills: unknown[]; nextCursor?: string }> {
    const url = new URL('https://clawhub.ai/api/v1/skills');
    url.searchParams.set('limit', '200');
    url.searchParams.set('sort', 'updated');
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`ClawHub API error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as ClawHubResponse;

    return {
      skills: data.items,
      nextCursor: data.nextCursor ?? undefined,
    };
  }

  normalize(raw: unknown): SkillUpsert {
    const skill = raw as ClawHubSkill;
    const hasVtFlags = skill.virusTotalFlagged === true;

    return {
      name: skill.displayName ?? skill.slug,
      slug: slugify(skill.slug),
      description: skill.summary ?? skill.description ?? skill.skillMdExcerpt ?? '',
      version: skill.version ?? '1.0.0',
      schemaJson: skill.schema,
      executionLayer: this.inferExecutionLayer(skill),
      skillMd: skill.skillMd,
      capabilitiesRequired: this.extractCapabilities(skill),
      source: 'clawhub',
      sourceUrl: `https://clawhub.ai/skills/${skill.slug}`,
      sourceHash: '', // Set by base class
      trustScore: hasVtFlags ? 0.3 : 0.6,
    };
  }

  private inferExecutionLayer(skill: ClawHubSkill): SkillUpsert['executionLayer'] {
    // If skill has only SKILL.md (no code), it's instructions-only
    if (skill.hasCode === false && (skill.skillMd || skill.skillMdExcerpt)) {
      return 'instructions';
    }
    // If it has binaries or browser capabilities, needs a container
    if (skill.hasBins || skill.capabilities?.includes('browser')) {
      return 'container';
    }
    // Default to worker (pure function)
    return 'worker';
  }

  private extractCapabilities(skill: ClawHubSkill): string[] {
    const caps: string[] = [];
    if (skill.hasBins) caps.push('native-binaries');
    if (skill.capabilities) caps.push(...skill.capabilities);
    return caps;
  }
}
