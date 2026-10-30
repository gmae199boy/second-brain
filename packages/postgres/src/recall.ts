import { CONVERSATION_CHUNK_INDEX_CONFIG_ID, formatSessionToken, type RecallStore } from '@second-brain/core';
import { sql } from 'kysely';
import { describe, type PgConnect } from './connect.js';
import { originalText, pgText } from './text.js';

export function postgresRecallStore(connect: PgConnect): RecallStore {
  return { async searchRecall(input) {
    const opened = connect();
    if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
    try {
      const source = input.kind === 'chunks'
        ? sql`select c.id as chunk_id, null::uuid as tool_note_id, null::uuid as message_id, null::text as tool, null::bytea as tool_raw, c.body, c.body_raw, c.from_at, c.to_at, c.session_id from brain.chunks c where c.index_config_id=${CONVERSATION_CHUNK_INDEX_CONFIG_ID}::uuid and lower(c.body) like lower(${pgText(input.pattern).text}) escape '\\'`
        : sql`select null::uuid as chunk_id, n.id as tool_note_id, m.id as message_id, n.tool, n.tool_raw, n.target as body, n.target_raw as body_raw, m.occurred_at as from_at, m.occurred_at as to_at, n.session_id from brain.tool_notes n left join brain.messages m on m.session_id=n.session_id and m.harness_message_id=n.harness_message_id and m.harness_message_id_raw is not distinct from n.harness_message_id_raw where lower(n.target) like lower(${pgText(input.pattern).text}) escape '\\'`;
      // [ASSUMPTION] 근접 단계 다음 리터럴 일치 횟수, 시각 내림차순, id 순이다.
      const rows = await sql<{ chunk_id: string | null; tool_note_id: string | null; message_id: string | null; tool: string | null; tool_raw: Buffer | null; body: string; body_raw: Buffer | null; from_at: string | null; to_at: string | null; harness: string; harness_session_id: string; started_at: string; workspace_id: string | null; tag_source: string | null; project_id: string | null; worktree_id: string | null }>`select x.*, s.harness, s.harness_session_id, s.started_at, s.workspace_id, s.tag_source, s.project_id, s.worktree_id from (${source}) x join brain.sessions s on s.id=x.session_id order by case when ${input.worktree ?? null}::text is not null and s.worktree_id::text=${input.worktree ?? null} then 0 when ${input.project ?? null}::text is not null and s.project_id::text=${input.project ?? null} then 1 else 2 end, (length(lower(x.body))-length(replace(lower(x.body),lower(${pgText(input.query).text}),''))) desc, x.from_at desc nulls last, coalesce(x.chunk_id,x.tool_note_id) asc limit ${input.limit}`.execute(opened.connection.db);
      return { ok: true, rows: rows.rows.map(originalText).map(r => ({ kind: 'conversation' as const, session: formatSessionToken({ harness: r.harness, harnessSessionId: r.harness_session_id }), harness: r.harness, started_at: new Date(r.started_at).toISOString(), workspace_id: r.workspace_id, tag_source: r.tag_source, project_id: r.project_id, worktree_id: r.worktree_id, from_at: r.from_at === null ? null : new Date(r.from_at).toISOString(), to_at: r.to_at === null ? null : new Date(r.to_at).toISOString(), ...(r.chunk_id ? { chunk_id: r.chunk_id } : { tool_note_id: r.tool_note_id!, message_id: r.message_id, tool: r.tool ?? '' }), body: r.body })) };
    } catch (error) {
      const code = (error as { code?: string }).code;
      return { ok: false, code: code?.startsWith('08') || code?.startsWith('28') || ['3D000', '57P01', '57P02', '57P03', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(code ?? '') || (code === undefined && error instanceof Error && ['timeout exceeded when trying to connect', 'Connection terminated due to connection timeout', 'Connection terminated unexpectedly', 'Connection terminated'].includes(error.message)) ? 'DB_UNAVAILABLE' : 'SEARCH_FAILED', message: describe(error) };
    }
  } };
}
