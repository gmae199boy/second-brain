import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MIN_NODE_VERSION } from '../src/bootstrap.js';

/**
 * The plugin folder, as Claude Code reads it: the manifest, the one hook, the
 * launcher, the committed copy of the bootstrap, and the commit it asks for.
 *
 * It lives in this package's tests rather than in a `plugin/test/` of its own
 * because vitest only picks up `test/` folders under `packages/`, `apps/` and
 * `tooling/`, and because the thing being guarded is this package's own
 * artefact: `plugin/bootstrap.mjs` is a copy of `bin/second-brain.js`.
 *
 * The rules themselves were measured against Claude Code 2.1.300 on
 * 2026-10-15 and are written down in `epic-capture-research.md` 1-3.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const pluginRoot = join(repoRoot, 'plugin');

function read(...parts: readonly string[]): string {
  return readFileSync(join(pluginRoot, ...parts), 'utf8');
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const temporary: string[] = [];

afterAll(() => {
  for (const folder of temporary) rmSync(folder, { recursive: true, force: true });
});

function temporaryFolder(prefix: string): string {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(folder);
  return folder;
}

describe('the plugin manifest', () => {
  interface Manifest {
    name?: string;
    version?: string;
    description?: string;
  }

  const manifest = json(join(pluginRoot, '.claude-plugin', 'plugin.json')) as Manifest;

  it('is named second-brain, which is what the marketplace entry installs', () => {
    expect(manifest.name).toBe('second-brain');
  });

  it('carries a semver version, which is what the plugin cache is keyed by', () => {
    // A remote marketplace copies the plugin into
    // `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` and keeps
    // using that copy until the version changes, so this is the field that
    // decides whether anyone ever sees a new `app-ref`. Only the shape is
    // checked here; the rule that it goes up with the ref is in the README.
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('says in Korean what the first session will do and what it needs', () => {
    const description = manifest.description ?? '';
    expect(description).toContain('~/.second_brain/app');
    expect(description).toContain('git');
    expect(description).toContain('pnpm');
    expect(description).toContain(MIN_NODE_VERSION);
    // Somebody reads this in the plugin list before agreeing to install it.
    expect(description).toMatch(/[가-힣]/);
  });
});

describe('the hooks file', () => {
  interface Hooks {
    hooks?: Record<string, { matcher?: string; hooks?: Record<string, unknown>[] }[]>;
  }

  const hooks = json(join(pluginRoot, 'hooks', 'hooks.json')) as Hooks;

  it('registers the startup and collecting events', () => {
    // A plugin's hooks are merged with the settings files' and all of them
    // run, so one source of hook entries is the only way a turn is not
    // ingested twice (AD-19). The collecting hooks are story 2.14's.
    expect(Object.keys(hooks.hooks ?? {})).toEqual(['SessionStart', 'Stop', 'SessionEnd']);
  });

  it('registers exactly one command, asynchronously and with no matcher', () => {
    const groups = hooks.hooks?.['SessionStart'] ?? [];
    expect(groups).toHaveLength(1);
    expect(groups[0]?.matcher).toBeUndefined();

    const entries = groups[0]?.hooks ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      type: 'command',
      // `|| exit 0` as well as the asynchrony: an asynchronous hook cannot
      // block a session, and a non-zero exit from a SessionStart hook still
      // puts its stderr in front of the user for no reason.
      command: 'sh "${CLAUDE_PLUGIN_ROOT}/bin/session-start.sh" || exit 0',
      async: true,
    });
  });
});

describe('the plugin folder', () => {
  it('holds no package.json and no lockfile', () => {
    // Claude Code installs a plugin's node dependencies when it copies it into
    // the cache, and skips `pnpm-lock.yaml` while doing it: a manifest here
    // would mean an install nobody asked for, from a lockfile it ignores
    // (epic-capture-research 2).
    const entries = readdirSync(pluginRoot, { recursive: true }) as string[];
    const forbidden = entries.filter((entry) =>
      ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'].includes(
        entry.split('/').at(-1) ?? '',
      ),
    );

    expect(forbidden).toEqual([]);
  });

  it('asks for one commit, as 40 lowercase hex characters on one line', () => {
    expect(read('app-ref')).toMatch(/^[0-9a-f]{40}\n$/);
  });

  it('carries the committed bootstrap byte for byte', () => {
    // The marketplace refuses a `source` that points outside the plugin root,
    // so the entry point cannot be shared by reference and is a copy
    // (epic-capture-research 2). `pnpm build` makes the copy; this is what
    // fails when somebody forgets to run it.
    expect(read('bootstrap.mjs')).toBe(
      readFileSync(join(repoRoot, 'tooling', 'bootstrap', 'bin', 'second-brain.js'), 'utf8'),
    );
  });

  it('is called .mjs, so node reads it as a module without a manifest', () => {
    // There is no `"type": "module"` beside it in the plugin cache, so a `.js`
    // copy would be ESM only as far as node's syntax detection took it
    // (Decision 2026-10-17).
    expect(read('bootstrap.mjs').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(read('bootstrap.mjs')).toContain('import ');
  });
});

describe('the marketplace', () => {
  interface Marketplace {
    name?: string;
    owner?: { name?: string };
    plugins?: { name?: string; source?: string; description?: string }[];
  }

  const marketplace = json(join(repoRoot, '.claude-plugin', 'marketplace.json')) as Marketplace;

  it('offers this one plugin from the folder beside it', () => {
    expect(marketplace.name).toBe('second-brain');
    expect(marketplace.owner?.name).toBe('gmae199boy');
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins?.[0]?.name).toBe('second-brain');
    // A relative source has to start with `./`, and anything reaching outside
    // the marketplace root is refused (epic-capture-research 2).
    expect(marketplace.plugins?.[0]?.source).toBe('./plugin');
    expect(marketplace.plugins?.[0]?.description ?? '').toMatch(/[가-힣]/);
  });
});

describe('the launcher', () => {
  const launcher = read('bin', 'session-start.sh');

  it('carries the CLI\'s node finder, byte for byte', async () => {
    // One copy of the rule (`apps/cli/src/install/shim.ts`), embedded in two
    // files that cannot import anything: this one and the shim.
    const shim = (await import(
      join(repoRoot, 'apps', 'cli', 'dist', 'install', 'shim.js')
    )) as { NODE_FINDER_SH: string };

    expect(launcher).toContain(shim.NODE_FINDER_SH);
  });

  it('is POSIX sh that parses', () => {
    const parsed = spawnSync('sh', ['-n', join(pluginRoot, 'bin', 'session-start.sh')], {
      encoding: 'utf8',
    });

    expect(parsed.stderr).toBe('');
    expect(parsed.status).toBe(0);
  });

  it('hands the bootstrap the ref and the plugin root, and consents in advance', () => {
    expect(launcher).toContain(
      '"$brain_node" "$ROOT/bootstrap.mjs" --yes --ref "$brain_ref" --plugin-root "$ROOT"',
    );
  });

  it('puts the node it found in front of PATH, so pnpm and git are found too', () => {
    expect(launcher).toContain(
      'PATH=$(dirname "$brain_node"):/opt/homebrew/bin:/usr/local/bin:$PATH',
    );
  });

  it('says one JSON line and exits 0 when there is no node it can use', () => {
    const home = temporaryFolder('brain-launcher-home-');
    const empty = temporaryFolder('brain-launcher-empty-');
    const plugin = temporaryFolder('brain-launcher-plugin-');
    cpSync(pluginRoot, plugin, { recursive: true });

    const run = spawnSync('sh', [join(plugin, 'bin', 'session-start.sh')], {
      encoding: 'utf8',
      env: {
        // No PATH to a node, no nvm, and the fixed folders pointed at an empty
        // one: exactly the machine this branch exists for.
        PATH: '/usr/bin:/bin',
        HOME: home,
        NVM_DIR: join(empty, 'nvm'),
        SECOND_BRAIN_NODE_DIRS: empty,
        SECOND_BRAIN_HOME: home,
        CLAUDE_PLUGIN_ROOT: plugin,
      },
    });

    // Exit 0: a SessionStart hook never stops a session.
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');

    const lines = run.stdout.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(1);
    const said = JSON.parse(lines[0] ?? '') as { systemMessage?: string };
    expect(said.systemMessage).toContain(MIN_NODE_VERSION);
    expect(said.systemMessage).toContain(empty);
    expect(said.systemMessage).toMatch(/[가-힣]/);
    // The bootstrap never ran on this path, so there is no record for doctor
    // to report and this line is the whole account — and it reaches the model,
    // not the screen (Decision 2026-10-18).
    expect(said.systemMessage).toContain('사용자에게 한 줄로');
  });

  it('says one JSON line and exits 0 when the app-ref cannot be read', () => {
    const plugin = temporaryFolder('brain-launcher-noref-');
    cpSync(pluginRoot, plugin, { recursive: true });
    writeFileSync(join(plugin, 'app-ref'), 'not a commit\n', 'utf8');

    const run = spawnSync('sh', [join(plugin, 'bin', 'session-start.sh')], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', HOME: '/nonexistent', CLAUDE_PLUGIN_ROOT: plugin },
    });

    expect(run.status).toBe(0);
    const lines = run.stdout.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(1);
    const said = JSON.parse(lines[0] ?? '') as { systemMessage?: string };
    expect(said.systemMessage).toContain('app-ref');
    expect(said.systemMessage).toContain('사용자에게 한 줄로');
  });
});

describe('collecting launchers', () => {
  it.each(['Stop', 'SessionEnd'])('registers one asynchronous %s command without a matcher', (event) => {
    const config = json(join(pluginRoot, 'hooks', 'hooks.json')) as { hooks: Record<string, unknown> };
    expect(config.hooks[event]).toEqual([{ hooks: [{ type: 'command', command: 'sh "${CLAUDE_PLUGIN_ROOT}/bin/brain.sh" sessions ingest claude-code || exit 0', async: true }] }]);
  });
  it('is silent before installation, with no node to find', () => {
    const home = temporaryFolder('brain-no-shim-');
    const run = spawnSync('sh', [join(pluginRoot, 'bin', 'brain.sh'), 'sessions', 'ingest', 'claude-code'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home }, input: 'payload' });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
  });
  it('passes arguments, stdin, plugin root and PATH to the shim', async () => {
    const { mkdirSync, chmodSync } = await import('node:fs');
    const home = temporaryFolder('brain-shim-launch-');
    mkdirSync(join(home, 'bin'));
    const shim = join(home, 'bin', 'brain');
    writeFileSync(shim, '#!/bin/sh\nprintf "%s\\n" "$@" > "$SECOND_BRAIN_HOME/args"\ncat > "$SECOND_BRAIN_HOME/input"\nprintf "%s" "$SECOND_BRAIN_PLUGIN_ROOT" > "$SECOND_BRAIN_HOME/root"\nprintf "%s" "$PATH" > "$SECOND_BRAIN_HOME/path"\n');
    chmodSync(shim, 0o755);
    const run = spawnSync('sh', [join(pluginRoot, 'bin', 'brain.sh'), 'sessions', 'ingest', 'a b'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home, SECOND_BRAIN_HOME: home }, input: 'payload\n' });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
    expect(readFileSync(join(home, 'args'), 'utf8')).toBe('sessions\ningest\na b\n');
    expect(readFileSync(join(home, 'input'), 'utf8')).toBe('payload\n');
    expect(readFileSync(join(home, 'root'), 'utf8')).toBe(pluginRoot.replace(/\/$/, ''));
    expect(readFileSync(join(home, 'path'), 'utf8')).toBe('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
  });
  it('drains after bootstrap, silences drain output and preserves bootstrap status', async () => {
    const { chmodSync, mkdirSync } = await import('node:fs');
    const home = temporaryFolder('brain-drain-launch-');
    const plugin = temporaryFolder('brain-drain-plugin-');
    cpSync(pluginRoot, plugin, { recursive: true });
    mkdirSync(join(home, 'bin'));
    const shim = join(home, 'bin', 'brain');
    writeFileSync(shim, `#!/bin/sh\nNODE='${process.execPath}'\nprintf "noise\\n"\nprintf "error\\n" >&2\ncat > "$SECOND_BRAIN_HOME/drain-input"\nprintf "%s\\n" "$@" > "$SECOND_BRAIN_HOME/drain-args"\nexit 9\n`);
    chmodSync(shim, 0o755);
    writeFileSync(join(plugin, 'bootstrap.mjs'), 'console.log(JSON.stringify({systemMessage:"설치 완료"})); process.exitCode = 7;\n');
    const run = spawnSync('sh', [join(plugin, 'bin', 'session-start.sh')], { encoding: 'utf8', input: 'session payload', env: { PATH: process.env['PATH'], HOME: home, SECOND_BRAIN_HOME: home, CLAUDE_PLUGIN_ROOT: plugin } });
    expect(run.status).toBe(7);
    expect(run.stdout).toBe('{"systemMessage":"설치 완료"}\n');
    expect(run.stderr).toBe('');
    expect(readFileSync(join(home, 'drain-input'), 'utf8')).toBe('');
    expect(readFileSync(join(home, 'drain-args'), 'utf8')).toBe('queue\ndrain\n');
  });
});
