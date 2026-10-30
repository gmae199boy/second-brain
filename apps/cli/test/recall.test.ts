import { afterAll, describe, expect, it } from 'vitest';
import { pgHome, runPgCommand } from './pg-home.js';
import { tempHomes } from './temp-home.js';

const homes = tempHomes();
afterAll(() => homes.cleanup());
describe('검색 명령', () => {
  it('빈 검색은 실패 대신 빈 배열과 안내를 반환한다', async () => {
    const home = await homes.create('brain-recall-cli-');
    const db = await pgHome(home);
    try {
      const result = await runPgCommand(['recall', 'chunks', '검색', '--json'], { ...db.env, SECOND_BRAIN_HOME: home });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, data: [], meta: { count: 0, has_more: false, hint: expect.any(String) } });
    } finally { await db.drop(); }
  });
});

it('실제 CLI가 6개 이상에서 다섯 조각을 돌려주고 긴 출력의 다음 원문을 읽는다', async () => {
  const { postgresStore } = await import('second_brain/postgres');
  const { sampleEnsureSessionInput, sampleIngestBatch, sequenceIdGen, memorySpool } = await import('second_brain/testing');
  const { conversationChunkHandler, CONVERSATION_CHUNK_KIND, drainQueue } = await import('second_brain');
  const home = await homes.create('brain-recall-cli-'); const db = await pgHome(home);
  const store = postgresStore({ databaseUrl: db.appUrl });
  const clock = { now: () => new Date('2026-10-30T00:00:00Z') }; const ids = sequenceIdGen({ timestampMs: clock.now().getTime(), start: 900 });
  try {
    expect((await store.ensureSession(sampleEnsureSessionInput())).ok).toBe(true);
    for (let i = 0; i < 7; i++) {
      const batch = sampleIngestBatch(); batch.messages = [batch.messages[0]!]; batch.toolNotes = []; batch.attachments = [];
      batch.messages[0]!.id = ids.next(); batch.messages[0]!.harnessMessageId = `message-${i}`; batch.messages[0]!.occurredAt = new Date(Date.UTC(2026, 0, i + 1)); batch.messages[0]!.body = `검색 ${i} ` + '본문 '.repeat(450);
      if (i === 0) { const note = sampleIngestBatch().toolNotes[0]!; batch.toolNotes = [{ ...note, id: ids.next(), harnessMessageId: 'message-0', target: 'Bash SECRET=value ' + 'x'.repeat(500) }]; }
      expect((await store.ingest(batch)).ok).toBe(true);
    }
    await drainQueue({ store, clock, idGen: ids, spool: memorySpool() }, { budgetMs: 1000, handlers: { [CONVERSATION_CHUNK_KIND]: conversationChunkHandler({ store, clock, idGen: ids }) } });
    const env = { ...db.env, SECOND_BRAIN_HOME: home };
    const result = await runPgCommand(['recall', 'chunks', '검색', '--json'], env);
    const json = JSON.parse(result.stdout); expect(result.code).toBe(0); expect(json.data.length).toBeGreaterThan(0); expect(json.meta.has_more).toBe(true); expect(json.warnings).toContain('RESULT_TRUNCATED'); expect(Array.from(result.stdout).length).toBeLessThanOrEqual(8000);
    const next = json.meta.next.args; const read = await runPgCommand(['sessions', 'read', next.session, '--from-at', next.from_at, '--json'], env);
    expect(read.code).toBe(0); expect(JSON.parse(read.stdout).data[0].at).toBe(next.from_at);
    const middle = await runPgCommand(['recall', 'chunks', '검색 3', '--json'], env);
    expect(middle.code).toBe(0); const source = JSON.parse(middle.stdout).data[0];
    expect(source).toBeTruthy();
    const ranges = JSON.stringify([{ from_at: source.from_at, to_at: source.to_at }, { from_at: source.from_at, to_at: source.to_at }]);
    const expandArgs = ['recall', 'expand', source.session, '--ranges', ranges, '--before', '1', '--after', '1', '--json'];
    const expanded = await runPgCommand(expandArgs, env); expect(expanded.code).toBe(0);
    const expansion = JSON.parse(expanded.stdout).data as { id: string }[];
    const original = await store.readSession(source.session); if (!original.ok) throw new Error(original.message);
    const ordered = [...original.messages].sort((a,b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));
    const first = ordered.findIndex(m => m.occurredAt.getTime() >= Date.parse(source.from_at));
    const last = ordered.findLastIndex(m => m.occurredAt.getTime() <= Date.parse(source.to_at));
    expect(expansion.map(m => m.id)).toEqual(ordered.slice(Math.max(0, first - 1), last + 2).map(m => m.id));
    const appended = sampleIngestBatch(); appended.messages = [appended.messages[0]!]; appended.toolNotes = []; appended.attachments = [];
    appended.messages[0]!.id = ids.next(); appended.messages[0]!.harnessMessageId = 'message-later'; appended.messages[0]!.occurredAt = new Date(Date.UTC(2026, 0, 8)); appended.messages[0]!.body = '나중 메시지';
    expect((await store.ingest(appended)).ok).toBe(true);
    await drainQueue({ store, clock, idGen: ids, spool: memorySpool() }, { budgetMs: 1000, handlers: { [CONVERSATION_CHUNK_KIND]: conversationChunkHandler({ store, clock, idGen: ids }) } });
    const expandedAgain = await runPgCommand(expandArgs, env); expect(JSON.parse(expandedAgain.stdout).data).toEqual(expansion);
    const textFirst = await runPgCommand(['sessions', 'read', source.session, '--limit', '1'], env);
    const textNext = textFirst.stdout.split('\n').find(line => line.startsWith('다음: '));
    expect(textNext).toBeTruthy();
    const textNextArgs = textNext!.slice('다음: '.length).split(' ').slice(1);
    const textSecond = await runPgCommand(textNextArgs, env); expect(textSecond.code).toBe(0);
    const jsonFirst = JSON.parse((await runPgCommand(['sessions', 'read', source.session, '--limit', '1', '--json'], env)).stdout);
    const jsonNext = jsonFirst.meta.next.args;
    const jsonSecond = JSON.parse((await runPgCommand(['sessions', 'read', jsonNext.session, '--limit', String(jsonNext.limit), '--cursor', jsonNext.cursor, '--json'], env)).stdout);
    expect(textSecond.stdout).toContain(jsonSecond.data[0].body);
    let cursor: string | undefined; const pageRows: { id: string; kind: string; body: string }[] = [];
    do {
      const page = await runPgCommand(['sessions', 'read', source.session, '--limit', '1', ...(cursor ? ['--cursor', cursor] : []), '--json'], env);
      expect(page.code).toBe(0); const data = JSON.parse(page.stdout); pageRows.push(...data.data); cursor = data.meta.next?.args.cursor;
    } while (cursor);
    expect(pageRows.filter(row => row.kind === 'message')).toHaveLength(8);
    expect(new Set(pageRows.map(row => row.id)).size).toBe(9);
    expect(pageRows.filter(row => row.kind === 'tool')).toHaveLength(1);
    expect(JSON.stringify(pageRows)).not.toContain('SECRET=value');
    expect(JSON.stringify(pageRows)).not.toContain('x'.repeat(500));
    for (const [ns, verb] of [['recall', 'chunks'], ['recall', 'tools'], ['recall', 'expand'], ['sessions', 'read']]) {
      const guide = await runPgCommand(['guide', 'schema', ns!, verb!, '--json'], env);
      const command = JSON.parse(guide.stdout).data.commands[0];
      expect(command).toMatchObject({ ns, verb, risk: 'read', hook: false, dry_run: false });
      expect(command.required.length).toBeGreaterThan(0); expect(command.output).toBeTruthy(); expect(command.options.length).toBeGreaterThan(0);
    }
    const text = await runPgCommand(['recall', 'chunks', '검색'], env); expect(text.code).toBe(0); expect(Array.from(text.stdout).length).toBeLessThanOrEqual(8000);
    const sourceLine = text.stdout.split('\n').find(line => line.startsWith('출처 ')); expect(sourceLine).toBeTruthy();
    const textSource = JSON.parse(sourceLine!.slice('출처 '.length));
    const sourceJson = JSON.parse((await runPgCommand(['recall', 'chunks', '검색', '--json'], env)).stdout).data[0];
    for (const key of ['kind', 'session', 'harness', 'started_at', 'workspace_id', 'project_id', 'worktree_id', 'tag_source', 'from_at', 'to_at', 'chunk_id']) expect(textSource[key]).toEqual(sourceJson[key]);
    const fromText = await runPgCommand(['recall', 'expand', textSource.session, '--from', textSource.from_at, '--to', textSource.to_at, '--json'], env);
    expect(fromText.code).toBe(0); expect(JSON.parse(fromText.stdout).data.length).toBeGreaterThan(0);
    expect(text.stdout).toContain('더 있는 결과:'); expect(text.stdout).toContain('생략:');
    const searchNext = text.stdout.split('\n').find(line => line.startsWith('다음: ')); expect(searchNext).toBeTruthy();
    expect((await runPgCommand(searchNext!.slice('다음: '.length).split(' ').slice(1), env)).code).toBe(0);
    for (const flags of [['--json'], []]) { const tools = await runPgCommand(['recall', 'tools', 'SECRET', ...flags], env); expect(tools.code).toBe(0); expect(tools.stdout).not.toContain('SECRET=value'); expect(tools.stdout).not.toContain('x'.repeat(500)); }
    const newKey = { harness: 'demo', harnessSessionId: 'orphan-append-cli' };
    expect((await store.ensureSession(sampleEnsureSessionInput({ id: ids.next(), key: newKey }))).ok).toBe(true);
    const initial = sampleIngestBatch(); initial.key = newKey; initial.messages = [initial.messages[0]!]; initial.attachments = [];
    initial.messages[0]!.id = ids.next(); initial.messages[0]!.harnessMessageId = 'first-cli'; initial.messages[0]!.body = '첫 메시지';
    initial.toolNotes = [{ ...initial.toolNotes[0]!, id: ids.next(), harnessMessageId: 'orphan-cli', target: '고아 메모' }];
    expect((await store.ingest(initial)).ok).toBe(true);
    const token = 'demo:orphan-append-cli';
    const initialPage = JSON.parse((await runPgCommand(['sessions', 'read', token, '--limit', '1', '--json'], env)).stdout);
    let resume = initialPage.meta.next.args.cursor as string;
    const later = sampleIngestBatch(); later.key = newKey; later.messages = [later.messages[0]!]; later.attachments = [];
    later.messages[0]!.id = ids.next(); later.messages[0]!.harnessMessageId = 'orphan-cli'; later.messages[0]!.occurredAt = new Date(initial.messages[0]!.occurredAt.getTime() + 1000); later.messages[0]!.body = '새 메시지 '.repeat(2500);
    later.toolNotes = [{ ...later.toolNotes[0]!, id: ids.next(), harnessMessageId: 'orphan-cli', ordinal: 1, target: 'SECRET=value' }];
    expect((await store.ingest(later)).ok).toBe(true);
    const appendedRows: { id: string; body: string }[] = [];
    do { const page = await runPgCommand(['sessions', 'read', token, '--limit', '1', '--cursor', resume, '--json'], env); expect(page.code).toBe(0); const data = JSON.parse(page.stdout); appendedRows.push(...data.data); resume = data.meta.next?.args.cursor; } while (resume);
    expect(appendedRows.filter(row => row.id === later.messages[0]!.id).map(row => row.body).join('')).toBe(later.messages[0]!.body);
    expect(appendedRows.some(row => row.id === later.toolNotes[0]!.id)).toBe(true);
    expect(appendedRows.findIndex(row => row.id === initial.toolNotes[0]!.id)).toBeGreaterThan(appendedRows.findIndex(row => row.id === later.messages[0]!.id));
    expect(appendedRows.filter(row => row.id === initial.toolNotes[0]!.id)).toHaveLength(1);
    expect(JSON.stringify(appendedRows)).not.toContain('SECRET=value');
    const extra = sampleIngestBatch(); extra.key = newKey; extra.messages = []; extra.attachments = [];
    const longNote = { ...later.toolNotes[0]!, id: ids.next(), ordinal: 2, target: '긴 메모 '.repeat(3000) };
    const orphanNote = { ...longNote, id: ids.next(), harnessMessageId: 'new-orphan-cli', ordinal: 0, target: '별도 고아' };
    extra.toolNotes = [longNote, orphanNote]; expect((await store.ingest(extra)).ok).toBe(true);
    let noteCursor: string | undefined; const noteRows: { id: string; body: string }[] = []; let notePages = 0;
    do { expect(++notePages).toBeLessThan(20); const result = await runPgCommand(['sessions', 'read', token, '--limit', '1', ...(noteCursor ? ['--cursor', noteCursor] : ['--note', longNote.id]), '--json'], env); expect(result.code).toBe(0); const data = JSON.parse(result.stdout); noteRows.push(...data.data); noteCursor = data.meta.next?.args.cursor; } while (noteCursor);
    expect(noteRows.filter(row => row.id === longNote.id).map(row => row.body).join('')).toBe(longNote.target);
    expect(noteRows.some(row => row.id === orphanNote.id)).toBe(true);
    const dynamicKey = { harness: 'demo', harnessSessionId: 'orphan-change-cli' };
    expect((await store.ensureSession(sampleEnsureSessionInput({ id: ids.next(), key: dynamicKey }))).ok).toBe(true);
    const dynamic = sampleIngestBatch(); dynamic.key = dynamicKey; dynamic.messages = [dynamic.messages[0]!]; dynamic.attachments = [];
    dynamic.messages[0]!.id = ids.next(); dynamic.messages[0]!.harnessMessageId = 'dynamic-message';
    const high = { ...dynamic.toolNotes[0]!, id: '00000000-0000-7000-8000-000000000020', harnessMessageId: 'orphan-20', target: '대기 고아' }; dynamic.toolNotes = [high];
    expect((await store.ingest(dynamic)).ok).toBe(true);
    const dynamicSession = 'demo:orphan-change-cli'; const firstDynamic = JSON.parse((await runPgCommand(['sessions', 'read', dynamicSession, '--limit', '1', '--json'], env)).stdout);
    const smaller = { ...high, id: '00000000-0000-7000-8000-000000000010', harnessMessageId: 'orphan-10', target: '작은 고아' };
    dynamic.messages = []; dynamic.toolNotes = [smaller]; expect((await store.ingest(dynamic)).ok).toBe(true);
    const resumed = await runPgCommand(['sessions', 'read', dynamicSession, '--limit', '1', '--cursor', firstDynamic.meta.next.args.cursor, '--json'], env);
    expect(resumed.code).toBe(0); const resumedPage = JSON.parse(resumed.stdout); expect(resumedPage.data[0].id).toBe(smaller.id); expect(resumedPage.meta.hint).toContain('고아 메모 구성');
    const orphanSearch = await runPgCommand(['recall', 'tools', '작은 고아'], env);
    expect(orphanSearch.code).toBe(0); expect(Array.from(orphanSearch.stdout + orphanSearch.stderr).length).toBeLessThanOrEqual(8000);
    const orphanSource = JSON.parse(orphanSearch.stdout.split('\n').find(line => line.startsWith('출처 '))!.slice('출처 '.length));
    expect(orphanSource).toMatchObject({ session: dynamicSession, harness: 'demo', tool_note_id: smaller.id, message_id: null, from_at: null, to_at: null });
    expect(orphanSource.chunk_id).toBeUndefined();
    const fromOrphanText = await runPgCommand(['sessions', 'read', orphanSource.session, '--note', orphanSource.tool_note_id, '--json'], env);
    expect(fromOrphanText.code).toBe(0); expect(JSON.parse(fromOrphanText.stdout).data[0].id).toBe(smaller.id);



    const { readFile, writeFile } = await import('node:fs/promises'); const { join } = await import('node:path');
    const configPath = join(home, 'config.toml'); const originalConfig = await readFile(configPath, 'utf8');
    const commands = [ ['recall', 'chunks', '검색'], ['recall', 'tools', 'SECRET'], ['recall', 'expand', source.session, '--from', source.from_at, '--to', source.to_at], ['sessions', 'read', source.session] ];
    try {
      for (const extra of [`unknown_${'x'.repeat(9000)} = 1`, Array.from({ length: 600 }, (_, index) => `unknown_${index} = 1`).join('\n')]) {
        await writeFile(configPath, `${originalConfig}\n${extra}\n`);
        for (const args of commands) for (const flags of [['--json'], []]) {
          const output = await runPgCommand([...args, ...flags], env);
          expect(Array.from(output.stdout + output.stderr).length).toBeLessThanOrEqual(8000);
          if (flags.length) {
            const envelope = JSON.parse(output.stdout);
            expect(envelope.warnings).toContain('CONFIG_UNKNOWN_KEY');
            if (!envelope.ok) { expect(envelope.error.code).toBe('INVALID_ARGUMENT'); expect(envelope.warnings.filter((code: string) => code === 'CONFIG_UNKNOWN_KEY')).toHaveLength(1); }
          } else { expect(output.code).toBe(2); expect(output.stderr).toContain('CONFIG_UNKNOWN_KEY'); expect(output.stderr).not.toContain('x'.repeat(100)); }
        }
      }
    } finally { await writeFile(configPath, originalConfig); }

  } finally { await store.close(); await db.drop(); }
});

it('실제 CLI가 근접도와 관련도에 따라 기본 다섯 건을 정렬한다', async () => {
  const { postgresStore } = await import('second_brain/postgres');
  const { sampleEnsureSessionInput, sampleCheckoutInput, sequenceIdGen } = await import('second_brain/testing');
  const { CONVERSATION_CHUNK_INDEX_CONFIG_ID, searchRecall, okEnvelope, errorEnvelope } = await import('second_brain');
  const pg = await import('pg'); const home = await homes.create('brain-recall-order-'); const db = await pgHome(home);
  const store = postgresStore({ databaseUrl: db.appUrl }); const client = new pg.default.Client({ connectionString: db.url });
  const ids = sequenceIdGen({ timestampMs: Date.UTC(2026, 0, 1), start: 1000 });
  try {
    await client.connect(); const project = ids.next(), worktree = ids.next(), sibling = ids.next(); const expected: string[] = [];
    for (let i = 0; i < 6; i++) {
      const sessionId = ids.next(), chunkId = ids.next(); expected.push(chunkId);
      const checkout = i < 4 ? sampleCheckoutInput({ projectId: project, worktreeId: i < 2 ? worktree : sibling, worktreePath: i < 2 ? '/fixture/a' : '/fixture/b' }) : null;
      expect((await store.ensureSession(sampleEnsureSessionInput({ id: sessionId, key: { harness: 'demo', harnessSessionId: `cli-sort-${i}` }, checkout }))).ok).toBe(true);
      await client.query('insert into brain.chunks(id,session_id,index_config_id,from_at,to_at,part,body) values($1,$2,$3,$4,$4,0,$5)', [chunkId, sessionId, CONVERSATION_CHUNK_INDEX_CONFIG_ID, new Date(Date.UTC(2026, 0, i + 1)).toISOString(), i % 2 === 0 ? '검색 검색' : '검색']);
    }
    const output = await runPgCommand(['recall', 'chunks', '검색', '--worktree', worktree, '--project', project, '--json'], { ...db.env, SECOND_BRAIN_HOME: home });
    expect(output.code).toBe(0); const result = JSON.parse(output.stdout);
    expect(result.data.map((row: { chunk_id: string }) => row.chunk_id)).toEqual(expected.slice(0, 5));
    expect(result.meta).toMatchObject({ count: 5, has_more: true });
    expect(result.data.every((row: { kind: string; session: string; from_at: string; to_at: string }) => row.kind === 'conversation' && row.session.startsWith('demo:') && row.from_at && row.to_at)).toBe(true);
    await client.query('delete from brain.chunks where id=$1', [expected[5]]);
    const exactlyFive = await runPgCommand(['recall', 'chunks', '검색', '--json'], { ...db.env, SECOND_BRAIN_HOME: home });
    expect(JSON.parse(exactlyFive.stdout)).toMatchObject({ meta: { count: 5, has_more: false } });
    for (const [suffix, query] of [['a'.repeat(1800), '긴출처'], ['token=a;'.repeat(31), '가림출처']] as const) {
      const sessionId = ids.next(), chunkId = ids.next();
      expect((await store.ensureSession(sampleEnsureSessionInput({ id: sessionId, key: { harness: 'demo', harnessSessionId: suffix } }))).ok).toBe(true);
      await client.query('insert into brain.chunks(id,session_id,index_config_id,from_at,to_at,part,body) values($1,$2,$3,$4,$4,0,$5)', [chunkId, sessionId, CONVERSATION_CHUNK_INDEX_CONFIG_ID, '2026-01-01T00:00:00Z', query + ' 본문'.repeat(4000)]);
      const sdk = await searchRecall(store, 'chunks', { query });
      if (query === '가림출처') { expect(sdk).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' }); if (!sdk.ok) { const envelope = errorEnvelope({ now: () => new Date('2026-01-01T00:00:00Z') }, sdk); expect(JSON.stringify(envelope)).not.toContain('token=a;'); expect(Array.from(JSON.stringify(envelope)).length).toBeLessThanOrEqual(8000); } }
      else {
        expect(sdk.ok).toBe(true);
        if (sdk.ok) expect(Array.from(JSON.stringify(okEnvelope({ now: () => new Date('2026-01-01T00:00:00Z') }, sdk.data, sdk.warnings, sdk.meta))).length).toBeLessThanOrEqual(8000);
      }
      for (const flags of [['--json'], []]) {
        const output = await runPgCommand(['recall', 'chunks', query, ...flags], { ...db.env, SECOND_BRAIN_HOME: home });
        expect(Array.from(output.stdout + output.stderr).length).toBeLessThanOrEqual(8000);
        if (query === '가림출처') { expect(output.code).not.toBe(0); expect(output.stdout + output.stderr).not.toContain('token=a;'); }
        else expect(output.code).toBe(0);
      }
    }


  } finally { await client.end(); await store.close(); await db.drop(); }
});
