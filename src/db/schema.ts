// ══════════════════════════════════════════════════════════════════════════════
// Drizzle Schema Definitions
// ══════════════════════════════════════════════════════════════════════════════
//
// Defines database schema for type-safe queries.
//
// Note: The skills table is managed by the broader Runics platform.
// This file defines it for type safety, but search service doesn't create it.
//
// ══════════════════════════════════════════════════════════════════════════════

import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  boolean,
  jsonb,
  integer,
  smallint,
  real,
  bigint,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ──────────────────────────────────────────────────────────────────────────────
// Skills Table (Platform-Managed, Defined for Type Safety)
// ──────────────────────────────────────────────────────────────────────────────

export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    version: text('version').notNull().default('1.0.0'),
    source: text('source').notNull(),
    description: text('description'),
    agentSummary: text('agent_summary'),
    alternateQueries: text('alternate_queries').array(),
    schemaJson: jsonb('schema_json'),
    authRequirements: jsonb('auth_requirements'),
    installMethod: jsonb('install_method'),
    trustScore: numeric('trust_score', { precision: 3, scale: 2 }).default('0.5'),
    cogniumScanned: boolean('cognium_scanned').default(false),
    cogniumReport: jsonb('cognium_report'),
    capabilitiesRequired: text('capabilities_required').array(),
    executionLayer: text('execution_layer').notNull(),
    sourceExecutionId: uuid('source_execution_id'),
    reuseCount: integer('reuse_count').default(0),
    contentSafetyPassed: boolean('content_safety_passed'),
    tags: text('tags').array(),
    category: text('category'),
    // Phase 5: Sync pipeline columns
    sourceUrl: text('source_url'),
    sourceHash: text('source_hash'),
    mcpUrl: text('mcp_url'),
    skillMd: text('skill_md'),
    r2BundleKey: text('r2_bundle_key'),
    tenantId: text('tenant_id'),
    cogniumScannedAt: timestamp('cognium_scanned_at'),
    // Composition & Social layer (v4)
    // Author attribution
    authorId: uuid('author_id'),
    authorType: text('author_type').notNull().default('human'),
    authorBotModel: text('author_bot_model'),
    authorBotPromptHash: text('author_bot_prompt_hash'),
    // Type and status
    type: text('type').notNull().default('skill'),
    status: text('status').notNull().default('published'),
    // Fork lineage
    forkOf: uuid('fork_of'),
    originId: uuid('origin_id'),
    forkDepth: integer('fork_depth').default(0),
    // Metadata
    readme: text('readme'),
    categories: text('categories').array().default(sql`'{}'`),
    ecosystem: text('ecosystem'),
    language: text('language'),
    license: text('license'),
    logoUrl: text('logo_url'),
    homepageUrl: text('homepage_url'),
    demoUrl: text('demo_url'),
    changelog: jsonb('changelog').default([]),
    // Agent quality signals
    avgExecutionTimeMs: real('avg_execution_time_ms'),
    p95ExecutionTimeMs: real('p95_execution_time_ms'),
    errorRate: real('error_rate'),
    agentConsumptionPattern: text('agent_consumption_pattern'),
    schemaCompatibilityScore: real('schema_compatibility_score'),
    replacementSkillId: uuid('replacement_skill_id'),
    adversarialTested: boolean('adversarial_tested').default(false),
    provenanceAttested: boolean('provenance_attested').default(false),
    // Human social counters
    humanStarCount: integer('human_star_count').default(0),
    humanForkCount: integer('human_fork_count').default(0),
    humanCopyCount: integer('human_copy_count').default(0),
    humanUseCount: integer('human_use_count').default(0),
    // Agent counters
    agentInvocationCount: bigint('agent_invocation_count', { mode: 'number' }).default(0),
    agentForkCount: integer('agent_fork_count').default(0),
    compositionInclusionCount: integer('composition_inclusion_count').default(0),
    dependentCount: integer('dependent_count').default(0),
    weeklyAgentInvocationCount: integer('weekly_agent_invocation_count').default(0),
    // Editorial
    featured: boolean('featured').default(false),
    verifiedCreator: boolean('verified_creator').default(false),
    collectionIds: uuid('collection_ids').array().default(sql`'{}'`),
    // Lifecycle
    publishedAt: timestamp('published_at'),
    lastUsedAt: timestamp('last_used_at'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => ({
    trustScoreIdx: index('idx_skills_trust_score').on(table.trustScore),
    sourceIdx: index('idx_skills_source').on(table.source),
    slugIdx: index('idx_skills_slug').on(table.slug),
    executionLayerIdx: index('idx_skills_execution_layer').on(table.executionLayer),
    authorIdIdx: index('idx_skills_author_id').on(table.authorId),
    typeIdx: index('idx_skills_type').on(table.type),
    forkOfIdx: index('idx_skills_fork_of').on(table.forkOf),
    originIdIdx: index('idx_skills_origin_id').on(table.originId),
  })
);

// ──────────────────────────────────────────────────────────────────────────────
// Skill Embeddings Table (Search-Managed)
// ──────────────────────────────────────────────────────────────────────────────

export const skillEmbeddings = pgTable(
  'skill_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id').notNull(),
    // embedding: vector type handled by raw SQL (pgvector extension)
    source: text('source').notNull().default('agent_summary'),
    sourceText: text('source_text').notNull(),
    // tsv: tsvector type handled by raw SQL (generated column)
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    skillIdIdx: index('idx_skill_embeddings_skill_id').on(table.skillId),
    tenantIdIdx: index('idx_skill_embeddings_tenant_id').on(table.tenantId),
    // HNSW and GIN indexes created via raw SQL migrations
  })
);

// ──────────────────────────────────────────────────────────────────────────────
// Search Logs Table (Monitoring)
// ──────────────────────────────────────────────────────────────────────────────

export const searchLogs = pgTable(
  'search_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    timestamp: timestamp('timestamp').defaultNow(),

    // Query
    query: text('query').notNull(),
    tenantId: text('tenant_id').notNull(),
    appetite: text('appetite'),

    // Routing
    tier: smallint('tier').notNull(),
    cacheHit: boolean('cache_hit').default(false),

    // Results
    topScore: real('top_score'),
    gapToSecond: real('gap_to_second'),
    clusterDensity: smallint('cluster_density'),
    keywordHits: smallint('keyword_hits'),
    resultCount: smallint('result_count'),
    matchSource: text('match_source'),
    resultSkillIds: text('result_skill_ids').array(),

    // Performance
    totalLatencyMs: real('total_latency_ms'),
    vectorSearchMs: real('vector_search_ms'),
    fullTextSearchMs: real('full_text_search_ms'),
    fusionStrategy: text('fusion_strategy'),

    // LLM usage
    llmInvoked: boolean('llm_invoked').default(false),
    llmLatencyMs: real('llm_latency_ms'),
    llmModel: text('llm_model'),
    llmTokensUsed: integer('llm_tokens_used'),

    // Cost tracking
    embeddingCost: real('embedding_cost').default(0),
    llmCost: real('llm_cost').default(0),

    // Deep search trace
    alternateQueriesUsed: text('alternate_queries_used').array(),
    compositionDetected: boolean('composition_detected').default(false),
    generationHintReturned: boolean('generation_hint_returned').default(false),
  },
  (table) => ({
    timestampIdx: index('idx_search_logs_timestamp').on(table.timestamp),
    tenantIdx: index('idx_search_logs_tenant').on(table.tenantId, table.timestamp),
    tierIdx: index('idx_search_logs_tier').on(table.tier),
    matchSourceIdx: index('idx_search_logs_match_source').on(table.matchSource),
  })
);

// ──────────────────────────────────────────────────────────────────────────────
// Quality Feedback Table (Quality Learning)
// ──────────────────────────────────────────────────────────────────────────────

export const qualityFeedback = pgTable(
  'quality_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    searchEventId: uuid('search_event_id').references(() => searchLogs.id),
    skillId: uuid('skill_id').notNull(),
    feedbackType: text('feedback_type').notNull(),
    position: smallint('position').notNull(),
    timestamp: timestamp('timestamp').defaultNow(),
  },
  (table) => ({
    eventIdx: index('idx_feedback_event').on(table.searchEventId),
    skillIdx: index('idx_feedback_skill').on(table.skillId),
    typeIdx: index('idx_feedback_type').on(table.feedbackType, table.timestamp),
  })
);

// ──────────────────────────────────────────────────────────────────────────────
// Authors Table (Composition & Social Layer)
// ──────────────────────────────────────────────────────────────────────────────

export const authors = pgTable(
  'authors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    handle: text('handle').notNull().unique(),
    displayName: text('display_name'),
    authorType: text('author_type').notNull().default('human'),
    bio: text('bio'),
    avatarUrl: text('avatar_url'),
    homepageUrl: text('homepage_url'),
    botModel: text('bot_model'),
    botOperatorId: uuid('bot_operator_id'),
    totalSkillsPublished: integer('total_skills_published').default(0),
    totalHumanStarsReceived: integer('total_human_stars_received').default(0),
    totalHumanForksReceived: integer('total_human_forks_received').default(0),
    verified: boolean('verified').default(false),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    handleIdx: index('idx_authors_handle').on(table.handle),
    typeIdx: index('idx_authors_type').on(table.authorType),
  })
);

// ──────────────────────────────────────────────────────────────────────────────
// User Stars Table (Human-Only Social Action)
// ──────────────────────────────────────────────────────────────────────────────

export const userStars = pgTable(
  'user_stars',
  {
    userId: uuid('user_id').notNull(),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    pk: uniqueIndex('idx_user_stars_pk').on(table.userId, table.skillId),
    userIdx: index('idx_user_stars_user').on(table.userId),
    skillIdx: index('idx_user_stars_skill').on(table.skillId),
  })
);

// ──────────────────────────────────────────────────────────────────────────────
// Composition Steps Table
// ──────────────────────────────────────────────────────────────────────────────

export const compositionSteps = pgTable(
  'composition_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    compositionId: uuid('composition_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    stepOrder: smallint('step_order').notNull(),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id),
    stepName: text('step_name'),
    inputMapping: jsonb('input_mapping'),
    condition: jsonb('condition'),
    onError: text('on_error').default('fail'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    compositionIdx: index('idx_composition_steps_composition').on(table.compositionId),
    skillIdx: index('idx_composition_steps_skill').on(table.skillId),
    orderUnique: uniqueIndex('idx_composition_steps_order').on(
      table.compositionId,
      table.stepOrder
    ),
  })
);

// ──────────────────────────────────────────────────────────────────────────────
// Skill Invocations Table (Agent Signal Tracking)
// ──────────────────────────────────────────────────────────────────────────────

export const skillInvocations = pgTable(
  'skill_invocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id),
    compositionId: uuid('composition_id').references(() => skills.id),
    tenantId: text('tenant_id').notNull(),
    callerType: text('caller_type').notNull().default('agent'),
    durationMs: integer('duration_ms'),
    succeeded: boolean('succeeded').notNull(),
    invokedAt: timestamp('invoked_at').defaultNow(),
  },
  (table) => ({
    skillIdx: index('idx_invocations_skill').on(table.skillId, table.invokedAt),
    compositionIdx: index('idx_invocations_composition').on(table.compositionId),
    tenantIdx: index('idx_invocations_tenant').on(table.tenantId, table.invokedAt),
  })
);

// ──────────────────────────────────────────────────────────────────────────────
// Type Exports
// ──────────────────────────────────────────────────────────────────────────────

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;

export type SkillEmbedding = typeof skillEmbeddings.$inferSelect;
export type NewSkillEmbedding = typeof skillEmbeddings.$inferInsert;

export type SearchLog = typeof searchLogs.$inferSelect;
export type NewSearchLog = typeof searchLogs.$inferInsert;

export type QualityFeedback = typeof qualityFeedback.$inferSelect;
export type NewQualityFeedback = typeof qualityFeedback.$inferInsert;

export type Author = typeof authors.$inferSelect;
export type NewAuthor = typeof authors.$inferInsert;

export type UserStar = typeof userStars.$inferSelect;
export type NewUserStar = typeof userStars.$inferInsert;

export type CompositionStep = typeof compositionSteps.$inferSelect;
export type NewCompositionStep = typeof compositionSteps.$inferInsert;

export type SkillInvocation = typeof skillInvocations.$inferSelect;
export type NewSkillInvocation = typeof skillInvocations.$inferInsert;
