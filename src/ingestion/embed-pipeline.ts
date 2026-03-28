// ══════════════════════════════════════════════════════════════════════════════
// EmbedPipeline — Skill Ingestion & Embedding Generation
// ══════════════════════════════════════════════════════════════════════════════
//
// Orchestrates the ingestion pipeline:
// 1. Generate agent_summary (LLM) — via agent-summary.ts
// 2. Content safety check (Llama Guard) — via content-safety.ts
// 3. Embed agent_summary (Workers AI bge-small)
// 4. [Phase 3] Generate + embed alternate queries — via alternate-queries.ts
//
// ══════════════════════════════════════════════════════════════════════════════

import type { Env, SkillInput, EmbeddingSet } from '../types';
import { checkContentSafety } from './content-safety';
import { generateAgentSummary } from './agent-summary';
import { generateAlternateQueries } from './alternate-queries';

export class EmbedPipeline {
  constructor(private env: Env) {}

  // ────────────────────────────────────────────────────────────────────────────
  // Phase 1: Single Embedding
  // ────────────────────────────────────────────────────────────────────────────

  async processSkill(skill: SkillInput): Promise<EmbeddingSet> {
    // Generate agent summary if not provided
    const agentSummaryText =
      skill.agentSummary ?? (await generateAgentSummary(this.env, skill));

    // Embed the agent summary
    const embedding = await this.embed(agentSummaryText);

    return {
      agentSummary: { text: agentSummaryText, embedding },
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Content Safety Check (delegates to content-safety.ts)
  // ────────────────────────────────────────────────────────────────────────────

  async checkContentSafety(skill: SkillInput): Promise<boolean> {
    return checkContentSafety(this.env, skill);
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
  // Phase 3: Multi-Vector Processing
  // ────────────────────────────────────────────────────────────────────────────

  async processSkillMultiVector(skill: SkillInput): Promise<EmbeddingSet> {
    // 1. Get base agent_summary embedding
    const base = await this.processSkill(skill);

    // 2. Generate 5 alternate queries via LLM
    const skillWithSummary: SkillInput = {
      ...skill,
      agentSummary: skill.agentSummary ?? base.agentSummary.text,
    };
    const alternateTexts = await generateAlternateQueries(this.env, skillWithSummary);

    if (alternateTexts.length === 0) {
      console.log(`[MULTI-VECTOR] No alternates generated for ${skill.name}, using base only`);
      return base;
    }

    // 3. Batch embed all alternates in a single Workers AI call
    try {
      const embedResult = await this.env.AI.run(this.env.EMBEDDING_MODEL as any, {
        text: alternateTexts,
      });

      const embeddings = (embedResult as any)?.data;
      if (!embeddings || !Array.isArray(embeddings)) {
        console.error(`[MULTI-VECTOR] Batch embedding failed for ${skill.name}`);
        return base;
      }

      // 4. Build alternate embedding entries
      const alternates = alternateTexts.map((text, i) => ({
        source: `alt_query_${i}`,
        text,
        embedding: embeddings[i] as number[],
      }));

      console.log(`[MULTI-VECTOR] Generated ${alternates.length} alternates for ${skill.name}`);

      return { ...base, alternates };
    } catch (error) {
      console.error(`[MULTI-VECTOR] Batch embedding error for ${skill.name}:`, error);
      return base;
    }
  }
}
