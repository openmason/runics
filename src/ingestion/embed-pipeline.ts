// ══════════════════════════════════════════════════════════════════════════════
// EmbedPipeline — Skill Ingestion & Embedding Generation
// ══════════════════════════════════════════════════════════════════════════════
//
// Phase 1: Single embedding (agent_summary only)
// Phase 3: Multi-vector (agent_summary + 5 alternate queries)
//
// Pipeline:
// 1. Generate agent_summary if not provided (LLM)
// 2. Content safety check (Llama Guard)
// 3. Embed agent_summary (Workers AI bge-small)
// 4. [Phase 3] Generate + embed alternate queries
//
// ══════════════════════════════════════════════════════════════════════════════

import type { Env, SkillInput, EmbeddingSet } from '../types';

export class EmbedPipeline {
  constructor(private env: Env) {}

  // ────────────────────────────────────────────────────────────────────────────
  // Phase 1: Single Embedding
  // ────────────────────────────────────────────────────────────────────────────

  async processSkill(skill: SkillInput): Promise<EmbeddingSet> {
    // Generate agent summary if not provided
    const agentSummaryText =
      skill.agentSummary ?? (await this.generateAgentSummary(skill));

    // Embed the agent summary
    const embedding = await this.embed(agentSummaryText);

    return {
      agentSummary: { text: agentSummaryText, embedding },
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Content Safety Check (Llama Guard)
  // ────────────────────────────────────────────────────────────────────────────

  async checkContentSafety(skill: SkillInput): Promise<boolean> {
    // Allow disabling content safety for development/testing
    if (this.env.DISABLE_CONTENT_SAFETY === 'true') {
      console.log('⚠️  Content safety check disabled (DISABLE_CONTENT_SAFETY=true)');
      return true;
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
      const result = await this.env.AI.run(this.env.SAFETY_MODEL as any, {
        messages: [
          {
            role: 'user',
            content: textToCheck,
          },
        ],
      });

      console.log('Llama Guard response:', JSON.stringify(result, null, 2));

      // Llama Guard returns { response: "safe" } or { response: "unsafe\nS..." }
      const response = (result as any)?.response?.toLowerCase() ?? '';
      const isSafe = response.startsWith('safe');

      if (!isSafe) {
        console.log(`Content flagged as unsafe for skill ${skill.id}:`, response);
      }

      return isSafe;
    } catch (error) {
      console.error('Content safety check error:', error);
      console.error('Error details:', JSON.stringify(error, null, 2));
      // Fail closed: if safety check errors, mark as unsafe
      return false;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Agent Summary Generation
  // ────────────────────────────────────────────────────────────────────────────

  private async generateAgentSummary(skill: SkillInput): Promise<string> {
    const systemPrompt = `Generate a concise search-optimized description of this tool/skill for AI agents.

Focus on:
- What it does (core functionality)
- What problems it solves (use cases)
- What inputs/outputs it has (interface)
- When to use it (context)

Start with "Use this tool when you need to..."
2-3 sentences max. Return only the description, no preamble or explanation.`;

    const userContent = `Name: ${skill.name}
Description: ${skill.description}
Tags: ${skill.tags.join(', ')}
Category: ${skill.category ?? 'general'}
Capabilities: ${skill.capabilitiesRequired?.join(', ') ?? 'none'}`;

    try {
      const response = await this.env.AI.run(this.env.LLM_MODEL as any, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        max_tokens: 200,
      });

      const summary = (response as any)?.response?.trim() ?? '';

      // Fallback if LLM returns empty or invalid response
      if (!summary || summary.length < 10) {
        return this.generateFallbackSummary(skill);
      }

      return summary;
    } catch (error) {
      console.error('Agent summary generation failed:', error);
      return this.generateFallbackSummary(skill);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Fallback Summary (if LLM fails)
  // ────────────────────────────────────────────────────────────────────────────

  private generateFallbackSummary(skill: SkillInput): string {
    const capabilities = skill.capabilitiesRequired?.length
      ? ` Requires ${skill.capabilitiesRequired.join(', ')} capabilities.`
      : '';

    return `Use this tool when you need to ${skill.description}${capabilities}`;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Embedding via Workers AI
  // ────────────────────────────────────────────────────────────────────────────

  private async embed(text: string): Promise<number[]> {
    try {
      const result = await this.env.AI.run(this.env.EMBEDDING_MODEL as any, {
        text: [text],
      });

      const embedding = (result as any)?.data?.[0];

      if (!embedding || !Array.isArray(embedding)) {
        throw new Error('Invalid embedding response from Workers AI');
      }

      // Validate embedding dimensions (bge-small-en-v1.5 = 384 dimensions)
      if (embedding.length !== 384) {
        throw new Error(
          `Expected 384-dimensional embedding, got ${embedding.length}`
        );
      }

      return embedding;
    } catch (error) {
      console.error('Embedding generation failed:', error);
      throw new Error(`Failed to generate embedding: ${(error as Error).message}`);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Phase 3: Multi-Vector Processing (NOT IMPLEMENTED YET)
  // ────────────────────────────────────────────────────────────────────────────

  async processSkillMultiVector(_skill: SkillInput): Promise<EmbeddingSet> {
    throw new Error(
      'Multi-vector processing is not implemented in Phase 1. Use processSkill() instead.'
    );

    // Phase 3 implementation:
    // 1. Generate base embedding via processSkill()
    // 2. Generate 5 alternate queries via generateAlternateQueries()
    // 3. Batch embed all alternates in single API call
    // 4. Return EmbeddingSet with alternates
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Phase 3: Alternate Query Generation (NOT IMPLEMENTED YET)
  // ────────────────────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async _generateAlternateQueries(_skill: SkillInput): Promise<string[]> {
    throw new Error(
      'Alternate query generation is not implemented in Phase 1.'
    );

    // Phase 3 implementation:
    // 1. Use ALTERNATE_QUERY_PROMPT to generate 5 queries
    // 2. Parse JSON response
    // 3. Return array of 5 strings
    // 4. Each query uses different strategy: direct, problem, business, alternate, composition
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Prompts (Phase 3)
// ══════════════════════════════════════════════════════════════════════════════

// Not used in Phase 1 - will be used in Phase 3 for generateAlternateQueries
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _ALTERNATE_QUERY_PROMPT = `You generate search queries that developers or AI agents would use to find this skill. Think about:

1. DIRECT: How someone who knows exactly what they want would ask
2. PROBLEM-BASED: How someone describing their problem (not the solution) would ask
3. BUSINESS LANGUAGE: How a non-technical person or PM would describe the need
4. ALTERNATE TERMINOLOGY: Different words for the same concept
5. COMPOSITION: When this skill would be part of a larger workflow

Return exactly 5 queries as a JSON array of strings. Each query 4-10 words. No explanations, just the JSON array.

Example:
["check rust dependency licenses", "are my crate dependencies safe to ship", "ensure open source compliance rust project", "cargo ban crate security advisory check", "rust supply chain security audit pipeline"]`;
