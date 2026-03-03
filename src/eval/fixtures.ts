// ══════════════════════════════════════════════════════════════════════════════
// Eval Fixtures — Query/Skill Test Pairs (Phase 2)
// ══════════════════════════════════════════════════════════════════════════════
//
// 90+ pairs across all 5 phrasing patterns + disambiguation + near-miss.
// Phase 2 expands from 7 skills / 32 queries to 40 skills / 90+ queries.
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

// Skill ID constants for readability
const SKILL = {
  CARGO_DENY: '550e8400-e29b-41d4-a716-446655440001',
  PRETTIER: '550e8400-e29b-41d4-a716-446655440002',
  ESLINT: '550e8400-e29b-41d4-a716-446655440003',
  TRIVY: '550e8400-e29b-41d4-a716-446655440004',
  DOCKER_POSTGRES: '550e8400-e29b-41d4-a716-446655440005',
  PANDOC: '550e8400-e29b-41d4-a716-446655440006',
  REDIS: '550e8400-e29b-41d4-a716-446655440007',
  LICENSE_CHECKER: '550e8400-e29b-41d4-a716-446655440008',
  FOSSA: '550e8400-e29b-41d4-a716-446655440009',
  BIOME: '550e8400-e29b-41d4-a716-446655440010',
  BLACK: '550e8400-e29b-41d4-a716-446655440011',
  SEMGREP: '550e8400-e29b-41d4-a716-446655440012',
  SNYK: '550e8400-e29b-41d4-a716-446655440013',
  CODEQL: '550e8400-e29b-41d4-a716-446655440014',
  DOCKER_BUILD: '550e8400-e29b-41d4-a716-446655440015',
  DOCKERFILE_LINT: '550e8400-e29b-41d4-a716-446655440016',
  HADOLINT: '550e8400-e29b-41d4-a716-446655440017',
  POSTMAN: '550e8400-e29b-41d4-a716-446655440018',
  HTTPIE: '550e8400-e29b-41d4-a716-446655440019',
  REST_CLIENT: '550e8400-e29b-41d4-a716-446655440020',
  TERRAFORM: '550e8400-e29b-41d4-a716-446655440021',
  KUBECTL: '550e8400-e29b-41d4-a716-446655440022',
  CLOUDFLARE_DEPLOY: '550e8400-e29b-41d4-a716-446655440023',
  PROMETHEUS: '550e8400-e29b-41d4-a716-446655440024',
  GRAFANA: '550e8400-e29b-41d4-a716-446655440025',
  DATADOG: '550e8400-e29b-41d4-a716-446655440026',
  MYSQL: '550e8400-e29b-41d4-a716-446655440027',
  MONGODB: '550e8400-e29b-41d4-a716-446655440028',
  DRIZZLE_MIGRATE: '550e8400-e29b-41d4-a716-446655440029',
  GIT_HOOKS: '550e8400-e29b-41d4-a716-446655440030',
  COMMITLINT: '550e8400-e29b-41d4-a716-446655440031',
  SEMANTIC_RELEASE: '550e8400-e29b-41d4-a716-446655440032',
  TYPEDOC: '550e8400-e29b-41d4-a716-446655440033',
  STORYBOOK: '550e8400-e29b-41d4-a716-446655440034',
  SWAGGER_CODEGEN: '550e8400-e29b-41d4-a716-446655440035',
  JEST: '550e8400-e29b-41d4-a716-446655440036',
  PLAYWRIGHT: '550e8400-e29b-41d4-a716-446655440037',
  K6: '550e8400-e29b-41d4-a716-446655440038',
  CLIPPY: '550e8400-e29b-41d4-a716-446655440039',
  DEPENDABOT: '550e8400-e29b-41d4-a716-446655440040',
} as const;

export const evalFixtures: EvalFixture[] = [
  // ──────────────────────────────────────────────────────────────────────────
  // DIRECT Pattern — User knows exactly what they want
  // ──────────────────────────────────────────────────────────────────────────

  { id: 'eval-direct-001', query: 'check rust dependency licenses', expectedSkillId: SKILL.CARGO_DENY, pattern: 'direct' },
  { id: 'eval-direct-002', query: 'format typescript code', expectedSkillId: SKILL.PRETTIER, pattern: 'direct' },
  { id: 'eval-direct-003', query: 'lint javascript files', expectedSkillId: SKILL.ESLINT, pattern: 'direct' },
  { id: 'eval-direct-004', query: 'scan docker images for vulnerabilities', expectedSkillId: SKILL.TRIVY, pattern: 'direct' },
  { id: 'eval-direct-005', query: 'run postgres database locally', expectedSkillId: SKILL.DOCKER_POSTGRES, pattern: 'direct' },
  { id: 'eval-direct-006', query: 'convert markdown to pdf', expectedSkillId: SKILL.PANDOC, pattern: 'direct' },
  { id: 'eval-direct-007', query: 'audit npm package licenses', expectedSkillId: SKILL.LICENSE_CHECKER, pattern: 'direct' },
  { id: 'eval-direct-008', query: 'run semgrep static analysis', expectedSkillId: SKILL.SEMGREP, pattern: 'direct' },
  { id: 'eval-direct-009', query: 'build docker image from dockerfile', expectedSkillId: SKILL.DOCKER_BUILD, pattern: 'direct' },
  { id: 'eval-direct-010', query: 'run postman api collection', expectedSkillId: SKILL.POSTMAN, pattern: 'direct' },
  { id: 'eval-direct-011', query: 'deploy terraform infrastructure', expectedSkillId: SKILL.TERRAFORM, pattern: 'direct' },
  { id: 'eval-direct-012', query: 'set up prometheus metrics', expectedSkillId: SKILL.PROMETHEUS, pattern: 'direct' },
  { id: 'eval-direct-013', query: 'run jest unit tests', expectedSkillId: SKILL.JEST, pattern: 'direct' },
  { id: 'eval-direct-014', query: 'run playwright browser tests', expectedSkillId: SKILL.PLAYWRIGHT, pattern: 'direct' },
  { id: 'eval-direct-015', query: 'deploy to cloudflare workers', expectedSkillId: SKILL.CLOUDFLARE_DEPLOY, pattern: 'direct' },
  { id: 'eval-direct-016', query: 'create grafana dashboard', expectedSkillId: SKILL.GRAFANA, pattern: 'direct' },
  { id: 'eval-direct-017', query: 'lint rust code with clippy', expectedSkillId: SKILL.CLIPPY, pattern: 'direct' },
  { id: 'eval-direct-018', query: 'run database migrations with drizzle', expectedSkillId: SKILL.DRIZZLE_MIGRATE, pattern: 'direct' },

  // ──────────────────────────────────────────────────────────────────────────
  // PROBLEM Pattern — User describes a problem, not the solution
  // ──────────────────────────────────────────────────────────────────────────

  { id: 'eval-problem-001', query: 'make sure we are not shipping GPL code in proprietary product', expectedSkillId: SKILL.CARGO_DENY, pattern: 'problem' },
  { id: 'eval-problem-002', query: 'code formatting is inconsistent across the team', expectedSkillId: SKILL.PRETTIER, pattern: 'problem' },
  { id: 'eval-problem-003', query: 'catch common javascript bugs before runtime', expectedSkillId: SKILL.ESLINT, pattern: 'problem' },
  { id: 'eval-problem-004', query: 'production containers might have security issues', expectedSkillId: SKILL.TRIVY, pattern: 'problem' },
  { id: 'eval-problem-005', query: 'need to test database migrations without affecting production', expectedSkillId: SKILL.DOCKER_POSTGRES, pattern: 'problem' },
  { id: 'eval-problem-006', query: 'documentation needs to be in PDF format for compliance', expectedSkillId: SKILL.PANDOC, pattern: 'problem' },
  { id: 'eval-problem-007', query: 'api responses are too slow need to add caching', expectedSkillId: SKILL.REDIS, pattern: 'problem' },
  { id: 'eval-problem-008', query: 'our npm dependencies might have problematic licenses', expectedSkillId: SKILL.LICENSE_CHECKER, pattern: 'problem' },
  { id: 'eval-problem-009', query: 'code has security vulnerabilities we cannot find manually', expectedSkillId: SKILL.SEMGREP, pattern: 'problem' },
  { id: 'eval-problem-010', query: 'need to verify our APIs return correct responses after changes', expectedSkillId: SKILL.POSTMAN, pattern: 'problem' },
  { id: 'eval-problem-011', query: 'cloud infrastructure is configured manually and drifting', expectedSkillId: SKILL.TERRAFORM, pattern: 'problem' },
  { id: 'eval-problem-012', query: 'we have no metrics to tell if our services are healthy or degraded', expectedSkillId: SKILL.PROMETHEUS, pattern: 'problem' },
  { id: 'eval-problem-013', query: 'login flow breaks on different browsers after deployments', expectedSkillId: SKILL.PLAYWRIGHT, pattern: 'problem' },
  { id: 'eval-problem-014', query: 'our kubernetes pods keep crashing and need debugging', expectedSkillId: SKILL.KUBECTL, pattern: 'problem' },
  { id: 'eval-problem-015', query: 'our python code style is inconsistent between developers', expectedSkillId: SKILL.BLACK, pattern: 'problem' },
  { id: 'eval-problem-016', query: 'commit messages are all over the place no consistency', expectedSkillId: SKILL.COMMITLINT, pattern: 'problem' },

  // ──────────────────────────────────────────────────────────────────────────
  // BUSINESS Pattern — Non-technical/PM language
  // ──────────────────────────────────────────────────────────────────────────

  { id: 'eval-business-001', query: 'ensure open source compliance for rust project', expectedSkillId: SKILL.CARGO_DENY, pattern: 'business' },
  { id: 'eval-business-002', query: 'maintain consistent code style across engineering team', expectedSkillId: SKILL.PRETTIER, pattern: 'business' },
  { id: 'eval-business-003', query: 'reduce bugs and improve code quality standards', expectedSkillId: SKILL.ESLINT, pattern: 'business' },
  { id: 'eval-business-004', query: 'meet security compliance requirements for container deployments', expectedSkillId: SKILL.TRIVY, pattern: 'business' },
  { id: 'eval-business-005', query: 'set up development environment for new engineers', expectedSkillId: SKILL.DOCKER_POSTGRES, pattern: 'business' },
  { id: 'eval-business-006', query: 'convert documentation to PDF and Word for client deliverables', expectedSkillId: SKILL.PANDOC, pattern: 'business' },
  { id: 'eval-business-007', query: 'improve application performance and scalability', expectedSkillId: SKILL.REDIS, pattern: 'business' },
  { id: 'eval-business-008', query: 'enterprise license compliance scanning across all projects', expectedSkillId: SKILL.FOSSA, pattern: 'business' },
  { id: 'eval-business-009', query: 'get visibility into application health and uptime', expectedSkillId: SKILL.DATADOG, pattern: 'business' },
  { id: 'eval-business-010', query: 'automate infrastructure provisioning for cloud migration', expectedSkillId: SKILL.TERRAFORM, pattern: 'business' },
  { id: 'eval-business-011', query: 'automate the release and versioning process', expectedSkillId: SKILL.SEMANTIC_RELEASE, pattern: 'business' },
  { id: 'eval-business-012', query: 'generate API documentation for partner integrations', expectedSkillId: SKILL.SWAGGER_CODEGEN, pattern: 'business' },
  { id: 'eval-business-013', query: 'keep all project dependencies secure and up to date', expectedSkillId: SKILL.DEPENDABOT, pattern: 'business' },
  { id: 'eval-business-014', query: 'ensure website works on all major browsers', expectedSkillId: SKILL.PLAYWRIGHT, pattern: 'business' },

  // ──────────────────────────────────────────────────────────────────────────
  // ALTERNATE Pattern — Different terminology for same concept
  // ──────────────────────────────────────────────────────────────────────────

  { id: 'eval-alternate-001', query: 'cargo ban crate security advisory check', expectedSkillId: SKILL.CARGO_DENY, pattern: 'alternate' },
  { id: 'eval-alternate-002', query: 'beautify typescript code automatically', expectedSkillId: SKILL.PRETTIER, pattern: 'alternate' },
  { id: 'eval-alternate-003', query: 'static analysis tool for javascript', expectedSkillId: SKILL.ESLINT, pattern: 'alternate' },
  { id: 'eval-alternate-004', query: 'container image vulnerability scanner', expectedSkillId: SKILL.TRIVY, pattern: 'alternate' },
  { id: 'eval-alternate-005', query: 'postgresql container for development', expectedSkillId: SKILL.DOCKER_POSTGRES, pattern: 'alternate' },
  { id: 'eval-alternate-006', query: 'document converter markup to portable format', expectedSkillId: SKILL.PANDOC, pattern: 'alternate' },
  { id: 'eval-alternate-007', query: 'fast javascript typescript formatter linter combo', expectedSkillId: SKILL.BIOME, pattern: 'alternate' },
  { id: 'eval-alternate-008', query: 'SAST security scanning multi language', expectedSkillId: SKILL.SEMGREP, pattern: 'alternate' },
  { id: 'eval-alternate-009', query: 'software composition analysis dependency checker', expectedSkillId: SKILL.SNYK, pattern: 'alternate' },
  { id: 'eval-alternate-010', query: 'IaC cloud provisioning declarative', expectedSkillId: SKILL.TERRAFORM, pattern: 'alternate' },
  { id: 'eval-alternate-011', query: 'k8s cluster management deploy pods', expectedSkillId: SKILL.KUBECTL, pattern: 'alternate' },
  { id: 'eval-alternate-012', query: 'HTTP request testing command line tool', expectedSkillId: SKILL.HTTPIE, pattern: 'alternate' },
  { id: 'eval-alternate-013', query: 'application performance monitoring distributed tracing', expectedSkillId: SKILL.DATADOG, pattern: 'alternate' },
  { id: 'eval-alternate-014', query: 'nosql document database for development', expectedSkillId: SKILL.MONGODB, pattern: 'alternate' },

  // ──────────────────────────────────────────────────────────────────────────
  // COMPOSITION Pattern — Part of a larger workflow
  // ──────────────────────────────────────────────────────────────────────────

  { id: 'eval-composition-001', query: 'rust supply chain security audit pipeline', expectedSkillId: SKILL.CARGO_DENY, pattern: 'composition' },
  { id: 'eval-composition-002', query: 'pre-commit hook to format and lint code', expectedSkillId: SKILL.GIT_HOOKS, pattern: 'composition' },
  { id: 'eval-composition-003', query: 'ci pipeline to validate code quality', expectedSkillId: SKILL.ESLINT, pattern: 'composition' },
  { id: 'eval-composition-004', query: 'container security scanning in deployment workflow', expectedSkillId: SKILL.TRIVY, pattern: 'composition' },
  { id: 'eval-composition-005', query: 'spin up a postgres container for integration test fixtures', expectedSkillId: SKILL.DOCKER_POSTGRES, pattern: 'composition' },
  { id: 'eval-composition-006', query: 'convert markdown docs to PDF as part of release pipeline', expectedSkillId: SKILL.PANDOC, pattern: 'composition' },
  { id: 'eval-composition-007', query: 'deploy infrastructure then deploy application on top', expectedSkillId: SKILL.TERRAFORM, pattern: 'composition' },
  { id: 'eval-composition-008', query: 'set up monitoring stack with metrics and dashboards', expectedSkillId: SKILL.PROMETHEUS, pattern: 'composition' },
  { id: 'eval-composition-009', query: 'automated release pipeline with version bump and changelog', expectedSkillId: SKILL.SEMANTIC_RELEASE, pattern: 'composition' },
  { id: 'eval-composition-010', query: 'end to end testing pipeline with cross browser verification', expectedSkillId: SKILL.PLAYWRIGHT, pattern: 'composition' },

  // ──────────────────────────────────────────────────────────────────────────
  // DISAMBIGUATION — Queries where multiple skills could match
  // Tests whether the search picks the most relevant one
  // ──────────────────────────────────────────────────────────────────────────

  { id: 'eval-disambig-001', query: 'check my code for issues', expectedSkillId: SKILL.ESLINT, pattern: 'direct' },
  { id: 'eval-disambig-002', query: 'static analysis to find security problems in my source code', expectedSkillId: SKILL.SEMGREP, pattern: 'direct' },
  { id: 'eval-disambig-003', query: 'format my code automatically', expectedSkillId: SKILL.PRETTIER, pattern: 'direct' },
  { id: 'eval-disambig-004', query: 'check dependency vulnerabilities', expectedSkillId: SKILL.SNYK, pattern: 'direct' },
  { id: 'eval-disambig-005', query: 'lint my dockerfile', expectedSkillId: SKILL.HADOLINT, pattern: 'direct' },
  { id: 'eval-disambig-006', query: 'test my API endpoints', expectedSkillId: SKILL.POSTMAN, pattern: 'direct' },
  { id: 'eval-disambig-007', query: 'run a local database for testing', expectedSkillId: SKILL.DOCKER_POSTGRES, pattern: 'direct' },
  { id: 'eval-disambig-008', query: 'set up application monitoring', expectedSkillId: SKILL.PROMETHEUS, pattern: 'direct' },
  { id: 'eval-disambig-009', query: 'check for license compliance issues', expectedSkillId: SKILL.FOSSA, pattern: 'direct' },
  { id: 'eval-disambig-010', query: 'generate TypeScript documentation', expectedSkillId: SKILL.TYPEDOC, pattern: 'direct' },
  { id: 'eval-disambig-011', query: 'load test my service', expectedSkillId: SKILL.K6, pattern: 'direct' },
  { id: 'eval-disambig-012', query: 'deploy my application to the cloud', expectedSkillId: SKILL.CLOUDFLARE_DEPLOY, pattern: 'direct' },
  { id: 'eval-disambig-013', query: 'run tests for my react components', expectedSkillId: SKILL.JEST, pattern: 'direct' },
  { id: 'eval-disambig-014', query: 'document my UI components', expectedSkillId: SKILL.STORYBOOK, pattern: 'direct' },
  { id: 'eval-disambig-015', query: 'analyze code for security vulnerabilities using queries', expectedSkillId: SKILL.CODEQL, pattern: 'direct' },
];

// ══════════════════════════════════════════════════════════════════════════════
// Fixture Validation
// ══════════════════════════════════════════════════════════════════════════════

export function validateFixtures(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check minimum count (Phase 2: 80+)
  if (evalFixtures.length < 80) {
    errors.push(
      `Expected at least 80 fixtures, got ${evalFixtures.length}`
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
    if (count < 5) {
      errors.push(`Too few fixtures for pattern ${pattern}: ${count} (min 5)`);
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
