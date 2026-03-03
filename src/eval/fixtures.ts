// ══════════════════════════════════════════════════════════════════════════════
// Eval Fixtures — Query/Skill Test Pairs
// ══════════════════════════════════════════════════════════════════════════════
//
// Minimum 30 pairs across all 5 phrasing patterns.
// These fixtures are used to measure baseline search quality in Phase 1
// and validate improvements in subsequent phases.
//
// Pattern definitions:
// - direct: User knows exactly what they want
// - problem: User describes their problem, not the solution
// - business: Non-technical/PM language
// - alternate: Different terminology for same concept
// - composition: Part of a larger workflow
//
// ══════════════════════════════════════════════════════════════════════════════

import type { EvalFixture } from '../types';

export const evalFixtures: EvalFixture[] = [
  // ──────────────────────────────────────────────────────────────────────────
  // DIRECT Pattern (6 fixtures)
  // ──────────────────────────────────────────────────────────────────────────

  {
    id: 'eval-direct-001',
    query: 'check rust dependency licenses',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440001',
    pattern: 'direct',
  },
  {
    id: 'eval-direct-002',
    query: 'format typescript code',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440002',
    pattern: 'direct',
  },
  {
    id: 'eval-direct-003',
    query: 'lint javascript files',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440003',
    pattern: 'direct',
  },
  {
    id: 'eval-direct-004',
    query: 'scan docker images for vulnerabilities',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440004',
    pattern: 'direct',
  },
  {
    id: 'eval-direct-005',
    query: 'run postgres database locally',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440005',
    pattern: 'direct',
  },
  {
    id: 'eval-direct-006',
    query: 'convert markdown to pdf',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440006',
    pattern: 'direct',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // PROBLEM Pattern (7 fixtures)
  // ──────────────────────────────────────────────────────────────────────────

  {
    id: 'eval-problem-001',
    query: 'make sure we are not shipping GPL code in proprietary product',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440001',
    pattern: 'problem',
  },
  {
    id: 'eval-problem-002',
    query: 'code formatting is inconsistent across the team',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440002',
    pattern: 'problem',
  },
  {
    id: 'eval-problem-003',
    query: 'catch common javascript bugs before runtime',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440003',
    pattern: 'problem',
  },
  {
    id: 'eval-problem-004',
    query: 'production containers might have security issues',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440004',
    pattern: 'problem',
  },
  {
    id: 'eval-problem-005',
    query: 'need to test database migrations without affecting production',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440005',
    pattern: 'problem',
  },
  {
    id: 'eval-problem-006',
    query: 'documentation needs to be in PDF format for compliance',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440006',
    pattern: 'problem',
  },
  {
    id: 'eval-problem-007',
    query: 'api responses are too slow need to add caching',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440007',
    pattern: 'problem',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // BUSINESS Pattern (7 fixtures)
  // ──────────────────────────────────────────────────────────────────────────

  {
    id: 'eval-business-001',
    query: 'ensure open source compliance for rust project',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440001',
    pattern: 'business',
  },
  {
    id: 'eval-business-002',
    query: 'maintain consistent code style across engineering team',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440002',
    pattern: 'business',
  },
  {
    id: 'eval-business-003',
    query: 'reduce bugs and improve code quality standards',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440003',
    pattern: 'business',
  },
  {
    id: 'eval-business-004',
    query: 'meet security compliance requirements for container deployments',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440004',
    pattern: 'business',
  },
  {
    id: 'eval-business-005',
    query: 'set up development environment for new engineers',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440005',
    pattern: 'business',
  },
  {
    id: 'eval-business-006',
    query: 'generate professional documentation deliverables',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440006',
    pattern: 'business',
  },
  {
    id: 'eval-business-007',
    query: 'improve application performance and scalability',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440007',
    pattern: 'business',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // ALTERNATE Pattern (6 fixtures)
  // ──────────────────────────────────────────────────────────────────────────

  {
    id: 'eval-alternate-001',
    query: 'cargo ban crate security advisory check',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440001',
    pattern: 'alternate',
  },
  {
    id: 'eval-alternate-002',
    query: 'beautify typescript code automatically',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440002',
    pattern: 'alternate',
  },
  {
    id: 'eval-alternate-003',
    query: 'static analysis tool for javascript',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440003',
    pattern: 'alternate',
  },
  {
    id: 'eval-alternate-004',
    query: 'container image vulnerability scanner',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440004',
    pattern: 'alternate',
  },
  {
    id: 'eval-alternate-005',
    query: 'postgresql container for development',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440005',
    pattern: 'alternate',
  },
  {
    id: 'eval-alternate-006',
    query: 'document converter markup to portable format',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440006',
    pattern: 'alternate',
  },

  // ──────────────────────────────────────────────────────────────────────────
  // COMPOSITION Pattern (6 fixtures)
  // ──────────────────────────────────────────────────────────────────────────

  {
    id: 'eval-composition-001',
    query: 'rust supply chain security audit pipeline',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440001',
    pattern: 'composition',
  },
  {
    id: 'eval-composition-002',
    query: 'pre-commit hook to format and lint code',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440002',
    pattern: 'composition',
  },
  {
    id: 'eval-composition-003',
    query: 'ci pipeline to validate code quality',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440003',
    pattern: 'composition',
  },
  {
    id: 'eval-composition-004',
    query: 'container security scanning in deployment workflow',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440004',
    pattern: 'composition',
  },
  {
    id: 'eval-composition-005',
    query: 'integration test setup with database fixtures',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440005',
    pattern: 'composition',
  },
  {
    id: 'eval-composition-006',
    query: 'documentation build pipeline for release artifacts',
    expectedSkillId: '550e8400-e29b-41d4-a716-446655440006',
    pattern: 'composition',
  },
];

// ══════════════════════════════════════════════════════════════════════════════
// Fixture Validation
// ══════════════════════════════════════════════════════════════════════════════

export function validateFixtures(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check minimum count
  if (evalFixtures.length < 30) {
    errors.push(
      `Expected at least 30 fixtures, got ${evalFixtures.length}`
    );
  }

  // Check pattern distribution
  const patternCounts: Record<string, number> = {
    direct: 0,
    problem: 0,
    business: 0,
    alternate: 0,
    composition: 0,
  };

  for (const fixture of evalFixtures) {
    patternCounts[fixture.pattern]++;
  }

  for (const [pattern, count] of Object.entries(patternCounts)) {
    if (count === 0) {
      errors.push(`Missing fixtures for pattern: ${pattern}`);
    }
  }

  // Check for duplicate IDs
  const ids = new Set<string>();
  for (const fixture of evalFixtures) {
    if (ids.has(fixture.id)) {
      errors.push(`Duplicate fixture ID: ${fixture.id}`);
    }
    ids.add(fixture.id);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Fixture Stats
// ══════════════════════════════════════════════════════════════════════════════

export function getFixtureStats() {
  const patternCounts: Record<string, number> = {
    direct: 0,
    problem: 0,
    business: 0,
    alternate: 0,
    composition: 0,
  };

  const skillCounts: Record<string, number> = {};

  for (const fixture of evalFixtures) {
    patternCounts[fixture.pattern]++;

    if (!skillCounts[fixture.expectedSkillId]) {
      skillCounts[fixture.expectedSkillId] = 0;
    }
    skillCounts[fixture.expectedSkillId]++;
  }

  return {
    total: evalFixtures.length,
    byPattern: patternCounts,
    uniqueSkills: Object.keys(skillCounts).length,
    bySkill: skillCounts,
  };
}
