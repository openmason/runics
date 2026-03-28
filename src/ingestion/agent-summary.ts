// ══════════════════════════════════════════════════════════════════════════════
// Agent Summary — LLM-Generated Search-Optimized Descriptions
// ══════════════════════════════════════════════════════════════════════════════
//
// Generates concise, search-optimized summaries for skills using Workers AI.
// These summaries are embedded as the primary vector for semantic search.
// Falls back to a template-based summary if LLM generation fails.
//
// ══════════════════════════════════════════════════════════════════════════════

import type { Env, SkillInput } from '../types';

const SYSTEM_PROMPT = `Generate a concise search-optimized description of this tool/skill for AI agents.

Focus on:
- What it does (core functionality)
- What problems it solves (use cases)
- What inputs/outputs it has (interface)
- When to use it (context)

Start with "Use this tool when you need to..."
2-3 sentences max. Return only the description, no preamble or explanation.`;

export async function generateAgentSummary(env: Env, skill: SkillInput): Promise<string> {
  const userContent = `Name: ${skill.name}
Description: ${skill.description}
Tags: ${skill.tags.join(', ')}
Category: ${skill.category ?? 'general'}
Capabilities: ${skill.capabilitiesRequired?.join(', ') ?? 'none'}`;

  try {
    const response = await env.AI.run(env.LLM_MODEL as any, {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      max_tokens: 200,
    });

    const summary = (response as any)?.response?.trim() ?? '';

    // Fallback if LLM returns empty or invalid response
    if (!summary || summary.length < 10) {
      return generateFallbackSummary(skill);
    }

    return summary;
  } catch (error) {
    console.error('Agent summary generation failed:', error);
    return generateFallbackSummary(skill);
  }
}

function generateFallbackSummary(skill: SkillInput): string {
  const capabilities = skill.capabilitiesRequired?.length
    ? ` Requires ${skill.capabilitiesRequired.join(', ')} capabilities.`
    : '';

  return `Use this tool when you need to ${skill.description}${capabilities}`;
}
