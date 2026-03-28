-- ══════════════════════════════════════════════════════════════════════════════
-- Bootstrap: Create the skills table on a fresh production database
-- ══════════════════════════════════════════════════════════════════════════════
--
-- The incremental migrations (0001–0014) expect the skills table to already
-- exist with its original core columns. On staging, the broader Runics platform
-- manages this table. For a fresh production database, we create it here.
--
-- After running this script, run all 14 migrations in order.
--
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL DEFAULT '1.0.0',
  source TEXT NOT NULL,
  description TEXT,
  agent_summary TEXT,
  alternate_queries TEXT[],
  schema_json JSONB,
  auth_requirements JSONB,
  install_method JSONB,
  trust_score NUMERIC(3,2) DEFAULT 0.5,
  capabilities_required TEXT[],
  execution_layer TEXT NOT NULL,
  content_safety_passed BOOLEAN,
  tags TEXT[],
  category TEXT,

  -- Legacy column referenced by migration 0012 (cognium_scanned boolean).
  -- Not in Drizzle schema but needed for migration compatibility.
  cognium_scanned BOOLEAN DEFAULT FALSE,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Core indexes (others are created by incremental migrations)
CREATE INDEX IF NOT EXISTS idx_skills_trust_score ON skills(trust_score);
CREATE INDEX IF NOT EXISTS idx_skills_source ON skills(source);
CREATE INDEX IF NOT EXISTS idx_skills_slug ON skills(slug);
CREATE INDEX IF NOT EXISTS idx_skills_execution_layer ON skills(execution_layer);
