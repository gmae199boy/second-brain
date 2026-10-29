import { spawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempHomes } from './temp-home.js';
import { pgHome } from './pg-home.js';
import { withoutHarnessFolders } from './environment.js';
export async function extHome() {
  const homes = tempHomes(), home = await homes.create('brain-ext-');
  const db = await pgHome(home);
  // Production setup creates the database with brain_owner ownership. The
  // shared test helper precreates it as postgres, so reproduce that ownership.
  const databaseName = new URL(db.url).pathname.slice(1);
  if (!/^[a-z][a-z0-9_]*$/.test(databaseName)) throw new Error('잘못된 시험 데이터베이스 이름');
  await db.query(`alter database "${databaseName}" owner to brain_owner`);
  const password = decodeURIComponent(new URL(db.url).password);
  await appendFile(join(home, '.env'), `BRAIN_POSTGRES_PASSWORD=${password}\n`);
  const env = { ...withoutHarnessFolders(process.env), SECOND_BRAIN_HOME: home, SECOND_BRAIN_TEST_EXTENSIONS: fileURLToPath(new URL('./fixtures/extensions/', import.meta.url)), BRAIN_DATABASE_URL: db.appUrl };
  return {
    home, db, env,
    run(args: readonly string[]) {
      return new Promise<{ code: number | null; stdout: string; stderr: string; body: any }>((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', code => { let body; try { body = JSON.parse(stdout); } catch { body = undefined; } resolve({ code, stdout, stderr, body }); });
      });
    },
    ledger(owner: string) {
      if (!/^[a-z][a-z0-9_]*$/.test(owner)) throw new Error('잘못된 소유자');
      return db.rows(`select owner,version from brain.schema_migrations where owner='${owner}' order by version`);
    },
    async cleanup() { await db.drop(); await homes.cleanup(); },
  };
}
