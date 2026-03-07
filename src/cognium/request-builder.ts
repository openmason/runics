// ══════════════════════════════════════════════════════════════════════════════
// Cognium Client — Request Builder
// ══════════════════════════════════════════════════════════════════════════════
//
// Maps a Runics Skill → CircleIRAnalyzeRequest.
// Circle-IR has no knowledge of source, priority, or composition.
//
// ══════════════════════════════════════════════════════════════════════════════

import type { CircleIRAnalyzeRequest, SkillRow } from './types';

export function buildCircleIRRequest(skill: SkillRow): CircleIRAnalyzeRequest {
  const code = skill.r2BundleKey
    ? `// Code bundle at R2: ${skill.r2BundleKey}\n// Bundle key provided for external fetch`
    : skill.skillMd ?? skill.description;

  const language = inferLanguage(skill);

  return {
    code,
    filename: skill.slug,
    language,
  };
}

function inferLanguage(skill: SkillRow): CircleIRAnalyzeRequest['language'] {
  if (skill.executionLayer === 'mcp-remote' || skill.executionLayer === 'instructions') {
    return 'typescript';
  }
  if (skill.slug.includes('-rust') || skill.sourceUrl?.includes('Cargo.toml')) return 'rust';
  if (skill.slug.includes('-py') || skill.sourceUrl?.includes('.py')) return 'python';
  if (skill.slug.includes('-java') || skill.sourceUrl?.includes('.java')) return 'java';
  return 'typescript';
}
