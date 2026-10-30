import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { v7 } from 'uuid';
import type { Clock } from 'second_brain';
import { homeResources } from '../config/resources.js';
import { postgresSecrets } from '../config/codec.js';
import { installedExtensionMigrations } from '../runtime/extensions.js';
import { containerState, volumeOwner } from '../runtime/orbstack.js';
import { commandEnv, composeArgs, systemCommandRunner, type CommandRunner } from '../runtime/command-runner.js';
export interface PostgresInstallReport { project: string; volume: string; port: number; schema_version: number; applied: readonly string[]; owner_created: boolean; owner_name: string; compose_started: boolean; legacy_sqlite_path?: string | null; import?: import('second_brain').BrainDrainReport | null }
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
export async function installPostgres(options: { home: string; urlEnv: string; env: NodeJS.ProcessEnv; clock: Clock; runner?: CommandRunner; secrets?: { adminUrl: string; appPassword: string }; databaseName?: string }): Promise<PostgresInstallResult> {
  const { home, urlEnv, env, clock } = options;
  const resources = homeResources(home);
  try {
    const runner = options.runner ?? systemCommandRunner;
    const owner = await volumeOwner({ home, env, runner });
    if (!owner.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: owner.message };
    if (owner.exists && owner.owner !== resources.project) return { ok: false, code: 'DB_UNAVAILABLE', message: `볼륨 ${resources.volume}은 다른 project ${owner.owner ?? '(라벨 없음)'}의 것입니다. 아무것도 지우지 않았습니다` };
    const secrets = options.secrets ?? await postgresSecrets(home, resources.port, urlEnv);
    const composePath = join(home, 'postgres', 'compose.yaml');
    const content = renderPostgresCompose(home);
    const unchanged = await readFile(composePath, 'utf8').then(value => value === content, () => false);
    const state = await containerState({ home, env, runner });
    await mkdir(join(home, 'postgres'), { recursive: true, mode: 0o700 });
    if (!unchanged) await writeFile(composePath, content, { mode: 0o600 });
    const composeStarted = !unchanged || !state.ok;
    if (composeStarted) {
      const started = await runner({ command: 'docker', args: composeArgs(home, ['up', '-d', '--wait']),
        env: commandEnv({ ...env, BRAIN_POSTGRES_PASSWORD: decodeURIComponent(new URL(secrets.adminUrl).password) }), timeoutMs: 120_000 });
      if (!started.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: /port is already allocated|address already in use/i.test(started.stderr)
        ? `PostgreSQL 포트 ${resources.port}를 이미 사용 중입니다. 사용하는 프로그램을 확인하세요`
        : `PostgreSQL 컨테이너를 시작하지 못했습니다. OrbStack 상태를 확인하세요\n${(started.stderr || started.stdout || started.message).slice(-2000)}` };
    }
    const { prepareDatabase, runMigrations, postgresStore } = await import('second_brain/postgres');
    const prepared = await prepareDatabase({ databaseUrl: secrets.adminUrl, appPassword: secrets.appPassword, ...(options.databaseName === undefined ? {} : { databaseName: options.databaseName }) });
    if (!prepared.ok) return { ...prepared, message: `${prepared.message}\n기존 볼륨의 비밀번호가 다르면 .env를 복원하거나 볼륨을 명시적으로 지운 뒤 다시 설치하세요` };
    const migrated = await runMigrations({ databaseUrl: prepared.databaseUrl, clock });
    if (!migrated.ok) return migrated;
    const store = postgresStore({ databaseUrl: prepared.databaseUrl });
    try {
      const registered = await store.listExtensions();
      if (!registered.ok) return registered;
      const owners = await installedExtensionMigrations(home, registered.extensions.map(extension => extension.name));
      const applied = [...migrated.applied];
      if (owners.length > 0) {
        const extensions = await runMigrations({ databaseUrl: prepared.databaseUrl, clock, owners });
        if (!extensions.ok) return extensions;
        applied.push(...extensions.applied);
      }
      const owner = await store.ensureSelfUser({ id: v7(), name: userInfo().username, createdAt: clock.now() });
      if (!owner.ok) return owner;
      return { ok: true, report: { ...resources, schema_version: migrated.to, applied, owner_created: owner.created, owner_name: owner.user.name, compose_started: composeStarted } };
    } finally { await store.close(); }
  } catch (error) { return { ok: false, code: 'DB_UNAVAILABLE', message: `PostgreSQL 설치에 실패했습니다: ${error instanceof Error ? error.message : String(error)}` }; }
}
