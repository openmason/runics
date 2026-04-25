#!/usr/bin/env tsx
/**
 * Test database connection and check schema
 */

import pg from 'pg';
const { Pool } = pg;

async function main() {
  console.log('🔍 Testing Neon database connection...\n');

  // Get connection string from Hyperdrive config
  const hyperdriveId = '0a0c0917202e4d66909372fd5b430477';

  // You need to provide your Neon connection string directly
  // Format: postgresql://user:password@host/database?sslmode=require
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error('❌ DATABASE_URL environment variable not set');
    console.error('\nUsage:');
    console.error('  DATABASE_URL="postgresql://..." npm run test-db');
    console.error('\nGet your connection string from:');
    console.error('  https://console.neon.tech → Your Project → Connection Details');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });

  try {
    // Test basic connection
    console.log('1. Testing SELECT 1...');
    await pool.query('SELECT 1');
    console.log('   ✅ Basic connection works\n');

    // Check pgvector extension
    console.log('2. Checking pgvector extension...');
    const extResult = await pool.query(
      `SELECT * FROM pg_extension WHERE extname = 'vector'`
    );
    if (extResult.rows.length > 0) {
      console.log('   ✅ pgvector extension installed\n');
    } else {
      console.log('   ❌ pgvector extension NOT installed\n');
      console.log('   Run: CREATE EXTENSION IF NOT EXISTS vector;\n');
    }

    // List tables
    console.log('3. Checking existing tables...');
    const tablesResult = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    if (tablesResult.rows.length === 0) {
      console.log('   ⚠️  No tables found\n');
    } else {
      console.log(`   Found ${tablesResult.rows.length} tables:`);
      tablesResult.rows.forEach((row: any) => {
        console.log(`   - ${row.table_name}`);
      });
      console.log('');
    }

    // Check required tables
    const requiredTables = ['skills', 'skill_embeddings', 'search_logs', 'quality_feedback'];
    const existingTables = tablesResult.rows.map((r: any) => r.table_name);
    const missingTables = requiredTables.filter((t) => !existingTables.includes(t));

    if (missingTables.length > 0) {
      console.log('❌ Missing required tables:');
      missingTables.forEach((t) => console.log(`   - ${t}`));
      console.log('\nYou need to run the migrations:');
      console.log('  1. Connect to your database');
      console.log('  2. Run: src/db/migrations/0001_skill_embeddings.sql');
      console.log('  3. Run: src/db/migrations/0002_search_logs.sql');
      console.log('  4. Run: src/db/migrations/0003_quality_feedback.sql');
      console.log('\nOr create the skills table first (see SETUP.md)');
    } else {
      console.log('✅ All required tables exist!\n');
      console.log('Your database is ready to use.');
    }

  } catch (error) {
    console.error('❌ Database error:', (error as Error).message);
    console.error('\nTroubleshooting:');
    console.error('  - Check your connection string is correct');
    console.error('  - Ensure database exists in Neon');
    console.error('  - Verify database is not sleeping (Neon free tier)');
    console.error('  - Check Hyperdrive configuration matches Neon details');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
