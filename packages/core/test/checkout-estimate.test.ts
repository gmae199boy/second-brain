import { describe, expect, it } from 'vitest';
import { checkoutFor } from '../src/sessions/ingest.js';
import { memoryRepositories, sequenceIdGen } from '../src/testing/index.js';

const checkout = (path: string, remoteUrl: string | null = 'https://demo.example/brain-owner/notes.git', commonDir = '/repo/.git') => ({ worktreePath: path, commonDir, remoteUrl });
const missing = { kind: 'missing' } as const;
const unknown = { kind: 'unknown', reason: 'permission', message: '읽을 권한이 없습니다' } as const;
const ask = (repositories: ReturnType<typeof memoryRepositories>, cwd: string | null = '/parent/gone') => checkoutFor(repositories, sequenceIdGen({ timestampMs: 0 }), cwd);

describe('사라진 근거 폴더 추정', () => {
  it('cwd가 없거나 살아 있는 레포 밖이면 추정하지 않는다', async () => {
    const repositories = memoryRepositories();
    expect(await ask(repositories, null)).toEqual({ checkout: null, tagSource: null, unknown: null });
    expect((await ask(repositories)).checkout).toBeNull();
    expect(repositories.inspects()).toEqual(['/parent/gone']);
  });
  it('살아 있는 cwd는 저장소 꼭대기를 쓴다', async () => {
    const repositories = memoryRepositories({ '/parent/gone': checkout('/parent') });
    expect(await ask(repositories)).toMatchObject({ tagSource: 'cwd', checkout: { worktreePath: '/parent' } });
  });
  it('처음 남아 있는 조상 저장소에 원래 cwd를 붙인다', async () => {
    const repositories = memoryRepositories({ '/parent/gone': missing, '/parent': missing, '/': checkout('/') });
    expect(await ask(repositories)).toMatchObject({ tagSource: 'ancestor', checkout: { worktreePath: '/parent/gone' } });
  });
  it('형제의 정체성이 같으면 경로순 첫 형제에서 추정한다', async () => {
    const repositories = memoryRepositories({ '/parent/gone': missing, '/parent/a': checkout('/parent/a'), '/parent/z': checkout('/parent/z') });
    repositories.setFolders('/parent', { kind: 'listed', folders: ['/parent/z', '/parent/gone', '/parent/a'] });
    expect(await ask(repositories)).toMatchObject({ tagSource: 'sibling', checkout: { worktreePath: '/parent/gone' } });
    expect(repositories.inspects()).toEqual(['/parent/gone', '/parent', '/parent/a', '/parent/z']);
  });
  it.each(['different', 'local', 'unknown', 'empty', 'missing-list'] as const)('%s 형제는 확정하지 않는다', async (kind) => {
    const repositories = memoryRepositories({ '/parent/gone': missing, '/parent/a': checkout('/parent/a') });
    repositories.set('/parent/b', kind === 'unknown' ? unknown : checkout('/parent/b', kind === 'local' ? null : 'https://demo.example/brain-owner/other.git'));
    repositories.setFolders('/parent', kind === 'missing-list' ? missing : { kind: 'listed', folders: kind === 'empty' ? [] : ['/parent/a', '/parent/b'] });
    const result = await ask(repositories);
    expect(result.checkout).toBeNull();
    expect(result.unknown).toEqual(kind === 'unknown' ? unknown : null);
  });
  it('같은 로컬 저장소의 형제 워크트리는 같은 정체성이다', async () => {
    const repositories = memoryRepositories({ '/parent/gone': missing, '/parent/a': checkout('/parent/a', null), '/parent/b': checkout('/parent/b', null) });
    repositories.setFolders('/parent', { kind: 'listed', folders: ['/parent/a', '/parent/b'] });
    expect((await ask(repositories)).tagSource).toBe('sibling');
  });
  it('바로 위 폴더도 없으면 더 위의 형제를 찾지 않는다', async () => {
    const repositories = memoryRepositories({ '/parent/gone': missing, '/parent': missing });
    repositories.setFolders('/parent', { kind: 'listed', folders: ['/parent/a'] });
    expect((await ask(repositories)).checkout).toBeNull();
  });
  it('조상이나 목록의 무응답은 미룬다', async () => {
    const repositories = memoryRepositories({ '/parent/gone': missing, '/parent': unknown });
    expect((await ask(repositories)).unknown).toEqual(unknown);
    repositories.set('/parent', { kind: 'not_repository' });
    repositories.setFolders('/parent', unknown);
    expect((await ask(repositories)).unknown).toEqual(unknown);
  });
});
