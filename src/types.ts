// ══════════════════════════════════════════════════════════════════════════════
// Runics Search — Shared Types
// ══════════════════════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────────────────────
// Risk Appetite & Trust Filtering
// ──────────────────────────────────────────────────────────────────────────────

export type Appetite = 'strict' | 'cautious' | 'balanced' | 'adventurous';

export type SkillStatus = 'draft' | 'published' | 'deprecated' | 'archived'
  | 'vulnerable' | 'revoked' | 'degraded' | 'contains-vulnerable';

export type SkillType = 'atomic' | 'auto-composite' | 'human-composite' | 'forked';

export type VerificationTier = 'unverified' | 'scanned' | 'verified' | 'certified';

export type TrustBadge = 'human-verified' | 'auto-distilled' | 'upstream';

export function appetiteToTrustThreshold(appetite: Appetite): number {
  switch (appetite) {
    case 'strict':
      return 0.85;
    case 'cautious':
      return 0.70;
    case 'balanced':
      return 0.50; // default
    case 'adventurous':
      return 0.20;
  }
}

export function appetiteToAllowVulnerable(appetite: Appetite): boolean {
  return appetite === 'balanced' || appetite === 'adventurous';
}

// ──────────────────────────────────────────────────────────────────────────────
// Skill Input (Ingestion)
// ──────────────────────────────────────────────────────────────────────────────

export interface SkillInput {
  id: string;
  name: string;
  slug: string;
  version: string;
  source: string;
  description: string;
  agentSummary?: string;
  tags: string[];
  category?: string;
  schemaJson?: Record<string, unknown>;
  authRequirements?: Record<string, unknown>;
  installMethod?: Record<string, unknown>;
  trustScore: number;
  capabilitiesRequired?: string[];
  executionLayer: string;
  tenantId: string;
}

export interface EmbeddingSet {
  agentSummary: {
    text: string;
    embedding: number[];
  };
  alternates?: Array<{
    source: string; // alt_query_0, alt_query_1, etc.
    text: string;
    embedding: number[];
  }>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Search Request & Response
// ──────────────────────────────────────────────────────────────────────────────

export interface FindSkillRequest {
  query: string;
  tenantId: string;
  appetite?: Appetite;
  tags?: string[];
  category?: string;
  limit?: number;
  // v5.2: execution environment + visibility
  runtimeEnv?: string[];
  visibility?: 'public' | 'private' | 'unlisted';
}

export interface FindSkillResponse {
  results: SkillResult[];
  confidence: 'high' | 'medium' | 'low_enriched' | 'no_match';
  enriched: boolean;

  // Tier 2: available if caller wants to await better results
  enrichmentPromise?: Promise<FindSkillResponse>;

  // Tier 3: composition detection
  composition?: CompositionResult;

  // Tier 3: debug/analytics trace
  searchTrace?: {
    originalQuery: string;
    alternateQueries?: string[];
    terminologyMap?: Record<string, string>;
    reasoning?: string;
  };

  // Tier 3 no-match: hints for skill generation
  generationHints?: {
    intent: string;
    capabilities: string[];
    complexity: string;
  };

  meta: {
    matchSources: string[]; // which embedding types matched top 3
    latencyMs: number;
    tier: 1 | 2 | 3;
    cacheHit: boolean;
    llmInvoked: boolean;
    degraded?: boolean; // true when circuit breaker is open (vector-only results)
    reranked?: boolean; // true when cross-encoder reranking was applied
  };
}

export interface SkillResult {
  id: string;
  name: string;
  slug: string;
  version: string;
  agentSummary: string;

  // Trust
  trustScore: number;
  verificationTier: VerificationTier;
  trustBadge: TrustBadge | null;

  // Status
  status: SkillStatus;
  revokedReason?: string;
  remediationMessage?: string;
  remediationUrl?: string;

  // Execution
  executionLayer: string;
  mcpUrl?: string;
  capabilitiesRequired: string[];

  // Composition
  skillType: SkillType;
  forkedFrom?: string;

  // v5.2: Environment
  runtimeEnv: string;
  visibility: string;

  // Usage
  runCount: number;
  lastRunAt?: string;

  // Search signals
  score: number;
  matchSource: string;
  matchText?: string;

  // Deprecation auto-migration
  replacementSkillId?: string;
  replacementSlug?: string;

  // Share
  shareUrl: string;

  // Social (optional, for enriched results)
  authorHandle?: string;
  authorType?: 'human' | 'bot' | 'org';
  humanStarCount?: number;
  humanForkCount?: number;
  agentInvocationCount?: number;
  compositionInclusionCount?: number;
  avgExecutionTimeMs?: number;
  errorRate?: number;
  tags?: string[];
  cooccursWith?: { skillId: string; slug: string; compositionCount: number }[];

  // Extended analysis (optional, from Circle-IR dedicated endpoints)
  qualityScore?: number;
  qualityTier?: string;
  trustTier?: string;
  specAlignmentScore?: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Composition Detection
// ──────────────────────────────────────────────────────────────────────────────

export interface CompositionResult {
  detected: boolean;
  parts: Array<{
    purpose: string;
    skill: ScoredSkill | null;
  }>;
  reasoning: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Search Provider Interface (SearchProvider abstraction layer)
// ──────────────────────────────────────────────────────────────────────────────

export interface SearchFilters {
  tenantId: string;
  tags?: string[];
  category?: string;
  minTrustScore?: number; // trust-based filtering
  executionLayer?: string; // filter by execution capability
  contentSafetyRequired?: boolean; // default true
  allowVulnerable?: boolean; // v5.0: include vulnerable/contains-vulnerable skills
  statusFilter?: SkillStatus[]; // v5.0: explicit status filter
  slug?: string; // v5.0: pin to specific slug
  version?: string; // v5.0: pin to specific version
  // v5.2: execution environment + visibility
  runtimeEnv?: string[]; // filter by runtime environment(s)
  visibility?: 'public' | 'private' | 'unlisted'; // default: respects tenant scope
}

export interface SearchOptions {
  limit?: number; // default 10
  offset?: number;
  includeMatchText?: boolean; // include source_text for debugging
}

export interface SearchResult {
  results: ScoredSkill[];
  confidence: ConfidenceSignal;
  meta: SearchMeta;
}

export interface ScoredSkill {
  skillId: string;
  score: number; // cosine similarity (0–1)
  fullTextScore: number; // tsvector rank (normalized 0–1)
  fusedScore: number; // final score after fusion
  matchSource: string; // which embedding type matched
  matchText?: string; // the text that matched
}

export interface ConfidenceSignal {
  topScore: number;
  gapToSecond: number;
  clusterDensity: number; // count of results above tier2 threshold
  keywordHits: number;
  tier: 1 | 2 | 3;
}

export interface SearchMeta {
  latencyMs: number;
  vectorSearchMs: number;
  fullTextSearchMs: number;
  fusionStrategy: 'score_blend' | 'rrf';
  totalCandidates: number;
  cacheHit: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Monitoring & Logging
// ──────────────────────────────────────────────────────────────────────────────

export interface SearchLogEntry {
  // Query
  query: string;
  tenantId: string;
  appetite?: string;

  // Routing
  tier: 1 | 2 | 3;
  cacheHit: boolean;

  // Results
  topScore?: number;
  gapToSecond?: number;
  clusterDensity?: number;
  keywordHits?: number;
  resultCount: number;
  matchSource?: string;
  resultSkillIds: string[];

  // Performance
  totalLatencyMs: number;
  vectorSearchMs?: number;
  fullTextSearchMs?: number;
  fusionStrategy?: string;

  // LLM usage
  llmInvoked: boolean;
  llmLatencyMs?: number;
  llmModel?: string;
  llmTokensUsed?: number;

  // Cost tracking (USD estimates)
  embeddingCost: number;
  llmCost: number;

  // Deep search trace (Tier 3 only)
  alternateQueriesUsed?: string[];
  compositionDetected: boolean;
  generationHintReturned: boolean;
}

export interface QualityFeedback {
  searchEventId: string;
  skillId: string;
  feedbackType: 'click' | 'use' | 'dismiss' | 'explicit_good' | 'explicit_bad';
  position: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Analytics
// ──────────────────────────────────────────────────────────────────────────────

export interface TierDistribution {
  tier1: number;
  tier2: number;
  tier3: number;
}

export interface MatchSourceStats {
  matchSource: string;
  queryCount: number;
  avgTopScore: number;
  useCount: number;
}

export interface LatencyPercentiles {
  p50: number;
  p95: number;
  p99: number;
  p999: number;
}

export interface CostBreakdown {
  totalCost: number;
  embeddingCost: number;
  llmCost: number;
  byTier: {
    tier1: number;
    tier2: number;
    tier3: number;
  };
}

export interface FailedQuery {
  query: string;
  timestamp: Date;
  tier: number;
  topScore?: number;
  dismissCount: number;
}

export interface Tier3Pattern {
  pattern: string;
  frequency: number;
  avgTopScore: number;
  alternateQueriesUsed: string[];
}

// ──────────────────────────────────────────────────────────────────────────────
// Eval Suite
// ──────────────────────────────────────────────────────────────────────────────

export interface EvalFixture {
  id: string;
  query: string;
  expectedSkillId: string;
  acceptableSkillIds?: readonly string[]; // Additional IDs that count as correct (e.g., duplicates from other sources)
  acceptableNamePatterns?: readonly string[]; // Name substrings that auto-match (e.g., 'prometheus' matches any Prometheus MCP server)
  pattern: 'direct' | 'problem' | 'business' | 'alternate' | 'composition';
}

export interface EvalMetrics {
  recall1: number; // correct skill in top 1
  recall5: number; // correct skill in top 5
  mrr: number; // mean reciprocal rank
  avgTopScore: number;
  tierDistribution: Record<1 | 2 | 3, number>;
  byPattern: Record<string, { recall5: number; mrr: number }>; // per phrasing pattern

  // Phase 2: Enhanced metrics
  tierAccuracy: Record<1 | 2 | 3, { total: number; correct: number; accuracy: number }>;
  latencyByTier: Record<1 | 2 | 3, { p50: number; p95: number; p99: number }>;
  llmFallbackLift: {
    tier2: { total: number; enrichedImproved: number; liftRate: number };
    tier3: { total: number; enrichedImproved: number; liftRate: number };
  };

  // Phase 3: match source distribution
  matchSourceDistribution: Record<string, { count: number; correctAtRank1: number; avgScore: number }>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Cloudflare Workers Environment
// ──────────────────────────────────────────────────────────────────────────────

export interface Env {
  // Bindings
  SEARCH_CACHE: KVNamespace;
  HYPERDRIVE: Hyperdrive;
  AI: Ai;

  // Environment variables
  ENVIRONMENT: string;
  EMBEDDING_MODEL: string;
  RERANKER_MODEL: string;
  LLM_MODEL: string;
  SAFETY_MODEL: string;
  CONFIDENCE_TIER1_THRESHOLD: string;
  CONFIDENCE_TIER2_THRESHOLD: string;
  CACHE_TTL_SECONDS: string;
  DEFAULT_APPETITE: string;
  VECTOR_WEIGHT: string;
  FULLTEXT_WEIGHT: string;
  DISABLE_CONTENT_SAFETY?: string; // Set to "true" to skip content safety checks (dev/testing only)

  // Phase 2: Confidence gate tuning
  SCORE_GAP_THRESHOLD?: string; // Min gap for high confidence (default: "0.05")
  CLUSTER_DENSITY_THRESHOLD?: string; // Relative threshold for cluster density (default: "0.05")
  DEEP_SEARCH_ENABLED?: string; // Enable LLM deep search (default: "true")
  LLM_MAX_TOKENS?: string; // Max tokens for LLM calls (default: "500")

  // Phase 3: Multi-vector indexing
  MULTI_VECTOR_ENABLED?: string; // Set to "true" to enable multi-vector indexing

  // Phase 4: Production polish
  CIRCUIT_BREAKER_THRESHOLD?: string; // Consecutive failures before circuit opens (default: "3")
  CIRCUIT_BREAKER_COOLDOWN_MS?: string; // Cooldown before half-open retry (default: "30000")
  RATE_LIMIT_RPM?: string; // Max requests per minute per IP (default: "100")
  RERANKER_ENABLED?: string; // Set to "true" to enable cross-encoder reranking
  RERANKER_TOP_N?: string; // Number of candidates to rerank (default: "20")
  SKIP_RERANKER_GAP?: string; // T1 gap above which reranker is skipped (default: "0.10")

  // Phase 5: Sync pipelines & publish API
  EMBED_QUEUE: Queue;
  COGNIUM_QUEUE: Queue;
  COGNIUM_POLL_QUEUE: Queue; // v5.0: poll queue for async job flow
  SKILL_EVENTS?: Queue;       // v5.4: skill revocation/vulnerability events for Cortex
  ANALYSIS_QUEUE: Queue;      // v5.4: analysis submit queue (quality/trust/understand/spec-diff)
  ANALYSIS_POLL_QUEUE: Queue; // v5.4: analysis poll queue
  COGNIUM_JOBS: KVNamespace; // v5.0: job state KV namespace (also used for analysis jobs)
  R2_BUCKET: R2Bucket;
  NEON_CONNECTION_STRING: string;
  GITHUB_TOKEN?: string;
  SYNC_MCP_ENABLED?: string; // default "true"
  SYNC_CLAWHUB_ENABLED?: string; // default "true"
  SYNC_GITHUB_ENABLED?: string; // default "true"
  SYNC_GLAMA_ENABLED?: string; // default "true"
  SYNC_SMITHERY_ENABLED?: string; // default "true"
  SYNC_PULSEMCP_ENABLED?: string; // default "true"
  SYNC_OPENCLAW_ENABLED?: string; // default "true"

  // v5.0: Cognium client configuration
  COGNIUM_ENABLED?: string;         // default "true" — set to "false" to halt all cron + queue cognium scanning
  ANALYSIS_ENABLED?: string;        // default "true" — set to "false" to halt analysis queue processing
  COGNIUM_URL?: string; // default "https://circle.cognium.net"
  COGNIUM_API_KEY?: string;
  COGNIUM_POLL_DELAY_MS?: string; // default "15000"
  COGNIUM_MAX_POLL_ATTEMPTS?: string; // default "12"
  COGNIUM_FAST_BATCH_SIZE?: string; // default "10" — non-GitHub skills per cron cycle
  COGNIUM_REPO_BATCH_SIZE?: string; // default "3"  — GitHub/repo skills per cron cycle
  COGNIUM_MAX_INFLIGHT?: string;    // default "20" — skip submissions if too many jobs pending

  // v5.0: Admin API authentication
  ADMIN_API_KEY?: string; // Set via: wrangler secret put ADMIN_API_KEY

  // v5.0: Notifications
  ACTIVEPIECES_WEBHOOK_URL?: string;

  // v5.0: Version ranking weights
  VERSION_TRUST_WEIGHT?: string; // default "0.7"
  VERSION_USAGE_WEIGHT?: string; // default "0.3"

  // Trust-score ranking boost
  TRUST_BOOST_WEIGHT?: string; // default "0.3" — multiplicative boost on fusedScore
  CANDIDATE_POOL_MULTIPLIER?: string; // default "3" — fetch N× candidates before trust-boost pagination
  NAME_BOOST_WEIGHT?: string; // default "0.15" — boost for query-to-name token overlap
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 5: Sync Pipeline Types
// ──────────────────────────────────────────────────────────────────────────────

export interface SyncResult {
  source: string;
  synced: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

export interface SkillUpsert {
  name: string;
  slug: string;
  description: string;
  version?: string;
  schemaJson?: Record<string, unknown>;
  executionLayer: 'mcp-remote' | 'instructions' | 'worker' | 'container';
  mcpUrl?: string;
  skillMd?: string;
  changelog?: string;
  repositoryUrl?: string;
  capabilitiesRequired?: string[];
  source: string;
  sourceUrl: string;
  sourceHash: string;
  trustScore?: number;
  // v5.2
  runtimeEnv?: string;
  visibility?: 'public' | 'private' | 'unlisted';
  tenantId?: string;
}

export interface EmbedQueueMessage {
  skillId: string;
  action: 'embed';
  source?: string;
}

// v5.0: Cognium submit message (replaces CogniumQueueMessage)
export interface CogniumSubmitMessage {
  skillId: string;
  priority: 'normal' | 'high';
  timestamp: number;
}

// v5.0: Cognium poll message
export interface CogniumPollMessage {
  skillId: string;
  jobId: string;
  attempt: number;
}

// v5.4: Analysis queue messages (re-exported from cognium/types)
export type { AnalysisEndpoint, AnalysisSubmitMessage, AnalysisPollMessage } from './cognium/types';

// ──────────────────────────────────────────────────────────────────────────────
// Composition & Social Layer Types (v4)
// ──────────────────────────────────────────────────────────────────────────────

export interface CompositionInput {
  name: string;
  slug?: string;
  description: string;
  tags?: string[];
  authorId: string;
  authorType: 'human' | 'bot';
  steps: {
    skillId: string;
    stepName?: string;
    inputMapping?: Record<string, string>;
    onError?: 'fail' | 'skip' | 'retry';
  }[];
}

export interface InvocationBatch {
  invocations: {
    skillId: string;
    compositionId?: string;
    tenantId: string;
    callerType: 'agent' | 'human';
    durationMs?: number;
    succeeded: boolean;
  }[];
}

export interface CoOccurrenceResult {
  skillId: string;
  name: string;
  slug: string;
  compositionCount: number;
  totalPairedInvocations: number;
}

export interface ForkResult {
  id: string;
  slug: string;
  version: string;
  forkedFrom: string;
  trustScore: number;
  status: SkillStatus;
}

export interface LeaderboardFilters {
  skillType?: SkillType;
  category?: string;
  ecosystem?: string;
  limit?: number;
  offset?: number;
}

export interface LeaderboardEntry {
  id: string;
  slug: string;
  name: string;
  skillType: string;
  authorHandle: string;
  authorType: string;
  score: number;
  trustScore: number;
  humanStarCount?: number;
  humanForkCount?: number;
  agentInvocationCount?: number;
  weeklyAgentInvocationCount?: number;
  compositionInclusionCount?: number;
  avgExecutionTimeMs?: number;
  errorRate?: number;
}
