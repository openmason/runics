// ══════════════════════════════════════════════════════════════════════════════
// BaseSyncWorker — Abstract base for upstream sync pipelines
// ══════════════════════════════════════════════════════════════════════════════
//
// Shared infrastructure for all sync adapters:
// - Cursor-based pagination loop
// - Change detection via source_hash (SHA-256 of raw upstream data)
// - Upsert with ON CONFLICT (source, source_url)
// - Queue dispatch to EMBED_QUEUE + COGNIUM_QUEUE
// - Per-skill error isolation (one failure doesn't abort the batch)
//
// ══════════════════════════════════════════════════════════════════════════════

import { Pool } from '@neondatabase/serverless';
import type { Env, SyncResult, SkillUpsert, EmbedQueueMessage, CogniumSubmitMessage } from '../types';
import { sha256 } from './utils';

export abstract class BaseSyncWorker {
  protected pool: Pool;

  constructor(protected env: Env) {
    this.pool = new Pool({ connectionString: env.NEON_CONNECTION_STRING });
  }

  /**
   * Fetch a page of skills from the upstream source.
   * Return skills and an optional cursor for the next page.
   */
  abstract fetchBatch(cursor?: string): Promise<{ skills: unknown[]; nextCursor?: string }>;

  /**
   * Normalize a raw upstream skill into the unified SkillUpsert shape.
   */
  abstract normalize(raw: unknown): SkillUpsert;

  /**
   * Human-readable source name for logging.
   */
  protected abstract get sourceName(): string;

  /**
   * Run the full sync: paginate → normalize → change-detect → upsert → enqueue.
   */
  async run(): Promise<SyncResult> {
    const startTime = Date.now();
    let cursor: string | undefined;
    let synced = 0;
    let skipped = 0;
    let errors = 0;

    try {
      do {
        const batch = await this.fetchBatch(cursor);

        for (const raw of batch.skills) {
          try {
            const skill = this.normalize(raw);
            const hash = await sha256(JSON.stringify(raw));

            // Change detection: skip if source_hash unchanged
            const existing = await this.findBySourceUrl(skill.source, skill.sourceUrl);
            if (existing?.source_hash === hash) {
              skipped++;
              continue;
            }

            skill.sourceHash = hash;

            // Upsert skill row
            const skillId = await this.upsertSkill(skill);

            // Enqueue for embedding generation (async)
            await this.env.EMBED_QUEUE.send({
              skillId,
              action: 'embed',
              source: this.sourceName,
            } satisfies EmbedQueueMessage);

            // Enqueue for Cognium trust scanning (async, v5.0 format)
            await this.env.COGNIUM_QUEUE.send({
              skillId,
              priority: 'normal',
              timestamp: Date.now(),
            } satisfies CogniumSubmitMessage);

            synced++;
          } catch (error) {
            console.error(`[SYNC:${this.sourceName}] Error processing skill:`, error);
            errors++;
          }
        }

        cursor = batch.nextCursor;
      } while (cursor);
    } catch (error) {
      console.error(`[SYNC:${this.sourceName}] Fatal error in sync run:`, error);
    }

    const result: SyncResult = {
      source: this.sourceName,
      synced,
      skipped,
      errors,
      durationMs: Date.now() - startTime,
    };

    console.log(
      `[SYNC:${this.sourceName}] Complete: ` +
        `synced=${synced} skipped=${skipped} errors=${errors} ` +
        `duration=${result.durationMs}ms`
    );

    return result;
  }

  /**
   * Look up an existing skill by source identity for change detection.
   */
  private async findBySourceUrl(
    source: string,
    sourceUrl: string
  ): Promise<{ id: string; source_hash: string } | null> {
    const result = await this.pool.query(
      'SELECT id, source_hash FROM skills WHERE source = $1 AND source_url = $2 LIMIT 1',
      [source, sourceUrl]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Upsert a skill row. Returns the skill ID (existing or newly generated).
   */
  private async upsertSkill(skill: SkillUpsert): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO skills (
        name, slug, version, source, description, schema_json,
        execution_layer, mcp_url, skill_md, capabilities_required,
        source_url, source_hash, trust_score, tenant_id, content_safety_passed, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,NOW())
      ON CONFLICT (source, source_url) WHERE source_url IS NOT NULL
      DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        schema_json = EXCLUDED.schema_json,
        execution_layer = EXCLUDED.execution_layer,
        mcp_url = EXCLUDED.mcp_url,
        skill_md = EXCLUDED.skill_md,
        capabilities_required = EXCLUDED.capabilities_required,
        source_hash = EXCLUDED.source_hash,
        content_safety_passed = EXCLUDED.content_safety_passed,
        updated_at = NOW()
      RETURNING id`,
      [
        skill.name,
        skill.slug,
        skill.version ?? '1.0.0',
        skill.source,
        skill.description,
        skill.schemaJson ? JSON.stringify(skill.schemaJson) : null,
        skill.executionLayer,
        skill.mcpUrl ?? null,
        skill.skillMd ?? null,
        skill.capabilitiesRequired ?? [],
        skill.sourceUrl,
        skill.sourceHash,
        skill.trustScore ?? 0.5,
        skill.tenantId ?? null,
      ]
    );
    return result.rows[0].id;
  }
}
