import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { exitCodeGuide, guideShow } from 'second_brain';
import { commands } from '../src/commands/index.js';
import { HOME_ENV } from '../src/config/paths.js';
import { assertKoreanLines } from './language.js';
import { withoutHarnessFolders } from './environment.js';

/**
 * The three `guide` commands, against the built binary in a home where nothing
 * is installed. That is the whole point of them being `standalone`: an agent
 * asking what this CLI takes, or what an exit code means, is often asking
 * because nothing works yet — and the plugin's install step proves the build
 * by calling `guide schema --json` before there is any configuration (epic 2,
 * story 5).
 */

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

/** A home with no configuration in it, and no file to make one from. */
const NO_HOME = '/nonexistent/second-brain-home';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Envelope<T> {
  ok: boolean;
  now: string;
  data?: T;
  warnings: string[];
  error?: { code: string; message: string; exit_code?: number; hint?: string };
}

function runBrain(args: readonly string[]): Promise<Run> {
  const env: NodeJS.ProcessEnv = withoutHarnessFolders({
    ...process.env,
    [HOME_ENV]: NO_HOME,
  });
  const child = spawn(process.execPath, [binPath, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** The command and option names, which Boundaries keeps in English. */
const COMMAND_WORDS: readonly string[] = [
  ...commands.map((spec) => `${spec.ns} ${spec.verb}`),
  ...commands.map((spec) => spec.ns),
  ...commands.map((spec) => spec.verb),
  ...commands.flatMap((spec) => [...spec.required]),
  ...commands.flatMap((spec) => spec.examples.flatMap((example) => example.split(/\s+/))),
];

interface CommandSchema {
  ns: string;
  verb: string;
  used_for: string;
  required: string[];
  examples: string[];
  output: string;
  risk: string;
  hook: boolean;
  dry_run: boolean;
  arguments: { name: string; required: boolean }[];
  options: { flags: string; description: string }[];
}

beforeAll(() => {
  if (!existsSync(binPath)) {
    throw new Error(`${binPath} does not exist. Run \`pnpm build\` before these tests.`);
  }
});

describe('brain guide schema', () => {
  it('answers every registered command, in the registry order, with no configuration', async () => {
    const run = await runBrain(['guide', 'schema', '--json']);

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope<{ commands: CommandSchema[] }>;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual([]);

    // The registry is the schema: a command that exists is a command this
    // answers for, and the order is the one `--help` prints.
    expect((envelope.data?.commands ?? []).map((one) => `${one.ns} ${one.verb}`)).toEqual(
      commands.map((spec) => `${spec.ns} ${spec.verb}`),
    );
  });

  it('carries the seven meta fields of each command, in the envelope spelling', async () => {
    const run = await runBrain(['guide', 'schema', '--json']);

    const schemas = (JSON.parse(run.stdout) as Envelope<{ commands: CommandSchema[] }>).data
      ?.commands ?? [];
    for (const spec of commands) {
      const schema = schemas.find((one) => one.ns === spec.ns && one.verb === spec.verb);
      expect(schema, `${spec.ns} ${spec.verb}`).toBeDefined();
      // `used_for` and `dry_run`, not `usedFor` and `dryRun`: the JSON keys of
      // this CLI are the envelope's (Conventions, 이름).
      expect(schema).toMatchObject({
        used_for: spec.usedFor,
        required: [...spec.required],
        examples: [...spec.examples],
        output: spec.output,
        risk: spec.risk,
        hook: spec.hook,
        dry_run: spec.dryRun,
      });
      expect(schema?.arguments).toEqual(
        (spec.arguments ?? []).map((declared) => ({
          name: declared.replace(/^[<[]/, '').replace(/[>\]]$/, ''),
          required: declared.startsWith('<'),
        })),
      );
      expect(schema?.options).toEqual(
        (spec.options ?? []).map((option) => ({
          flags: option.flags,
          description: option.description,
        })),
      );
    }
  });

  it('narrows to one namespace, and to one command', async () => {
    const namespace = await runBrain(['guide', 'schema', 'guide', '--json']);
    const one = await runBrain(['guide', 'schema', 'doctor', 'run', '--json']);

    expect(namespace.code).toBe(0);
    const inNamespace = (
      JSON.parse(namespace.stdout) as Envelope<{ commands: CommandSchema[] }>
    ).data?.commands ?? [];
    expect(inNamespace.map((command) => command.verb)).toEqual(
      commands.filter((spec) => spec.ns === 'guide').map((spec) => spec.verb),
    );

    expect(one.code).toBe(0);
    const single = (JSON.parse(one.stdout) as Envelope<{ commands: CommandSchema[] }>).data
      ?.commands ?? [];
    expect(single).toHaveLength(1);
    expect(single[0]).toMatchObject({ ns: 'doctor', verb: 'run' });
  });

  it('answers USAGE and names the namespaces it knows for one it does not', async () => {
    const run = await runBrain(['guide', 'schema', 'nope', '--json']);

    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as Envelope<never>;
    expect(envelope.error?.code).toBe('USAGE');
    expect(envelope.error?.exit_code).toBe(2);
    for (const ns of new Set(commands.map((spec) => spec.ns))) {
      expect(envelope.error?.message).toContain(ns);
    }
  });

  it('answers USAGE and names the verbs of that namespace for a verb it does not know', async () => {
    const run = await runBrain(['guide', 'schema', 'doctor', 'nope', '--json']);

    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as Envelope<never>;
    expect(envelope.error?.code).toBe('USAGE');
    expect(envelope.error?.message).toContain('run');
  });

  it('prints a few lines per command in text mode, in Korean', async () => {
    const run = await runBrain(['guide', 'schema', 'doctor', 'run']);

    expect(run.code).toBe(0);
    const lines = run.stdout.trimEnd().split('\n');
    expect(lines[0]).toBe('doctor run: brain에 닿는지, 건강한지 확인합니다');
    expect(lines.some((line) => line.includes('예시: brain doctor run'))).toBe(true);
    expect(lines.some((line) => line.startsWith('  출력: '))).toBe(true);
    expect(lines.some((line) => line.startsWith('  위험도: '))).toBe(true);
    assertKoreanLines(run.stdout, { label: 'guide schema', allow: COMMAND_WORDS });
  });
});

describe('brain guide exit-codes', () => {
  it('answers exactly what the Core constants say', async () => {
    const run = await runBrain(['guide', 'exit-codes', '--json']);

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope<unknown>;
    expect(envelope.ok).toBe(true);
    // Rendered, never re-worded: the tables are Core's (AD-17), and a CLI that
    // said anything else would be a second code table.
    expect(envelope.data).toEqual(JSON.parse(JSON.stringify(exitCodeGuide())));
  });

  it('prints the three tables in text mode, in Korean', async () => {
    const run = await runBrain(['guide', 'exit-codes']);

    expect(run.code).toBe(0);
    const guide = exitCodeGuide();
    for (const row of guide.exit_codes) {
      expect(run.stdout).toContain(row.meaning);
      expect(run.stdout).toContain(row.agent_action);
    }
    for (const row of guide.error_codes) expect(run.stdout).toContain(row.code);
    for (const row of guide.warning_codes) expect(run.stdout).toContain(row.code);
    assertKoreanLines(run.stdout, { label: 'guide exit-codes', allow: COMMAND_WORDS });
  });
});

describe('brain guide show', () => {
  it('prints the conventions section as Markdown, with the six prohibitions', async () => {
    const run = await runBrain(['guide', 'show']);

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('## CLI 사용 규약');
    // The six things an agent must not do (Conventions). Each is here as the
    // phrase that names it, so a section that quietly loses one fails.
    for (const forbidden of [
      '`--yes`를 스스로 붙이지 않습니다',
      '사람에게 묻지 않고 `error.retry`를 부르지 않습니다',
      '백오프 루프로 되풀이하지 않습니다',
      '덜 파괴적인 동사로 우회하지 않습니다',
      '이전 승인을 다시 쓰지 않습니다',
      '`--json`으로 확인을 피해 가지 않습니다',
    ]) {
      expect(run.stdout).toContain(forbidden);
    }
    expect(run.stdout).toContain('stderr는 실패 신호가 아닙니다');
    assertKoreanLines(run.stdout, { label: 'guide show', allow: COMMAND_WORDS });
  });

  it('builds its exit-code table from the same constants', async () => {
    const run = await runBrain(['guide', 'show']);

    for (const row of exitCodeGuide().exit_codes) {
      expect(run.stdout).toContain(row.meaning);
      expect(run.stdout).toContain(row.agent_action);
    }
  });

  it('hands the same Markdown over as data under --json', async () => {
    const run = await runBrain(['guide', 'show', '--json']);

    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope<{ markdown: string }>;
    expect(envelope.ok).toBe(true);
    expect(envelope.data?.markdown).toBe(guideShow());
  });
});

describe('the namespace that was removed', () => {
  it('refuses `brain admin doctor` with USAGE rather than running anything', async () => {
    const run = await runBrain(['admin', 'doctor', '--json']);

    // No alias is kept: nobody outside this repository has run the old name,
    // so it is a command nobody registered (Decision 2026-10-16).
    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as Envelope<never>;
    expect(envelope.error?.code).toBe('USAGE');
    expect(envelope.error?.message).toContain('doctor run');
  });
});
