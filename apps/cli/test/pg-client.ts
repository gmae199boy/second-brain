import pg from 'pg';
import { pgDatabaseUrl } from './pg-home.js';

// CLI fixtures compare portable values rather than pg's driver-specific types.
const types = new pg.TypeOverrides();
types.setTypeParser(20, value => Number(value));
types.setTypeParser(1184, value => new Date(value).toISOString());

/** An administrative PG connection for arranging and inspecting one test home. */
export class PgTestClient {
  private client: pg.Client;
  private ready: Promise<unknown>;
  constructor(homeOrUrl: string) {
    this.client = new pg.Client({ connectionString: pgDatabaseUrl(homeOrUrl), options: '-c search_path=brain,public', types });
    this.ready = this.client.connect();
  }
  async exec(sql: string): Promise<void> { await this.ready; await this.client.query(sql); }
  prepare(sql: string) {
    const all = async (...values: unknown[]) => { await this.ready; return (await this.client.query(sql, values)).rows; };
    return { all, get: async (...values: unknown[]) => (await all(...values))[0], run: async (...values: unknown[]) => { await all(...values); } };
  }
  async close(): Promise<void> { await this.ready.catch(() => {}); await this.client.end(); }
}
