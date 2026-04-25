// ══════════════════════════════════════════════════════════════════════════════
// Embed Queue Consumer — Processes embedding generation for synced/published skills
// ══════════════════════════════════════════════════════════════════════════════
//
// Triggered by EMBED_QUEUE messages from sync workers and publish API.
// For each skill: fetch from DB → content safety check → generate embeddings → index.
// Reuses existing EmbedPipeline + PgVectorProvider infrastructure.
//
// ══════════════════════════════════════════════════════════════════════════════

import { createPool } from '../db/connection';
import type { Pool } from '../db/connection';
import { PgVectorProvider } from '../providers/pgvector-provider';
import { EmbedPipeline } from '../ingestion/embed-pipeline';
import type { Env, EmbedQueueMessage, SkillInput } from '../types';

export async function handleEmbedQueue(
  batch: MessageBatch<EmbedQueueMessage>,
  env: Env
): Promise<void> {
  const pool = createPool(env);
  const embedPipeline = new EmbedPipeline(env);
  const provider = new PgVectorProvider(env);
  const useMultiVector = env.MULTI_VECTOR_ENABLED === 'true';

  for (const message of batch.messages) {
    const { skillId, source } = message.body;

    try {
      // 1. Fetch skill from DB
      const result = await pool.query(
        `SELECT id, name, slug, version, source, description, agent_summary,
                tags, category, schema_json, trust_score, capabilities_required,
                execution_layer, tenant_id
         FROM skills WHERE id = $1`,
        [skillId]
      );

      const row = result.rows[0];
      if (!row) {
        console.warn(`[EMBED-QUEUE] Skill ${skillId} not found, acking`);
        message.ack();
        continue;
      }

      // 2. Build SkillInput from DB row
      const skill: SkillInput = {
        id: row.id,
        name: row.name,
        slug: row.slug,
        version: row.version,
        source: row.source,
        description: row.description ?? '',
        agentSummary: row.agent_summary,
        tags: row.tags ?? [],
        category: row.category,
        schemaJson: row.schema_json,
        trustScore: parseFloat(row.trust_score ?? '0.5'),
        capabilitiesRequired: row.capabilities_required ?? [],
        executionLayer: row.execution_layer,
        tenantId: row.tenant_id ?? 'default',
      };

      // 3. Content safety check
      const safetyResult = await embedPipeline.checkContentSafety(skill);
      if ('error' in safetyResult) {
        // Transient error (Workers AI timeout/rate limit) — retry, don't mark unsafe
        console.warn(`[EMBED-QUEUE] Skill ${skillId} safety check errored, will retry`);
        message.retry();
        continue;
      }
      if (!safetyResult.safe) {
        console.warn(`[EMBED-QUEUE] Skill ${skillId} failed content safety, revoking`);
        await pool.query(
          `UPDATE skills SET content_safety_passed = false, status = 'revoked', updated_at = NOW() WHERE id = $1`,
          [skillId]
        );
        message.ack();
        continue;
      }

      // 4. Generate embeddings (single or multi-vector)
      const embeddings = useMultiVector
        ? await embedPipeline.processSkillMultiVector(skill)
        : await embedPipeline.processSkill(skill);

      // Update skill with generated agent summary so index() persists it
      skill.agentSummary = embeddings.agentSummary.text;

      // 5. Index skill + embeddings (transactional upsert)
      await provider.index(skill, embeddings);

      console.log(
        `[EMBED-QUEUE] Indexed skill ${skillId} (${skill.name}) from ${source ?? 'unknown'}, ` +
          `alternates: ${embeddings.alternates?.length ?? 0}`
      );

      message.ack();
    } catch (error) {
      console.error(`[EMBED-QUEUE] Error processing skill ${skillId}:`, error);
      // Retry on failure — Cloudflare Queues will re-deliver
      message.retry();
    }
  }
}
