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
  executionLayer: z.enum(['mcp-remote', 'instructions', 'worker', 'container']),
  mcpUrl: z.string().url().optional(),
  skillMd: z.string().optional(),
  capabilitiesRequired: z.array(z.string()).optional(),
  source: z.enum(['manual', 'forge', 'cognium']).optional(),
  sourceUrl: z.string().optional(),
  tenantId: z.string().uuid().optional(),
  trustScore: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  category: z.string().optional(),
});

export const updateSkillSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().min(10).max(2000).optional(),
  schemaJson: z.record(z.unknown()).optional(),
  executionLayer: z.enum(['mcp-remote', 'instructions', 'worker', 'container']).optional(),
  mcpUrl: z.string().url().optional(),
  skillMd: z.string().optional(),
  capabilitiesRequired: z.array(z.string()).optional(),
  trustScore: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  category: z.string().optional(),
});

export const trustUpdateSchema = z.object({
  trustScore: z.number().min(0).max(1),
  cogniumReport: z.object({
    contentSafe: z.boolean(),
    findings: z.array(
      z.object({
        tool: z.string(),
        severity: z.enum(['low', 'medium', 'high', 'critical']),
        message: z.string(),
      })
    ),
    scannedAt: z.string().datetime(),
  }),
});

export type PublishSkillInput = z.infer<typeof publishSkillSchema>;
export type UpdateSkillInput = z.infer<typeof updateSkillSchema>;
export type TrustUpdateInput = z.infer<typeof trustUpdateSchema>;
