import { createHash } from 'node:crypto';
import { CONVERSATION_CHUNK_INDEX_CONFIG_ID, conversationFingerprintJson, type ChunkParams, type ConversationIndexStore } from '@second-brain/core';
import { sql, type Kysely } from 'kysely';
import { databaseFailure, type PgConnect, type PgSchema } from './connect.js';
import { originalText, pgText } from './text.js';
class ExpiredClaim extends Error {}

const configId = CONVERSATION_CHUNK_INDEX_CONFIG_ID;
async function snapshot(db: Kysely<PgSchema>, sessionId: string) {
  const config = (await sql<{ chunk_params: ChunkParams }>`select chunk_params from brain.index_configs where id = ${configId}::uuid and kind='chunk'`.execute(db)).rows[0];
  if (!config) throw new Error('대화 조각 설정이 없습니다');
  const rules = config.chunk_params.rules;
  if (!rules || rules.version !== 1 || rules.order !== 'occurred_at,id' || rules.units !== 'code_points' || rules.separator !== 'newline' || rules.boundary !== 'include_timestamp_group_at_target' || rules.split !== 'split_limit' || rules.parts !== 'range_0_or_1_to_n') throw new Error('지원하지 않는 대화 조각 규칙');
  const messages = (await sql<{ id: string; occurred_at: string; body: string; body_raw: Buffer | null }>`select id, occurred_at, body, body_raw from brain.messages where session_id=${sessionId}::uuid order by occurred_at,id`.execute(db)).rows.map(originalText).map(m => ({ id: m.id, occurredAt: new Date(m.occurred_at), body: m.body }));
  const hash = createHash('sha256');
  for (const token of conversationFingerprintJson(config.chunk_params, messages)) hash.update(token, 'utf8');
  return { config: config.chunk_params, messages, fingerprint: `sha256:${hash.digest('hex')}` };
}
export function postgresConversationIndexStore(connect: PgConnect): ConversationIndexStore {
  return {
    async readConversationSnapshot(sessionId) {
      const opened = connect(); if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await opened.connection.db.transaction().execute(async held => {
          await sql`set transaction isolation level repeatable read read only`.execute(held);
          const session = (await sql`select id from brain.sessions where id=${sessionId}::uuid`.execute(held)).rows[0];
          return session ? snapshot(held, sessionId) : null;
        });
        return { ok: true, snapshot: result };
      } catch (error) { return databaseFailure(error); }
    },
    async commitConversationChunks(input) {
      const started = performance.now();
      const opened = connect(); if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const session = (await sql<{ harness: string; harness_session_id: string }>`select harness,harness_session_id from brain.sessions where id=${input.sessionId}::uuid`.execute(opened.connection.db)).rows[0];
        if (!session) return { ok: true, committed: false };
        const result = await opened.connection.db.transaction().execute(async held => {
          await sql`select pg_advisory_xact_lock(hashtextextended(${`${session.harness}:${session.harness_session_id}`}, 0))`.execute(held);
          const claim = (await sql<{ claim_expires_at: string }>`select claim_expires_at from brain.work_items where id=${input.workId}::uuid and kind='conversation_chunk' and target_kind='session' and target_id=${input.sessionId} and claimed_by=${input.claimedBy} and completed_at is null for update`.execute(held)).rows[0];
          const elapsed = performance.now() - started;
          if (!claim || new Date(claim.claim_expires_at).getTime() <= input.now.getTime() + elapsed || (await snapshot(held, input.sessionId)).fingerprint !== input.fingerprint) return false;
          const old = (await sql<{ id: string; from_at: string; to_at: string; part: number; body: string; body_raw: Buffer | null }>`select id, from_at,to_at,part,body,body_raw from brain.chunks where session_id=${input.sessionId}::uuid and index_config_id=${configId}::uuid`.execute(held)).rows.map(originalText);
          const wanted = new Set<string>();
          for (const chunk of input.chunks) {
            const from = chunk.fromAt.toISOString(), to = chunk.toAt.toISOString();
            const match = old.find(c => c.from_at === from && c.to_at === to && c.part === chunk.part && c.body === chunk.body);
            if (match) { wanted.add(match.id); continue; }
            const previous = old.find(c => c.from_at === from && c.to_at === to && c.part === chunk.part);
            if (previous) await sql`delete from brain.chunks where id=${previous.id}::uuid`.execute(held);
            const body = pgText(chunk.body);
            await sql`insert into brain.chunks(id,session_id,index_config_id,from_at,to_at,part,body,body_raw) values (${chunk.id}::uuid,${input.sessionId}::uuid,${configId}::uuid,${from}::timestamptz,${to}::timestamptz,${chunk.part},${body.text},${body.raw})`.execute(held);
            wanted.add(chunk.id);
          }
          for (const chunk of old) if (!wanted.has(chunk.id)) await sql`delete from brain.chunks where id=${chunk.id}::uuid`.execute(held);
          if (new Date(claim.claim_expires_at).getTime() <= input.now.getTime() + performance.now() - started) throw new ExpiredClaim();
          return true;
        });
        return { ok: true, committed: result };
      } catch (error) { return error instanceof ExpiredClaim ? { ok: true, committed: false } : databaseFailure(error); }
    },
    async searchConversationChunks(input) {
      const opened = connect(); if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const rows = (await sql<{ id: string; session_id: string; from_at: string; to_at: string; part: number; body: string; body_raw: Buffer | null }>`select id,session_id,from_at,to_at,part,body,body_raw from brain.chunks where lower(body) like lower(${pgText(input.pattern).text}) escape '\\' order by id`.execute(opened.connection.db)).rows.map(originalText);
        return { ok: true, chunks: rows.map(r => ({ id: r.id, sessionId: r.session_id, fromAt: new Date(r.from_at), toAt: new Date(r.to_at), part: r.part, body: r.body })) };
      } catch (error) { return databaseFailure(error); }
    },
  };
}
