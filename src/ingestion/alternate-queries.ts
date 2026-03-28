// ══════════════════════════════════════════════════════════════════════════════
// Alternate Queries — Multi-Vector Query Generation (Phase 3)
// ══════════════════════════════════════════════════════════════════════════════
//
// Generates 5 alternate search queries for each skill using Workers AI.
// Each query uses a different strategy (direct, problem-based, business language,
// alternate terminology, composition). These are embedded as additional vectors
// to improve recall for diverse query formulations.
//
// ══════════════════════════════════════════════════════════════════════════════

import type { Env, SkillInput } from '../types';

const ALTERNATE_QUERY_PROMPT = `You generate search queries that developers or AI agents would use to find this skill. Think about:

1. DIRECT: How someone who knows exactly what they want would ask
2. PROBLEM-BASED: How someone describing their problem (not the solution) would ask
3. BUSINESS LANGUAGE: How a non-technical person or PM would describe the need
4. ALTERNATE TERMINOLOGY: Different words for the same concept
5. COMPOSITION: When this skill would be part of a larger workflow

Return exactly 5 queries as a JSON array of strings. Each query 4-10 words. No explanations, just the JSON array.

Example:
["check rust dependency licenses", "are my crate dependencies safe to ship", "ensure open source compliance rust project", "cargo ban crate security advisory check", "rust supply chain security audit pipeline"]`;

export async function generateAlternateQueries(env: Env, skill: SkillInput): Promise<string[]> {
  try {
    const response = await env.AI.run(env.LLM_MODEL as any, {
      messages: [
        { role: 'system', content: ALTERNATE_QUERY_PROMPT },
        {
          role: 'user',
          content: `Name: ${skill.name}\nAgent summary: ${skill.agentSummary ?? skill.description}\nTags: ${skill.tags.join(', ')}\nCategory: ${skill.category ?? 'general'}\nCapabilities: ${skill.capabilitiesRequired?.join(', ') ?? 'none'}`,
        },
      ],
      max_tokens: 200,
    });

    // Workers AI chat models return { response: string }
    let text = '';
    if (response && typeof response === 'object' && 'response' in response) {
      text = String((response as any).response).trim();
    } else if (typeof response === 'string') {
      text = response.trim();
    } else {
      return [];
    }

    // Try JSON parse first (preferred)
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    let queries: string[] = [];

    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        queries = parsed.filter((s: unknown): s is string => typeof s === 'string');
      }
    } catch {
      // Fallback: parse as newline-separated, comma-separated, or numbered list
      const separator = cleaned.includes('\n') ? '\n' : ',';
      queries = cleaned
        .split(separator)
        .map((line) => line.replace(/^\d+[\.\)]\s*/, '').replace(/^[-*]\s*/, '').replace(/^["']|["']$/g, '').trim())
        .filter((line) => line.length >= 4);
    }

    const result = queries
      .filter((s) => s.length >= 4 && s.length <= 80)
      .slice(0, 5);

    return result;
  } catch (error) {
    console.error(`[MULTI-VECTOR] Failed for ${skill.name}:`, (error as Error).message);
    return [];
  }
}
