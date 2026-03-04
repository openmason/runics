// ══════════════════════════════════════════════════════════════════════════════
// Cognium Queue Consumer — Dispatches trust scoring requests to Cognium
// ══════════════════════════════════════════════════════════════════════════════
//
// Phase 5 stub: logs the intent and acks the message.
// When Cognium service is ready, this will POST to its scanning endpoint.
// Cognium results come back via PUT /v1/skills/:id/trust callback.
//
// ══════════════════════════════════════════════════════════════════════════════

import type { Env, CogniumQueueMessage } from '../types';

export async function handleCogniumQueue(
  batch: MessageBatch<CogniumQueueMessage>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const { skillId, source } = message.body;

    try {
      // TODO: When Cognium service is live, POST to scanning endpoint:
      // await fetch(`${env.COGNIUM_URL}/v1/scan`, {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify({ skillId, callbackUrl: `${env.RUNICS_URL}/v1/skills/${skillId}/trust` }),
      // });

      console.log(
        `[COGNIUM-QUEUE] Received scan request for skill ${skillId} from ${source ?? 'unknown'} (stub — no Cognium service yet)`
      );

      message.ack();
    } catch (error) {
      console.error(`[COGNIUM-QUEUE] Error processing skill ${skillId}:`, error);
      message.retry();
    }
  }
}
