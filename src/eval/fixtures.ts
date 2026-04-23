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

// Acceptable alternative skill IDs — cross-source duplicates and equivalent tools
// that serve the same purpose as the primary expected skill.
const ALT = {
  POSTGRES: [
    'c6d7bda7-07f2-4cb9-a00e-4ad10a2ab08a', // capital.hove/read-only-local-postgres-mcp-server
    'b5d83ffb-ba08-4574-8fc5-b2f5fe41a0a6', // PostgreSQL MCP Server (neverinfamous)
    '81981fae-8a78-45c3-aa3b-ee5ef583179c', // PostgreSQL MCP Server (itunified)
    '73c8dce1-8827-4db7-a54a-601f376481f0', // PostgreSQL MCP Server (neverinfamous-server)
    '8c931f75-4fcd-4dba-a501-37c9aa8e1a45', // io.github.pgEdge/postgres-mcp
    '2ca2c400-3b4d-43b2-99e3-16f5934ff0ba', // ai.waystation/postgres
  ],
  PANDOC: [
    'f4b1fc72-1fbc-4736-b7ac-97ed6b382086', // MCP MD2PDF Server
    '647b7fad-d16f-4276-8f5a-b81255d9927f', // Pandoc Document Conversion (glama)
    'cb763396-af0d-4ffc-95d5-9e59d304d094', // mcp-pandoc (glama)
    '841a5be0-b1d0-433a-a75e-04d2251eebb5', // huoshui-pdf-converter
    '42779b73-f9ff-40aa-8328-c4d0ebd99b51', // Prince PDF Converter
    '0882ec8c-dd16-4ee0-bca8-7ab2cd8b4599', // PDFCrowd PDF Export
  ],
  TERRAFORM: [
    '5f3bf9fe-7933-42a1-b355-351e817fd1f4', // Terraform (hashicorp MCP server)
    'ae0d726d-6cc6-4f0e-a77a-71241240ef4d', // F5 Distributed Cloud Terraform Provider
    '3975e73b-4159-4d27-a2cd-0f2494c77d08', // Terraform Ingest MCP
    '66bfd735-f71c-473e-a191-1fb52946871b', // Terraform Registry MCP Server
  ],
  PROMETHEUS: [
    '122724ed-ecd1-4bb3-900c-d950f5d6ca34', // io.github.mshegolev/prometheus-mcp
    '93ec1114-5607-423a-9a23-4629aa3910e4', // io.github.tjhop/prometheus-mcp-server
    '10831dd6-b6a5-4d5f-a1b8-82ad4c3dc3db', // Prometheus MCP Server (pab1it0)
    '7fa0db34-b200-45b7-a304-1c669fa67291', // io.github.jeanlopezxyz/mcp-prometheus
    '5ab0206a-01bd-466e-8781-2b104bce0a4a', // Prometheus MCP
  ],
  PLAYWRIGHT: [
    'ced13a07-eab5-4b99-b93e-433c1d47d57b', // Playwright Automation (microsoft-playwright-mcp, smithery)
    '1ab5fd33-49cd-4dfa-89b2-918cc7e2f52c', // io.github.dinesh-nalla-se/playwright-mcp
    '910b2f97-7538-4e24-b3ec-439b2d8dc92a', // io.github.oguzc/playwright-wizard-mcp
    'b8d5dd0e-5497-4300-8c72-d8ba88e2883e', // Playwright (glama)
    '840896fc-a3fb-4dbe-be5b-cff255071b91', // Cloudflare Playwright MCP
  ],
  GRAFANA: [
    '4c6cfb76-62f0-4612-a2a5-75f346fcabc5', // io.github.grafana/mcp-grafana
    'e7f80c6b-72a7-42e7-b8a8-f2ffa52225ae', // Grafana (glama)
    'bbabea4a-f123-4acc-b4a5-84099e38501e', // Grafana MCP Server (drdroidlab)
    '1c7e22e2-4900-4e9f-9027-35d79980c1fc', // Grafana MCP Server (0xteamhq)
  ],
  SEMGREP: [
    'c8570524-c718-4edb-80d5-8eff99238f59', // Semgrep MCP Server (glama)
    '7955d13d-502b-4d34-a7d3-4158dad578b9', // MCP Server Semgrep (glama)
    '7fb74cce-a81a-47f4-9efd-e5af648ceb76', // Semgrep MCP Server (stefanskiasan)
  ],
  POSTMAN: [
    '38e417ec-f042-434c-b284-bf4b84caf722', // io.github.cocaxcode/api-testing-mcp
    'e04a75f4-f16f-402b-8b70-8053bc5ac93c', // io.github.ryudi84/api-tester
    '0cfe47bc-a59b-4b62-9969-8a4300d26a58', // MyPostmanServer (glama)
    'c2033721-020a-4ce3-8906-dbb5fda1589c', // Postman MCP Server
    '1ba47d16-154f-4434-aa66-9a331a7abf58', // api-test-mcp
  ],
  CLOUDFLARE: [
    '1d787498-ded2-4a51-b1e5-ba540e3cb804', // cloudflare-mcp (github)
    'cba11189-cb90-4d60-bcdc-eb4dfde01a30', // Cloudflare (smithery)
    '75a6496b-1867-4b9e-957f-5b350ebc9b9e', // com.cloudflare.mcp/mcp
    'b5d5365e-2e24-4952-b5b4-df75de224fad', // Cloudflare MCP Server (itunified)
  ],
  REDIS: [
    'aa4e77f6-807c-4fef-b460-c8cad905648f', // Redis MCP Server (official redis)
    'f2c4fe73-d2b8-42ab-a33c-b0dcae737437', // io.github.daedalus/mcp-redis-server
    '8f16bf78-6516-4425-adc7-ff09ec165b81', // mcp-redis (redis official)
  ],
  LICENSE: [
    '99e1a1a1-6627-473e-8b3e-111d2e4606a5', // io.github.bighippoman/license-compliance
    '34813153-20c9-43cc-8de6-181d6c7ab4c8', // io.github.webmoleai/mcp-check-licenses
    '0b4826ed-10ee-49ce-b741-edf55cb8484f', // io.github.webmoleai/mcp-license-audit
    '53072956-6ecc-493e-9463-5784c22b9188', // io.github.thegridwork/license
    '63ab7614-847f-4247-9861-a89dbd65ec75', // license-checker-ai-mcp
  ],
  KUBECTL: [
    '5e464e5e-bdef-4fda-b016-0ff285cbbdcc', // io.github.containers/kubernetes-mcp-server
    '3848bab1-fe87-461e-b44d-933568c39ccc', // Kubernetes Monitor
    'a746a0c1-04a6-4cc3-81a9-f69974b94f99', // kubectl-mcp-server
    '7c7a366f-6a9c-4a09-b50e-7a4832f2fd2d', // kubectl-debug-queries
  ],
  TRIVY: [
    '49202c54-6431-4e13-8ecb-9ef633e41812', // Trivy (glama)
    '0006c23e-ea0f-4554-bd53-a2f0045b36e7', // Trivy Security Scanner MCP Server (glama)
  ],
  SNYK: [
    '02a50a22-b9ad-4e24-90dd-f9375267fe1a', // io.snyk/mcp
    '56c5399c-9db8-4e98-bfaa-69613eb2fab4', // Snyk MCP Server (glama)
    'f4194e58-6c52-4cce-8734-5538a695bd71', // Snyk Studio MCP (glama)
    'e95e8b1e-4fd3-4cbf-bf5a-47527b21e5c6', // depguard (SCA tool)
  ],
  DATADOG: [
    '8384396f-37c4-4fb3-9f64-ae5531e0c9fb', // New Relic MCP Server
    '06775d9e-2da6-4aed-847f-70aa31b95c9a', // mcp-datadog
    '1742f2ff-3c6f-4a9c-86a8-bc523b538cca', // io.github.TANTIOPE/datadog-mcp
  ],
  JEST: [
    'cfe33e8b-3bac-42e5-a735-5b577ddfd46e', // Claude Jester MCP (test runner)
  ],
  ESLINT: [
    // No direct ESLint duplicates — code quality tools that may match
  ],
  COMMITLINT: [
    'e2b85bd4-e607-4140-9f59-6373980fb280', // conventional-commits
    '1b62ca2d-799a-4473-9adb-e5ecdfb761a9', // commit-message-ai-mcp
    'f62dc3ca-9697-48fc-860a-d5e839877c80', // Commit Conventional Message Court
  ],
  SEMANTIC_RELEASE: [
    '330d6156-2ee8-49c5-a48e-0ab212a68064', // io.github.ryudi84/changelog
    '6dadfec6-76f1-48c0-b131-dd0fb8d14467', // io.github.ryudi84/changelog-forge-mcp
    '54e02817-8a5f-4cbb-8557-7368d8e6e5c6', // changelogai
  ],
  SWAGGER: [
    'e35a2840-888f-4992-bf73-a3a5ad1a8387', // io.github.Docat0209/openapi
    '5e29a57e-9b66-441c-b0bc-75b1f973d045', // OpenAPI to MCP
    'b028293c-9f21-4c90-8cc9-0ee3db09ee17', // OpenAPI MCP Server
    'b9553847-9980-47bd-b8a1-fef70ce19559', // MCP Swagger Server (glama)
  ],
  DEPENDABOT: [
    'e95e8b1e-4fd3-4cbf-bf5a-47527b21e5c6', // depguard
    '5bd7aa91-6aee-42dc-9ac2-6d7da3654c1a', // io.github.niradler/dependency-mcp
    '42826fc0-2bad-4a54-b3c8-2233139261ec', // com.sonatype/dependency-management-mcp-server
    'f517e107-f7e5-40d1-8f90-661912b78a68', // dependency-audit
  ],
  STORYBOOK: [
    'cd92cdca-8e61-423e-84ab-8d75db53f34e', // Storybook MCP Addon
  ],
  FOSSA: [
    ...[] as string[], // fossa has few direct alternatives; license tools overlap
  ],
  K6: [
    '89cce5f0-767a-43fa-a429-fc8b596f0f0b', // jmeter-mcp (load testing)
  ],
  CODEQL: [
    'e9684f45-707d-433a-a4c4-a4d65a210b11', // Grasp — Codebase Analysis
  ],
} as const;

export const evalFixtures: EvalFixture[] = [
  // ──────────────────────────────────────────────────────────────────────────
  // DIRECT Pattern — User knows exactly what they want
  // ──────────────────────────────────────────────────────────────────────────

  { id: 'eval-direct-001', query: 'check rust dependency licenses', expectedSkillId: SKILL.CARGO_DENY, pattern: 'direct' },
  { id: 'eval-direct-002', query: 'format typescript code', expectedSkillId: SKILL.PRETTIER, pattern: 'direct' },
  { id: 'eval-direct-003', query: 'lint javascript files', expectedSkillId: SKILL.ESLINT, pattern: 'direct' },
  { id: 'eval-direct-004', query: 'scan docker images for vulnerabilities', expectedSkillId: SKILL.TRIVY, pattern: 'direct' },
  { id: 'eval-direct-005', query: 'run postgres database locally', expectedSkillId: SKILL.DOCKER_POSTGRES, acceptableSkillIds: ALT.POSTGRES, pattern: 'direct' },
  { id: 'eval-direct-006', query: 'convert markdown to pdf', expectedSkillId: SKILL.PANDOC, acceptableSkillIds: ALT.PANDOC, pattern: 'direct' },
  { id: 'eval-direct-007', query: 'audit npm package licenses', expectedSkillId: SKILL.LICENSE_CHECKER, pattern: 'direct' },
  { id: 'eval-direct-008', query: 'run semgrep static analysis', expectedSkillId: SKILL.SEMGREP, acceptableSkillIds: ALT.SEMGREP, pattern: 'direct' },
  { id: 'eval-direct-009', query: 'build docker image from dockerfile', expectedSkillId: SKILL.DOCKER_BUILD, pattern: 'direct' },
  { id: 'eval-direct-010', query: 'run postman api collection', expectedSkillId: SKILL.POSTMAN, acceptableSkillIds: ALT.POSTMAN, pattern: 'direct' },
  { id: 'eval-direct-011', query: 'deploy terraform infrastructure', expectedSkillId: SKILL.TERRAFORM, acceptableSkillIds: ALT.TERRAFORM, pattern: 'direct' },
  { id: 'eval-direct-012', query: 'set up prometheus metrics', expectedSkillId: SKILL.PROMETHEUS, acceptableSkillIds: ALT.PROMETHEUS, pattern: 'direct' },
  { id: 'eval-direct-013', query: 'run jest unit tests', expectedSkillId: SKILL.JEST, acceptableSkillIds: ALT.JEST, pattern: 'direct' },
  { id: 'eval-direct-014', query: 'run playwright browser tests', expectedSkillId: SKILL.PLAYWRIGHT, acceptableSkillIds: ALT.PLAYWRIGHT, pattern: 'direct' },
  { id: 'eval-direct-015', query: 'deploy to cloudflare workers', expectedSkillId: SKILL.CLOUDFLARE_DEPLOY, acceptableSkillIds: ALT.CLOUDFLARE, pattern: 'direct' },
  { id: 'eval-direct-016', query: 'create grafana dashboard', expectedSkillId: SKILL.GRAFANA, acceptableSkillIds: ALT.GRAFANA, pattern: 'direct' },
  { id: 'eval-direct-017', query: 'lint rust code with clippy', expectedSkillId: SKILL.CLIPPY, pattern: 'direct' },
  { id: 'eval-direct-018', query: 'run database migrations with drizzle', expectedSkillId: SKILL.DRIZZLE_MIGRATE, pattern: 'direct' },

  // ──────────────────────────────────────────────────────────────────────────
  // PROBLEM Pattern — User describes a problem, not the solution
  // ──────────────────────────────────────────────────────────────────────────

  { id: 'eval-problem-001', query: 'make sure we are not shipping GPL code in proprietary product', expectedSkillId: SKILL.CARGO_DENY, acceptableSkillIds: [...ALT.LICENSE], pattern: 'problem' },
  { id: 'eval-problem-002', query: 'code formatting is inconsistent across the team', expectedSkillId: SKILL.PRETTIER, pattern: 'problem' },
  { id: 'eval-problem-003', query: 'catch common javascript bugs before runtime', expectedSkillId: SKILL.ESLINT, pattern: 'problem' },
  { id: 'eval-problem-004', query: 'production containers might have security issues', expectedSkillId: SKILL.TRIVY, acceptableSkillIds: ALT.TRIVY, pattern: 'problem' },
  { id: 'eval-problem-005', query: 'need to test database migrations without affecting production', expectedSkillId: SKILL.DOCKER_POSTGRES, acceptableSkillIds: ALT.POSTGRES, pattern: 'problem' },
  { id: 'eval-problem-006', query: 'documentation needs to be in PDF format for compliance', expectedSkillId: SKILL.PANDOC, acceptableSkillIds: ALT.PANDOC, pattern: 'problem' },
  { id: 'eval-problem-007', query: 'api responses are too slow need to add caching', expectedSkillId: SKILL.REDIS, acceptableSkillIds: ALT.REDIS, pattern: 'problem' },
  { id: 'eval-problem-008', query: 'our npm dependencies might have problematic licenses', expectedSkillId: SKILL.LICENSE_CHECKER, acceptableSkillIds: ALT.LICENSE, pattern: 'problem' },
  { id: 'eval-problem-009', query: 'code has security vulnerabilities we cannot find manually', expectedSkillId: SKILL.SEMGREP, acceptableSkillIds: ALT.SEMGREP, pattern: 'problem' },
  { id: 'eval-problem-010', query: 'need to verify our APIs return correct responses after changes', expectedSkillId: SKILL.POSTMAN, acceptableSkillIds: ALT.POSTMAN, pattern: 'problem' },
  { id: 'eval-problem-011', query: 'cloud infrastructure is configured manually and drifting', expectedSkillId: SKILL.TERRAFORM, acceptableSkillIds: ALT.TERRAFORM, pattern: 'problem' },
  { id: 'eval-problem-012', query: 'we have no metrics to tell if our services are healthy or degraded', expectedSkillId: SKILL.PROMETHEUS, acceptableSkillIds: [...ALT.PROMETHEUS, ...ALT.GRAFANA, ...ALT.DATADOG], pattern: 'problem' },
  { id: 'eval-problem-013', query: 'login flow breaks on different browsers after deployments', expectedSkillId: SKILL.PLAYWRIGHT, acceptableSkillIds: ALT.PLAYWRIGHT, pattern: 'problem' },
  { id: 'eval-problem-014', query: 'our kubernetes pods keep crashing and need debugging', expectedSkillId: SKILL.KUBECTL, acceptableSkillIds: ALT.KUBECTL, pattern: 'problem' },
  { id: 'eval-problem-015', query: 'our python code style is inconsistent between developers', expectedSkillId: SKILL.BLACK, pattern: 'problem' },
  { id: 'eval-problem-016', query: 'commit messages are all over the place no consistency', expectedSkillId: SKILL.COMMITLINT, acceptableSkillIds: ALT.COMMITLINT, pattern: 'problem' },

  // ──────────────────────────────────────────────────────────────────────────
  // BUSINESS Pattern — Non-technical/PM language
  // ──────────────────────────────────────────────────────────────────────────

  { id: 'eval-business-001', query: 'ensure open source compliance for rust project', expectedSkillId: SKILL.CARGO_DENY, acceptableSkillIds: [...ALT.LICENSE], pattern: 'business' },
  { id: 'eval-business-002', query: 'maintain consistent code style across engineering team', expectedSkillId: SKILL.PRETTIER, pattern: 'business' },
  { id: 'eval-business-003', query: 'reduce bugs and improve code quality standards', expectedSkillId: SKILL.ESLINT, pattern: 'business' },
  { id: 'eval-business-004', query: 'meet security compliance requirements for container deployments', expectedSkillId: SKILL.TRIVY, acceptableSkillIds: ALT.TRIVY, pattern: 'business' },
  { id: 'eval-business-005', query: 'set up development environment for new engineers', expectedSkillId: SKILL.DOCKER_POSTGRES, acceptableSkillIds: ALT.POSTGRES, pattern: 'business' },
  { id: 'eval-business-006', query: 'convert documentation to PDF and Word for client deliverables', expectedSkillId: SKILL.PANDOC, acceptableSkillIds: ALT.PANDOC, pattern: 'business' },
  { id: 'eval-business-007', query: 'improve application performance and scalability', expectedSkillId: SKILL.REDIS, acceptableSkillIds: [...ALT.REDIS, ...ALT.K6], pattern: 'business' },
  { id: 'eval-business-008', query: 'enterprise license compliance scanning across all projects', expectedSkillId: SKILL.FOSSA, acceptableSkillIds: [...ALT.LICENSE, SKILL.LICENSE_CHECKER], pattern: 'business' },
  { id: 'eval-business-009', query: 'get visibility into application health and uptime', expectedSkillId: SKILL.DATADOG, acceptableSkillIds: [...ALT.DATADOG, ...ALT.PROMETHEUS, ...ALT.GRAFANA], pattern: 'business' },
  { id: 'eval-business-010', query: 'automate infrastructure provisioning for cloud migration', expectedSkillId: SKILL.TERRAFORM, acceptableSkillIds: ALT.TERRAFORM, pattern: 'business' },
  { id: 'eval-business-011', query: 'automate the release and versioning process', expectedSkillId: SKILL.SEMANTIC_RELEASE, acceptableSkillIds: ALT.SEMANTIC_RELEASE, pattern: 'business' },
  { id: 'eval-business-012', query: 'generate API documentation for partner integrations', expectedSkillId: SKILL.SWAGGER_CODEGEN, acceptableSkillIds: ALT.SWAGGER, pattern: 'business' },
  { id: 'eval-business-013', query: 'keep all project dependencies secure and up to date', expectedSkillId: SKILL.DEPENDABOT, acceptableSkillIds: [...ALT.DEPENDABOT, ...ALT.SNYK], pattern: 'business' },
  { id: 'eval-business-014', query: 'ensure website works on all major browsers', expectedSkillId: SKILL.PLAYWRIGHT, acceptableSkillIds: ALT.PLAYWRIGHT, pattern: 'business' },

  // ──────────────────────────────────────────────────────────────────────────
  // ALTERNATE Pattern — Different terminology for same concept
  // ──────────────────────────────────────────────────────────────────────────

  { id: 'eval-alternate-001', query: 'cargo ban crate security advisory check', expectedSkillId: SKILL.CARGO_DENY, pattern: 'alternate' },
  { id: 'eval-alternate-002', query: 'beautify typescript code automatically', expectedSkillId: SKILL.PRETTIER, pattern: 'alternate' },
  { id: 'eval-alternate-003', query: 'static analysis tool for javascript', expectedSkillId: SKILL.ESLINT, acceptableSkillIds: [...ALT.SEMGREP], pattern: 'alternate' },
  { id: 'eval-alternate-004', query: 'container image vulnerability scanner', expectedSkillId: SKILL.TRIVY, acceptableSkillIds: ALT.TRIVY, pattern: 'alternate' },
  { id: 'eval-alternate-005', query: 'postgresql container for development', expectedSkillId: SKILL.DOCKER_POSTGRES, acceptableSkillIds: ALT.POSTGRES, pattern: 'alternate' },
  { id: 'eval-alternate-006', query: 'document converter markup to portable format', expectedSkillId: SKILL.PANDOC, acceptableSkillIds: ALT.PANDOC, pattern: 'alternate' },
  { id: 'eval-alternate-007', query: 'fast javascript typescript formatter linter combo', expectedSkillId: SKILL.BIOME, pattern: 'alternate' },
  { id: 'eval-alternate-008', query: 'SAST security scanning multi language', expectedSkillId: SKILL.SEMGREP, acceptableSkillIds: ALT.SEMGREP, pattern: 'alternate' },
  { id: 'eval-alternate-009', query: 'software composition analysis dependency checker', expectedSkillId: SKILL.SNYK, acceptableSkillIds: [...ALT.SNYK, ...ALT.DEPENDABOT], pattern: 'alternate' },
  { id: 'eval-alternate-010', query: 'IaC cloud provisioning declarative', expectedSkillId: SKILL.TERRAFORM, pattern: 'alternate' },
  { id: 'eval-alternate-011', query: 'k8s cluster management deploy pods', expectedSkillId: SKILL.KUBECTL, acceptableSkillIds: ALT.KUBECTL, pattern: 'alternate' },
  { id: 'eval-alternate-012', query: 'HTTP request testing command line tool', expectedSkillId: SKILL.HTTPIE, pattern: 'alternate' },
  { id: 'eval-alternate-013', query: 'application performance monitoring distributed tracing', expectedSkillId: SKILL.DATADOG, acceptableSkillIds: [...ALT.DATADOG, ...ALT.PROMETHEUS], pattern: 'alternate' },
  { id: 'eval-alternate-014', query: 'nosql document database for development', expectedSkillId: SKILL.MONGODB, pattern: 'alternate' },

  // ──────────────────────────────────────────────────────────────────────────
  // COMPOSITION Pattern — Part of a larger workflow
  // ──────────────────────────────────────────────────────────────────────────

  { id: 'eval-composition-001', query: 'rust supply chain security audit pipeline', expectedSkillId: SKILL.CARGO_DENY, pattern: 'composition' },
  { id: 'eval-composition-002', query: 'pre-commit hook to format and lint code', expectedSkillId: SKILL.GIT_HOOKS, pattern: 'composition' },
  { id: 'eval-composition-003', query: 'ci pipeline to validate code quality', expectedSkillId: SKILL.ESLINT, pattern: 'composition' },
  { id: 'eval-composition-004', query: 'container security scanning in deployment workflow', expectedSkillId: SKILL.TRIVY, acceptableSkillIds: ALT.TRIVY, pattern: 'composition' },
  { id: 'eval-composition-005', query: 'spin up a postgres container for integration test fixtures', expectedSkillId: SKILL.DOCKER_POSTGRES, acceptableSkillIds: ALT.POSTGRES, pattern: 'composition' },
  { id: 'eval-composition-006', query: 'convert markdown docs to PDF as part of release pipeline', expectedSkillId: SKILL.PANDOC, acceptableSkillIds: ALT.PANDOC, pattern: 'composition' },
  { id: 'eval-composition-007', query: 'deploy infrastructure then deploy application on top', expectedSkillId: SKILL.TERRAFORM, acceptableSkillIds: ALT.TERRAFORM, pattern: 'composition' },
  { id: 'eval-composition-008', query: 'set up monitoring stack with metrics and dashboards', expectedSkillId: SKILL.PROMETHEUS, acceptableSkillIds: [...ALT.PROMETHEUS, ...ALT.GRAFANA], pattern: 'composition' },
  { id: 'eval-composition-009', query: 'automated release pipeline with version bump and changelog', expectedSkillId: SKILL.SEMANTIC_RELEASE, acceptableSkillIds: ALT.SEMANTIC_RELEASE, pattern: 'composition' },
  { id: 'eval-composition-010', query: 'end to end testing pipeline with cross browser verification', expectedSkillId: SKILL.PLAYWRIGHT, acceptableSkillIds: ALT.PLAYWRIGHT, pattern: 'composition' },

  // ──────────────────────────────────────────────────────────────────────────
  // DISAMBIGUATION — Queries where multiple skills could match
  // Tests whether the search picks the most relevant one
  // ──────────────────────────────────────────────────────────────────────────

  { id: 'eval-disambig-001', query: 'check my code for issues', expectedSkillId: SKILL.ESLINT, pattern: 'direct' },
  { id: 'eval-disambig-002', query: 'static analysis to find security problems in my source code', expectedSkillId: SKILL.SEMGREP, acceptableSkillIds: [...ALT.SEMGREP, SKILL.CODEQL], pattern: 'direct' },
  { id: 'eval-disambig-003', query: 'format my code automatically', expectedSkillId: SKILL.PRETTIER, pattern: 'direct' },
  { id: 'eval-disambig-004', query: 'check dependency vulnerabilities', expectedSkillId: SKILL.SNYK, acceptableSkillIds: ALT.SNYK, pattern: 'direct' },
  { id: 'eval-disambig-005', query: 'lint my dockerfile', expectedSkillId: SKILL.HADOLINT, pattern: 'direct' },
  { id: 'eval-disambig-006', query: 'test my API endpoints', expectedSkillId: SKILL.POSTMAN, acceptableSkillIds: ALT.POSTMAN, pattern: 'direct' },
  { id: 'eval-disambig-007', query: 'run a local database for testing', expectedSkillId: SKILL.DOCKER_POSTGRES, acceptableSkillIds: ALT.POSTGRES, pattern: 'direct' },
  { id: 'eval-disambig-008', query: 'set up application monitoring', expectedSkillId: SKILL.PROMETHEUS, acceptableSkillIds: [...ALT.PROMETHEUS, ...ALT.GRAFANA, ...ALT.DATADOG], pattern: 'direct' },
  { id: 'eval-disambig-009', query: 'check for license compliance issues', expectedSkillId: SKILL.FOSSA, acceptableSkillIds: [...ALT.LICENSE, SKILL.LICENSE_CHECKER], pattern: 'direct' },
  { id: 'eval-disambig-010', query: 'generate TypeScript documentation', expectedSkillId: SKILL.TYPEDOC, pattern: 'direct' },
  { id: 'eval-disambig-011', query: 'load test my service', expectedSkillId: SKILL.K6, acceptableSkillIds: ALT.K6, pattern: 'direct' },
  { id: 'eval-disambig-012', query: 'deploy my application to the cloud', expectedSkillId: SKILL.CLOUDFLARE_DEPLOY, acceptableSkillIds: ALT.CLOUDFLARE, pattern: 'direct' },
  { id: 'eval-disambig-013', query: 'run tests for my react components', expectedSkillId: SKILL.JEST, acceptableSkillIds: ALT.JEST, pattern: 'direct' },
  { id: 'eval-disambig-014', query: 'document my UI components', expectedSkillId: SKILL.STORYBOOK, acceptableSkillIds: ALT.STORYBOOK, pattern: 'direct' },
  { id: 'eval-disambig-015', query: 'analyze code for security vulnerabilities using queries', expectedSkillId: SKILL.CODEQL, acceptableSkillIds: [...ALT.CODEQL, ...ALT.SEMGREP], pattern: 'direct' },
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
