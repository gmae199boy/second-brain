import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createIsolatedTestDatabase } from '@second-brain/test-db';
import { expect, it } from 'vitest';
import { CONVERSATION_CHUNK_INDEX_CONFIG_ID, literalLikePattern, searchRecall } from '@second-brain/core';
import { sampleCheckoutInput, sampleEnsureSessionInput, sampleSelfUserInput } from '@second-brain/core/testing';
import { postgresStore, prepareDatabase, runMigrations } from '../src/index.js';
import { clock } from './fixture.js';
import { conversationFixture } from './conversation-fixture.js';

// Independent copy of the pre-optimization ordering and character-length score.
async function oracle(client: pg.Client, kind: 'chunks' | 'tools', query: string, limit: number, worktree?: string, project?: string) {
  const source = kind === 'chunks'
    ? `select c.id, c.body, c.from_at, c.session_id from brain.chunks c where c.index_config_id=$5::uuid and lower(c.body) like lower($1) escape '\\'`
    : `select n.id, n.target as body, m.occurred_at as from_at, n.session_id from brain.tool_notes n left join brain.messages m on m.session_id=n.session_id and m.harness_message_id=n.harness_message_id and m.harness_message_id_raw is not distinct from n.harness_message_id_raw where lower(n.target) like lower($1) escape '\\' and $5::uuid is not null`;
  return (await client.query<{ id: string }>(`select x.id from (${source}) x join brain.sessions s on s.id=x.session_id
    order by case when $3::text is not null and s.worktree_id::text=$3 then 0 when $4::text is not null and s.project_id::text=$4 then 1 else 2 end,
    (length(lower(x.body))-length(replace(lower(x.body),lower($2),''))) desc, x.from_at desc nulls last, x.id asc limit $6`,
    [literalLikePattern(query), query.replaceAll('\0', '�'), worktree ?? null, project ?? null, CONVERSATION_CHUNK_INDEX_CONFIG_ID, limit])).rows.map(row => row.id);
}

it('chunk와 tool의 전수 원형 순위 및 고정 순서, 문자와 raw 결합을 보존한다', async () => {
  const f = await conversationFixture('기존 본문');
  const client = new pg.Client({ connectionString: f.db.url });
  try {
    await client.connect();
    const project = f.ids.next(), worktree = f.ids.next(), sibling = f.ids.next();
    const chunks: string[] = [], notes: string[] = [], messages: string[] = [];
    const bodies = ['aa', 'aaaaa', 'aaaaa', 'aa aa aa', 'aa aa aa aa', 'aa aa aa aa aa'];
    for (let i = 0; i < bodies.length; i++) {
      const session = f.ids.next(), chunk = f.ids.next(), note = f.ids.next(), message = f.ids.next();
      chunks.push(chunk); notes.push(note); messages.push(message);
      const checkout = i < 4 ? sampleCheckoutInput({ projectId: project, worktreeId: i < 2 ? worktree : sibling, worktreePath: i < 2 ? '/fixture/a' : '/fixture/b' }) : null;
      const created = await f.store.ensureSession(sampleEnsureSessionInput({ id: session, key: { harness: 'demo', harnessSessionId: `rank-${i}` }, checkout }));
      expect(created.ok).toBe(true);
      const at = new Date(Date.UTC(2026, 0, i + 1));
      const body = `${bodies[i]} 수면 %_\\ 가 가`;
      await client.query('insert into brain.chunks(id,session_id,index_config_id,from_at,to_at,part,body) values($1,$2,$3,$4,$4,0,$5)', [chunk, session, CONVERSATION_CHUNK_INDEX_CONFIG_ID, at, body]);
      // A raw identity distinguishes NUL from the replacement character. Last note is an orphan.
      const identity = i === 4 ? 'raw�id' : `message-${i}`;
      const raw = i === 4 ? Buffer.from('raw\0id') : null;
      if (i === 4) await client.query("insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at) values($1,$2,$3,'user','other raw identity',$4)", [f.ids.next(), session, identity, at]);
      if (i !== 5) await client.query("insert into brain.messages(id,session_id,harness_message_id,harness_message_id_raw,role,body,occurred_at) values($1,$2,$3,$4,'user','message',$5)", [message, session, identity, raw, at]);
      await client.query("insert into brain.tool_notes(id,session_id,harness_message_id,harness_message_id_raw,ordinal,tool,tool_raw,target,target_raw,ok) values($1,$2,$3,$4,0,$5,$6,$7,$8,1)", [note, session, identity, raw, i === 4 ? '도구�이름' : 'tool', i === 4 ? Buffer.from('도구\0이름') : null, body, i === 4 ? Buffer.from(body + '\0') : null]);
    }
    const tieChunks: string[] = [], tieNotes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const session = f.ids.next(), chunk = f.ids.next(), note = f.ids.next();
      tieChunks.push(chunk); tieNotes.push(note);
      const created = await f.store.ensureSession(sampleEnsureSessionInput({ id: session, key: { harness: 'demo', harnessSessionId: `tie-${i}` }, checkout: null }));
      expect(created.ok).toBe(true);
      const at = new Date('2026-03-01T00:00:00Z');
      await client.query('insert into brain.chunks(id,session_id,index_config_id,from_at,to_at,part,body) values($1,$2,$3,$4,$4,0,$5)', [chunk, session, CONVERSATION_CHUNK_INDEX_CONFIG_ID, at, 'tiecase']);
      if (i < 2) await client.query("insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at) values($1,$2,'tie','user','message',$3)", [f.ids.next(), session, at]);
      await client.query("insert into brain.tool_notes(id,session_id,harness_message_id,ordinal,tool,target,ok) values($1,$2,'tie',0,'tool','tiecase',1)", [note, session]);
    }
    for (const kind of ['chunks', 'tools'] as const) {
      const result = await f.store.searchRecall({ kind, query: 'tiecase', pattern: '%tiecase%', limit: 3 });
      expect(result.ok && result.rows.map(row => kind === 'chunks' ? row.chunk_id : row.tool_note_id)).toEqual(kind === 'chunks' ? tieChunks : tieNotes);
      expect(result.ok && result.rows.map(row => kind === 'chunks' ? row.chunk_id : row.tool_note_id)).toEqual(await oracle(client, kind, 'tiecase', 3));
    }
    const alternateConfig = f.ids.next();
    await client.query(`insert into brain.index_configs(id,kind,model,dimensions,chunk_params)
      values($1,'chunk',null,null,'{"targetChars":1201,"overlapMessages":1,"splitMessagesOverChars":2400}'::jsonb)`, [alternateConfig]);
    await client.query('insert into brain.chunks(id,session_id,index_config_id,from_at,to_at,part,body) values($1,$2,$3,$4,$4,0,$5)',
      [f.ids.next(), f.sessionId, alternateConfig, new Date('2026-01-01T00:00:00Z'), 'aa aa aa aa aa aa']);
    const rawChunk = f.ids.next();
    await client.query('insert into brain.chunks(id,session_id,index_config_id,from_at,to_at,part,body,body_raw) values($1,$2,$3,$4,$4,0,$5,$6)',
      [rawChunk, f.sessionId, CONVERSATION_CHUNK_INDEX_CONFIG_ID, new Date('2026-02-01T00:00:00Z'), '원문�끝', Buffer.from('원문\0끝')]);
    const rawResult = await f.store.searchRecall({ kind: 'chunks', query: '원문�끝', pattern: literalLikePattern('원문\0끝'), limit: 5 });
    expect(rawResult.ok && rawResult.rows).toMatchObject([{ chunk_id: rawChunk, body: '원문\0끝' }]);
    for (const kind of ['chunks', 'tools'] as const) {
      for (const limit of [1, 5, 200]) {
        for (const query of ['aa', '수면', '%', '_', '\\', '가', '가', '불일치']) {
          const input = { kind, query, pattern: literalLikePattern(query), limit, worktree, project };
          const actual = await f.store.searchRecall(input);
          expect(actual.ok).toBe(true); if (!actual.ok) throw Error(actual.message);
          const ids = actual.rows.map(row => kind === 'chunks' ? row.chunk_id : row.tool_note_id);
          expect(ids).toEqual(await oracle(client, kind, query, limit, worktree, project));
        }
      }
      const result = await f.store.searchRecall({ kind, query: 'aa', pattern: '%aa%', limit: 6, worktree, project });
      expect(result.ok).toBe(true); if (!result.ok) throw Error(result.message);
      expect(result.rows.map(row => kind === 'chunks' ? row.chunk_id : row.tool_note_id)).toEqual(kind === 'chunks'
        ? [chunks[1], chunks[0], chunks[3], chunks[2], chunks[5], chunks[4]]
        : [notes[1], notes[0], notes[3], notes[2], notes[5], notes[4]]);
      if (kind === 'tools') {
        expect(result.rows[4]).toMatchObject({ message_id: null, from_at: null });
        expect(result.rows[5]).toMatchObject({ message_id: messages[4], tool: '도구\0이름', body: expect.stringContaining('\0') });
      }
      // A lower proximity tier can have a higher score and a later timestamp.
      for (const scenario of [
        { worktree, project: undefined, order: [1,0,5,4,3,2] },
        { worktree: undefined, project, order: [3,2,1,0,5,4] },
        { worktree: undefined, project: undefined, order: [5,4,3,2,1,0] },
      ]) {
        const input = { kind, query:'aa', pattern:'%aa%', limit:6, ...(scenario.worktree ? {worktree:scenario.worktree} : {}), ...(scenario.project ? {project:scenario.project} : {}) };
        const actual = await f.store.searchRecall(input); expect(actual.ok).toBe(true); if (!actual.ok) throw Error(actual.message);
        const ids = actual.rows.map(row => kind==='chunks' ? row.chunk_id : row.tool_note_id);
        expect(ids).toEqual(scenario.order.map(index => (kind==='chunks' ? chunks : notes)[index]));
        expect(ids).toEqual(await oracle(client, kind, 'aa', 6, scenario.worktree, scenario.project));
      }
      const page = await searchRecall(f.store, kind, { query: 'aa', limit: 5, worktree, project });
      expect(page.ok && page.meta.has_more).toBe(true);
    }
    // Same proximity, competing mixed-case occurrence counts and opposite recency.
    const caseWorktree = f.ids.next(), caseProject = f.ids.next();
    const caseChunks = ['a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002'];
    const caseNotes = ['b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002'];
    for (let i = 0; i < 2; i++) {
      const session = f.ids.next(), at = new Date(Date.UTC(2026, 4, i + 1));
      const created = await f.store.ensureSession(sampleEnsureSessionInput({ id: session, key: { harness: 'demo', harnessSessionId: `case-${i}` }, checkout: sampleCheckoutInput({ projectId: caseProject, worktreeId: caseWorktree, worktreePath: '/fixture/case' }) }));
      expect(created.ok).toBe(true);
      const body = i === 0 ? 'AA Aa aa' : 'aa aa';
      await client.query('insert into brain.chunks(id,session_id,index_config_id,from_at,to_at,part,body) values($1,$2,$3,$4,$4,0,$5)', [caseChunks[i], session, CONVERSATION_CHUNK_INDEX_CONFIG_ID, at, body]);
      await client.query("insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at) values($1,$2,'case','user','message',$3)", [f.ids.next(), session, at]);
      await client.query("insert into brain.tool_notes(id,session_id,harness_message_id,ordinal,tool,target,ok) values($1,$2,'case',0,'tool',$3,1)", [caseNotes[i], session, body]);
    }
    for (const kind of ['chunks', 'tools'] as const) for (const query of ['aa', 'AA']) {
      const result = await f.store.searchRecall({ kind, query, pattern: literalLikePattern(query), limit: 2, worktree: caseWorktree, project: caseProject });
      expect(result.ok).toBe(true); if (!result.ok) throw Error(result.message);
      const ids = result.rows.map(row => kind === 'chunks' ? row.chunk_id : row.tool_note_id);
      expect(ids).toEqual(kind === 'chunks' ? caseChunks : caseNotes);
      expect(ids).toEqual(await oracle(client, kind, query, 2, caseWorktree, caseProject));
    }
    // Insert orphans in reverse UUID order; equal score and NULL times must sort by ID.
    const orphanIds = ['c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000003'];
    for (const [index, id] of [...orphanIds].reverse().entries()) {
      await client.query("insert into brain.tool_notes(id,session_id,harness_message_id,ordinal,tool,target,ok) values($1,$2,$3,0,'tool','orphanrank',1)", [id, f.sessionId, `orphan-${index}`]);
    }
    for (const limit of [1, 2, 3]) {
      const result = await f.store.searchRecall({ kind: 'tools', query: 'orphanrank', pattern: '%orphanrank%', limit });
      expect(result.ok).toBe(true); if (!result.ok) throw Error(result.message);
      expect(result.rows.map(row => row.tool_note_id)).toEqual(orphanIds.slice(0, limit));
      expect(result.rows.every(row => row.message_id === null && row.from_at === null)).toBe(true);
      expect(result.rows.map(row => row.tool_note_id)).toEqual(await oracle(client, 'tools', 'orphanrank', limit));
    }
  } finally { await client.end(); await f.close(); }
}, 120000);

it('바이트 길이가 다른 본문과 빈 검색어의 순위 및 ASCII gate fallback을 보존한다', async () => {
  const f = await conversationFixture('fixture outside score cases');
  const client = new pg.Client({ connectionString: f.db.url });
  try {
    await client.connect();
    const project = f.ids.next(), worktree = f.ids.next();
    const bodies = ['가 가 ASCII', '가 한글🙂 �', '가 가 가 é 가', 'AAA aa aaaaa %_\\', '원문�끝'];
    const chunks: string[] = [], notes: string[] = [];
    for (let i = 0; i < bodies.length; i++) {
      const session = f.ids.next(), chunk = f.ids.next(), note = f.ids.next();
      chunks.push(chunk); notes.push(note);
      const created = await f.store.ensureSession(sampleEnsureSessionInput({ id: session, key: { harness: 'demo', harnessSessionId: `byte-rank-${i}` }, checkout: sampleCheckoutInput({ projectId: project, worktreeId: worktree, worktreePath: '/fixture/byte-rank' }) }));
      expect(created.ok).toBe(true);
      const at = new Date(Date.UTC(2026, 6, i + 1));
      const raw = i === 4 ? Buffer.from('원문\0끝') : null;
      await client.query('insert into brain.chunks(id,session_id,index_config_id,from_at,to_at,part,body,body_raw) values($1,$2,$3,$4,$4,0,$5,$6)', [chunk, session, CONVERSATION_CHUNK_INDEX_CONFIG_ID, at, bodies[i], raw]);
      await client.query("insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at) values($1,$2,'rank','user','message',$3)", [f.ids.next(), session, at]);
      await client.query("insert into brain.tool_notes(id,session_id,harness_message_id,ordinal,tool,target,target_raw,ok) values($1,$2,'rank',0,'tool',$3,$4,1)", [note, session, bodies[i], raw]);
    }
    for (const kind of ['chunks', 'tools'] as const) {
      for (const query of ['가', '가', 'é', 'a', 'aa', 'AAA', '🙂', '🙂�', '%', '_', '\\', '%_\\', '', '\0', '\ud800', '원문\0끝']) {
        const input = { kind, query, pattern: literalLikePattern(query), limit: 200, worktree, project };
        const result = await f.store.searchRecall(input);
        expect(result.ok).toBe(true); if (!result.ok) throw Error(result.message);
        expect(result.rows.map(row => kind === 'chunks' ? row.chunk_id : row.tool_note_id)).toEqual(await oracle(client, kind, query, 200, worktree, project));
        if (query === '가') expect(result.rows.map(row => kind === 'chunks' ? row.chunk_id : row.tool_note_id)).toEqual([2, 0, 1].map(i => (kind === 'chunks' ? chunks : notes)[i]));
        if (query === '원문\0끝') expect(result.rows[0]?.body).toBe('원문\0끝');
      }
    }
    // Exercise a copy of the gate expression on ASCII and non-ASCII inputs, and force
    // each environmental guard false to check the fallback expression independently.
    const gate = await client.query<{ body: string; gate: boolean; scalar_gate: boolean; folded: string; scalar_folded: string; expected: string; forced_encoding: string; forced_locale: string }>(`
      select body,
        current_setting('server_encoding') = 'UTF8' and lower('ABCDEFGHIJKLMNOPQRSTUVWXYZ') collate "C" = 'abcdefghijklmnopqrstuvwxyz' and octet_length(body)=length(body) as gate,
        (select current_setting('server_encoding') = 'UTF8' and lower('ABCDEFGHIJKLMNOPQRSTUVWXYZ') collate "C" = 'abcdefghijklmnopqrstuvwxyz') and octet_length(body)=length(body) as scalar_gate,
        case when (select current_setting('server_encoding') = 'UTF8' and lower('ABCDEFGHIJKLMNOPQRSTUVWXYZ') collate "C" = 'abcdefghijklmnopqrstuvwxyz') and octet_length(body)=length(body) then lower(body collate "C") else lower(body) end as scalar_folded,
        case when current_setting('server_encoding') = 'UTF8' and lower('ABCDEFGHIJKLMNOPQRSTUVWXYZ') collate "C" = 'abcdefghijklmnopqrstuvwxyz' and octet_length(body)=length(body) then lower(body collate "C") else lower(body) end as folded,
        lower(body) as expected,
        case when false and lower('ABCDEFGHIJKLMNOPQRSTUVWXYZ') collate "C" = 'abcdefghijklmnopqrstuvwxyz' and octet_length(body)=length(body) then lower(body collate "C") else lower(body) end as forced_encoding,
        case when current_setting('server_encoding') = 'UTF8' and false and octet_length(body)=length(body) then lower(body collate "C") else lower(body) end as forced_locale
      from unnest($1::text[]) as body`, [['ABCxyz', '한글 ABC', 'İ I', 'é 가']]);
    expect(gate.rows[0]?.folded).toBe(gate.rows[0]?.expected);
    expect(gate.rows.slice(1).every(row => !row.gate)).toBe(true);
    for (const row of gate.rows) { expect(row.scalar_gate).toBe(row.gate); expect([row.folded, row.scalar_folded, row.forced_encoding, row.forced_locale]).toEqual([row.expected, row.expected, row.expected, row.expected]); }
    // Non-overlapping matches, empty query, and multibyte queries use the same
    // ordering even when score magnitudes differ between characters and bytes.
    for (const query of ['aa', '가', '가', '']) {
      const scores = await client.query<{ id: number; char_score: number; byte_score: number; optimized_score: number; ascii_gate: boolean; body_bytes: number; c_fold_bytes: number }>(`
        select id, length(lower(body))-length(replace(lower(body),lower($2),'')) as char_score,
          octet_length(lower(body))-octet_length(replace(lower(body),lower($2),'')) as byte_score,
          current_setting('server_encoding') = 'UTF8' and lower('ABCDEFGHIJKLMNOPQRSTUVWXYZ') collate "C" = 'abcdefghijklmnopqrstuvwxyz' and octet_length(body)=length(body) as ascii_gate,
          octet_length(body) as body_bytes, octet_length(lower(body collate "C")) as c_fold_bytes,
          case when current_setting('server_encoding') = 'UTF8' and lower('ABCDEFGHIJKLMNOPQRSTUVWXYZ') collate "C" = 'abcdefghijklmnopqrstuvwxyz' and octet_length(body)=length(body)
            then octet_length(body)-octet_length(replace(lower(body collate "C"),lower($2),''))
            else octet_length(lower(body))-octet_length(replace(lower(body),lower($2),'')) end as optimized_score
        from unnest($1::text[]) with ordinality as t(body,id)`, [bodies, query]);
      const rank = (key: 'char_score' | 'byte_score' | 'optimized_score') => [...scores.rows].sort((a,b) => b[key]-a[key] || Number(a.id)-Number(b.id)).map(row => row.id);
      expect(rank('byte_score')).toEqual(rank('char_score'));
      // This direct SQL expression is a test copy; the store/oracle checks above exercise product SQL.
      expect(scores.rows.map(row => row.optimized_score)).toEqual(scores.rows.map(row => row.byte_score));
      expect(rank('optimized_score')).toEqual(rank('char_score'));
      expect(scores.rows.filter(row => row.ascii_gate).every(row => row.body_bytes === row.c_fold_bytes)).toBe(true);
      expect(scores.rows[0]?.ascii_gate).toBe(false);
      expect(scores.rows[3]?.ascii_gate).toBe(gate.rows[0]?.gate);
      if (query === 'aa') expect(scores.rows[3]).toMatchObject({ char_score: 8, byte_score: 8 });
      if (query === '') expect(scores.rows.every(row => row.char_score === 0 && row.byte_score === 0 && row.optimized_score === 0)).toBe(true);
    }
  } finally { await client.end(); await f.close(); }
}, 120000);


it('터키어 ICU 기본 locale에서 실제 chunk와 tool 검색이 원형 순위를 보존한다', async () => {
  // Fixed application roles are isolated in a fixture-owned PostgreSQL cluster.
  const cluster = await createIsolatedTestDatabase();
  const name = `brain_tr_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(cluster.url); adminUrl.pathname = '/postgres';
  const localeUrl = new URL(cluster.url); localeUrl.pathname = `/${name}`;
  const appUrl = new URL(localeUrl); appUrl.username = 'brain_app'; appUrl.password = 'brain-test-app';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  let connected = false;
  let client: pg.Client | undefined;
  let store: ReturnType<typeof postgresStore> | undefined;
  try {
    await admin.connect(); connected = true;
    // template0 permits a database default ICU locale distinct from the cluster default.
    // No skip: unavailable ICU or database creation is a test failure.
    await admin.query(`create database "${name}" with template template0 encoding 'UTF8' locale_provider icu icu_locale 'tr-TR'`);
    const prepared = await prepareDatabase({ databaseUrl: localeUrl.toString(), appPassword: 'brain-test-app', maintenancePassword: 'brain-test-maintenance', databaseName: name });
    if (!prepared.ok) throw new Error(prepared.message);
    const migrated = await runMigrations({ databaseUrl: localeUrl.toString(), clock });
    if (!migrated.ok) throw new Error(JSON.stringify(migrated));
    client = new pg.Client({ connectionString: localeUrl.toString() });
    await client.connect();
    const locale = await client.query<{ default_lower: string; c_lower: string; encoding: string; provider: string; locale: string; scalar_gate: boolean }>(`
      select lower('I') as default_lower, lower('I' collate "C") as c_lower,
        current_setting('server_encoding') as encoding, datlocprovider as provider, datlocale as locale,
        (select current_setting('server_encoding') = 'UTF8' and lower('ABCDEFGHIJKLMNOPQRSTUVWXYZ') collate "C" = 'abcdefghijklmnopqrstuvwxyz') as scalar_gate
      from pg_database where datname = current_database()`);
    expect(locale.rows[0]).toMatchObject({ default_lower: 'ı', c_lower: 'i', encoding: 'UTF8', provider: 'i', locale: 'tr-TR', scalar_gate: false });
    expect(locale.rows[0]?.default_lower).not.toBe(locale.rows[0]?.c_lower);
    store = postgresStore({ databaseUrl: appUrl.toString() });
    const user = await store.ensureSelfUser(sampleSelfUserInput());
    if (!user.ok) throw new Error(user.message);
    const chunks = ['d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002'];
    const notes = ['e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002'];
    for (let i = 0; i < 2; i++) {
      const session = randomUUID(), chunk = chunks[i]!, note = notes[i]!, message = randomUUID();
      const created = await store.ensureSession(sampleEnsureSessionInput({ id: session, key: { harness: 'demo', harnessSessionId: `turkish-${i}` }, checkout: null }));
      if (!created.ok) throw new Error(created.message);
      const at = new Date(Date.UTC(2026, 0, i + 1));
      const body = i === 0 ? 'I I' : 'I';
      await client.query('insert into brain.chunks(id,session_id,index_config_id,from_at,to_at,part,body) values($1,$2,$3,$4,$4,0,$5)', [chunk, session, CONVERSATION_CHUNK_INDEX_CONFIG_ID, at, body]);
      await client.query("insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at) values($1,$2,'turkish','user','message',$3)", [message, session, at]);
      await client.query("insert into brain.tool_notes(id,session_id,harness_message_id,ordinal,tool,target,ok) values($1,$2,'turkish',0,'tool',$3,1)", [note, session, body]);
    }
    for (const kind of ['chunks', 'tools'] as const) {
      const result = await store.searchRecall({ kind, query: 'I', pattern: literalLikePattern('I'), limit: 2 });
      expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.message);
      const ids = result.rows.map(row => kind === 'chunks' ? row.chunk_id : row.tool_note_id);
      expect(ids).toEqual(kind === 'chunks' ? chunks : notes);
      expect(ids).toEqual(await oracle(client, kind, 'I', 2));
    }
  } finally {
    try { await store?.close(); } finally {
      try { await client?.end(); } finally {
        try { if (connected) await admin.query(`drop database if exists "${name}" with (force)`); } finally {
          try { await admin.end(); } finally { await cluster.drop(); }
        }
      }
    }
  }
}, 120000);

it('도구 후보 0, 1, 255, 256, 257, 300 경계에서 원형 순위와 상세 행을 보존한다', async () => {
  const f = await conversationFixture('batch fixture');
  const client = new pg.Client({ connectionString: f.db.url });
  try {
    await client.connect();
    const project = f.ids.next(), worktree = f.ids.next(), sibling = f.ids.next();
    const sessions = [f.ids.next(), f.ids.next()];
    for (let i=0; i<2; i++) {
      const created = await f.store.ensureSession(sampleEnsureSessionInput({ id:sessions[i]!, key:{harness:'demo',harnessSessionId:`batch-${i}`}, checkout:sampleCheckoutInput({projectId:project,worktreeId:i===0?worktree:sibling,worktreePath:`/fixture/batch-${i}`}) }));
      if (!created.ok) throw Error(created.message);
    }
    const records: {id:string; messageId:string|null; session:number; body:string; tool:string; time:string|null; score:number}[] = [];
    const idFor=(prefix:string,i:number)=>`${prefix}0000000-0000-4000-8000-${i.toString(16).padStart(12,'0')}`;
    for (const count of [0,1,255,256,257,300]) {
      while(records.length<count) {
        const i=records.length, session=i%2, id=idFor('a',i+1), messageId=i===3?null:idFor('b',i+1);
        const at=new Date(Date.UTC(2026,7,1+i%3));
        const identity=i<3?'shared':`identity-${i}`, raw=i===2?Buffer.from('shared\0'):null;
        const body=i===0?'batchkey batchkey':'batchkey';
        const rawBody=i===2?Buffer.from('batchkey\0'):null, rawTool=i===2?Buffer.from('tool\0raw'):null;
        if(messageId) await client.query("insert into brain.messages(id,session_id,harness_message_id,harness_message_id_raw,role,body,occurred_at) values($1,$2,$3,$4,'user','message',$5)",[messageId,sessions[session],identity,raw,at]);
        await client.query("insert into brain.tool_notes(id,session_id,harness_message_id,harness_message_id_raw,ordinal,tool,tool_raw,target,target_raw,ok) values($1,$2,$3,$4,0,'tool',$5,$6,$7,1)",[id,sessions[session],identity,raw,rawTool,body,rawBody]);
        records.push({id,messageId,session,body:rawBody?'batchkey\0':body,tool:rawTool?'tool\0raw':'tool',time:messageId?at.toISOString():null,score:i===0?2:1});
      }
      const ordered=[...records].sort((a,b)=>a.session-b.session || b.score-a.score || (b.time ?? '').localeCompare(a.time ?? '') || a.id.localeCompare(b.id));
      for(const limit of [...new Set([1,5,Math.max(1,count)])]) for(const query of ['b','ba','bat','batchkey']) {
        const result=await f.store.searchRecall({kind:'tools',query,pattern:literalLikePattern(query),limit,worktree,project});
        expect(result.ok).toBe(true); if(!result.ok) throw Error(result.message);
        const expected=ordered.slice(0,limit);
        expect(result.rows.map(row=>row.tool_note_id)).toEqual(expected.map(row=>row.id));
        expect(result.rows.map(row=>row.tool_note_id)).toEqual(await oracle(client,'tools',query,limit,worktree,project));
        expect(result.rows.map(row=>({id:row.tool_note_id,messageId:row.message_id,body:row.body,tool:row.tool,time:row.from_at}))).toEqual(expected.map(row=>({id:row.id,messageId:row.messageId,body:row.body,tool:row.tool,time:row.time})));
      }
      if(count>=255) expect(ordered.slice(0,3).map(row=>row.id)).toEqual([idFor('a',1),idFor('a',3),idFor('a',9)]);
    }
  } finally { await client.end(); await f.close(); }
}, 120000);

it.each(['가나', '가나다'])('비일치 대량 데이터와 256·257 일치 후보에서 %s Unicode 순위와 공개 상세를 보존한다', async (token) => {
  const f=await conversationFixture('independent batch contract');
  const client=new pg.Client({connectionString:f.db.url});
  try {
    await client.connect();
    const project=f.ids.next(), outsideProject=f.ids.next(), worktrees=[f.ids.next(),f.ids.next(),f.ids.next()];
    const metas: {id:string;workspace:string;harness:string;harnessSessionId:string;startedAt:string;tagSource:'cwd'|'ancestor'|'sibling';project:string;worktree:string}[]=[];
    for(let i=0;i<3;i++) {
      const id=f.ids.next(), workspace=f.ids.next(), harness=`contract${i}`, harnessSessionId=`unicode-${i}`;
      const startedAt=new Date(Date.UTC(2025,i,2,3,4,5)), tagSource=(['cwd','ancestor','sibling'] as const)[i]!;
      await client.query('insert into brain.workspaces(id,name) values($1,$2)',[workspace,`contract-workspace-${i}`]);
      const checkout=sampleCheckoutInput({projectId:i===2?outsideProject:project,worktreeId:worktrees[i]!,worktreePath:`/fixture/contract-${i}`,...(i===2?{remoteIdentity:'example.invalid/other/repo'}:{})});
      const created=await f.store.ensureSession(sampleEnsureSessionInput({id,key:{harness,harnessSessionId},startedAt,workspaceId:workspace,tagSource,checkout}));
      if(!created.ok) throw Error(created.message);
      metas.push({id,workspace,harness,harnessSessionId,startedAt:startedAt.toISOString(),tagSource,project:i===2?outsideProject:project,worktree:worktrees[i]!});
    }
    const special=[
      {session:0,body:`${token} ${token}`,time:'2026-01-01T00:00:00.000Z',tool:'old'},
      {session:0,body:token,time:'2026-04-01T00:00:00.000Z',tool:'new'},
      {session:1,body:token,time:'2026-03-01T00:00:00.000Z',tool:'sibling'},
      {session:2,body:`${token} ${token} ${token}`,time:'2026-05-01T00:00:00.000Z',tool:'outside'},
    ];
    const ids=special.map(()=>f.ids.next()), messages=special.map(()=>f.ids.next());
    for(const [i,row] of special.entries()) {
      await client.query("insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at) values($1,$2,$3,'user','message',$4)",[messages[i],metas[row.session]!.id,`special-${i}`,row.time]);
      await client.query("insert into brain.tool_notes(id,session_id,harness_message_id,ordinal,tool,target,ok) values($1,$2,$3,0,$4,$5,1)",[ids[i],metas[row.session]!.id,`special-${i}`,row.tool,row.body]);
    }
    // Nonmatching rows remain present in both checks; their count does not select the strategy.
    await client.query(`insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at)
      select md5('t38-unmatched-message-'||i)::uuid,$1,'unmatched-'||i,'user','message','2025-01-01'::timestamptz from generate_series(1,300) i`,[metas[2]!.id]);
    await client.query(`insert into brain.tool_notes(id,session_id,harness_message_id,ordinal,tool,target,ok)
      select md5('t38-unmatched-note-'||i)::uuid,$1,'unmatched-'||i,0,'unmatched','other 가',1 from generate_series(1,300) i`,[metas[2]!.id]);
    const addFiller=async(first:number,last:number)=>{
      await client.query(`insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at)
        select md5('t38-match-message-'||i)::uuid,$1,'filler-'||i,'user','message','2025-01-01'::timestamptz from generate_series($2::int,$3::int) i`,[metas[2]!.id,first,last]);
      await client.query(`insert into brain.tool_notes(id,session_id,harness_message_id,ordinal,tool,target,ok)
        select md5('t38-match-note-'||i)::uuid,$1,'filler-'||i,0,'filler',$4,1 from generate_series($2::int,$3::int) i`,[metas[2]!.id,first,last,token]);
    };
    await addFiller(1,252);
    const expected=(i:number)=>{
      const row=special[i]!, meta=metas[row.session]!;
      return {kind:'conversation',session:`${meta.harness}:${meta.harnessSessionId}`,harness:meta.harness,started_at:meta.startedAt,workspace_id:meta.workspace,tag_source:meta.tagSource,project_id:meta.project,worktree_id:meta.worktree,from_at:row.time,to_at:row.time,tool_note_id:ids[i],message_id:messages[i],tool:row.tool,body:row.body};
    };
    const uuid=(value:string)=>{const h=createHash('md5').update(value).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;};
    for(const boundary of [256,257]) {
      if(boundary===257) await addFiller(253,253);
      for(const scenario of [
        {worktree:worktrees[0],project,order:[0,1,2,3]},
        {worktree:undefined,project,order:[0,1,2,3]},
        {worktree:undefined,project:undefined,order:[3,0,1,2]},
      ]) for(const limit of [1,4,8]) {
        const result=await f.store.searchRecall({kind:'tools',query:token,pattern:literalLikePattern(token),limit,worktree:scenario.worktree,project:scenario.project});
        expect(result.ok).toBe(true); if(!result.ok) throw Error(result.message);
        expect(result.rows.map(row=>row.tool_note_id)).toEqual(await oracle(client,'tools',token,limit,scenario.worktree,scenario.project));
        const first=scenario.order.slice(0,Math.min(limit,4));
        expect(result.rows.slice(0,first.length)).toEqual(first.map(expected));
        const meta=metas[2]!;
        const filler=Array.from({length:boundary-4},(_,i)=>({kind:'conversation',session:`${meta.harness}:${meta.harnessSessionId}`,harness:meta.harness,started_at:meta.startedAt,workspace_id:meta.workspace,tag_source:meta.tagSource,project_id:meta.project,worktree_id:meta.worktree,from_at:'2025-01-01T00:00:00.000Z',to_at:'2025-01-01T00:00:00.000Z',tool_note_id:uuid(`t38-match-note-${i+1}`),message_id:uuid(`t38-match-message-${i+1}`),tool:'filler',body:token})).sort((a,b)=>a.tool_note_id.localeCompare(b.tool_note_id));
        expect(result.rows).toEqual([...scenario.order.map(expected),...filler].slice(0,limit));
        expect(result.rows.every(row=>!('chunk_id' in row))).toBe(true);
      }
    }
  } finally {await client.end();await f.close();}
},120000);

it('빈 검색은 캐시하지 않고 존재 확인과 최종 조회의 각 snapshot을 보존한다', async () => {
  const f = await conversationFixture('probe unrelated');
  const client = new pg.Client({ connectionString: f.db.url });
  const original = pg.Client.prototype.query;
  try {
    await client.connect();
    const chunk = f.ids.next(); let note = f.ids.next();
    const query = '찾기%_\\\0', pattern = literalLikePattern(query), body = '찾기%_\\�';
    const add = async (kind: 'chunks' | 'tools') => {
      if (kind === 'chunks') await client.query('insert into brain.chunks(id,session_id,index_config_id,from_at,to_at,part,body,body_raw) values($1,$2,$3,now(),now(),0,$4,$5)', [chunk, f.sessionId, CONVERSATION_CHUNK_INDEX_CONFIG_ID, body, Buffer.from('찾기%_\\\0')]);
      else await client.query("insert into brain.tool_notes(id,session_id,harness_message_id,ordinal,tool,target,target_raw,ok) values($1,$2,$3,0,'tool',$4,$5,1)", [note, f.sessionId, `probe-orphan-${note}`, body, Buffer.from('찾기%_\\\0')]);
    };
    const remove = async (kind: 'chunks' | 'tools') => {
      if (kind === 'chunks') { await client.query('delete from brain.chunks where id=$1', [chunk]); return; }
      // Tool notes are immutable except for owner redaction. Commit the real
      // target change before the store resumes, then use a fresh id next time.
      await client.query('begin');
      try {
        await client.query("set local brain.redacting='on'");
        await client.query("update brain.tool_notes set target='[redacted]', target_raw=null where id=$1", [note]);
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; }
      note = f.ids.next();
    };
    for (const kind of ['chunks', 'tools'] as const) {
      const search = (limit = 5) => f.store.searchRecall({kind, query, pattern, limit});
      expect(await search()).toEqual({ok:true, rows:[]});
      await add(kind);
      const present = await search(); expect(present.ok).toBe(true); if (!present.ok) throw Error(present.message);
      expect(present.rows.map(row => kind === 'chunks' ? row.chunk_id : row.tool_note_id)).toEqual(await oracle(client, kind, query, 5));
      expect(present.rows[0]?.body).toBe('찾기%_\\\0');
      if (kind === 'tools') expect(present.rows[0]?.message_id).toBeNull();
      await remove(kind);
      expect(await search()).toEqual({ok:true, rows:[]});
      expect(await search(0)).toEqual({ok:true, rows:[]});
      expect(await search(-1)).toMatchObject({ok:false, code:'SEARCH_FAILED'});
      for (const limit of [1.5, Number.NaN]) {
        let oracleFailed = false;
        try { await oracle(client, kind, query, limit); } catch { oracleFailed = true; }
        const result = await search(limit);
        if (oracleFailed) expect(result).toMatchObject({ok:false, code:'SEARCH_FAILED'});
        else expect(result).toEqual({ok:true, rows:[]});
      }

      // Interpose after the actual probe returns, before the store continues.
      // Mutations use a separate client; no fake search result or product hook.
      const between = async (change: () => Promise<void>) => {
        let fired = false;
        pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
          const result = Reflect.apply(original, this, args) as Promise<unknown>;
          // The store's first query is the probe; the separate mutation client
          // must never trigger this interposition itself.
          if (!fired && this !== client) {
            fired = true;
            return result.then(async value => { await change(); return value; });
          }
          return result;
        } as typeof pg.Client.prototype.query;
        try { const result = await search(); expect(fired).toBe(true); return result; }
        finally { pg.Client.prototype.query = original; }
      };
      // Negative probe sees absence; the insert after it must not leak into its result.
      expect(await between(() => add(kind))).toEqual({ok:true,rows:[]});
      // Positive probe sees presence; the later full query sees deletion or redaction.
      expect(await between(() => remove(kind))).toEqual({ok:true,rows:[]});
      expect(await search()).toEqual({ok:true,rows:[]});
    }
    // Matching only a different index configuration must still yield no chunks.
    const config = f.ids.next();
    await client.query(`insert into brain.index_configs(id,kind,model,dimensions,chunk_params) values($1,'chunk',null,null,'{"targetChars":1201,"overlapMessages":1,"splitMessagesOverChars":2400}'::jsonb)`, [config]);
    await client.query('insert into brain.chunks(id,session_id,index_config_id,from_at,to_at,part,body) values($1,$2,$3,now(),now(),0,$4)', [chunk,f.sessionId,config,body]);
    expect(await f.store.searchRecall({kind:'chunks',query,pattern,limit:5})).toEqual({ok:true,rows:[]});
    // A failed probe must follow the existing SEARCH_FAILED path, never empty.
    await client.query('drop table brain.tool_notes cascade');
    expect(await f.store.searchRecall({kind:'tools',query,pattern,limit:5})).toMatchObject({ok:false,code:'SEARCH_FAILED'});
  } finally { pg.Client.prototype.query = original; await client.end(); await f.close(); }
}, 120000);
