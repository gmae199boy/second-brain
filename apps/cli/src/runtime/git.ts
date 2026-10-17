import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { Checkout, RepositoryInspector } from 'second_brain';

/**
 * The Runtime's `RepositoryInspector`: the one place git is asked what a
 * working folder is (AD-1).
 *
 * Three read-only commands, `execFile` and no shell. No shell because a cwd
 * comes out of a transcript — it is whatever the harness wrote — and a path
 * with a quote or a semicolon in it must be an argument and never a word of a
 * command line. Read-only because this runs on the critical path of a turn: a
 * `git fetch` would reach the network and `GIT_OPTIONAL_LOCKS=0` keeps git from
 * even refreshing the index, so nothing here can block on somebody else's
 * `git` or leave a file behind.
 *
 * Everything that can go wrong answers `null`: a folder that is not a
 * repository, a path that is gone, a bare repository, a machine with no git, a
 * call that ran past its budget, output in a shape this code does not know.
 * The session is then ingested with no tags, because capture comes before the
 * tags and a brain that refuses a session until git works is a brain that
 * loses turns (Decision 2026-10-18).
 */
export function gitRepositoryInspector(): RepositoryInspector {
  return {
    async inspect(cwd: string): Promise<Checkout | null> {
      // A relative path would be resolved against this process's own working
      // directory, and the process's cwd is never the evidence a tag may rest
      // on (AD-12). A transcript that carried one tells us nothing.
      if (!isAbsolute(cwd)) return null;

      // Absolute, so the identity of a repository with no remote is a path
      // that means the same thing from every working folder (AD-12). The two
      // lines come back in the order the options are written.
      const paths = await git(cwd, [
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--git-common-dir',
      ]);
      if (paths === null) return null;
      const [worktreePath, commonDir] = lines(paths);
      // A bare repository has a common directory and no top: it is nobody's
      // working folder, so there is nothing here to tag a session with.
      if (worktreePath === undefined || commonDir === undefined) return null;

      return { remoteUrl: await remoteUrl(cwd), commonDir, worktreePath };
    },
  };
}

/** How long one git call may take before it is the same as no answer. */
const TIMEOUT_MS = 2000;

/**
 * The URL of the remote this checkout came from, or `null`.
 *
 * `origin` when there is one, and otherwise the first name git lists. Picking
 * one rather than looking at them all is deliberate: the identity must come
 * out the same on every machine that has this clone, and a rule that searched
 * the existing projects for a match would make it depend on what this database
 * happens to hold already (Decision 2026-10-18).
 */
async function remoteUrl(cwd: string): Promise<string | null> {
  const listed = await git(cwd, ['remote']);
  if (listed === null) return null;
  const names = lines(listed);
  const name = names.includes('origin') ? 'origin' : names[0];
  if (name === undefined) return null;

  const url = await git(cwd, ['remote', 'get-url', name]);
  if (url === null) return null;
  // A remote whose URL git cannot print is a remote this repository may as
  // well not have: the caller falls back to the common directory.
  return lines(url)[0] ?? null;
}

/**
 * One git call's standard output, or `null` for anything that went wrong.
 *
 * `GIT_TERMINAL_PROMPT=0` so a repository whose remote wants credentials
 * answers instead of waiting for somebody to type, and `GIT_OPTIONAL_LOCKS=0`
 * so a read never queues behind another git in the same folder.
 */
function git(cwd: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      {
        timeout: TIMEOUT_MS,
        env: { ...gitFreeEnvironment(), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        // Plenty for a few paths, and a cap rather than a promise: output
        // past it is an answer this code does not understand, which is `null`.
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout) => {
        resolve(error === null ? stdout : null);
      },
    );
  });
}

/**
 * This process's environment with every `GIT_` variable taken out.
 *
 * A hook inherits whatever the shell around it was carrying, and git reads a
 * great deal from there: `GIT_DIR`, `GIT_WORK_TREE` and `GIT_COMMON_DIR` each
 * win over the `-C <cwd>` this code passes. A session opened inside one
 * repository would then be tagged with another — a `git commit` hook, or a
 * terminal left inside a `git rebase`, is enough to do it. So the folder is
 * the only thing that decides what git answers here (AD-12).
 */
function gitFreeEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
}

/** The non-empty lines of a git answer, trimmed of the newline it ends with. */
function lines(output: string): string[] {
  return output.split('\n').filter((line) => line !== '');
}
