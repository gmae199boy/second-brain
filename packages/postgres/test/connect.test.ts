import { expect, it } from 'vitest';
import { createPool } from '../src/connect.js';

it.each([
  [{}, 5000, 6000, 7000],
  [{ connectTimeoutMs: 50 }, 50, 1050, 2050],
  [{ lockTimeoutMs: 50, queryTimeoutMs: 50 }, 50, 1050, 2050],
  [{ queryTimeoutMs: 0 }, 5000, 0, 0],
] as const)('orders server and client deadlines and preserves unlimited migrations: %j', async (options, lock, statement, client) => {
  const pool = createPool({ databaseUrl: 'postgresql://localhost/unused', ...options });
  try {
    expect(pool.options.connectionTimeoutMillis).toBe(('connectTimeoutMs' in options ? options.connectTimeoutMs : 5000));
    expect(pool.options.options).toBe(`-c lock_timeout=${lock} -c statement_timeout=${statement} -c timezone=UTC`);
    expect(pool.options.query_timeout).toBe(client);
  } finally { await pool.end(); }
});
