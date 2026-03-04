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
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => ({
    trustScoreIdx: index('idx_skills_trust_score').on(table.trustScore),
    sourceIdx: index('idx_skills_source').on(table.source),
    slugIdx: index('idx_skills_slug').on(table.slug),
    executionLayerIdx: index('idx_skills_execution_layer').on(table.executionLayer),
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
