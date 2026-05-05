// ══════════════════════════════════════════════════════════════════════════════
// Cognium Client — Analysis Submit Consumer
// ══════════════════════════════════════════════════════════════════════════════
//
// Queue handler for ANALYSIS_QUEUE. Fetches skill metadata from DB,
// submits to Circle-IR analysis endpoints (quality, trust, understand,
// spec-diff) with throttling, stores per-endpoint job state in KV,
// and enqueues poll messages.
//
// Throttling: 2s delay between endpoint submissions + max_batch_size=2
// on the queue consumer = max ~4 concurrent Circle-IR requests.
//
// ══════════════════════════════════════════════════════════════════════════════

import { createPool } from '../db/connection';
import type { Pool } from '../db/connection';
import type { Env } from '../types';
import type { AnalysisSubmitMessage, AnalysisEndpoint, SkillRow } from './types';
import { buildAnalysisRequests } from './analysis-request-builder';

const ALL_ENDPOINTS: AnalysisEndpoint[] = ['quality', 'trust', 'understand', 'specDiff'];

const ENDPOINT_PATHS: Record<AnalysisEndpoint, string> = {
  quality: '/api/quality',
  trust: '/api/trust',
  understand: '/api/understand',
  specDiff: '/api/spec-diff',
};

export async function handleAnalysisSubmitQueue(
  batch: MessageBatch<AnalysisSubmitMessage>,
  env: Env,
): Promise<void> {
  if (env.ANALYSIS_ENABLED === 'false') {
    for (const msg of batch.messages) msg.ack();
    console.log(`[ANALYSIS-SUBMIT] Disabled (ANALYSIS_ENABLED=false), acked ${batch.messages.length} messages`);
    return;
  }

  const pool = createPool(env);
  const cogniumUrl = env.COGNIUM_URL ?? 'https://circle.cognium.net';
  const initialDelay = parseInt(env.COGNIUM_POLL_DELAY_MS ?? '15000', 10);

  for (const msg of batch.messages) {
    try {
      const { skillId, endpoints: requestedEndpoints } = msg.body;
      const endpoints = requestedEndpoints ?? ALL_ENDPOINTS;

      const skill = await fetchSkillById(pool, skillId);
      if (!skill) {
        console.log(`[ANALYSIS-SUBMIT] Skill ${skillId} not found, skipping`);
        msg.ack();
        continue;
      }

      const requests = buildAnalysisRequests(skill);
      let submitted = 0;

      for (let i = 0; i < endpoints.length; i++) {
        const endpoint = endpoints[i];
        const path = ENDPOINT_PATHS[endpoint];
        const body = endpoint === 'quality' ? requests.quality
          : endpoint === 'trust' ? requests.trust
          : endpoint === 'understand' ? requests.understand
          : requests.specDiff;

        try {
          const res = await fetch(`${cogniumUrl}${path}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          });

          if (!res.ok) {
            if (res.status >= 500 || res.status === 429) {
              // Transient — re-enqueue just this endpoint with a delay
              console.warn(`[ANALYSIS-SUBMIT] ${path} returned ${res.status} for ${skill.slug}, re-queuing`);
              await env.ANALYSIS_QUEUE.send(
                { skillId, endpoints: [endpoint], priority: 'normal', timestamp: Date.now() } as AnalysisSubmitMessage,
                { delaySeconds: 60 },
              );
            } else {
              console.error(`[ANALYSIS-SUBMIT] ${path} rejected ${skill.slug}: ${res.status} (skipping)`);
            }
            continue;
          }

          const { job_id } = await res.json() as { job_id: string };

          // Store per-endpoint job state in KV (2h TTL)
          await env.COGNIUM_JOBS.put(
            `analysis:job:${skillId}:${endpoint}`,
            JSON.stringify({ jobId: job_id, skillId, endpoint, apiPath: path, submittedAt: Date.now() }),
            { expirationTtl: 7200 },
          );

          // Enqueue poll message
          await env.ANALYSIS_POLL_QUEUE.send(
            { skillId, endpoint, jobId: job_id, apiPath: path, attempt: 1 },
            { delaySeconds: Math.floor(initialDelay / 1000) },
          );

          submitted++;
          console.log(`[ANALYSIS-SUBMIT] ${endpoint} job ${job_id} submitted for ${skill.slug}`);
        } catch (endpointErr) {
          console.error(`[ANALYSIS-SUBMIT] ${endpoint} error for ${skill.slug}: ${(endpointErr as Error).message}`);
          // Re-enqueue this endpoint for retry
          await env.ANALYSIS_QUEUE.send(
            { skillId, endpoints: [endpoint], priority: 'normal', timestamp: Date.now() } as AnalysisSubmitMessage,
            { delaySeconds: 60 },
          );
        }

        // Throttle: 2s delay between endpoint submissions
        if (i < endpoints.length - 1) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      console.log(`[ANALYSIS-SUBMIT] ${submitted}/${endpoints.length} endpoints submitted for ${skill.slug}`);
      msg.ack();
    } catch (err) {
      console.error(`[ANALYSIS-SUBMIT] Error for ${msg.body.skillId}: ${(err as Error).message}`);
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
