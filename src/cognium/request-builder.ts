// ══════════════════════════════════════════════════════════════════════════════
// Cognium Client — Request Builder
// ══════════════════════════════════════════════════════════════════════════════
//
// Maps a Runics Skill → CircleIRSkillAnalyzeRequest.
// Mode A: repo_url for GitHub-sourced skills with a source URL.
// Mode B: inline files for ClawHub / registry skills (SKILL.md, description).
//
// ══════════════════════════════════════════════════════════════════════════════

import type { CircleIRSkillAnalyzeRequest, SkillRow } from './types';
import { isGitHubRepoUrl } from '../sync/utils';

export function buildCircleIRRequest(skill: SkillRow): CircleIRSkillAnalyzeRequest {
  const skillContext: CircleIRSkillAnalyzeRequest['skill_context'] = {
    name: skill.name,
    description: skill.description,
    source_registry: skill.source,
    source_url: skill.sourceUrl ?? undefined,
    execution_layer: skill.executionLayer,
  };

  const options: CircleIRSkillAnalyzeRequest['options'] = {
    enable_sast: true,
    enable_instruction_analysis: true,
    enable_capability_mismatch: true,
    enable_llm_verification: true,
  };

  // Mode A: Use repo URL for full code analysis
  // Priority: sourceUrl (if GitHub) > repositoryUrl (discovered from upstream metadata)
  const repoUrl = isGitHubRepoUrl(skill.sourceUrl)
    ? skill.sourceUrl!
    : isGitHubRepoUrl(skill.repositoryUrl)
      ? skill.repositoryUrl!
      : null;

  if (repoUrl) {
    return {
      repo_url: repoUrl,
      skill_context: skillContext,
      options,
    };
  }

  // Mode B: Inline files for ClawHub / registry / manual skills
  const files = buildInlineFiles(skill);
  return {
    files,
    skill_context: skillContext,
    options,
  };
}

// Max sizes per inline file to prevent request bloat (512 KB total budget)
const MAX_FILE_SIZE = 256 * 1024; // 256 KB per file
const MAX_SCHEMA_SIZE = 64 * 1024; // 64 KB for schema JSON

function truncate(content: string, maxBytes: number): string {
  if (content.length <= maxBytes) return content;
  return content.slice(0, maxBytes) + '\n... [truncated]';
}

function buildInlineFiles(skill: SkillRow): Record<string, string> {
  const files: Record<string, string> = {};

  // SKILL.md — the primary LLM instructions document
  if (skill.skillMd) {
    files['SKILL.md'] = truncate(skill.skillMd, MAX_FILE_SIZE);
  }

  // Description as fallback context (always include if non-trivial)
  if (skill.description && skill.description.length > 20) {
    files['DESCRIPTION.md'] = truncate(skill.description, MAX_FILE_SIZE);
  }

  // Schema JSON — declares capabilities/inputs the skill advertises
  if (skill.schemaJson) {
    const raw = JSON.stringify(skill.schemaJson, null, 2);
    files['schema.json'] = truncate(raw, MAX_SCHEMA_SIZE);
  }

  // If we have an R2 bundle key, note it for context (actual code is fetched separately)
  if (skill.r2BundleKey) {
    files['_metadata.json'] = JSON.stringify({
      r2_bundle_key: skill.r2BundleKey,
      note: 'Code bundle stored in R2. SAST should analyze fetched bundle contents.',
    });
  }

  // If there are no files at all, send description as SKILL.md fallback
  if (Object.keys(files).length === 0) {
    files['SKILL.md'] = truncate(skill.description || skill.name, MAX_FILE_SIZE);
  }

  return files;
}
