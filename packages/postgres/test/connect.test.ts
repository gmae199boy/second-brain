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

const profiles = [
  ['turn', 3000, 'second-brain-hook'], ['command', 10000, 'second-brain-command'], ['drain', 10000, 'second-brain-drain'],
] as const;
it.each(profiles)('sets the %s path pool options', async (path, budget, applicationName) => {
  const pool = createPool({ databaseUrl: 'postgresql://localhost/unused', path });
  try {
    expect(pool.options.connectionTimeoutMillis).toBe(budget);
    expect(pool.options.query_timeout).toBe(budget + 2000);
    expect(pool.options.options).toBe(`-c lock_timeout=${budget} -c statement_timeout=${budget + 1000} -c timezone=UTC`);
    expect(pool.options.application_name).toBe(applicationName);
  } finally { await pool.end(); }
});
it('lets explicit settings override a path profile', async () => {
  const pool = createPool({ databaseUrl: 'postgresql://localhost/unused', path: 'turn', connectTimeoutMs: 20, lockTimeoutMs: 40, queryTimeoutMs: 1200, applicationName: 'explicit' });
  try {
    expect(pool.options.connectionTimeoutMillis).toBe(20);
    expect(pool.options.query_timeout).toBe(2200);
    expect(pool.options.options).toBe('-c lock_timeout=40 -c statement_timeout=1200 -c timezone=UTC');
    expect(pool.options.application_name).toBe('explicit');
  } finally { await pool.end(); }
});
it.each(profiles)('applies the %s path profile to a live session', async (path, budget, applicationName) => {
  const { database } = await import('./fixture.js');
  const db = await database(); const pool = createPool({ databaseUrl: db.appUrl, path });
  try {
    const result = await pool.query("select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as statement, current_setting('application_name') as application, current_setting('TimeZone') as timezone");
    expect(result.rows).toEqual([{ lock: `${budget / 1000}s`, statement: `${(budget + 1000) / 1000}s`, application: applicationName, timezone: 'UTC' }]);
  } finally { await pool.end(); await db.drop(); }
});
