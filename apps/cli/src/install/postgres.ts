import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { v7 } from 'uuid';
import type { Clock } from 'second_brain';
import { homeResources } from '../config/resources.js';
import { postgresSecrets } from '../config/codec.js';
import { composeArgs, systemCommandRunner, type CommandRunner } from '../runtime/command-runner.js';
export interface PostgresInstallReport { project: string; volume: string; port: number; schema_version: number; applied: readonly string[]; owner_created: boolean }
export type PostgresInstallResult = { ok: true; report: PostgresInstallReport } | { ok: false; code: string; message: string };
export function renderPostgresCompose(home: string): string {
  const r = homeResources(home);
  return `name: ${r.project}
services:
  postgres:
    image: postgres:18
    environment:
      POSTGRES_PASSWORD: \${BRAIN_POSTGRES_PASSWORD:?BRAIN_POSTGRES_PASSWORD is required}
    ports:
      - "127.0.0.1:${r.port}:5432"
    volumes:
      - data:/var/lib/postgresql
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 1s
      timeout: 3s
      retries: 60
volumes:
  data:
    name: ${r.volume}
`;
}
export async function installPostgres(options: { home: string; urlEnv: string; env: NodeJS.ProcessEnv; clock: Clock; runner?: CommandRunner }): Promise<PostgresInstallResult> {
  const { home, urlEnv, env, clock } = options;
  const resources = homeResources(home);
  try {
    const secrets = await postgresSecrets(home, resources.port, urlEnv);
    await mkdir(join(home, 'postgres'), { recursive: true, mode: 0o700 });
    await writeFile(join(home, 'postgres', 'compose.yaml'), renderPostgresCompose(home), { mode: 0o600 });
    const started = await (options.runner ?? systemCommandRunner)({ command: 'docker', args: composeArgs(home, ['up', '-d', '--wait']),
      env: { ...env, BRAIN_POSTGRES_PASSWORD: decodeURIComponent(new URL(secrets.adminUrl).password) }, timeoutMs: 120_000 });
    if (!started.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: `PostgreSQL 컨테이너를 시작하지 못했습니다. OrbStack을 켜고 다시 실행하세요\n${(started.stderr || started.stdout || started.message).slice(-2000)}` };
    const { prepareDatabase, runMigrations, postgresStore } = await import('second_brain/postgres');
    const prepared = await prepareDatabase({ databaseUrl: secrets.adminUrl, appPassword: secrets.appPassword });
    if (!prepared.ok) return { ...prepared, message: `${prepared.message}\n기존 볼륨의 비밀번호가 다르면 .env를 복원하거나 볼륨을 명시적으로 지운 뒤 다시 설치하세요` };
    const migrated = await runMigrations({ databaseUrl: prepared.databaseUrl, clock });
    if (!migrated.ok) return migrated;
    const store = postgresStore({ databaseUrl: prepared.databaseUrl });
    try {
      const owner = await store.ensureSelfUser({ id: v7(), name: userInfo().username, createdAt: clock.now() });
      if (!owner.ok) return owner;
      return { ok: true, report: { ...resources, schema_version: migrated.to, applied: migrated.applied, owner_created: owner.created } };
    } finally { await store.close(); }
  } catch (error) { return { ok: false, code: 'DB_UNAVAILABLE', message: `PostgreSQL 설치에 실패했습니다: ${error instanceof Error ? error.message : String(error)}` }; }
}
