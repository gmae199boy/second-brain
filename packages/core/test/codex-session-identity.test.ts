import { describe, expect, it } from 'vitest';
import { codexParser } from '../../codex/src/parser.js';
import { createBrain } from '../src/brain.js';
import { sessionIdentityHandler } from '../src/capture/session-identity-work.js';
import { memoryFileStore } from '../src/testing/fakes/file-store.js';
import { memoryStore, memorySpool, memoryRepositories, memoryTranscriptReader, memoryTranscriptFolder, sequenceIdGen, sampleSelfUserInput } from '../src/testing/index.js';

const path = '/transcripts/codex.jsonl';
const start = '/demo/gone';
const token = 'codex:synthetic';
const line = (v: unknown) => JSON.stringify(v) + '\n';
const transcript = (cwd: string | null = start) => line({ type: 'session_meta', payload: { id: 'synthetic', cwd } }) + line({ type: 'turn_context', payload: { cwd: '/elsewhere/repo' } }) + line({ timestamp: '2026-01-01T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } });
const checkout = (path: string, remote = 'git@github.com:Example/Repo.git') => ({ remoteUrl: remote, commonDir: `${path}/.git`, worktreePath: path });

async function kit(content = transcript()) {
  const clock = { now: () => new Date('2026-01-03T00:00:00Z') };
  const store = memoryStore();
  await store.ensureSelfUser(sampleSelfUserInput());
  const idGen = sequenceIdGen({ timestampMs: clock.now().getTime() });
  const repositories = memoryRepositories();
  const transcripts = memoryTranscriptReader({ files: { [path]: content } });
  const folder = memoryTranscriptFolder({ harness: 'codex', files: [{ path, harnessSessionId: 'synthetic', sizeBytes: content.length, modifiedAt: clock.now() }] });
  const deps = { store: { ...store, async readSchemaVersions() { return { ok: true as const, versions: {} }; } }, files: memoryFileStore(), spool: memorySpool(), parsers: [codexParser()], repositories, transcripts, transcriptFolders: [folder], clock, idGen, schemaVersions: { core: 6 }, machine: 'synthetic' };
  const brain = createBrain(deps);
  const ingest = () => brain.sessions.ingest({ session: token, transcriptPath: path });
  return { store, repositories, transcripts, folder, deps, ingest };
}

describe('Codex with shared session identity', () => {
  it('estimates a deleted start from an ancestor, never the later turn', async () => {
    const k = await kit();
    k.repositories.set(start, { kind: 'missing' });
    k.repositories.set('/demo', checkout('/demo'));
    expect(await k.ingest()).toMatchObject({ ok: true });
    expect(k.repositories.inspects()).toEqual([start, '/demo']);
    expect(k.store.snapshot().sessions[0]).toMatchObject({ firstCwd: start, tagSource: 'ancestor' });
    expect(k.store.snapshot().worktrees[0]).toMatchObject({ path: start });
  });

  it.each([false, true])('estimates only unambiguous sibling identities (ambiguous: %s)', async ambiguous => {
    const k = await kit();
    k.repositories.set(start, { kind: 'missing' });
    k.repositories.set('/demo', { kind: 'not_repository' });
    k.repositories.setFolders('/demo', { kind: 'listed', folders: ['/demo/one', '/demo/two'] });
    k.repositories.set('/demo/one', checkout('/demo/one'));
    k.repositories.set('/demo/two', checkout('/demo/two', ambiguous ? 'git@github.com:Example/Other.git' : 'https://github.com/example/repo'));
    expect(await k.ingest()).toMatchObject({ ok: true });
    const session = k.store.snapshot().sessions[0]!;
    expect(session.firstCwd).toBe(start);
    expect(session.tagSource).toBe(ambiguous ? null : 'sibling');
    expect(session.projectId === null).toBe(ambiguous);
  });

  it('retries unknown from stored evidence when transcript cannot be located and preserves filled tags', async () => {
    const k = await kit();
    k.repositories.set(start, { kind: 'unknown', reason: 'git_missing', message: 'synthetic' });
    expect(await k.ingest()).toMatchObject({ ok: true });
    const work = k.store.snapshot().workItems.find(w => w.kind === 'session_identity');
    if (!work) throw new Error('missing identity work');
    expect(k.store.snapshot().sessions[0]).toMatchObject({ firstCwd: start, projectId: null });
    expect(await sessionIdentityHandler(k.deps)(work)).toMatchObject({ ok: false, code: 'REPOSITORY_UNANSWERED' });
    k.folder.remove(path);
    k.repositories.set(start, checkout(start));
    expect(await sessionIdentityHandler(k.deps)(work)).toEqual({ ok: true });
    const before = k.store.snapshot().sessions[0];
    expect(before).toMatchObject({ firstCwd: start, tagSource: 'cwd' });
    expect(before?.projectId).not.toBeNull();
    k.repositories.set(start, checkout(start, 'git@github.com:other/changed.git'));
    expect(await sessionIdentityHandler(k.deps)(work)).toEqual({ ok: true });
    expect(k.store.snapshot().sessions[0]).toEqual(before);
  });

  it('keeps a non-repository untagged without work and falls back to message cwd only when start is absent', async () => {
    const k = await kit();
    k.repositories.set(start, { kind: 'not_repository' });
    k.repositories.set('/elsewhere/repo', checkout('/elsewhere/repo'));
    expect(await k.ingest()).toMatchObject({ ok: true });
    expect(k.store.snapshot().sessions[0]).toMatchObject({ firstCwd: start, projectId: null, worktreeId: null });
    expect(k.store.snapshot().workItems.filter(w => w.kind === 'session_identity')).toHaveLength(0);
    const fallback = await kit(transcript(null));
    fallback.repositories.set('/elsewhere/repo', checkout('/elsewhere/repo'));
    expect(await fallback.ingest()).toMatchObject({ ok: true });
    expect(fallback.store.snapshot().sessions[0]).toMatchObject({ firstCwd: '/elsewhere/repo', tagSource: 'cwd' });
  });
});
