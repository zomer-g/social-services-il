import pg from 'pg';

const { Pool } = pg;

/**
 * Postgres numerics arrive as strings by default so that arbitrary precision
 * survives the wire. Every numeric in this schema is a count, a score or a
 * coordinate, all of which fit a double comfortably.
 */
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8

let pool: pg.Pool | undefined;

/**
 * TLS is opt-in via the connection string, because the database the platform
 * provisions sits on a private per-channel network and speaks plaintext —
 * asking it for SSL fails the connection outright. A managed database reached
 * over the open internet says `sslmode=require` in its URL and gets TLS.
 */
function sslOption(connectionString: string): pg.PoolConfig['ssl'] {
  const mode = new URL(connectionString).searchParams.get('sslmode');
  if (!mode || mode === 'disable' || mode === 'allow' || mode === 'prefer') return false;
  // Providers front Postgres with certificates that do not chain to a public
  // root, so verification is relaxed while the transport stays encrypted.
  return { rejectUnauthorized: mode === 'verify-full' };
}

export function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool = new Pool({
    connectionString,
    // The host gives each channel its own small Postgres; a modest ceiling
    // keeps a burst of API traffic from exhausting it.
    max: Number(process.env['PG_POOL_MAX'] ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: sslOption(connectionString),
  });
  pool.on('error', (err) => console.error('[error] idle postgres client:', err.message));
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as unknown[]);
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
