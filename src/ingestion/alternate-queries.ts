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

function buildAlternateQueryPrompt(name: string): string {
  return `You generate 5 search queries that developers or AI agents would use to find the tool "${name}".

Generate EXACTLY ONE query for each of these strategies, in this order:

1. DIRECT — how someone who already knows about "${name}" would phrase the search
2. PROBLEM — the underlying problem the user faces, in their own words (no tool names)
3. BUSINESS — how a non-technical manager or PM would describe the need (no tool names)
4. ALTERNATE — a different phrasing or synonym with "${name}" in it for disambiguation
5. COMPOSITION — a larger workflow or pipeline that "${name}" fits into

Hard requirements:
- Queries #1 and #4 MUST include the tool name "${name}" (or an obvious variant like removing dashes)
- Queries #2 and #3 MUST NOT include the tool name — they are semantic/problem phrasings
- Each query is 4-10 words, lowercase, no quotes
- Return ONLY a JSON array of 5 strings. No prose, no code fences.

Example for a tool named "cargo-deny":
["check rust dependency licenses with cargo-deny", "shipping GPL code in proprietary rust binary", "ensure open source compliance for rust project", "cargo-deny security advisory scanner", "rust supply chain security audit pipeline"]`;
}

export async function generateAlternateQueries(env: Env, skill: SkillInput): Promise<string[]> {
  try {
    const response = await env.AI.run(env.LLM_MODEL as any, {
      messages: [
        { role: 'system', content: buildAlternateQueryPrompt(skill.name) },
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
