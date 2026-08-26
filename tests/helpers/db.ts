import 'dotenv/config';
import pg from 'pg';

// Schema assertions must read pg_catalog and information_schema, which
// PostgREST does not expose. They therefore need a direct connection.
const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.\n' +
      'Supabase dashboard -> Project Settings -> Database -> Connection string -> URI',
  );
}

export const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  max: 4,
});

export async function q<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
