// ══════════════════════════════════════════════════════════════════════════════
// Cognium Client — Notification Trigger
// ══════════════════════════════════════════════════════════════════════════════
//
// Sends webhook notifications to Activepieces on revoke/flag events.
//
// ══════════════════════════════════════════════════════════════════════════════

import type { Env } from '../types';

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
  skillId: string,
  status: 'revoked' | 'vulnerable',
  reason?: string,
): Promise<void> {
  const webhookUrl = env.ACTIVEPIECES_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log(`[NOTIFY] No ACTIVEPIECES_WEBHOOK_URL configured, skipping notification for ${skillId}`);
    return;
  }

  const payload = JSON.stringify({
    event: status === 'revoked' ? 'skill.revoked' : 'skill.flagged',
    skillId,
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
        console.error(`[NOTIFY] Webhook failed (non-retryable): ${response.status} for ${skillId}`);
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

  console.error(`[NOTIFY] Webhook failed after ${MAX_RETRIES} attempts for ${skillId}:`, lastError?.message);
}
