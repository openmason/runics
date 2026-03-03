#!/usr/bin/env tsx
// ══════════════════════════════════════════════════════════════════════════════
// Seed Script — Populate Test Skills for Eval Suite
// ══════════════════════════════════════════════════════════════════════════════
//
// Creates and indexes the 7 test skills needed for the eval suite:
// - cargo-deny (Rust license checker)
// - prettier (Code formatter)
// - eslint (JavaScript linter)
// - trivy (Container security scanner)
// - docker-postgres (Local Postgres)
// - pandoc (Document converter)
// - redis (Caching layer)
//
// Usage:
//   npm run seed
//   npm run seed -- --endpoint http://localhost:8787
//   npm run seed -- --endpoint https://runics-search.workers.dev --tenant prod
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
];

// ──────────────────────────────────────────────────────────────────────────────
// Parse CLI Arguments
// ──────────────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);

  const options = {
    endpoint: 'http://localhost:8787',
    tenantId: 'eval-tenant',
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
  npm run seed -- --endpoint https://runics-search.workers.dev
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
  skill: SkillInput
): Promise<{ success: boolean; error?: string; details?: any }> {
  try {
    const response = await fetch(`${endpoint}/v1/skills/${skill.id}/index`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
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

    const result = await indexSkill(options.endpoint, skill);

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
