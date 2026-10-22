import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { FolderListing, InspectResult, InspectUnknownReason, RepositoryInspector } from 'second_brain';

type GitFailure = Exclude<InspectResult, { kind: 'checkout' }>;
type GitResult = { ok: true; stdout: string } | { ok: false; result: GitFailure };

const unknown = (reason: InspectUnknownReason, message: string): GitFailure => ({
  kind: 'unknown', reason, message,
});

/** Read-only execFile calls keep transcript paths out of shell interpretation. */
export function gitRepositoryInspector(
  { command = 'git', timeoutMs = 2000 }: { command?: string; timeoutMs?: number } = {},
): RepositoryInspector {
  const git = (cwd: string, args: readonly string[]): Promise<GitResult> => new Promise((resolve) => {
    execFile(command, ['-C', cwd, ...args], {
      timeout: timeoutMs,
      env: {
        ...gitFreeEnvironment(), LC_ALL: 'C',
        GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
      },
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error === null) return resolve({ ok: true, stdout });
      let result: GitFailure;
      if (error.code === 'ENOENT') result = unknown('git_missing', 'git을 실행할 수 없습니다');
      else if (error.killed) result = unknown('timeout', 'git 응답 시간이 초과되었습니다');
      else if (error.code === 'EACCES' || error.code === 'EPERM' ||
          /dubious ownership|Permission denied/i.test(stderr)) {
        result = unknown('permission', '저장소를 확인할 권한이 없습니다');
      } else if (/not a git repository|must be run in a work tree/i.test(stderr)) {
        result = { kind: 'not_repository' };
      } else result = unknown('unexpected', 'git이 정상적인 응답을 반환하지 않았습니다');
      resolve({ ok: false, result });
    });
  });

  // Once rev-parse succeeded a remote failure cannot establish a local-only identity.
  const remoteFailure = (failure: GitFailure): GitFailure =>
    failure.kind === 'not_repository'
      ? unknown('unexpected', '저장소의 remote를 확인하지 못했습니다')
      : failure;

  return {
    async listFolders(path): Promise<FolderListing> {
      try {
        const entries = await readdir(path, { withFileTypes: true });
        const folders: string[] = [];
        for (const entry of entries) {
          const candidate = join(path, entry.name);
          if (entry.isDirectory()) folders.push(candidate);
          else if (entry.isSymbolicLink()) {
            try {
              if ((await stat(candidate)).isDirectory()) folders.push(candidate);
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
            }
          }
        }
        return { kind: 'listed', folders: folders.sort() };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
        return { kind: 'unknown', reason: code === 'EACCES' || code === 'EPERM' ? 'permission' : 'unexpected',
          message: '형제 폴더 목록을 읽을 수 없습니다' };
      }
    },
    async inspect(cwd): Promise<InspectResult> {
      if (!isAbsolute(cwd)) return { kind: 'not_repository' };
      try {
        if (!(await stat(cwd)).isDirectory()) return { kind: 'not_repository' };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
        return code === 'EACCES' || code === 'EPERM'
          ? unknown('permission', '작업 폴더를 읽을 권한이 없습니다')
          : unknown('unexpected', '작업 폴더를 확인하지 못했습니다');
      }
      const paths = await git(cwd, [
        'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir',
      ]);
      if (!paths.ok) return paths.result;
      const values = lines(paths.stdout);
      const [worktreePath, commonDir] = values;
      if (values.length !== 2 || worktreePath === undefined || commonDir === undefined ||
          !isAbsolute(worktreePath) || !isAbsolute(commonDir)) {
        return unknown('unexpected', 'git의 저장소 경로 응답을 읽을 수 없습니다');
      }

      const listed = await git(cwd, ['remote']);
      if (!listed.ok) return remoteFailure(listed.result);
      const names = lines(listed.stdout);
      const name = names.includes('origin') ? 'origin' : names[0];
      let remoteUrl: string | null = null;
      if (name !== undefined) {
        const url = await git(cwd, ['remote', 'get-url', name]);
        if (!url.ok) return remoteFailure(url.result);
        remoteUrl = lines(url.stdout)[0] ?? null;
        if (remoteUrl === null) return unknown('unexpected', 'git의 remote 주소 응답이 비어 있습니다');
      }
      return { kind: 'checkout', checkout: { remoteUrl, commonDir, worktreePath } };
    },
  };
}

/** Inherited git state can override -C and silently identify a different repository. */
function gitFreeEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') && name !== 'LANGUAGE'),
  );
}

function lines(output: string): string[] {
  return output.split('\n').filter((line) => line !== '');
}
