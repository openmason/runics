// ══════════════════════════════════════════════════════════════════════════════
// Cognium Client — Notification Trigger
// ══════════════════════════════════════════════════════════════════════════════
//
// Sends webhook notifications to Activepieces on revoke/flag events.
//
// ══════════════════════════════════════════════════════════════════════════════

import type { Env } from '../types';

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

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: status === 'revoked' ? 'skill.revoked' : 'skill.flagged',
        skillId,
        status,
        reason: reason ?? null,
        timestamp: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      console.error(`[NOTIFY] Webhook failed: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.error(`[NOTIFY] Webhook error for ${skillId}:`, (error as Error).message);
  }
}
