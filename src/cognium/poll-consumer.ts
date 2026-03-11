// ══════════════════════════════════════════════════════════════════════════════
// Cognium Client — Poll Consumer
// ══════════════════════════════════════════════════════════════════════════════
//
// Queue handler for COGNIUM_POLL_QUEUE. Polls Circle-IR job status with
// exponential backoff. On completion, fetches findings, normalizes, and
// delegates to scan-report-handler for scoring + DB update + cascade.
//
// Backoff schedule (12 attempts, ~30 min total):
//   15s → 30s → 60s → 120s ×5 → 300s ×4
//
// ══════════════════════════════════════════════════════════════════════════════

import { Pool } from '@neondatabase/serverless';
import type { Env } from '../types';
import type { CogniumPollMessage, CircleIRJobStatus, CircleIRFinding, CircleIRSkillResult, SkillRow } from './types';
import { normalizeFindings } from './finding-mapper';
import { applyScanReport, markScanFailed } from './scan-report-handler';

const POLL_DELAYS_MS = [
  15_000, 30_000, 60_000,
  120_000, 120_000, 120_000, 120_000, 120_000,
  300_000, 300_000, 300_000, 300_000,
];

export async function handleCogniumPollQueue(
  batch: MessageBatch<CogniumPollMessage>,
  env: Env,
): Promise<void> {
  const pool = new Pool({ connectionString: env.NEON_CONNECTION_STRING });
  const maxAttempts = parseInt(env.COGNIUM_MAX_POLL_ATTEMPTS ?? '12', 10);
  const cogniumUrl = env.COGNIUM_URL ?? 'https://circle.cognium.net';

  for (const msg of batch.messages) {
    const { skillId, jobId, attempt } = msg.body;

    try {
      // ── Step 1: Check job status ────────────────────────────────────────
      const statusRes = await fetch(`${cogniumUrl}/api/analyze/${jobId}/status`, {
        headers: { 'Authorization': `Bearer ${env.COGNIUM_API_KEY ?? ''}` },
      });

      if (!statusRes.ok) {
        if (statusRes.status >= 500 || statusRes.status === 429) {
          msg.retry();
          continue;
        }
        // 4xx (not 429) — unrecoverable
        console.error(`[COGNIUM-POLL] Status check failed for job ${jobId}: ${statusRes.status}`);
        await markScanFailed(pool, skillId, `Status check returned ${statusRes.status}`);
        await env.COGNIUM_JOBS.delete(`cognium:job:${skillId}`);
        msg.ack();
        continue;
      }

      const job = await statusRes.json() as CircleIRJobStatus;

      // ── Step 2: Handle terminal states ──────────────────────────────────
      if (job.status === 'completed') {
        await handleCompleted(pool, env, cogniumUrl, skillId, jobId, job);
        await env.COGNIUM_JOBS.delete(`cognium:job:${skillId}`);
        msg.ack();
        continue;
      }

      if (job.status === 'failed' || job.status === 'cancelled') {
        await markScanFailed(pool, skillId, `Circle-IR job ${job.status}`);
        await env.COGNIUM_JOBS.delete(`cognium:job:${skillId}`);
        msg.ack();
        continue;
      }

      // ── Step 3: Still running — re-enqueue or give up ───────────────────
      if (attempt >= maxAttempts) {
        console.error(`[COGNIUM-POLL] Max attempts (${maxAttempts}) reached for job ${jobId}`);
        await markScanFailed(pool, skillId, `Poll timeout after ${maxAttempts} attempts`);
        await env.COGNIUM_JOBS.delete(`cognium:job:${skillId}`);
        msg.ack();
        continue;
      }

      const nextDelay = POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)];
      await env.COGNIUM_POLL_QUEUE.send(
        { skillId, jobId, attempt: attempt + 1 },
        { delaySeconds: Math.floor(nextDelay / 1000) },
      );
      console.log(`[COGNIUM-POLL] Job ${jobId} still ${job.status}, re-queued attempt ${attempt + 1} (delay ${nextDelay}ms)`);
      msg.ack();
    } catch (err) {
      console.error(`[COGNIUM-POLL] Error polling job ${jobId}: ${(err as Error).message}`);
      msg.retry();
    }
  }
}

async function handleCompleted(
  pool: Pool,
  env: Env,
  cogniumUrl: string,
  skillId: string,
  jobId: string,
  job: CircleIRJobStatus,
): Promise<void> {
  const authHeaders = { 'Authorization': `Bearer ${env.COGNIUM_API_KEY ?? ''}` };

  // Fetch findings, skill-result, and full results (for files_detail/bundle_metadata) in parallel
  const [findingsRes, skillResultRes, resultsRes] = await Promise.all([
    fetch(`${cogniumUrl}/api/analyze/${jobId}/findings`, { headers: authHeaders }),
    fetch(`${cogniumUrl}/api/analyze/${jobId}/skill-result`, { headers: authHeaders }),
    fetch(`${cogniumUrl}/api/analyze/${jobId}/results`, { headers: authHeaders }),
  ]);

  if (!findingsRes.ok) {
    console.error(`[COGNIUM-POLL] Findings fetch failed for job ${jobId}: ${findingsRes.status}`);
    await markScanFailed(pool, skillId, `Findings fetch returned ${findingsRes.status}`);
    return;
  }

  const { findings: raw } = await findingsRes.json() as { findings: CircleIRFinding[] };
  const findings = normalizeFindings(raw);

  // Skill result is best-effort — don't fail the scan if it's unavailable
  let skillResult: CircleIRSkillResult | null = null;
  if (skillResultRes.ok) {
    skillResult = await skillResultRes.json() as CircleIRSkillResult;
  } else {
    console.warn(`[COGNIUM-POLL] Skill-result fetch failed for job ${jobId}: ${skillResultRes.status} (non-fatal)`);
  }

  // Enrich job status with files_detail and bundle_metadata from /results
  if (resultsRes.ok) {
    const resultsBody = await resultsRes.json() as {
      files_detail?: CircleIRJobStatus['files_detail'];
      bundle_metadata?: CircleIRJobStatus['bundle_metadata'];
      metrics?: CircleIRJobStatus['metrics'];
    };
    if (resultsBody.files_detail) job.files_detail = resultsBody.files_detail;
    if (resultsBody.bundle_metadata) job.bundle_metadata = resultsBody.bundle_metadata;
    if (resultsBody.metrics) job.metrics = resultsBody.metrics;
  } else {
    console.warn(`[COGNIUM-POLL] Results fetch failed for job ${jobId}: ${resultsRes.status} (non-fatal)`);
  }

  // Fetch skill row
  const skill = await fetchSkillById(pool, skillId);
  if (!skill) {
    console.log(`[COGNIUM-POLL] Skill ${skillId} not found (deleted?), skipping report`);
    return;
  }

  await applyScanReport(env, pool, skill, findings, job, skillResult);
  const verdict = skillResult?.verdict ?? job.summary?.verdict ?? 'unknown';
  const bundleInfo = job.bundle_metadata ? `, bundle=${job.bundle_metadata.bundle_download}` : '';
  console.log(`[COGNIUM-POLL] Scan report applied for skill ${skill.slug} (${findings.length} findings, verdict=${verdict}${bundleInfo})`);
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
