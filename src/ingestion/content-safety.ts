// ══════════════════════════════════════════════════════════════════════════════
// Content Safety — Llama Guard Classification
// ══════════════════════════════════════════════════════════════════════════════
//
// Interim content safety gate using Workers AI Llama Guard 3 8B.
// Runs at ingest time; unsafe skills are excluded via WHERE filter at query time.
// Will be removed when Circle-IR adds native content safety support.
//
// ══════════════════════════════════════════════════════════════════════════════

import type { Env, SkillInput } from '../types';

export type SafetyResult = { safe: boolean } | { error: true };

/**
 * Check content safety using Llama Guard 3.
 * Returns { safe: true/false } for definitive results, or { error: true } on transient failure.
 * Callers should NOT permanently mark skills unsafe on { error: true } — retry later instead.
 */
export async function checkContentSafety(env: Env, skill: SkillInput): Promise<SafetyResult> {
  // Allow disabling content safety for development/testing
  if (env.DISABLE_CONTENT_SAFETY === 'true') {
    return { safe: true };
  }

  const textToCheck = [
    skill.name,
    skill.description,
    skill.agentSummary ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  try {
    // Llama Guard 3 8B classification via Workers AI
    // Format: https://developers.cloudflare.com/workers-ai/models/llama-guard-3-8b/
    const result = await env.AI.run(env.SAFETY_MODEL as any, {
      messages: [
        {
          role: 'user',
          content: textToCheck,
        },
      ],
    });

    // Llama Guard returns { response: "safe" } or { response: "unsafe\nS..." }
    const response = (result as any)?.response?.toLowerCase() ?? '';
    const isSafe = response.startsWith('safe');

    if (!isSafe) {
      console.warn(`[SAFETY] Content flagged as unsafe for skill ${skill.id}: ${response}`);
    }

    return { safe: isSafe };
  } catch (error) {
    console.error('[SAFETY] Content safety check error (transient, will retry):', error);
    // Return error signal — callers should retry, not permanently mark unsafe
    return { error: true };
  }
}
