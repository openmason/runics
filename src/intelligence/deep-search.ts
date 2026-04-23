// ══════════════════════════════════════════════════════════════════════════════
// DeepSearch — LLM-Powered Query Expansion (Tier 2 & 3)
// ══════════════════════════════════════════════════════════════════════════════
//
// Tier 2: Generates 2-3 alternate phrasings, re-embeds, re-searches, merges.
// Tier 3: Full intent decomposition + terminology translation + composition.
//
// Uses Workers AI Llama 3.3 70B Instruct.
//
// ══════════════════════════════════════════════════════════════════════════════

import type { SearchProvider } from '../providers/search-provider';
import type {
  Env,
  SearchFilters,
  SearchResult,
  ScoredSkill,
  CompositionResult,
} from '../types';
import type { CircuitBreaker } from '../resilience/circuit-breaker';

// ──────────────────────────────────────────────────────────────────────────────
// Deep Search Prompt (from Architecture spec section 6)
// ──────────────────────────────────────────────────────────────────────────────

const DEEP_SEARCH_PROMPT = `You are a search intelligence layer for a skill/tool registry.
A user query got low-confidence results from vector search. Your job:

1. INTENT DECOMPOSITION: Break the query into sub-intents if complex
2. TERMINOLOGY TRANSLATION: Map colloquial/business terms to technical terms
3. CAPABILITY REASONING: Infer what kind of tool would solve this
4. COMPOSITION DETECTION: Detect if this needs multiple skills in sequence

Context: match_source shows WHICH embedding matched best:
- "agent_summary" = matched the skill's main description
- "alt_query_N" = matched a pre-generated alternate query phrasing
If even alternate queries didn't match, the query uses truly novel terminology.

Respond as JSON:
{
  "alternate_queries": string[],
  "terminology_map": Record<string,string>,
  "needs_composition": boolean,
  "composition_parts": string[],
  "capability_hints": string[],
  "reasoning": string
}`;

// ──────────────────────────────────────────────────────────────────────────────
// Tier 2 Expansion Prompt (lighter weight)
// ──────────────────────────────────────────────────────────────────────────────

const QUERY_EXPANSION_PROMPT = `You are a search query expander. Given a user query about developer tools/skills, generate 2-3 alternate phrasings that might find better results.

Rules:
- Keep each query 4-12 words
- Try different terminology (technical vs colloquial)
- Consider both the tool name and what problem it solves

Respond as a JSON array of strings only. No explanation.`;

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface DeepSearchResult {
  result: SearchResult;
  noMatch: boolean;
  composition?: CompositionResult;
  trace: {
    originalQuery: string;
    alternateQueries: string[];
    terminologyMap?: Record<string, string>;
    reasoning?: string;
  };
  generationHints?: {
    intent: string;
    capabilities: string[];
    complexity: string;
  };
}

interface LLMDeepSearchResponse {
  alternate_queries: string[];
  terminology_map: Record<string, string>;
  needs_composition: boolean;
  composition_parts: string[];
  capability_hints: string[];
  reasoning: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// DeepSearch Class
// ──────────────────────────────────────────────────────────────────────────────

export class DeepSearch {
  private maxTokens: number;

  constructor(
    private env: Env,
    private provider: SearchProvider,
    private embedFn: (text: string) => Promise<number[]>,
    private circuitBreaker: CircuitBreaker
  ) {
    this.maxTokens = parseInt(env.LLM_MAX_TOKENS || '500');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Tier 2: Query Expansion (lightweight)
  // ──────────────────────────────────────────────────────────────────────────

  async expandAndReSearch(
    query: string,
    initialResult: SearchResult,
    filters: SearchFilters,
    preGeneratedQueries?: string[]
  ): Promise<SearchResult> {
    try {
      // Use pre-generated alternate queries if available (from parallel T2 pipeline),
      // otherwise generate them now
      const alternateQueries = preGeneratedQueries ?? await this.generateAlternateQueries(query);

      if (alternateQueries.length === 0) {
        return initialResult;
      }

      // Embed and search each alternate query in parallel
      const alternateResults = await Promise.all(
        alternateQueries.map(async (altQuery) => {
          const embedding = await this.embedFn(altQuery);
          return this.provider.search(altQuery, embedding, filters, { limit: 10 });
        })
      );

      // Merge all results: initial + all alternate searches
      const mergedResults = this.mergeResults(
        initialResult,
        alternateResults
      );

      return mergedResults;
    } catch (error) {
      console.error('DeepSearch expandAndReSearch error:', error);
      return initialResult;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Tier 3: Full Deep Search
  // ──────────────────────────────────────────────────────────────────────────

  async deepSearch(
    query: string,
    embedding: number[],
    initialResult: SearchResult,
    filters: SearchFilters
  ): Promise<DeepSearchResult> {
    try {
      // Build context from initial results for the LLM
      const topResults = initialResult.results.slice(0, 5);
      const resultContext = topResults
        .map(
          (r) =>
            `- score=${r.fusedScore.toFixed(3)} match_source=${r.matchSource} skill=${r.skillId}`
        )
        .join('\n');

      // Call LLM for deep analysis
      const llmResponse = await this.callDeepSearchLLM(query, resultContext);

      if (!llmResponse) {
        return {
          result: initialResult,
          noMatch: initialResult.results.length === 0,
          trace: {
            originalQuery: query,
            alternateQueries: [],
            reasoning: 'LLM deep search failed, returning initial results',
          },
        };
      }

      // Re-search with alternate queries
      const alternateResults = await Promise.all(
        llmResponse.alternate_queries.map(async (altQuery) => {
          const altEmbedding = await this.embedFn(altQuery);
          return this.provider.search(altQuery, altEmbedding, filters, {
            limit: 10,
          });
        })
      );

      // If composition detected, search each part independently
      let compositionResult: CompositionResult | undefined;
      if (
        llmResponse.needs_composition &&
        llmResponse.composition_parts.length > 0
      ) {
        const partResults = await Promise.all(
          llmResponse.composition_parts.map(async (part) => {
            const partEmbedding = await this.embedFn(part);
            const partResult = await this.provider.search(
              part,
              partEmbedding,
              filters,
              { limit: 3 }
            );
            return {
              purpose: part,
              skill: partResult.results[0] ?? null,
            };
          })
        );

        compositionResult = {
          detected: true,
          parts: partResults,
          reasoning: llmResponse.reasoning,
        };
      }

      // Merge all results
      const mergedResult = this.mergeResults(initialResult, alternateResults);

      const noMatch =
        mergedResult.results.length === 0 ||
        mergedResult.confidence.topScore < parseFloat(this.env.CONFIDENCE_TIER2_THRESHOLD || '0.35');

      return {
        result: mergedResult,
        noMatch,
        composition: compositionResult,
        trace: {
          originalQuery: query,
          alternateQueries: llmResponse.alternate_queries,
          terminologyMap: llmResponse.terminology_map,
          reasoning: llmResponse.reasoning,
        },
        generationHints: noMatch
          ? {
              intent: llmResponse.reasoning,
              capabilities: llmResponse.capability_hints,
              complexity: llmResponse.composition_parts.length > 1 ? 'multi-step' : 'single',
            }
          : undefined,
      };
    } catch (error) {
      console.error('DeepSearch deepSearch error:', error);
      return {
        result: initialResult,
        noMatch: initialResult.results.length === 0,
        trace: {
          originalQuery: query,
          alternateQueries: [],
          reasoning: `Deep search error: ${(error as Error).message}`,
        },
      };
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────────────────────────────────

  async generateAlternateQueries(query: string): Promise<string[]> {
    const { result: queries } = await this.circuitBreaker.execute(
      async () => {
        const response = await this.env.AI.run(
          this.env.LLM_MODEL as any,
          {
            messages: [
              { role: 'system', content: QUERY_EXPANSION_PROMPT },
              { role: 'user', content: query },
            ],
            max_tokens: 100,
          }
        );

        const responseText = (response as any).response;
        const parsed = JSON.parse(responseText);
        return Array.isArray(parsed) ? parsed.slice(0, 3) : [];
      },
      [] as string[]
    );

    return queries;
  }

  private async callDeepSearchLLM(
    query: string,
    resultContext: string
  ): Promise<LLMDeepSearchResponse | null> {
    const { result } = await this.circuitBreaker.execute(
      async () => {
        const response = await this.env.AI.run(
          this.env.LLM_MODEL as any,
          {
            messages: [
              { role: 'system', content: DEEP_SEARCH_PROMPT },
              {
                role: 'user',
                content: `Query: "${query}"\n\nInitial results:\n${resultContext}`,
              },
            ],
            max_tokens: this.maxTokens,
          }
        );

        const responseText = (response as any).response;
        return JSON.parse(responseText) as LLMDeepSearchResponse;
      },
      null
    );

    return result;
  }

  private mergeResults(
    primary: SearchResult,
    alternates: SearchResult[]
  ): SearchResult {
    // Collect all results, keyed by skillId (keep best score per skill)
    const skillBest = new Map<string, ScoredSkill>();

    for (const result of [primary, ...alternates]) {
      for (const skill of result.results) {
        const existing = skillBest.get(skill.skillId);
        if (!existing || skill.fusedScore > existing.fusedScore) {
          skillBest.set(skill.skillId, skill);
        }
      }
    }

    // Sort by fused score descending
    const mergedResults = Array.from(skillBest.values()).sort(
      (a, b) => b.fusedScore - a.fusedScore
    );

    // Recompute confidence from merged results
    const topScore = mergedResults[0]?.fusedScore ?? 0;
    const gapToSecond =
      mergedResults.length > 1
        ? topScore - mergedResults[1].fusedScore
        : mergedResults.length > 0
          ? 1.0
          : 0;

    const tier2Threshold = parseFloat(
      this.env.CONFIDENCE_TIER2_THRESHOLD || '0.35'
    );
    const clusterDensity = mergedResults.filter(
      (r) => r.fusedScore >= tier2Threshold
    ).length;

    return {
      results: mergedResults,
      confidence: {
        topScore,
        gapToSecond,
        clusterDensity,
        keywordHits: primary.confidence.keywordHits,
        tier: primary.confidence.tier, // preserve original tier for logging
      },
      meta: {
        ...primary.meta,
        totalCandidates: mergedResults.length,
      },
    };
  }
}
