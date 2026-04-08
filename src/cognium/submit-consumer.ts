// ══════════════════════════════════════════════════════════════════════════════
// Cognium Client — Submit Consumer
// ══════════════════════════════════════════════════════════════════════════════
//
// Queue handler for COGNIUM_QUEUE. Fetches skill metadata from DB,
// submits to Circle-IR POST /api/analyze/skill, stores job state in KV,
// and enqueues first poll message.
//
// ══════════════════════════════════════════════════════════════════════════════

import { Pool } from '@neondatabase/serverless';
import type { Env } from '../types';
import type { CogniumSubmitMessage, SkillRow } from './types';
import { buildCircleIRRequest } from './request-builder';

export async function handleCogniumSubmitQueue(
  batch: MessageBatch<CogniumSubmitMessage>,
  env: Env,
): Promise<void> {
  // Hard kill switch — when COGNIUM_ENABLED=false, ack all messages and exit
  // without contacting Circle-IR. Acking (not retrying) prevents the queue from
  // backing up while scanning is paused.
  if (env.COGNIUM_ENABLED === 'false') {
    for (const msg of batch.messages) msg.ack();
    console.log(`[COGNIUM-SUBMIT] Disabled (COGNIUM_ENABLED=false), acked ${batch.messages.length} messages`);
    return;
  }
  const pool = new Pool({ connectionString: env.NEON_CONNECTION_STRING });

  for (const msg of batch.messages) {
    try {
      const skill = await fetchSkillById(pool, msg.body.skillId);
      if (!skill) {
        console.log(`[COGNIUM-SUBMIT] Skill ${msg.body.skillId} not found, skipping`);
        msg.ack();
        continue;
      }

      // Deduplication: skip if a job is already in flight for this skill
      const existingJob = await pool.query(
        `SELECT cognium_job_id FROM skills WHERE id = $1 AND cognium_job_id IS NOT NULL`,
        [msg.body.skillId]
      );
      if (existingJob.rows.length > 0) {
        console.log(`[COGNIUM-SUBMIT] Skill ${msg.body.skillId} already has job ${existingJob.rows[0].cognium_job_id}, skipping`);
        msg.ack();
        continue;
      }

      // buildCircleIRRequest now includes bundle_url for clawhub skills —
      // Circle-IR downloads + extracts the zip bundle directly
      const cogniumUrl = env.COGNIUM_URL ?? 'https://circle.cognium.net';
      const response = await fetch(`${cogniumUrl}/api/analyze/skill`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.COGNIUM_API_KEY ?? ''}`,
        },
        body: JSON.stringify(buildCircleIRRequest(skill)),
      });

      if (!response.ok) {
        if (response.status >= 500 || response.status === 429) {
          msg.retry();
          continue;
        }
        console.error(`[COGNIUM-SUBMIT] Circle-IR rejected ${skill.id}: ${response.status}`);
        msg.ack();
        continue;
      }

      const { job_id } = await response.json() as { job_id: string };

      // Persist job state in KV (1h TTL — safety net)
      await env.COGNIUM_JOBS.put(
        `cognium:job:${skill.id}`,
        JSON.stringify({ jobId: job_id, skillId: skill.id, submittedAt: Date.now() }),
        { expirationTtl: 3600 },
      );

      // Enqueue first poll with initial delay
      const initialDelay = parseInt(env.COGNIUM_POLL_DELAY_MS ?? '15000', 10);
      await env.COGNIUM_POLL_QUEUE.send(
        { skillId: skill.id, jobId: job_id, attempt: 1 },
        { delaySeconds: Math.floor(initialDelay / 1000) },
      );

      console.log(`[COGNIUM-SUBMIT] Job ${job_id} submitted for skill ${skill.slug}`);
      msg.ack();
    } catch (err) {
      console.error(`[COGNIUM-SUBMIT] Error for ${msg.body.skillId}: ${(err as Error).message}`);
      msg.retry();
    }
  }
}

async function fetchSkillById(pool: Pool, skillId: string): Promise<SkillRow | null> {
  const result = await pool.query(
    `SELECT id, slug, version, name, description, source, status,
            execution_layer AS "executionLayer",
            skill_md AS "skillMd",
            r2_bundle_key AS "r2BundleKey",
            source_url AS "sourceUrl",
            repository_url AS "repositoryUrl",
            root_source AS "rootSource",
            skill_type AS "skillType",
            composition_skill_ids AS "compositionSkillIds",
            schema_json AS "schemaJson",
            capabilities_required AS "capabilitiesRequired",
            agent_summary AS "agentSummary",
            changelog::text AS "changelog"
     FROM skills WHERE id = $1`,
    [skillId]
  );
  return result.rows[0] ?? null;
}
