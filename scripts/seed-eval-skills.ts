#!/usr/bin/env tsx
// ══════════════════════════════════════════════════════════════════════════════
// Seed Script — Populate Test Skills for Eval Suite
// ══════════════════════════════════════════════════════════════════════════════
//
// Creates and indexes 40 test skills needed for the eval suite (Phase 2):
// Covers overlapping domains to stress disambiguation.
//
// Usage:
//   npm run seed
//   npm run seed -- --endpoint http://localhost:8787
//   npm run seed -- --endpoint https://runics.workers.dev --tenant prod
//
// ══════════════════════════════════════════════════════════════════════════════

import type { SkillInput } from '../src/types';
import { Pool } from '@neondatabase/serverless';

// ──────────────────────────────────────────────────────────────────────────────
// Test Skills Definitions
// ──────────────────────────────────────────────────────────────────────────────

const TEST_SKILLS: SkillInput[] = [
  {
    id: '550e8400-e29b-41d4-a716-446655440001', // cargo-deny
    name: 'cargo-deny',
    slug: 'cargo-deny',
    version: '1.0.0',
    source: 'mcp-registry',
    description:
      'Check Rust crate licenses and security advisories. Prevents shipping code with incompatible licenses (GPL in proprietary) and known vulnerabilities.',
    agentSummary:
      'Use this tool when you need to check Rust crate dependencies for license compliance and security vulnerabilities. It scans Cargo.toml manifests to detect incompatible licenses and known security advisories, preventing problematic dependencies from being shipped.',
    tags: ['rust', 'security', 'license', 'compliance'],
    category: 'security',
    trustScore: 0.9,
    capabilitiesRequired: ['filesystem'],
    executionLayer: 'container',
    tenantId: 'eval-tenant',
    schemaJson: {
      type: 'function',
      function: {
        name: 'cargo-deny',
        description: 'Check Rust dependencies for license and security issues',
        parameters: {
          type: 'object',
          properties: {
            manifest_path: { type: 'string', description: 'Path to Cargo.toml' },
          },
        },
      },
    },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440002', // prettier
    name: 'prettier',
    slug: 'prettier',
    version: '3.0.0',
    source: 'mcp-registry',
    description:
      'Opinionated code formatter for JavaScript, TypeScript, JSON, CSS, Markdown. Ensures consistent code style across the team.',
    agentSummary:
      'Use this tool when you need to automatically format code to ensure consistent style across JavaScript, TypeScript, JSON, CSS, or Markdown files. It applies opinionated formatting rules that eliminate style debates and maintain clean, readable code.',
    tags: ['formatting', 'javascript', 'typescript', 'code-quality'],
    category: 'formatting',
    trustScore: 0.95,
    capabilitiesRequired: ['filesystem'],
    executionLayer: 'worker',
    tenantId: 'eval-tenant',
    schemaJson: {
      type: 'function',
      function: {
        name: 'prettier',
        description: 'Format code files',
        parameters: {
          type: 'object',
          properties: {
            files: { type: 'array', items: { type: 'string' } },
            config: { type: 'object' },
          },
        },
      },
    },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440003', // eslint
    name: 'eslint',
    slug: 'eslint',
    version: '8.0.0',
    source: 'mcp-registry',
    description:
      'Pluggable JavaScript linter. Identifies and fixes problems in JavaScript code, enforces coding standards, catches bugs before runtime.',
    agentSummary:
      'Use this tool when you need to lint JavaScript or TypeScript code to identify problems, enforce coding standards, and catch bugs before runtime. It can automatically fix many issues and provides detailed reports on code quality violations.',
    tags: ['linting', 'javascript', 'typescript', 'code-quality'],
    category: 'linting',
    trustScore: 0.95,
    capabilitiesRequired: ['filesystem'],
    executionLayer: 'worker',
    tenantId: 'eval-tenant',
    schemaJson: {
      type: 'function',
      function: {
        name: 'eslint',
        description: 'Lint JavaScript/TypeScript files',
        parameters: {
          type: 'object',
          properties: {
            files: { type: 'array', items: { type: 'string' } },
            fix: { type: 'boolean', description: 'Auto-fix issues' },
          },
        },
      },
    },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440004', // trivy
    name: 'trivy',
    slug: 'trivy',
    version: '1.0.0',
    source: 'mcp-registry',
    description:
      'Comprehensive security scanner for container images and filesystems. Detects vulnerabilities (CVEs), misconfigurations, secrets, and license issues.',
    agentSummary:
      'Use this tool when you need to scan container images or filesystems for security vulnerabilities, misconfigurations, exposed secrets, and license compliance issues. It provides comprehensive CVE detection and severity ratings for risk assessment.',
    tags: ['security', 'container', 'vulnerability', 'compliance'],
    category: 'security',
    trustScore: 0.9,
    capabilitiesRequired: ['container', 'network'],
    executionLayer: 'container',
    tenantId: 'eval-tenant',
    schemaJson: {
      type: 'function',
      function: {
        name: 'trivy',
        description: 'Scan container images for vulnerabilities',
        parameters: {
          type: 'object',
          properties: {
            image: { type: 'string', description: 'Container image to scan' },
            severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
          },
        },
      },
    },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440005', // docker-postgres
    name: 'docker-postgres',
    slug: 'docker-postgres',
    version: '15.0.0',
    source: 'mcp-registry',
    description:
      'PostgreSQL database in a Docker container. Perfect for local development, testing migrations, and integration tests without affecting production.',
    agentSummary:
      'Use this tool when you need to spin up a PostgreSQL database in a Docker container for local development, testing database migrations, or running integration tests. It provides an isolated database environment without affecting production systems.',
    tags: ['database', 'postgres', 'development', 'testing'],
    category: 'database',
    trustScore: 0.95,
    capabilitiesRequired: ['container', 'network'],
    executionLayer: 'container',
    tenantId: 'eval-tenant',
    schemaJson: {
      type: 'function',
      function: {
        name: 'docker-postgres',
        description: 'Start PostgreSQL container',
        parameters: {
          type: 'object',
          properties: {
            port: { type: 'number', description: 'Port to expose' },
            database: { type: 'string', description: 'Database name' },
          },
        },
      },
    },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440006', // pandoc
    name: 'pandoc',
    slug: 'pandoc',
    version: '3.0.0',
    source: 'mcp-registry',
    description:
      'Universal document converter. Converts between markup formats: Markdown, reStructuredText, HTML, LaTeX, PDF, Word, and more.',
    agentSummary:
      'Use this tool when you need to convert documents between different formats like Markdown, HTML, LaTeX, PDF, Word, or reStructuredText. It handles complex document transformations while preserving structure and formatting.',
    tags: ['documentation', 'conversion', 'markdown', 'pdf'],
    category: 'documentation',
    trustScore: 0.9,
    capabilitiesRequired: ['filesystem'],
    executionLayer: 'container',
    tenantId: 'eval-tenant',
    schemaJson: {
      type: 'function',
      function: {
        name: 'pandoc',
        description: 'Convert documents between formats',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Input file path' },
            output: { type: 'string', description: 'Output file path' },
            from: { type: 'string', description: 'Input format' },
            to: { type: 'string', description: 'Output format' },
          },
        },
      },
    },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440007', // redis
    name: 'redis',
    slug: 'redis',
    version: '7.0.0',
    source: 'mcp-registry',
    description:
      'In-memory data structure store used as database, cache, and message broker. Improves application performance with sub-millisecond latency.',
    agentSummary:
      'Use this tool when you need to set up an in-memory data store for caching, session management, or message brokering. It provides sub-millisecond latency for high-performance applications requiring fast data access and real-time operations.',
    tags: ['cache', 'database', 'performance', 'scalability'],
    category: 'infrastructure',
    trustScore: 0.95,
    capabilitiesRequired: ['network'],
    executionLayer: 'container',
    tenantId: 'eval-tenant',
    schemaJson: {
      type: 'function',
      function: {
        name: 'redis',
        description: 'Start Redis cache server',
        parameters: {
          type: 'object',
          properties: {
            port: { type: 'number', description: 'Port to expose' },
            maxmemory: { type: 'string', description: 'Max memory limit' },
          },
        },
      },
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 2 Skills — Overlapping Domains for Disambiguation
  // ──────────────────────────────────────────────────────────────────────────

  // LICENSE CHECKERS (cargo-deny=001 already exists)
  {
    id: '550e8400-e29b-41d4-a716-446655440008',
    name: 'license-checker',
    slug: 'license-checker',
    version: '25.0.0',
    source: 'mcp-registry',
    description:
      'Check npm package licenses against allowed/denied lists. Audits Node.js project dependencies for license compliance and outputs license inventory.',
    agentSummary:
      'Use this tool when you need to audit npm package licenses in a Node.js project. It checks all dependencies against configurable allowed and denied license lists and generates a compliance report.',
    tags: ['license', 'compliance', 'nodejs', 'npm'],
    category: 'security',
    trustScore: 0.85,
    capabilitiesRequired: ['filesystem'],
    executionLayer: 'worker',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'license-checker', description: 'Audit npm package licenses' } },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440009',
    name: 'fossa',
    slug: 'fossa',
    version: '3.0.0',
    source: 'mcp-registry',
    description:
      'Multi-language open source license compliance and vulnerability management. Scans projects across 20+ languages for license issues and security vulnerabilities.',
    agentSummary:
      'Use this tool when you need to perform enterprise-grade license compliance scanning across multiple programming languages. It detects license conflicts, generates SBOM reports, and identifies dependency vulnerabilities for regulatory compliance.',
    tags: ['license', 'compliance', 'security', 'multi-language', 'sbom'],
    category: 'security',
    trustScore: 0.9,
    capabilitiesRequired: ['filesystem', 'network'],
    executionLayer: 'container',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'fossa', description: 'Enterprise license compliance scanning' } },
  },

  // CODE FORMATTERS (prettier=002 already exists)
  {
    id: '550e8400-e29b-41d4-a716-446655440010',
    name: 'biome',
    slug: 'biome',
    version: '1.5.0',
    source: 'mcp-registry',
    description:
      'Fast formatter and linter for JavaScript, TypeScript, JSX, JSON. All-in-one replacement for Prettier and ESLint with near-instant performance.',
    agentSummary:
      'Use this tool when you need a fast all-in-one formatter and linter for JavaScript and TypeScript projects. It replaces both Prettier and ESLint with a single tool that runs in milliseconds.',
    tags: ['formatting', 'linting', 'javascript', 'typescript', 'performance'],
    category: 'formatting',
    trustScore: 0.85,
    capabilitiesRequired: ['filesystem'],
    executionLayer: 'worker',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'biome', description: 'Format and lint JS/TS code' } },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440011',
    name: 'black',
    slug: 'black',
    version: '24.0.0',
    source: 'mcp-registry',
    description:
      'The uncompromising Python code formatter. Formats Python code to a consistent style with no configuration needed.',
    agentSummary:
      'Use this tool when you need to format Python code. It enforces a consistent style with deterministic output and zero configuration, eliminating style debates in Python projects.',
    tags: ['formatting', 'python', 'code-quality'],
    category: 'formatting',
    trustScore: 0.9,
    capabilitiesRequired: ['filesystem'],
    executionLayer: 'worker',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'black', description: 'Format Python code' } },
  },

  // SECURITY SCANNERS
  {
    id: '550e8400-e29b-41d4-a716-446655440012',
    name: 'semgrep',
    slug: 'semgrep',
    version: '1.50.0',
    source: 'mcp-registry',
    description:
      'Lightweight static analysis for many languages. Find bugs, detect security vulnerabilities, and enforce code standards with custom pattern rules.',
    agentSummary:
      'Use this tool when you need to perform static code analysis across multiple languages. It detects security vulnerabilities, bugs, and anti-patterns using customizable pattern-matching rules that work on 30+ programming languages.',
    tags: ['security', 'static-analysis', 'multi-language', 'sast'],
    category: 'security',
    trustScore: 0.9,
    capabilitiesRequired: ['filesystem'],
    executionLayer: 'container',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'semgrep', description: 'Static analysis across languages' } },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440013',
    name: 'snyk',
    slug: 'snyk',
    version: '1.0.0',
    source: 'mcp-registry',
    description:
      'Find and fix vulnerabilities in open source dependencies and container images. Continuous monitoring with fix pull requests.',
    agentSummary:
      'Use this tool when you need to scan project dependencies for known vulnerabilities. It checks npm, pip, Maven, and other package ecosystems against a vulnerability database and suggests fix versions.',
    tags: ['security', 'vulnerability', 'dependencies', 'sca'],
    category: 'security',
    trustScore: 0.9,
    capabilitiesRequired: ['filesystem', 'network'],
    executionLayer: 'container',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'snyk', description: 'Scan dependencies for vulnerabilities' } },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440014',
    name: 'codeql',
    slug: 'codeql',
    version: '2.15.0',
    source: 'mcp-registry',
    description:
      'Semantic code analysis engine by GitHub. Queries code as data to find security vulnerabilities, bugs, and code patterns across repositories.',
    agentSummary:
      'Use this tool when you need deep semantic code analysis for security auditing. It treats code as queryable data to find complex vulnerability patterns like SQL injection, XSS, and authentication bypasses.',
    tags: ['security', 'static-analysis', 'github', 'sast'],
    category: 'security',
    trustScore: 0.95,
    capabilitiesRequired: ['filesystem'],
    executionLayer: 'container',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'codeql', description: 'Semantic code security analysis' } },
  },

  // CONTAINER TOOLS (trivy=004 already exists)
  {
    id: '550e8400-e29b-41d4-a716-446655440015',
    name: 'docker-build',
    slug: 'docker-build',
    version: '24.0.0',
    source: 'mcp-registry',
    description:
      'Build Docker container images from Dockerfiles. Supports multi-stage builds, build arguments, and layer caching for efficient image creation.',
    agentSummary:
      'Use this tool when you need to build Docker container images from a Dockerfile. It supports multi-stage builds, build arguments, and layer caching to create optimized container images.',
    tags: ['container', 'docker', 'build', 'devops'],
    category: 'devops',
    trustScore: 0.95,
    capabilitiesRequired: ['container'],
    executionLayer: 'container',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'docker-build', description: 'Build Docker images' } },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440016',
    name: 'dockerfile-lint',
    slug: 'dockerfile-lint',
    version: '1.0.0',
    source: 'mcp-registry',
    description:
      'Lint Dockerfiles for best practices and common mistakes. Checks for security issues, inefficient layers, and missing health checks.',
    agentSummary:
      'Use this tool when you need to validate Dockerfiles against best practices. It checks for security issues like running as root, inefficient layer ordering, missing health checks, and deprecated instructions.',
    tags: ['container', 'docker', 'linting', 'best-practices'],
    category: 'devops',
    trustScore: 0.8,
    capabilitiesRequired: ['filesystem'],
    executionLayer: 'worker',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'dockerfile-lint', description: 'Lint Dockerfiles' } },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440017',
    name: 'hadolint',
    slug: 'hadolint',
    version: '2.12.0',
    source: 'mcp-registry',
    description:
      'Haskell Dockerfile linter. Parses Dockerfiles into AST and checks against curated rules for shell best practices and Docker conventions.',
    agentSummary:
      'Use this tool when you need a strict Dockerfile linter that checks both Docker instructions and shell commands within RUN steps. It parses Dockerfiles into an AST and applies ShellCheck rules alongside Docker best practices.',
    tags: ['container', 'docker', 'linting', 'shellcheck'],
    category: 'devops',
    trustScore: 0.85,
    capabilitiesRequired: ['filesystem'],
    executionLayer: 'worker',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'hadolint', description: 'Lint Dockerfiles with shell analysis' } },
  },

  // API TESTING
  {
    id: '550e8400-e29b-41d4-a716-446655440018',
    name: 'postman',
    slug: 'postman',
    version: '10.0.0',
    source: 'mcp-registry',
    description:
      'API testing platform. Run API collections, validate responses, chain requests, and generate API documentation from test suites.',
    agentSummary:
      'Use this tool when you need to test APIs by running request collections. It validates response schemas, status codes, and body content, chains dependent requests, and generates documentation from your test suites.',
    tags: ['api', 'testing', 'http', 'documentation'],
    category: 'testing',
    trustScore: 0.9,
    capabilitiesRequired: ['network'],
    executionLayer: 'worker',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'postman', description: 'Run API test collections' } },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440019',
    name: 'httpie',
    slug: 'httpie',
    version: '3.2.0',
    source: 'mcp-registry',
    description:
      'Modern command-line HTTP client. Human-friendly syntax for making HTTP requests, inspecting responses, and debugging APIs.',
    agentSummary:
      'Use this tool when you need to make HTTP requests to test or debug APIs. It provides a human-friendly command-line interface for sending requests, inspecting headers, and viewing formatted response bodies.',
    tags: ['api', 'http', 'debugging', 'cli'],
    category: 'testing',
    trustScore: 0.85,
    capabilitiesRequired: ['network'],
    executionLayer: 'worker',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'httpie', description: 'HTTP client for API testing' } },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440020',
    name: 'rest-client',
    slug: 'rest-client',
    version: '1.0.0',
    source: 'mcp-registry',
    description:
      'HTTP request file runner. Execute .http/.rest files with variable substitution, environment switching, and response validation.',
    agentSummary:
      'Use this tool when you need to run HTTP request files (.http or .rest format) for API testing. It supports variable substitution, multiple environments, and can validate response status and body against expected values.',
    tags: ['api', 'testing', 'http', 'vscode'],
    category: 'testing',
    trustScore: 0.8,
    capabilitiesRequired: ['network', 'filesystem'],
    executionLayer: 'worker',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'rest-client', description: 'Run HTTP request files' } },
  },

  // DEPLOY TOOLS
  {
    id: '550e8400-e29b-41d4-a716-446655440021',
    name: 'terraform',
    slug: 'terraform',
    version: '1.7.0',
    source: 'mcp-registry',
    description:
      'Infrastructure as code tool. Define and provision cloud infrastructure declaratively across AWS, Azure, GCP, and other providers.',
    agentSummary:
      'Use this tool when you need to provision or manage cloud infrastructure using declarative configuration files. It plans and applies infrastructure changes across AWS, Azure, GCP, and 100+ other providers with state management and drift detection.',
    tags: ['infrastructure', 'iac', 'cloud', 'devops'],
    category: 'devops',
    trustScore: 0.95,
    capabilitiesRequired: ['network', 'filesystem'],
    executionLayer: 'container',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'terraform', description: 'Manage infrastructure as code' } },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440022',
    name: 'kubectl',
    slug: 'kubectl',
    version: '1.29.0',
    source: 'mcp-registry',
    description:
      'Kubernetes command-line tool. Deploy applications, inspect cluster resources, manage pods, services, and configurations.',
    agentSummary:
      'Use this tool when you need to interact with a Kubernetes cluster. It deploys applications, scales workloads, inspects pod logs, manages services, and applies configuration changes to cluster resources.',
    tags: ['kubernetes', 'container', 'orchestration', 'devops'],
    category: 'devops',
    trustScore: 0.95,
    capabilitiesRequired: ['network'],
    executionLayer: 'container',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'kubectl', description: 'Manage Kubernetes clusters' } },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440023',
    name: 'cloudflare-deploy',
    slug: 'cloudflare-deploy',
    version: '3.0.0',
    source: 'mcp-registry',
    description:
      'Deploy applications to Cloudflare Workers, Pages, and R2. Manages builds, environment variables, and rollbacks.',
    agentSummary:
      'Use this tool when you need to deploy applications to Cloudflare edge infrastructure. It handles Workers deployments, Pages builds, R2 storage configuration, and manages environment variables and rollbacks.',
    tags: ['deploy', 'cloudflare', 'edge', 'serverless'],
    category: 'devops',
    trustScore: 0.85,
    capabilitiesRequired: ['network'],
    executionLayer: 'worker',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'cloudflare-deploy', description: 'Deploy to Cloudflare' } },
  },

  // MONITORING
  {
    id: '550e8400-e29b-41d4-a716-446655440024',
    name: 'prometheus',
    slug: 'prometheus',
    version: '2.49.0',
    source: 'mcp-registry',
    description:
      'Time-series metrics collection and alerting system. Scrapes metrics endpoints, stores time-series data, and evaluates alerting rules.',
    agentSummary:
      'Use this tool when you need to collect application metrics and set up alerting. It scrapes /metrics endpoints, stores time-series data, and evaluates rules to fire alerts when thresholds are breached.',
    tags: ['monitoring', 'metrics', 'alerting', 'observability'],
    category: 'monitoring',
    trustScore: 0.95,
    capabilitiesRequired: ['network', 'container'],
    executionLayer: 'container',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'prometheus', description: 'Collect metrics and alerting' } },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440025',
    name: 'grafana',
    slug: 'grafana',
    version: '10.3.0',
    source: 'mcp-registry',
    description:
      'Data visualization and dashboarding platform. Create interactive dashboards from Prometheus, Loki, and other data sources.',
    agentSummary:
      'Use this tool when you need to create monitoring dashboards and visualizations. It connects to data sources like Prometheus, Loki, and databases to build interactive charts, graphs, and alert notification panels.',
    tags: ['monitoring', 'visualization', 'dashboards', 'observability'],
    category: 'monitoring',
    trustScore: 0.95,
    capabilitiesRequired: ['network', 'container'],
    executionLayer: 'container',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'grafana', description: 'Create monitoring dashboards' } },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440026',
    name: 'datadog',
    slug: 'datadog',
    version: '7.50.0',
    source: 'mcp-registry',
    description:
      'Full-stack monitoring and APM platform. Traces requests across services, collects logs and metrics, provides AI-powered anomaly detection.',
    agentSummary:
      'Use this tool when you need end-to-end application performance monitoring. It traces requests across microservices, collects distributed logs and infrastructure metrics, and uses ML to detect anomalies and performance regressions.',
    tags: ['monitoring', 'apm', 'tracing', 'logging', 'observability'],
    category: 'monitoring',
    trustScore: 0.9,
    capabilitiesRequired: ['network'],
    executionLayer: 'container',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'datadog', description: 'APM and monitoring platform' } },
  },

  // DATABASE TOOLS (docker-postgres=005 already exists)
  {
    id: '550e8400-e29b-41d4-a716-446655440027',
    name: 'mysql',
    slug: 'mysql',
    version: '8.0.0',
    source: 'mcp-registry',
    description:
      'MySQL database in a Docker container. Provides isolated MySQL instances for development, testing, and CI environments.',
    agentSummary:
      'Use this tool when you need to run a MySQL database locally in a container. It provides isolated MySQL instances for development, testing, and CI pipelines without affecting production systems.',
    tags: ['database', 'mysql', 'development', 'testing'],
    category: 'database',
    trustScore: 0.95,
    capabilitiesRequired: ['container', 'network'],
    executionLayer: 'container',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'mysql', description: 'Run MySQL database container' } },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440028',
    name: 'mongodb',
    slug: 'mongodb',
    version: '7.0.0',
    source: 'mcp-registry',
    description:
      'MongoDB NoSQL database container. Run MongoDB instances for document storage, development, and integration testing.',
    agentSummary:
      'Use this tool when you need a MongoDB NoSQL database for development or testing. It provides containerized MongoDB instances for document storage, aggregation pipeline testing, and application integration.',
    tags: ['database', 'mongodb', 'nosql', 'development'],
    category: 'database',
    trustScore: 0.9,
    capabilitiesRequired: ['container', 'network'],
    executionLayer: 'container',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'mongodb', description: 'Run MongoDB container' } },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440029',
    name: 'drizzle-migrate',
    slug: 'drizzle-migrate',
    version: '0.30.0',
    source: 'mcp-registry',
    description:
      'Database migration runner for Drizzle ORM. Generates and applies SQL migrations from TypeScript schema definitions.',
    agentSummary:
      'Use this tool when you need to run database migrations using Drizzle ORM. It generates SQL migration files from TypeScript schema changes and applies them safely with transaction support and rollback capability.',
    tags: ['database', 'migration', 'orm', 'typescript'],
    category: 'database',
    trustScore: 0.85,
    capabilitiesRequired: ['filesystem', 'network'],
    executionLayer: 'worker',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'drizzle-migrate', description: 'Run database migrations' } },
  },

  // GIT TOOLS
  {
    id: '550e8400-e29b-41d4-a716-446655440030',
    name: 'git-hooks',
    slug: 'git-hooks',
    version: '9.0.0',
    source: 'mcp-registry',
    description:
      'Git hook manager. Configure and share pre-commit, commit-msg, and pre-push hooks across the team with zero configuration.',
    agentSummary:
      'Use this tool when you need to set up Git hooks for your repository. It manages pre-commit, commit-msg, and pre-push hooks with easy configuration, ensuring code quality checks run automatically before commits and pushes.',
    tags: ['git', 'hooks', 'automation', 'code-quality'],
    category: 'git',
    trustScore: 0.9,
    capabilitiesRequired: ['filesystem'],
    executionLayer: 'worker',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'git-hooks', description: 'Manage Git hooks' } },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440031',
    name: 'commitlint',
    slug: 'commitlint',
    version: '18.0.0',
    source: 'mcp-registry',
    description:
      'Enforce conventional commit message format. Validates commit messages against configurable rules for consistent changelog generation.',
    agentSummary:
      'Use this tool when you need to enforce commit message conventions in a repository. It validates messages against rules like Conventional Commits format, enabling automated changelog generation and semantic versioning.',
    tags: ['git', 'commits', 'conventions', 'changelog'],
    category: 'git',
    trustScore: 0.85,
    capabilitiesRequired: ['filesystem'],
    executionLayer: 'worker',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'commitlint', description: 'Validate commit messages' } },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440032',
    name: 'semantic-release',
    slug: 'semantic-release',
    version: '23.0.0',
    source: 'mcp-registry',
    description:
      'Fully automated version management and package publishing. Analyzes commits to determine version bumps and generates changelogs.',
    agentSummary:
      'Use this tool when you need automated version management and release publishing. It analyzes commit messages to determine semantic version bumps (major/minor/patch), generates changelogs, and publishes packages to registries.',
    tags: ['git', 'release', 'versioning', 'automation', 'npm'],
    category: 'git',
    trustScore: 0.9,
    capabilitiesRequired: ['filesystem', 'network'],
    executionLayer: 'worker',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'semantic-release', description: 'Automated versioning and publishing' } },
  },

  // DOCS TOOLS (pandoc=006 already exists)
  {
    id: '550e8400-e29b-41d4-a716-446655440033',
    name: 'typedoc',
    slug: 'typedoc',
    version: '0.25.0',
    source: 'mcp-registry',
    description:
      'API documentation generator for TypeScript projects. Extracts types, interfaces, and JSDoc comments into browsable HTML documentation.',
    agentSummary:
      'Use this tool when you need to generate API documentation from TypeScript source code. It extracts types, interfaces, classes, and JSDoc comments into browsable HTML documentation with cross-references and search.',
    tags: ['documentation', 'typescript', 'api-docs', 'jsdoc'],
    category: 'documentation',
    trustScore: 0.85,
    capabilitiesRequired: ['filesystem'],
    executionLayer: 'worker',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'typedoc', description: 'Generate TypeScript API docs' } },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440034',
    name: 'storybook',
    slug: 'storybook',
    version: '8.0.0',
    source: 'mcp-registry',
    description:
      'Component documentation and visual testing workshop. Build, test, and document UI components in isolation.',
    agentSummary:
      'Use this tool when you need to document and test UI components in isolation. It provides a workshop environment for building component stories, running visual regression tests, and generating interactive documentation.',
    tags: ['documentation', 'ui', 'components', 'testing', 'react'],
    category: 'documentation',
    trustScore: 0.9,
    capabilitiesRequired: ['filesystem', 'network'],
    executionLayer: 'container',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'storybook', description: 'Document and test UI components' } },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440035',
    name: 'swagger-codegen',
    slug: 'swagger-codegen',
    version: '3.0.0',
    source: 'mcp-registry',
    description:
      'Generate API client SDKs and server stubs from OpenAPI/Swagger specifications. Supports 40+ languages and frameworks.',
    agentSummary:
      'Use this tool when you need to generate API client libraries or server stubs from an OpenAPI specification. It supports 40+ languages and frameworks, creating type-safe SDKs with authentication and request/response models.',
    tags: ['api', 'codegen', 'openapi', 'swagger', 'sdk'],
    category: 'documentation',
    trustScore: 0.85,
    capabilitiesRequired: ['filesystem'],
    executionLayer: 'container',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'swagger-codegen', description: 'Generate API clients from OpenAPI' } },
  },

  // TESTING
  {
    id: '550e8400-e29b-41d4-a716-446655440036',
    name: 'jest',
    slug: 'jest',
    version: '29.0.0',
    source: 'mcp-registry',
    description:
      'JavaScript testing framework with built-in assertions, mocking, and code coverage. Zero-config for most projects.',
    agentSummary:
      'Use this tool when you need to run JavaScript or TypeScript unit and integration tests. It provides built-in assertion libraries, mocking capabilities, snapshot testing, and code coverage reporting with zero configuration.',
    tags: ['testing', 'javascript', 'typescript', 'unit-testing', 'coverage'],
    category: 'testing',
    trustScore: 0.95,
    capabilitiesRequired: ['filesystem'],
    executionLayer: 'worker',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'jest', description: 'Run JavaScript/TypeScript tests' } },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440037',
    name: 'playwright',
    slug: 'playwright',
    version: '1.41.0',
    source: 'mcp-registry',
    description:
      'Browser automation and end-to-end testing framework. Test across Chromium, Firefox, and WebKit with auto-waiting and tracing.',
    agentSummary:
      'Use this tool when you need to run end-to-end browser tests or automate web interactions. It supports Chromium, Firefox, and WebKit with auto-waiting, network interception, and visual trace recording for debugging.',
    tags: ['testing', 'e2e', 'browser', 'automation', 'cross-browser'],
    category: 'testing',
    trustScore: 0.95,
    capabilitiesRequired: ['container', 'network'],
    executionLayer: 'container',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'playwright', description: 'Browser automation and E2E testing' } },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440038',
    name: 'k6',
    slug: 'k6',
    version: '0.49.0',
    source: 'mcp-registry',
    description:
      'Load testing tool for APIs and websites. Write tests in JavaScript, simulate thousands of virtual users, and analyze performance.',
    agentSummary:
      'Use this tool when you need to load test APIs or web applications. It simulates concurrent virtual users, measures response times and throughput, and identifies performance bottlenecks under realistic traffic patterns.',
    tags: ['testing', 'load-testing', 'performance', 'api'],
    category: 'testing',
    trustScore: 0.9,
    capabilitiesRequired: ['network'],
    executionLayer: 'container',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'k6', description: 'Load test APIs and websites' } },
  },

  // MISC
  {
    id: '550e8400-e29b-41d4-a716-446655440039',
    name: 'clippy',
    slug: 'clippy',
    version: '1.0.0',
    source: 'mcp-registry',
    description:
      'Official Rust linter. Catches common mistakes, suggests idiomatic Rust patterns, and enforces best practices in Rust code.',
    agentSummary:
      'Use this tool when you need to lint Rust code for common mistakes and non-idiomatic patterns. It catches potential bugs, suggests more efficient code patterns, and enforces Rust community best practices.',
    tags: ['rust', 'linting', 'code-quality', 'best-practices'],
    category: 'linting',
    trustScore: 0.95,
    capabilitiesRequired: ['filesystem'],
    executionLayer: 'container',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'clippy', description: 'Lint Rust code' } },
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440040',
    name: 'dependabot',
    slug: 'dependabot',
    version: '2.0.0',
    source: 'mcp-registry',
    description:
      'Automated dependency updates. Creates pull requests to keep project dependencies secure and up-to-date across multiple ecosystems.',
    agentSummary:
      'Use this tool when you need to keep project dependencies up-to-date automatically. It monitors dependency manifests, detects outdated or vulnerable packages, and creates pull requests with version bumps.',
    tags: ['dependencies', 'security', 'automation', 'github'],
    category: 'security',
    trustScore: 0.9,
    capabilitiesRequired: ['network', 'filesystem'],
    executionLayer: 'worker',
    tenantId: 'eval-tenant',
    schemaJson: { type: 'function', function: { name: 'dependabot', description: 'Automate dependency updates' } },
  },
];

// ──────────────────────────────────────────────────────────────────────────────
// Parse CLI Arguments
// ──────────────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);

  const options = {
    endpoint: 'http://localhost:8787',
    tenantId: 'eval-tenant',
    adminKey: process.env.ADMIN_API_KEY || '',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--endpoint':
      case '-e':
        options.endpoint = args[++i];
        break;
      case '--tenant':
      case '-t':
        options.tenantId = args[++i];
        break;
      case '--admin-key':
      case '-k':
        options.adminKey = args[++i];
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        printHelp();
        process.exit(1);
    }
  }

  return options;
}

function printHelp() {
  console.log(`
Runics Search — Seed Eval Skills

Usage:
  npm run seed [options]

Options:
  -e, --endpoint <url>    API endpoint (default: http://localhost:8787)
  -t, --tenant <id>       Tenant ID (default: eval-tenant)
  -h, --help              Show this help message

Examples:
  npm run seed
  npm run seed -- --endpoint https://runics.workers.dev
  npm run seed -- --tenant prod-tenant
`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Insert Skill into Database
// ──────────────────────────────────────────────────────────────────────────────

async function insertSkillsToDatabase(skills: SkillInput[]): Promise<void> {
  const connectionString = "postgresql://neondb_owner:npg_4P6BeXkZLcTA@ep-autumn-river-akx7s38p.c-3.us-west-2.aws.neon.tech/neondb?sslmode=require";
  const pool = new Pool({ connectionString });

  try {
    for (const skill of skills) {
      await pool.query(
        `INSERT INTO skills (
          id, name, slug, version, source, description, agent_summary,
          tags, category, trust_score, capabilities_required, execution_layer,
          tenant_id, content_safety_passed, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          agent_summary = EXCLUDED.agent_summary,
          updated_at = NOW()`,
        [
          skill.id,
          skill.name,
          skill.slug,
          skill.version,
          skill.source,
          skill.description,
          skill.agentSummary,
          skill.tags,
          skill.category,
          skill.trustScore,
          skill.capabilitiesRequired || [],
          skill.executionLayer,
          skill.tenantId,
          true, // content_safety_passed
        ]
      );
    }
  } finally {
    await pool.end();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Index Skill via API
// ──────────────────────────────────────────────────────────────────────────────

async function indexSkill(
  endpoint: string,
  skill: SkillInput,
  adminKey?: string
): Promise<{ success: boolean; error?: string; details?: any }> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminKey) headers['Authorization'] = `Bearer ${adminKey}`;

    const response = await fetch(`${endpoint}/v1/skills/${skill.id}/index`, {
      method: 'POST',
      headers,
      body: JSON.stringify(skill),
    });

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as any;
      return {
        success: false,
        error: errorData.error || `HTTP ${response.status}`,
        details: errorData,
      };
    }

    const data = await response.json();
    return { success: true, details: data };
  } catch (error) {
    return {
      success: false,
      error: (error as Error).message,
      details: error,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs();

  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║       RUNICS SEARCH — SEED EVAL SKILLS               ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Endpoint:    ${options.endpoint}`);
  console.log(`Tenant ID:   ${options.tenantId}`);
  console.log(`Skills:      ${TEST_SKILLS.length}`);
  console.log('');

  // Check endpoint health
  console.log('🔍 Checking endpoint health...');
  try {
    const healthResponse = await fetch(`${options.endpoint}/health`);
    if (!healthResponse.ok) {
      console.error('❌ Health check failed');
      console.error(`   HTTP ${healthResponse.status} ${healthResponse.statusText}`);
      process.exit(1);
    }
    const health = (await healthResponse.json()) as any;
    console.log(`✅ Endpoint healthy (db latency: ${health.dbLatencyMs}ms)`);
    console.log('');
  } catch (error) {
    console.error('❌ Failed to connect to endpoint');
    console.error(`   ${(error as Error).message}`);
    process.exit(1);
  }

  // Index each skill (this also inserts/updates the skill record)
  console.log('📦 Indexing skills...');
  console.log('');

  let successCount = 0;
  let failCount = 0;

  const failedSkills: Array<{ skill: string; error: string; details: any }> = [];

  for (let i = 0; i < TEST_SKILLS.length; i++) {
    const skill = TEST_SKILLS[i];
    process.stdout.write(`[${i + 1}/${TEST_SKILLS.length}] ${skill.name.padEnd(20)} `);

    const result = await indexSkill(options.endpoint, skill, options.adminKey);

    if (result.success) {
      console.log('✅');
      successCount++;
    } else {
      console.log(`❌ ${result.error}`);
      failedSkills.push({
        skill: skill.name,
        error: result.error || 'Unknown error',
        details: result.details,
      });
      failCount++;
    }
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`Success: ${successCount}/${TEST_SKILLS.length}`);
  console.log(`Failed:  ${failCount}/${TEST_SKILLS.length}`);
  console.log('═══════════════════════════════════════════════════════');

  if (failCount > 0) {
    console.log('');
    console.log('⚠️  Failed Skills - Detailed Errors:');
    console.log('');

    for (const failed of failedSkills) {
      console.log(`Skill: ${failed.skill}`);
      console.log(`Error: ${failed.error}`);
      console.log(`Details: ${JSON.stringify(failed.details, null, 2)}`);
      console.log('---');
    }

    process.exit(1);
  }

  console.log('');
  console.log('✅ All skills indexed successfully!');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Run the eval suite: npm run eval');
  console.log('  2. Check baseline metrics');
  console.log('  3. Tune confidence thresholds based on score distribution');
  console.log('');
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
