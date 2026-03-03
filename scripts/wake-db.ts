#!/usr/bin/env tsx
/**
 * Wake up Neon database (free tier auto-suspends)
 */

import { Pool, neonConfig } from '@neondatabase/serverless';

// Use HTTP fetch mode
neonConfig.fetchConnectionCache = true;

const pool = new Pool({
  connectionString: "postgresql://neondb_owner:npg_4P6BeXkZLcTA@ep-autumn-river-akx7s38p-pooler.c-3.us-west-2.aws.neon.tech/neondb?sslmode=require"
});

async function wake() {
  try {
    console.log('🔄 Attempting to wake Neon database...');
    const result = await pool.query('SELECT NOW() as time, version() as version');
    console.log('✅ Database is awake!');
    console.log('   Time:', result.rows[0].time);
    console.log('   Version:', result.rows[0].version.substring(0, 60) + '...');

    // Check if tables exist
    const tables = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    console.log(`\n📊 Found ${tables.rows.length} tables:`);
    tables.rows.forEach((row: any) => console.log(`   - ${row.table_name}`));

    await pool.end();
  } catch (error) {
    console.error('❌ Error:', (error as Error).message);
    console.error('\nThe database may be sleeping. Try again in a few seconds.');
    process.exit(1);
  }
}

wake();
