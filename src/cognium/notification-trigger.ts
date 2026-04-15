// ══════════════════════════════════════════════════════════════════════════════
// Cognium Client — Notification Trigger
// ══════════════════════════════════════════════════════════════════════════════
//
// Emits skill lifecycle events to the SKILL_EVENTS queue (v5.4, for Cortex
// consumption) and sends webhook notifications to Activepieces on revoke/flag.
//
// Queue emission is independent of the webhook — events are emitted even when
// ACTIVEPIECES_WEBHOOK_URL is not configured.
//
// ══════════════════════════════════════════════════════════════════════════════

import type { Env } from '../types';
import type { SkillEventMessage } from './types';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500; // 500ms, 1s, 2s

function isRetryable(status: number): boolean {
  return status >= 500 || status === 429;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function triggerNotification(
  env: Env,
  skill: { id: string; slug: string; version: string },
  status: 'revoked' | 'vulnerable',
  reason?: string,
): Promise<void> {
  // v5.4: Emit skill event to queue (independent of webhook)
  await emitSkillEvent(env, skill, status, reason);

  // Activepieces webhook (existing behavior)
  const webhookUrl = env.ACTIVEPIECES_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log(`[NOTIFY] No ACTIVEPIECES_WEBHOOK_URL configured, skipping webhook for ${skill.id}`);
    return;
  }

  const payload = JSON.stringify({
    event: status === 'revoked' ? 'skill.revoked' : 'skill.flagged',
    skillId: skill.id,
    status,
    reason: reason ?? null,
    timestamp: new Date().toISOString(),
  });

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });

      if (response.ok) return;

      if (!isRetryable(response.status)) {
        console.error(`[NOTIFY] Webhook failed (non-retryable): ${response.status} for ${skill.id}`);
        return;
      }

      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error as Error;
    }

    if (attempt < MAX_RETRIES - 1) {
      await sleep(BASE_DELAY_MS * 2 ** attempt);
    }
  }

  console.error(`[NOTIFY] Webhook failed after ${MAX_RETRIES} attempts for ${skill.id}:`, lastError?.message);
}

async function emitSkillEvent(
  env: Env,
  skill: { id: string; slug: string; version: string },
  status: 'revoked' | 'vulnerable',
  reason?: string,
): Promise<void> {
  if (!env.SKILL_EVENTS) {
    console.log(`[NOTIFY] No SKILL_EVENTS queue binding, skipping event for ${skill.id}`);
    return;
  }

  try {
    const event: SkillEventMessage = {
      type: `skill.${status}`,
      skillId: skill.id,
      slug: skill.slug,
      version: skill.version,
      reason: reason ?? null,
      timestamp: new Date().toISOString(),
    };
    await env.SKILL_EVENTS.send(event);
    console.log(`[NOTIFY] Emitted ${event.type} event for ${skill.slug}@${skill.version}`);
  } catch (err) {
    console.error(`[NOTIFY] SKILL_EVENTS queue send failed for ${skill.id}:`, (err as Error).message);
  }
}
