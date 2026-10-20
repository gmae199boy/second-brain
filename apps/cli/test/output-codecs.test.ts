import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { OUTPUT_CODECS, toolNoteForOutput } from 'second_brain';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HOME_ENV } from '../src/config/paths.js';
import { dispatch, type CommandSpec } from '../src/dispatch.js';
import { systemClock } from '../src/runtime/clock.js';
import { withoutHarnessFolders } from './environment.js';
import {
  KEPT_IN_FIXTURE,
  SECRETS,
  SECRETS_FIXTURE,
  TRUNCATED_HALF_KEY,
} from './secrets-fixture.js';

/**
 * The output codec contract, end to end, and the sink check that keeps it
 * honest (AD-11, 마스킹 B, change D1).
 *
 * Two halves, and both are needed. The first ingests the secrets fixture
 * through the real binary into a real SQLite file and pushes what was stored
 * through every registered codec: the database holds the secrets, no codec
 * lets one out, and ordinary code and prose survive the trip. The second walks
 * the source tree for anything that writes to stdout or stderr and refuses a
 * file the sink table below does not name — because the first half can only
 * check the ways out somebody registered, and the way a secret actually
 * escapes is a new `process.stdout.write` nobody thought about.
 *
 * `tooling/` and `plugin/` are outside both halves on purpose: neither may
 * import Core (AD-1, the boundary test of `second_brain`), they use node
 * built-ins alone, and neither reads the database — the bootstrap prints its
 * own progress and the plugin shim prints what the harness gave it.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const installPath = fileURLToPath(new URL('../dist/install.js', import.meta.url));
const HARNESS_SESSION = '4f1e7a90-1c2b-4d3e-8f55-000000000000';

/**
 * Every file under `apps/*​/src` and `packages/*​/src` that writes to stdout or
 * stderr, and the output codecs it writes through.
 *
 * A file that writes and is not in here fails the check, and so does a row
 * that names a file which no longer writes or a codec nobody registered. The
 * commander help text is the one thing deliberately absent from the list of
 * writers: it is printed by commander itself out of the registry's static
 * Korean sentences, none of which has ever been near the database.
 */
const SINKS: Readonly<Record<string, readonly string[]>> = {
  // The dispatcher's two sinks. Text mode and the warning lines go through
  // `text`; a hook's one line of stderr goes through `hook`; `--json` is
  // already masked, because Core masks an envelope as it builds it.
  'apps/cli/src/dispatch.ts': ['text', 'hook'],
  // The installer prints as it asks, so it cannot wait for the dispatcher.
  'apps/cli/src/install.ts': ['text'],
  'apps/cli/src/commands/setup-run.ts': ['text'],
};

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function childEnvironment(home: string): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = withoutHarnessFolders({
    ...process.env,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    [HOME_ENV]: home,
  });
  delete childEnv['SECOND_BRAIN_DATABASE_URL'];
  delete childEnv['BRAIN_TEST_DATABASE_URL'];
  return childEnv;
}

function run(script: string, args: readonly string[], home: string, stdin: string): Promise<Run> {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env: childEnvironment(home),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdin.end(stdin);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** An installed brain with the secrets fixture already in it. */
async function brainWithSecrets(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'brain-codec-'));
  homes.push(home);
  const install = await run(installPath, ['--yes'], home, '');
  expect(install.code, install.stdout + install.stderr).toBe(0);

  const transcript = join(home, 'secrets.jsonl');
  await copyFile(SECRETS_FIXTURE, transcript);
  const payload = JSON.stringify({
    session_id: HARNESS_SESSION,
    transcript_path: transcript,
    cwd: '/demo/repo',
    hook_event_name: 'Stop',
    stop_hook_active: false,
  });
  const ingest = await run(binPath, ['sessions', 'ingest', 'claude-code'], home, payload);
  expect(ingest.code, ingest.stdout + ingest.stderr).toBe(0);
  return home;
}

/** The stored session as a read would hand it to a codec (Decision 2026-10-19). */
function probeFrom(home: string): { texts: string[] } {
  const database = new DatabaseSync(join(home, 'brain.db'), { readOnly: true });
  try {
    const bodies = (
      database.prepare('select body from messages order by seq').all() as { body: string }[]
    ).map((row) => row.body);
    // The target column first, through the tool note rule: the shell form runs
    // over that column alone, and a codec walking a finished answer could no
    // longer tell which string came from it.
    const targets = (
      database.prepare('select target from tool_notes order by ordinal').all() as {
        target: string;
      }[]
    ).map((row) => toolNoteForOutput(row).target);
    return { texts: [...bodies, ...targets] };
  } finally {
    database.close();
  }
}

/** Whether a rendering holds a piece of text, plainly or JSON-escaped. */
function holds(rendered: string, text: string): boolean {
  const escaped = JSON.stringify(text).slice(1, -1);
  return rendered.includes(text) || rendered.includes(escaped);
}

describe('every registered output codec, on a session that was stored whole', () => {
  beforeAll(async () => {
    for (const path of [binPath, installPath, SECRETS_FIXTURE]) await readFile(path);
  });

  it('lets no secret of the stored session out of any codec', async () => {
    const home = await brainWithSecrets();
    const probe = probeFrom(home);
    // The probe is what a read would answer with, so a probe with nothing in
    // it would make every expectation below pass for the wrong reason.
    expect(probe.texts.length).toBeGreaterThan(2);

    for (const codec of OUTPUT_CODECS) {
      const rendered = codec.render(probe);
      for (const secret of SECRETS) {
        expect(holds(rendered, secret), `${secret} came out of the ${codec.name} codec`).toBe(
          false,
        );
      }
      // The half of a key the parser's cut left in the target. No pattern can
      // see it, and the truncated-tail rule takes it anyway (review #21).
      expect(
        holds(rendered, TRUNCATED_HALF_KEY),
        `the cut key survived the ${codec.name} codec`,
      ).toBe(false);
      expect(rendered).toContain('[REDACTED:truncated]');
    }
  }, 60_000);

  it('leaves ordinary code, prose and identifiers in every codec', async () => {
    const home = await brainWithSecrets();
    const probe = probeFrom(home);

    for (const codec of OUTPUT_CODECS) {
      for (const kept of KEPT_IN_FIXTURE) {
        expect(
          holds(codec.render(probe), kept),
          `the ${codec.name} codec masked ${kept}`,
        ).toBe(true);
      }
    }
  }, 60_000);

  it('keeps the secrets in the database, which is the other half of the rule', async () => {
    const home = await brainWithSecrets();

    const stored = probeFrom(home);
    const database = new DatabaseSync(join(home, 'brain.db'), { readOnly: true });
    const raw = (
      database.prepare('select body from messages').all() as { body: string }[]
    ).map((row) => row.body);
    database.close();

    for (const secret of ['sk-AAAAAAAAAAAAAAAAAAAA', 'Tiger2024', 'Pa!ss2024']) {
      expect(raw.join('\n'), `${secret} is not in the stored conversation`).toContain(secret);
    }
    // And the probe, which is what leaves, already differs from it.
    expect(stored.texts.join('\n')).toContain('[REDACTED:');
  }, 60_000);
});

/**
 * The sink check itself, as a function of a file list, so the negative case
 * can be made without writing a file into the repository.
 */
function sinkProblems(
  writers: readonly string[],
  table: Readonly<Record<string, readonly string[]>>,
  codecNames: readonly string[],
): string[] {
  const problems: string[] = [];
  for (const file of writers) {
    if (table[file] === undefined) {
      problems.push(
        `${file} writes to stdout or stderr and is in no row of the sink table: ` +
          'send its lines through an output codec and name it there (AD-11)',
      );
    }
  }
  for (const [file, codecs] of Object.entries(table)) {
    if (!writers.includes(file)) {
      problems.push(`${file} is in the sink table and no longer writes anything`);
    }
    for (const codec of codecs) {
      if (!codecNames.includes(codec)) {
        problems.push(`${file} names the codec ${codec}, which is in no registry`);
      }
    }
  }
  return problems;
}

/** Every `<area>/<package>/src/**​/*.ts` that writes to stdout or stderr. */
function writersUnder(area: string): string[] {
  const found: string[] = [];
  const packages = readdirSync(join(repoRoot, area), { withFileTypes: true });
  for (const entry of packages) {
    if (!entry.isDirectory()) continue;
    const source = join(repoRoot, area, entry.name, 'src');
    let files: string[];
    try {
      files = readdirSync(source, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const text = readFileSync(join(source, file), 'utf8');
      if (/process\.std(?:out|err)\.write|console\./u.test(text)) {
        found.push(`${area}/${entry.name}/src/${file}`);
      }
    }
  }
  return found.sort();
}

describe('the sink check', () => {
  it('finds a writer the sink table does not name, and says which file it is', () => {
    const problems = sinkProblems(
      ['apps/cli/src/dispatch.ts', 'apps/cli/src/commands/sessions-list.ts'],
      { 'apps/cli/src/dispatch.ts': ['text'] },
      OUTPUT_CODECS.map((codec) => codec.name),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('apps/cli/src/commands/sessions-list.ts');
  });

  it('refuses a row that names a codec no registry holds', () => {
    const problems = sinkProblems(
      ['apps/cli/src/dispatch.ts'],
      { 'apps/cli/src/dispatch.ts': ['mirror'] },
      OUTPUT_CODECS.map((codec) => codec.name),
    );

    expect(problems).toEqual([
      'apps/cli/src/dispatch.ts names the codec mirror, which is in no registry',
    ]);
  });

  it('refuses a row for a file that no longer writes anything', () => {
    const problems = sinkProblems([], { 'apps/cli/src/dispatch.ts': ['text'] }, ['text']);

    expect(problems).toEqual([
      'apps/cli/src/dispatch.ts is in the sink table and no longer writes anything',
    ]);
  });

  it('passes on this build: every writer is in the table, and every codec exists', () => {
    const writers = [...writersUnder('apps'), ...writersUnder('packages')].sort();

    // If this is empty the check proves nothing, which is the one way a scan
    // like this fails silently.
    expect(writers.length).toBeGreaterThan(0);
    expect(sinkProblems(writers, SINKS, OUTPUT_CODECS.map((codec) => codec.name))).toEqual([]);
  });
});

/**
 * The dispatcher's own output sites, in process, through the injected
 * `stdout` and `stderr` of `DispatchRuntime`.
 *
 * This is the plan's fourth acceptance criterion and the only thing that
 * actually holds the `encodeTextLine`/`encodeHookLine` calls in
 * `dispatch.ts` in place: the end-to-end halves above go through the codec
 * functions directly, so they would stay green if a wrapper were dropped.
 *
 * The commands are standalone and fake, so nothing here reads a
 * configuration or a database.
 */
describe('a failure whose message holds a secret, through the dispatcher', () => {
  const PLANTED = 'password: Pa!ss2024';
  const VALUE = 'Pa!ss2024';

  /** A registry of one standalone command, failing or succeeding or throwing. */
  function registryOf(spec: Partial<CommandSpec> & { verb: string }): CommandSpec[] {
    return [
      {
        ns: 'fake',
        usedFor: '아무것도 하지 않습니다',
        required: [],
        examples: [`brain fake ${spec.verb}`],
        output: '아무것도 없습니다',
        risk: 'read',
        hook: false,
        dryRun: false,
        standalone: true,
        run: async () => ({ ok: true as const, data: null }),
        ...spec,
      } as CommandSpec,
    ];
  }

  /** One invocation, with both streams captured rather than written. */
  async function invoke(
    registry: readonly CommandSpec[],
    argv: readonly string[],
  ): Promise<{ exit: number; stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    const exit = await dispatch(registry, argv, {
      clock: systemClock,
      env: {},
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    return { exit, stdout, stderr };
  }

  const failing = registryOf({
    verb: 'fail',
    run: async () => ({
      ok: false as const,
      code: 'USAGE',
      message: `설정이 틀렸습니다: ${PLANTED}`,
      hint: `${PLANTED} 를 고치세요`,
    }),
  });

  it('keeps the value out of both streams in --json mode', async () => {
    const run = await invoke(failing, ['fake', 'fail', '--json']);

    // The envelope was there and it was masked, which is Core's doing.
    expect(run.stdout).toContain('[REDACTED:password]');
    expect(run.stdout).not.toContain(VALUE);
    expect(run.stderr).not.toContain(VALUE);
  });

  it('keeps the value out of both streams in text mode, message and hint', async () => {
    const run = await invoke(failing, ['fake', 'fail']);

    expect(run.stderr).toContain('[REDACTED:password]');
    // Both lines: the failure sentence and the hint indented under it.
    expect(run.stderr.split('\n').filter((line) => line !== '')).toHaveLength(2);
    expect(run.stderr).not.toContain(VALUE);
    expect(run.stdout).not.toContain(VALUE);
  });

  it('keeps the value out of both streams in hook mode', async () => {
    const hook = registryOf({
      verb: 'hookfail',
      hook: true,
      run: async () => ({
        ok: false as const,
        code: 'USAGE',
        message: `설정이 틀렸습니다: ${PLANTED}`,
      }),
    });

    const run = await invoke(hook, ['fake', 'hookfail']);

    // A hook never fails the harness, and says its one line on stderr (AD-6).
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('[REDACTED:password]');
    expect(run.stderr).not.toContain(VALUE);
    expect(run.stdout).toBe('');
  });

  it('keeps the value out of the one line a hook says when a command throws', async () => {
    const throwing = registryOf({
      verb: 'hookthrow',
      hook: true,
      run: async () => {
        throw new Error(`버그: ${PLANTED}`);
      },
    });

    const run = await invoke(throwing, ['fake', 'hookthrow']);

    expect(run.exit).toBe(0);
    expect(run.stderr).toContain('[REDACTED:password]');
    expect(run.stderr).not.toContain(VALUE);
  });

  it('keeps the value out of the human-readable lines a command prints', async () => {
    const printing = registryOf({
      verb: 'print',
      run: async () => ({ ok: true as const, data: null, text: [`결과: ${PLANTED}`] }),
    });

    const run = await invoke(printing, ['fake', 'print']);

    expect(run.stdout).toContain('[REDACTED:password]');
    expect(run.stdout).not.toContain(VALUE);
  });
});
