// ══════════════════════════════════════════════════════════════════════════════
// CompositionDetector — Multi-Skill Query Detection
// ══════════════════════════════════════════════════════════════════════════════
//
// Detects queries that span multiple skills and decomposes them into
// an ordered sequence of sub-tasks with matched skills.
//
// Example: "lint my rust code, check licenses, then deploy to staging"
// → [{purpose: "lint rust", skill: clippy},
//    {purpose: "check licenses", skill: cargo-deny},
//    {purpose: "deploy staging", skill: cloudflare-deploy}]
//
// ══════════════════════════════════════════════════════════════════════════════

import type { Env, ScoredSkill, CompositionResult } from '../types';
import type { SearchProvider } from '../providers/search-provider';
import type { CircuitBreaker } from '../resilience/circuit-breaker';

const COMPOSITION_PROMPT = `You are analyzing a user query to detect if it requires multiple tools/skills in sequence.

A "composition" query is one where the user describes a multi-step workflow that would need different specialized tools for each step.

Examples of composition queries:
- "lint code, run tests, then deploy" → 3 skills needed
- "scan for vulnerabilities and check licenses" → 2 skills needed

Examples of NON-composition queries:
- "format my code" → 1 skill
- "deploy to production" → 1 skill
- "set up monitoring" → might involve multiple tools but the query describes a single concern

Analyze the query and respond as JSON:
{
  "is_composition": boolean,
  "parts": string[],
  "reasoning": string
}

If is_composition is false, parts should be empty.
Each part should be a concise sub-task description (3-8 words).`;

export class CompositionDetector {
  constructor(
    private env: Env,
    private provider: SearchProvider,
    private embedFn: (text: string) => Promise<number[]>,
    private circuitBreaker: CircuitBreaker
  ) {}

  async detect(
    query: string,
    results: ScoredSkill[],
    filters: { tenantId: string }
  ): Promise<CompositionResult> {
    const notDetected: CompositionResult = {
      detected: false,
      parts: [],
      reasoning: 'Composition detection skipped (circuit breaker)',
    };

    const { result: parsed, degraded } = await this.circuitBreaker.execute(
      async () => {
        const response = await this.env.AI.run(
          this.env.LLM_MODEL as any,
          {
            messages: [
              { role: 'system', content: COMPOSITION_PROMPT },
              { role: 'user', content: query },
            ],
            max_tokens: 200,
          }
        );

        const responseText = (response as any).response;
        return JSON.parse(responseText);
      },
      null
    );

    if (degraded || !parsed) {
      return notDetected;
    }

    if (!parsed.is_composition || !Array.isArray(parsed.parts) || parsed.parts.length === 0) {
      return {
        detected: false,
        parts: [],
        reasoning: parsed.reasoning || 'Single-skill query',
      };
    }

    // Search for each composition part
    const parts = await Promise.all(
      parsed.parts.map(async (part: string) => {
        const embedding = await this.embedFn(part);
        const result = await this.provider.search(
          part,
          embedding,
          { tenantId: filters.tenantId, contentSafetyRequired: true },
          { limit: 1 }
        );

        return {
          purpose: part,
          skill: result.results[0] ?? null,
        };
      })
    );

    return {
      detected: true,
      parts,
      reasoning: parsed.reasoning || 'Multi-skill workflow detected',
    };
  }
}
