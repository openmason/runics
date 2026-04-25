// ══════════════════════════════════════════════════════════════════════════════
// Cognium Client — Analysis Poll Consumer
// ══════════════════════════════════════════════════════════════════════════════
//
// Queue handler for ANALYSIS_POLL_QUEUE. Polls Circle-IR analysis job
// status for a single (skill, endpoint) pair with exponential backoff.
// On completion, fetches results and writes to DB immediately.
//
// Each endpoint is independent — quality can complete while trust is
// still polling. Results are applied incrementally via applyAnalysisResults.
//
// Backoff schedule (12 attempts, ~30 min total):
//   15s → 30s → 60s → 120s ×5 → 300s ×4
//
// ══════════════════════════════════════════════════════════════════════════════

import { createPool } from '../db/connection';
import type { Pool } from '../db/connection';
import type { Env } from '../types';
import type { AnalysisPollMessage, AsyncJobStatus } from './types';
import { applyAnalysisResults } from './analysis-report-handler';

const POLL_DELAYS_MS = [
  15_000, 30_000, 60_000,
  120_000, 120_000, 120_000, 120_000, 120_000,
  300_000, 300_000, 300_000, 300_000,
];

export async function handleAnalysisPollQueue(
  batch: MessageBatch<AnalysisPollMessage>,
  env: Env,
): Promise<void> {
  if (env.ANALYSIS_ENABLED === 'false') {
    for (const msg of batch.messages) msg.ack();
    console.log(`[ANALYSIS-POLL] Disabled (ANALYSIS_ENABLED=false), acked ${batch.messages.length} messages`);
    return;
  }

  const pool = createPool(env);
  const maxAttempts = parseInt(env.COGNIUM_MAX_POLL_ATTEMPTS ?? '12', 10);
  const cogniumUrl = env.COGNIUM_URL ?? 'https://circle.cognium.net';
  const apiKey = env.COGNIUM_API_KEY ?? '';

  for (const msg of batch.messages) {
    const { skillId, endpoint, jobId, apiPath, attempt } = msg.body;

    try {
      // ── Step 1: Check job status ────────────────────────────────────────
      const statusRes = await fetch(`${cogniumUrl}${apiPath}/${jobId}/status`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      if (!statusRes.ok) {
        if (statusRes.status >= 500 || statusRes.status === 429) {
          msg.retry();
          continue;
        }
        // 4xx (not 429) — unrecoverable
        console.error(`[ANALYSIS-POLL] ${endpoint} status check failed for job ${jobId}: ${statusRes.status}`);
        await env.COGNIUM_JOBS.delete(`analysis:job:${skillId}:${endpoint}`);
        msg.ack();
        continue;
      }

      const job = await statusRes.json() as AsyncJobStatus;

      // ── Step 2: Handle terminal states ──────────────────────────────────
      if (job.status === 'completed') {
        // Fetch results
        const resultRes = await fetch(`${cogniumUrl}${apiPath}/${jobId}/results`, {
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });

        if (resultRes.ok) {
          const result = await resultRes.json();
          // Apply this single endpoint's result immediately
          await applyAnalysisResults(pool, skillId, { [endpoint]: result });
          console.log(`[ANALYSIS-POLL] ${endpoint} completed for skill ${skillId} (job ${jobId})`);
        } else {
          console.error(`[ANALYSIS-POLL] ${endpoint} results fetch failed for job ${jobId}: ${resultRes.status}`);
        }

        await env.COGNIUM_JOBS.delete(`analysis:job:${skillId}:${endpoint}`);
        msg.ack();
        continue;
      }

      if (job.status === 'failed' || job.status === 'cancelled') {
        console.error(`[ANALYSIS-POLL] ${endpoint} job ${job.status} for skill ${skillId} (job ${jobId})`);
        await env.COGNIUM_JOBS.delete(`analysis:job:${skillId}:${endpoint}`);
        msg.ack();
        continue;
      }

      // ── Step 3: Still running — re-enqueue or give up ───────────────────
      if (attempt >= maxAttempts) {
        console.error(`[ANALYSIS-POLL] ${endpoint} max attempts (${maxAttempts}) reached for job ${jobId}`);
        await env.COGNIUM_JOBS.delete(`analysis:job:${skillId}:${endpoint}`);
        msg.ack();
        continue;
      }

      const nextDelay = POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)];
      await env.ANALYSIS_POLL_QUEUE.send(
        { skillId, endpoint, jobId, apiPath, attempt: attempt + 1 },
        { delaySeconds: Math.floor(nextDelay / 1000) },
      );
      console.log(`[ANALYSIS-POLL] ${endpoint} job ${jobId} still ${job.status}, re-queued attempt ${attempt + 1} (delay ${nextDelay}ms)`);
      msg.ack();
    } catch (err) {
      console.error(`[ANALYSIS-POLL] Error polling ${endpoint}/${jobId}: ${(err as Error).message}`);
      msg.retry();
    }
  }
}
