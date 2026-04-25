// ══════════════════════════════════════════════════════════════════════════════
// Database Connection — Hyperdrive-aware Pool factory
// ══════════════════════════════════════════════════════════════════════════════
//
// Prefers Cloudflare Hyperdrive (TCP connection pooling at the edge) when
// available. Falls back to direct Neon connection string for local dev
// or when Hyperdrive is not configured.
//
// Uses `pg` (node-postgres) which works with Hyperdrive's TCP layer.
// @neondatabase/serverless uses WebSockets and bypasses Hyperdrive entirely.
//
// ══════════════════════════════════════════════════════════════════════════════

import pg from 'pg';
import type { Env } from '../types';

const { Pool: PgPool } = pg;

/** Pool type for use in function signatures and class fields. */
export type Pool = InstanceType<typeof PgPool>;

/**
 * Get the connection string, preferring Hyperdrive when available.
 */
export function getConnectionString(env: Env): string {
  if (env.HYPERDRIVE?.connectionString) {
    return env.HYPERDRIVE.connectionString;
  }
  return env.NEON_CONNECTION_STRING;
}

/**
 * Create a new Pool using the best available connection method.
 */
export function createPool(env: Env): Pool {
  return new PgPool({ connectionString: getConnectionString(env) });
}
