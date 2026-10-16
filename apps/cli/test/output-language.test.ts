import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { exitCodeGuide, guideShow } from 'second_brain';
import { commands } from '../src/commands/index.js';
import { HOME_ENV } from '../src/config/paths.js';
import { assertKoreanLine, assertKoreanLines, englishLines } from './language.js';

/**
 * 사람이 읽는 출력은 한국어라는 Conventions의 결정(2026-10-16)을, 명령 표면
 * 전체에 대해 한 곳에서 지킨다: 등록된 모든 명령의 설명과 `--help`, 그리고
 * commander가 거절한 모든 경우다.
 *
 * 레지스트리에서 목록을 만들므로, 나중에 명령을 더하는 스토리는 아무것도
 * 건드리지 않고 이 검사를 함께 받는다 — 영어 설명을 넣으면 여기서 걸린다.
 *
 * 검사기 자체의 음성 사례는 Core의 `codes.test.ts`에 있고, 여기서는 줄 단위
 * 도우미가 영어 줄을 실제로 찾아내는지만 확인한다.
 */

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

/** 설정이 없는 home: 도움말도 거절도 데이터베이스를 읽지 않는다. */
const NO_HOME = '/nonexistent/second-brain-home';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runBrain(args: readonly string[]): Promise<Run> {
  const env: NodeJS.ProcessEnv = { ...process.env, [HOME_ENV]: NO_HOME };
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

/**
 * The namespaces and verbs this build registers. They are English by
 * construction (Boundaries: command and option names stay English), and both
 * `--help` and the `USAGE` message list them back, so the output-language
 * check is told about them rather than tripping over them.
 */
const COMMAND_WORDS: readonly string[] = [
  ...commands.map((spec) => `${spec.ns} ${spec.verb}`),
  ...commands.map((spec) => spec.ns),
  ...commands.map((spec) => spec.verb),
  // The meta's own English by construction: the names of the inputs a command
  // takes, and the words of the example command lines it prints under
  // `--help`. Both are things you type, which Boundaries keeps in English.
  ...commands.flatMap((spec) => [...spec.required]),
  ...commands.flatMap((spec) => spec.examples.flatMap((example) => example.split(/\s+/))),
];

/** `brain`, every namespace, and every command, as `--help` takes them. */
const HELP_TARGETS: readonly (readonly string[])[] = [
  [],
  ...[...new Set(commands.map((spec) => spec.ns))].map((ns) => [ns]),
  ...commands.map((spec) => [spec.ns, spec.verb]),
];

beforeAll(() => {
  if (!existsSync(binPath)) {
    throw new Error(`${binPath} does not exist. Run \`pnpm build\` before these tests.`);
  }
});

describe('the registry', () => {
  it.each(commands.map((spec) => [`${spec.ns} ${spec.verb}`, spec] as const))(
    '%s describes itself, its namespace, its meta and its flags in Korean',
    (_name, spec) => {
      const where = `${spec.ns} ${spec.verb}`;
      // The two sentences of the meta a person reads: what the command is for,
      // which is also the `--help` description, and what comes back from it.
      assertKoreanLine(spec.usedFor, { label: `${where} usedFor` });
      assertKoreanLine(spec.output, { label: `${where} output`, allow: COMMAND_WORDS });
      if (spec.nsDescription !== undefined) {
        assertKoreanLine(spec.nsDescription, { label: `${spec.ns} nsDescription` });
      }
      for (const option of spec.options ?? []) {
        assertKoreanLine(option.description, { label: `${where} ${option.flags}` });
      }
    },
  );
});

/**
 * The code tables, which are prose as much as the commands are: `meaning` says
 * what happened and `agent_action` says what to do about it, and both are read
 * by a person as well as by an agent (Conventions, output language).
 *
 * They are checked here rather than in Core's own tests because this is where
 * the CLI wrapper that knows about untranslated system originals lives, and
 * because `brain guide exit-codes` prints these very strings.
 */
describe('the code tables', () => {
  const guide = exitCodeGuide();

  it.each(guide.exit_codes.map((row) => [row.code, row] as const))(
    'exit code %s says what it means and what to do, in Korean',
    (_code, row) => {
      assertKoreanLine(row.meaning, { label: `exit ${row.code} meaning` });
      assertKoreanLine(row.agent_action, { label: `exit ${row.code} agent_action` });
    },
  );

  it.each(guide.error_codes.map((row) => [row.code, row] as const))(
    '%s says what it means, in Korean',
    (code, row) => {
      expect(row.meaning).not.toBe('');
      assertKoreanLine(row.meaning, { label: `${code} meaning` });
    },
  );

  it.each(guide.warning_codes.map((row) => [row.code, row] as const))(
    '%s says what it means, in Korean',
    (code, row) => {
      expect(row.meaning).not.toBe('');
      assertKoreanLine(row.meaning, { label: `${code} meaning` });
    },
  );

  it('writes the guide section in Korean', () => {
    assertKoreanLines(guideShow(), { label: 'guide show', allow: COMMAND_WORDS });
  });
});

describe('--help', () => {
  it.each(HELP_TARGETS.map((words) => [`brain ${words.join(' ')} --help`, words] as const))(
    '%s prints Korean labels and descriptions, and exits 0',
    async (_name, words) => {
      const run = await runBrain([...words, '--help']);

      expect(run.code).toBe(0);
      expect(run.stderr).toBe('');
      // Commander's own headings — `Usage:`, `Options:`, `Commands:` — are
      // replaced rather than translated in place, so the first line says
      // which language the rest is in.
      expect(run.stdout).toContain('사용법:');
      assertKoreanLines(run.stdout, {
        label: `brain ${words.join(' ')} --help`,
        allow: COMMAND_WORDS,
      });
    },
  );
});

describe('a command line commander refuses', () => {
  // `--json` is placed by each row rather than appended, because the one case
  // that needs the option last — an option with no value after it — would
  // otherwise swallow the flag as its value.
  it.each([
    ['no command at all', ['--json'] as string[]],
    ['an unknown namespace', ['nope', 'verb', '--json']],
    ['an unknown verb', ['doctor', 'nope', '--json']],
    ['an unknown option', ['doctor', 'run', '--nope', '--json']],
    ['a missing argument', ['setup', 'connect', '--json']],
    ['one argument too many', ['setup', 'connect', 'demo', 'extra', '--json']],
    ['an option with no value', ['setup', 'run', '--json', '--store-path']],
  ])('says so in Korean for %s', async (_what, args) => {
    const run = await runBrain(args);

    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as {
      error?: { code: string; message: string; hint?: string };
    };
    expect(envelope.error?.code).toBe('USAGE');
    assertKoreanLine(envelope.error?.message ?? '', {
      label: `USAGE message for ${args.join(' ')}`,
      allow: COMMAND_WORDS,
    });
    assertKoreanLine(envelope.error?.hint ?? '', { label: 'USAGE hint' });
  });

  it('names the command, not the argument, when there are too many arguments', async () => {
    const run = await runBrain(['setup', 'connect', 'demo', 'extra', '--json']);

    const envelope = JSON.parse(run.stdout) as { error?: { message: string } };
    // Commander quotes the command here, not the argument that was one too
    // many, so the quoted value belongs in front of the sentence.
    expect(envelope.error?.message).toContain("'connect'에 인자가 너무 많습니다");
  });

  it("carries commander's guess over, in Korean", async () => {
    const option = await runBrain(['doctor', 'run', '--jsn', '--json']);
    const verb = await runBrain(['doctor', 'rn', '--json']);

    const said = (run: Run): string =>
      (JSON.parse(run.stdout) as { error?: { message: string } }).error?.message ?? '';
    expect(said(option)).toContain("모르는 옵션입니다: '--jsn' (혹시 --json?)");
    expect(said(verb)).toContain("모르는 명령입니다: 'rn' (혹시 run?)");
    assertKoreanLine(said(option), { label: 'guess', allow: COMMAND_WORDS });
    assertKoreanLine(said(verb), { label: 'guess', allow: COMMAND_WORDS });
  });

  it('prints the message and, under it, the hint on stderr in text mode', async () => {
    const run = await runBrain(['doctor', 'run', '--nope']);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    const lines = run.stderr.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^USAGE: /);
    // The hint, indented under the sentence it belongs to (Decision
    // 2026-10-16): text mode has no envelope to read it out of.
    expect(lines[1]).toBe('  `--help`를 붙여 이 명령이 무엇을 받는지 확인하세요');
    assertKoreanLines(run.stderr, { label: 'USAGE stderr', allow: COMMAND_WORDS });
  });

  it('says the same message and hint in text mode as the envelope does', async () => {
    const text = await runBrain(['doctor', 'run', '--nope']);
    const json = await runBrain(['doctor', 'run', '--nope', '--json']);

    const envelope = JSON.parse(json.stdout) as {
      error?: { code: string; message: string; hint?: string };
    };
    // One sentence built in one place: the text line is the envelope's own
    // message and hint, not a second wording of them (Boundaries).
    expect(text.stderr).toBe(
      `${envelope.error?.code ?? ''}: ${envelope.error?.message ?? ''}\n  ${envelope.error?.hint ?? ''}\n`,
    );
  });
});

describe('the line-by-line checker', () => {
  it('finds the one English line among Korean ones', () => {
    const output = ['설정 폴더: /x', 'the shim is not executable', '요약: 통과 1'].join('\n');

    expect(englishLines(output)).toEqual(['the shim is not executable']);
  });

  it('keeps the original a Korean sentence introduced, and checks the rest', () => {
    // Node said the second half; it is not translated, and the Korean
    // sentence after it still is (Boundaries).
    expect(
      englishLines('/x/bin/brain을 읽을 수 없습니다: ENOENT: no such file. 다시 실행하세요.'),
    ).toEqual([]);
    expect(
      englishLines('/x/bin/brain을 읽을 수 없습니다: ENOENT: no such file. run it again.'),
    ).toHaveLength(1);
  });

  it('does not take any English after a Korean colon for a system original', () => {
    // All three sit exactly where an original would, and none of them is one:
    // a tail is excused only when it looks like an engine said it.
    for (const line of [
      '경고: /h/config.toml: ignoring unknown key "colour"',
      '점검이 실패했습니다: the probe threw',
      '요약: passed 3, warned 0, failed 1, skipped 2',
    ]) {
      expect(englishLines(line), line).toHaveLength(1);
    }
  });
});
