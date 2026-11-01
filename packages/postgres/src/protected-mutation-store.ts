import { createPool, type CreatePoolOptions } from './connect.js';
import type { PoolClient } from 'pg';

export type ProtectedMutation = ({ type: 'cancel'; id: string } | { type: 'hold'; group: string } | { type: 'disable'; extension: string }) & { at?: string };
export type ProtectedMutationResult = { type: 'cancel'; state: 'requested' } | { type: 'hold'; held: boolean } | { type: 'disable'; found: boolean; changed: boolean };
export interface ProtectedAttempt {
  work: string; token: string; run: number; state: 'pending' | 'spawning' | 'closed';
  lease: string | null; epoch: number | null; revoked: boolean;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function valid(action: ProtectedMutation): boolean {
  return (action.at === undefined || (Number.isFinite(Date.parse(action.at)) && new Date(action.at).toISOString()===action.at)) && (action.type === 'cancel' ? uuid.test(action.id) : action.type === 'hold' ? /^[a-z0-9:_.-]{1,128}$/.test(action.group) : /^[a-z][a-z0-9_]{0,30}$/.test(action.extension));
}
const query = `select w.id::text as work,w.current_attempt_token::text as token,w.attempts as run,l.state,
 a.protected_launch_lease::text as lease,a.protected_connection_epoch::text as epoch,
 exists(select 1 from brain.protected_auth_revocations r where r.work_id=w.id and r.attempt_token=w.current_attempt_token
 and r.run_generation=w.attempts and r.launch_lease=a.protected_launch_lease and r.connection_epoch=a.protected_connection_epoch) as revoked
 from brain.work_items w join brain.protected_work_kinds k on k.kind=w.kind and k.requires_input_revoke
 join brain.work_attempts a on a.token=w.current_attempt_token
 join brain.protected_input_launches l on l.work_id=w.id and l.attempt_token=a.token and l.run_generation=w.attempts
 where w.completed_at is null and (($1='cancel' and w.id::text=$2) or ($1='hold' and k.hold_group=$2) or ($1='disable' and k.extension_name=$2)) order by w.id`;
function argument(action: ProtectedMutation): string { return action.type === 'cancel' ? action.id : action.type === 'hold' ? action.group : action.extension; }
async function rows(client: PoolClient, action: ProtectedMutation): Promise<ProtectedAttempt[]> {
  const result = await client.query(query,[action.type,argument(action)]);
  return result.rows.map(row => {
    const run = Number(row.run), epoch = row.epoch === null ? null : Number(row.epoch);
    if (!uuid.test(row.work) || !uuid.test(row.token) || !Number.isSafeInteger(run) || run<=0 || !['pending','spawning','closed'].includes(row.state)
      || (row.lease !== null && !uuid.test(row.lease)) || (epoch !== null && (!Number.isSafeInteger(epoch) || epoch<=0)) || ((row.lease === null)!==(epoch === null)) || typeof row.revoked !== 'boolean') throw new Error('invalid protected identity');
    return {work:row.work,token:row.token,run,state:row.state,lease:row.lease,epoch,revoked:row.revoked};
  });
}
async function role(client: PoolClient): Promise<void> {
  const result=await client.query("select session_user='brain_protected_supervisor' as allowed");
  if (!result.rows[0]?.allowed) throw new Error('invalid role');
}
/** 보호 principal 전용 내부 adapter. 일반 API에 반환하지 않는다. */
export function postgresProtectedMutationStore(options: CreatePoolOptions) {
  const pool=createPool(options);
  return {
    async list(action: ProtectedMutation): Promise<ProtectedAttempt[] | null> {
      if(!valid(action))return null;const client=await pool.connect();
      try {await role(client);return await rows(client,action);} catch {return null;} finally {client.release();}
    },
    async commit(action: ProtectedMutation, expected: readonly ProtectedAttempt[], request: string): Promise<{ status: 'committed'; result: ProtectedMutationResult } | { status: 'changed' | 'unknown' }> {
      if(!valid(action) || !uuid.test(request))return {status:'unknown'};const client=await pool.connect();let committed=false;
      try {
        await client.query('begin');await client.query("set local statement_timeout='1900ms'");await client.query("set local lock_timeout='1500ms'");await client.query("set local transaction_timeout='1900ms'");await role(client);
        await client.query("select pg_advisory_xact_lock(hashtextextended('brain.protected.auth.revoke',0))");
        const current=await rows(client,action);
        if(JSON.stringify(current)!==JSON.stringify(expected)) {await client.query('rollback');return {status:'changed'};}
        if(action.type==='cancel' && current.length!==1) {await client.query('rollback');return {status:'changed'};}
        for(const item of current) {
          if(item.state==='pending') {
            const result=await client.query('select brain.close_unstarted_protected_input($1::uuid,$2::uuid,$3::bigint) as ok',[item.work,item.token,item.run]);if(result.rows[0]?.ok!==true)throw new Error('pending changed');
          } else if(item.state!=='closed' && !item.revoked) {
            if(!item.lease || !item.epoch)throw new Error('identity unknown');
            const result=await client.query('select brain.record_protected_auth_revoke($1::uuid,$2::uuid,$3::bigint,$4::bigint,$5::uuid) as ok',[item.work,item.token,item.run,item.epoch,item.lease]);if(result.rows[0]?.ok!==true)throw new Error('evidence changed');
          }
        }
        let outcome: ProtectedMutationResult;const at=action.at ?? new Date().toISOString();
        if(action.type==='cancel') {const result=await client.query('update brain.work_items set cancel_requested_at=coalesce(cancel_requested_at,$3::timestamptz) where id=$1::uuid and current_attempt_token=$2::uuid',[action.id,current[0]!.token,at]);if(result.rowCount!==1)throw new Error('attempt changed');outcome={type:'cancel',state:'requested'};}
        else if(action.type==='hold') {const result=await client.query('insert into brain.work_hold_groups(name,held_at) values ($1,$2::timestamptz) on conflict(name) do nothing',[action.group,at]);outcome={type:'hold',held:result.rowCount===1};}
        else {
          const existing=await client.query('select enabled from brain.extensions where name=$1 for update',[action.extension]);
          if(existing.rowCount===0)outcome={type:'disable',found:false,changed:false};
          else {await client.query('update brain.extensions set enabled=false,enabled_changed_at=case when enabled then $2::timestamptz else enabled_changed_at end where name=$1',[action.extension,at]);
            await client.query('insert into brain.work_hold_groups(name,held_at) values ($1,$2::timestamptz) on conflict(name) do nothing',[`extension:${action.extension}`,at]);outcome={type:'disable',found:true,changed:existing.rows[0].enabled===true};}
        }
        await client.query('insert into brain.protected_mutation_receipts(id,action,scope,result) values ($1::uuid,$2,$3,$4::jsonb)',[request,action.type,argument(action),JSON.stringify(outcome)]);
        await client.query('commit');committed=true;return {status:'committed',result:outcome};
      } catch {if(!committed)try {await client.query('rollback');} catch {} return {status:'unknown'};} finally {client.release();}
    },
    async applied(action: ProtectedMutation, expected: readonly ProtectedAttempt[], request: string): Promise<ProtectedMutationResult | null> {
      if(!valid(action) || !uuid.test(request))return null;const client=await pool.connect();
      try {
        await role(client);const current=await rows(client,action);
        if(current.length!==expected.length || current.some((item,i)=>item.work!==expected[i]?.work || item.token!==expected[i]?.token || item.run!==expected[i]?.run || item.lease!==expected[i]?.lease || item.epoch!==expected[i]?.epoch || !(item.state==='closed' || item.revoked)))return null;
        const result=await client.query('select result from brain.protected_mutation_receipts where id=$1::uuid and action=$2 and scope=$3',[request,action.type,argument(action)]);const value=result.rows[0]?.result;
        if(!value || value.type!==action.type)return null;
        if(value.type==='cancel' && value.state==='requested')return {type:'cancel',state:'requested'};
        if(value.type==='hold' && typeof value.held==='boolean')return {type:'hold',held:value.held};
        if(value.type==='disable' && typeof value.found==='boolean' && typeof value.changed==='boolean')return {type:'disable',found:value.found,changed:value.changed};
        return null;
      } catch {return null;} finally {client.release();}
    },
    async close(){await pool.end();},
  };
}
