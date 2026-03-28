// ══════════════════════════════════════════════════════════════════════════════
// Publish API — Zod Validation Schemas
// ══════════════════════════════════════════════════════════════════════════════

import { z } from 'zod';

export const publishSkillSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string().optional(),
  description: z.string().min(10).max(2000),
  schemaJson: z.record(z.unknown()).optional(),
  executionLayer: z.enum(['mcp-remote', 'instructions', 'worker', 'container', 'composite']),
  mcpUrl: z.string().url().optional(),
  skillMd: z.string().optional(),
  capabilitiesRequired: z.array(z.string()).optional(),
  source: z.enum(['manual', 'forge', 'human-distilled', 'mcp-registry', 'clawhub', 'github']).optional(),
  sourceUrl: z.string().optional(),
  tenantId: z.string().uuid().optional(),
  trustScore: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  category: z.string().optional(),
  // Author attribution (v4)
  authorId: z.string().uuid().optional(),
  authorHandle: z.string().optional(),
  authorType: z.enum(['human', 'bot', 'org']).optional(),
  authorBotModel: z.string().optional(),
  // v5.0: new fields
  skillType: z.enum(['atomic', 'auto-composite', 'human-composite', 'forked']).optional(),
  compositionSkillIds: z.array(z.string().uuid()).optional(),
  forkedFrom: z.string().optional(),
  forkedBy: z.string().optional(),
  forkChanges: z.array(z.string()).optional(),
  humanDistilledBy: z.string().optional(),
  trustBadge: z.enum(['human-verified', 'auto-distilled', 'upstream']).optional(),
  altQueries: z.array(z.string()).optional(),
  // v5.2: execution environment + visibility
  runtimeEnv: z.enum(['llm', 'api', 'browser', 'vm', 'local', 'device']).optional(),
  visibility: z.enum(['public', 'private', 'unlisted']).optional(),
  environmentVariables: z.array(z.string()).optional(),
});

export const updateSkillSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().min(10).max(2000).optional(),
  schemaJson: z.record(z.unknown()).optional(),
  mcpUrl: z.string().url().optional(),
  skillMd: z.string().optional(),
  capabilitiesRequired: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  category: z.string().optional(),
  categories: z.array(z.string()).optional(),
  runtimeEnv: z.enum(['llm', 'api', 'browser', 'vm', 'local', 'device']).optional(),
  visibility: z.enum(['public', 'private', 'unlisted']).optional(),
  environmentVariables: z.array(z.string()).optional(),
});

// v5.0: Full attestation schema (Cognium writes directly)
export const attestationUpdateSchema = z.object({
  trustScore: z.number().min(0).max(1),
  tier: z.enum(['unverified', 'scanned', 'verified', 'certified']),
  contentSafe: z.boolean(),
  scanCoverage: z.enum(['full', 'partial', 'text-only']),
  recommendedStatus: z.enum(['published', 'vulnerable', 'revoked']),
  statusReason: z.string().optional(),
  remediationMessage: z.string().optional(),
  remediationUrl: z.string().optional(),
  findings: z.array(z.object({
    severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
    tool: z.string(),
    cweId: z.string().optional(),
    title: z.string(),
    description: z.string(),
    confidence: z.number().optional(),
    verdict: z.string().optional(),
    llmVerified: z.boolean().optional(),
    remediationHint: z.string().optional(),
    remediationUrl: z.string().optional(),
  })),
  analyzerSummary: z.record(z.unknown()),
  scannedAt: z.string().datetime(),
});

// v5.0: Owner status change schema
export const statusChangeSchema = z.object({
  status: z.enum(['deprecated', 'published']),
  reason: z.string().optional(),
  replacementSkillId: z.string().uuid().optional(),
});

export type PublishSkillInput = z.infer<typeof publishSkillSchema>;
export type UpdateSkillInput = z.infer<typeof updateSkillSchema>;
export type AttestationUpdateInput = z.infer<typeof attestationUpdateSchema>;
export type StatusChangeInput = z.infer<typeof statusChangeSchema>;
