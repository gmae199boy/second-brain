import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { OUTPUT_CODECS, SQLITE_SCHEMA_VERSION, type OutputProbe } from 'second_brain';
import { memoryStore } from 'second_brain/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupRunLog } from '../src/commands/setup-run.js';
import { writeConfig } from '../src/config/codec.js';
import { HOME_ENV } from '../src/config/paths.js';
import { crashLines, dispatch, type CommandSpec, type CreateStore } from '../src/dispatch.js';
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
 * Every file under `apps/*​/src` and `packages/*​/src` that touches stdout or
 * stderr, and the output codecs it writes through.
 *
 * A file that writes and is not in here fails the check, and so does a row
 * that names a file which no longer writes or a codec nobody registered.
 *
 * Two kinds of writer are deliberately outside the table, because they are not
 * ours to route through a codec, and both were checked rather than assumed:
 *
 *   * **commander's help**, written by commander itself through `writeOut`. It
 *     is built from the registry alone — `usedFor`, the option descriptions,
 *     the examples, `output`, the risk label — all static Korean, none of it
 *     ever near the database. Commander's *error* text reaches nothing at all:
 *     `quiet()` in `dispatch.ts` sets `configureOutput({ writeErr: () => {} })`
 *     and the `USAGE` envelope is this app's own.
 *   * **`@clack/prompts`** in the installer, which draws the questions. Their
 *     messages are static Korean sentences; the one piece of data among them is
 *     a path placeholder (the recorded or default store and mirror path) and the
 *     harness labels from the connector registry. The installer runs before
 *     there is a database at all, so nothing it prints can have come out of
 *     one. Everything the *flow* says goes through `deps.log`, which is the
 *     `text` codec row below.
 */
const SINKS: Readonly<Record<string, readonly string[]>> = {
  // The entry point's last sink: an exception out of the dispatcher, stack and
  // all, through `crashLines`.
  'apps/cli/src/bin.ts': ['text'],
  // The dispatcher's two sinks. Text mode, the warning lines and the drain's
  // error line go through `text`; a hook's one line of stderr goes through
  // `hook`; `--json` is already masked, because Core masks an envelope as it
  // builds it. Commander's own output is the exemption above.
  'apps/cli/src/dispatch.ts': ['text', 'hook'],
  // The installer prints as it asks, so it cannot wait for the dispatcher.
  // This row also covers the `process.stdout.isTTY` read beside it: asking
  // whether anybody is watching writes nothing.
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

/**
 * The stored session, raw: the bodies and the tool notes exactly as the rows
 * hold them, with nothing masked.
 *
 * It used to run the tool notes through `toolNoteForOutput` here, which meant
 * this test applied the one rule a codec owns and a codec that forgot it stayed
 * green (follow-up review). The rule is the codec's now — every `render` calls
 * `sessionForOutput` — so the probe hands over the stored text and checks what
 * comes out the other end.
 */
function probeFrom(home: string): OutputProbe {
  const database = new DatabaseSync(join(home, 'brain.db'), { readOnly: true });
  try {
    const bodies = (
      database.prepare('select body from messages order by occurred_at').all() as {
        body: string;
      }[]
    ).map((row) => row.body);
    const toolNotes = database
      .prepare('select tool, target from tool_notes order by ordinal')
      .all() as { tool: string; target: string }[];
    return { texts: bodies, toolNotes };
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
    expect(probe.texts.length).toBeGreaterThan(1);
    expect(probe.toolNotes.length).toBeGreaterThan(1);

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

  it('runs the tool note rule inside every codec, for a name no keyword covers', () => {
    // Fixture-independent, and the one case that can only pass if the codec
    // itself called `sessionForOutput`: `MY_CREDENTIAL` is no keyword of the
    // pattern list, so the body rule sees nothing here and only the target
    // column's shell rule takes the value (follow-up review).
    const probe: OutputProbe = {
      texts: [],
      toolNotes: [{ tool: 'Bash', target: 'MY_CREDENTIAL=abc123 node run.js' }],
    };

    for (const codec of OUTPUT_CODECS) {
      const rendered = codec.render(probe);
      expect(holds(rendered, 'abc123'), `abc123 came out of the ${codec.name} codec`).toBe(false);
      // The name stays, which is what keeps the note readable.
      expect(holds(rendered, 'MY_CREDENTIAL')).toBe(true);
    }
  });

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
    // And what leaves already differs from it: the stored text is the raw
    // probe, every codec's rendering of it carries markers.
    for (const codec of OUTPUT_CODECS) {
      expect(codec.render(stored), `the ${codec.name} codec masked nothing`).toContain(
        '[REDACTED:',
      );
    }
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

/**
 * What counts as touching a standard stream.
 *
 * Wider than "`process.stdout.write`": the way a sink actually escapes this
 * check is a spelling nobody thought of, so any mention of `process.stdout` or
 * `process.stderr` counts — including taking a reference to one and writing
 * through that — and so do the three other ways out of a node process
 * (`writeSync` on descriptor 1 or 2, piping a stream into one, and `console`).
 * A file that only *reads* `process.stdout.isTTY` is caught too, which is a row
 * in the table with its reason rather than a hole in the scan (follow-up
 * review).
 */
const WRITER = /process\.std(?:out|err)\b|\bwriteSync\s*\(\s*[12]\b|\.pipe\(\s*process\.|console\./u;

/** Every `<area>/<package>/src/**​/*.ts` that touches stdout or stderr. */
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
      if (WRITER.test(text)) {
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

  it('sees a writer whatever spelling it uses', () => {
    // The spellings the narrower scan walked past: an alias, a raw descriptor,
    // a piped stream (follow-up review).
    for (const spelling of [
      'const out = process.stdout;\nout.write(line);',
      'writeSync(1, line);',
      'fs.writeSync( 2, line);',
      'stream.pipe(process.stdout);',
      'console.error(line);',
      "process.stderr.write('x');",
    ]) {
      expect(WRITER.test(spelling), `${spelling} was not seen as a writer`).toBe(true);
    }
    // And what it must not call a writer, or every file becomes a row.
    for (const quiet of ['const name = process.env.HOME;', 'await store.close();']) {
      expect(WRITER.test(quiet), `${quiet} was taken for a writer`).toBe(false);
    }
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

/**
 * The three sinks the registry check can only prove are *registered*, held in
 * place one at a time.
 *
 * The sink table says a file writes through a codec; nothing in it says the
 * call is still there. Each case below fails if `encodeTextLine` is taken out
 * of the file it names, which is what makes the table more than a comment
 * (follow-up review). The dispatcher's own output sites are the describe above.
 */
describe('the sinks outside the dispatcher, one at a time', () => {
  const PLANTED_LINE = 'password: Pa!ss2024';
  const PLANTED_VALUE = 'Pa!ss2024';

  it('masks the installer log line, which runs before there is a dispatcher', async () => {
    // The real dependency object, so this is the function the installer
    // actually prints through.
    const { systemInstallDeps } = await import('../src/install.js');
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        return true;
      });

    try {
      systemInstallDeps().log(`설치 중: ${PLANTED_LINE}`);
    } finally {
      spy.mockRestore();
    }

    expect(written.join('')).toContain('[REDACTED:password]');
    expect(written.join('')).not.toContain(PLANTED_VALUE);
  });

  it('masks the line `setup run` prints as the flow asks, and prints none under --json', () => {
    const written: string[] = [];
    const write = (text: string): void => {
      written.push(text);
    };

    setupRunLog(false, write)(`설치 중: ${PLANTED_LINE}`);
    expect(written.join('')).toContain('[REDACTED:password]');
    expect(written.join('')).not.toContain(PLANTED_VALUE);

    // Under `--json` the report is the envelope's `data` and this sink says
    // nothing at all.
    written.length = 0;
    setupRunLog(true, write)(`설치 중: ${PLANTED_LINE}`);
    expect(written).toEqual([]);
  });

  it('masks the one line the drain at the end of a command says when it throws', async () => {
    // The drain opens a connection of its own, which is the seam: the command
    // gets a working store and the drain's own `createStore` throws, so the
    // line under test is the `catch` of `drainOpportunistically`.
    const home = await mkdtemp(join(tmpdir(), 'brain-drain-'));
    homes.push(home);
    await writeConfig(home, { storePath: join(home, 'brain.db') });

    let opened = 0;
    const createStore: CreateStore = () => {
      opened += 1;
      if (opened === 1) {
        // The command's own store. The in-memory fake is not a `SchemaStore`;
        // this command does not write, so nothing asks it for the version.
        return {
          ...memoryStore(),
          readSchemaVersion: async () => ({
            ok: true as const,
            version: { version: SQLITE_SCHEMA_VERSION, appliedAt: new Date(0) },
          }),
        };
      }
      throw new Error(`핸들러가 터졌습니다: ${PLANTED_LINE}`);
    };

    const registry = [
      {
        ns: 'fake',
        verb: 'drains',
        usedFor: '아무것도 하지 않습니다',
        required: [],
        examples: ['brain fake drains'],
        output: '아무것도 없습니다',
        risk: 'read',
        hook: false,
        dryRun: false,
        run: async () => ({ ok: true as const, data: null }),
      } as unknown as CommandSpec,
    ];

    let stdout = '';
    let stderr = '';
    const exit = await dispatch(registry, ['fake', 'drains', '--json'], {
      clock: systemClock,
      env: withoutHarnessFolders({ [HOME_ENV]: home }),
      createStore,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    // The command answered, and the drain said its one line on stderr (AD-7).
    expect(exit).toBe(0);
    expect(stdout).toContain('"ok":true');
    expect(stderr).toContain('밀린 일 처리 중 오류');
    expect(stderr).toContain('[REDACTED:password]');
    expect(stderr).not.toContain(PLANTED_VALUE);
  });

  it('masks every line of a crash the entry point catches, stack and all', () => {
    // `bin.ts` writes exactly these lines to stderr. Node's own handler would
    // have written the message and the stack unmasked (follow-up review).
    const lines = crashLines(new Error(`버그: ${PLANTED_LINE}`));

    expect(lines[0]).toContain('[REDACTED:password]');
    expect(lines.join('\n')).not.toContain(PLANTED_VALUE);
    // The stack is kept: a crash report without the where is one nobody can
    // act on.
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('\n')).toContain('at ');
    // Anything that is not an `Error` still comes back as masked lines.
    expect(crashLines(PLANTED_LINE).join('\n')).toContain('[REDACTED:password]');
  });
});
