"""영속 보호 전이. 호출자는 별도 admission과 현재 attempt 검증을 제공해야 한다.

이 모듈은 네트워크를 수행하지 않는다. 각 함수의 트랜잭션이 반환된 뒤에만
호출할 수 있으며 미완료 intent는 명시적 복구 계약이 생길 때까지 차단한다.
"""
from contextlib import contextmanager
from datetime import timedelta
from uuid import uuid4


class ProtectionError(Exception):
    pass


@contextmanager
def _tx(conn, validate):
    # 외부 I/O 동안 transaction을 잡지 않는다. 검증자는 같은 transaction에서
    # admission, 취소/hold 및 현재 attempt를 모두 확인해야 한다.
    if not conn.autocommit:
        raise ProtectionError('PROTECTION_AUTOCOMMIT_REQUIRED')
    with conn.transaction():
        conn.execute("set local transaction_timeout = '1900ms'")
        conn.execute("set local statement_timeout = '1900ms'")
        conn.execute("set local lock_timeout = '1900ms'")
        if validate(conn) is not True:
            raise ProtectionError('PROTECTION_INVALID_ATTEMPT')
        yield


def create_target(conn, target, validate):
    with _tx(conn, validate):
        conn.execute("select pg_advisory_xact_lock(hashtextextended('garmin.binding',0))")
        row = conn.execute('select protection_id, generation from garmin.account_binding where target=%s', (target,)).fetchone()
        if row:
            return row
        key = uuid4()
        conn.execute('insert into garmin.account_protection(id) values (%s)', (key,))
        conn.execute('insert into garmin.account_binding(target,protection_id) values (%s,%s)', (target,key))
        return key, 1


def bind_profile(conn, target, profile, expected_generation, validate):
    """합집합 병합 중 intent와 모든 alias를 보존하고 이전 profile 변경을 거부한다."""
    with _tx(conn, validate):
        conn.execute("select pg_advisory_xact_lock(hashtextextended('garmin.binding',0))")
        row = conn.execute('''select b.protection_id,b.generation,p.profile_id from garmin.account_binding b
            join garmin.account_protection p on p.id=b.protection_id where b.target=%s for update of b,p''', (target,)).fetchone()
        if not row or row[1] != expected_generation:
            raise ProtectionError('PROTECTION_BINDING_CHANGED')
        old, _, existing = row
        if existing is not None and existing != profile:
            raise ProtectionError('PROTECTION_IDENTITY_MISMATCH')
        dest = conn.execute('select id from garmin.account_protection where profile_id=%s for update', (profile,)).fetchone()
        if not dest:
            conn.execute('update garmin.account_protection set profile_id=%s,version=version+1 where id=%s', (profile,old))
            conn.execute('update garmin.account_binding set generation=generation+1 where protection_id=%s', (old,))
            return old
        dest = dest[0]
        if dest == old:
            return old
        # 예약 이력이 겹치면 안전하게 중단한다. 자동으로 probe 권한을 만들지 않는다.
        if conn.execute('''select exists(select 1 from garmin.probe_reservation a join garmin.probe_reservation b
            on a.day=b.day where a.protection_id=%s and b.protection_id=%s)''', (old,dest)).fetchone()[0]:
            raise ProtectionError('PROTECTION_ALIAS_CONFLICT')
        conn.execute('''update garmin.account_protection d set
            auth_required=d.auth_required or s.auth_required,
            rate_day=case when d.rate_day is null then s.rate_day when s.rate_day is null then d.rate_day else greatest(d.rate_day,s.rate_day) end,
            manual_required=d.manual_required or s.manual_required, uncertain=d.uncertain or s.uncertain,
            consecutive_403=greatest(d.consecutive_403,s.consecutive_403),
            rate_generation=greatest(d.rate_generation,s.rate_generation)+1,
            last_request_day=case when s.last_finished_at > d.last_finished_at or d.last_finished_at is null then s.last_request_day else d.last_request_day end,
            last_finished_at=greatest(d.last_finished_at,s.last_finished_at),version=d.version+1
            from garmin.account_protection s where d.id=%s and s.id=%s''', (dest,old))
        conn.execute('update garmin.tokenstore_identity set protection_id=%s where protection_id=%s', (dest,old))
        conn.execute('update garmin.external_call_intent set protection_id=%s where protection_id=%s', (dest,old))
        conn.execute('update garmin.probe_reservation set protection_id=%s where protection_id=%s', (dest,old))
        conn.execute('update garmin.account_binding set protection_id=%s,generation=generation+1 where protection_id=%s', (dest,old))
        conn.execute('update garmin.account_binding set generation=generation+1 where protection_id=%s and target<>%s', (dest,target))
        conn.execute('delete from garmin.account_protection where id=%s', (old,))
        return dest


def begin_call(conn, target, generation, work_id, attempt_token, run_generation, stage, endpoint, clock, validate, request_day=None, first_call=False):
    now = clock()
    if now.tzinfo is None or stage not in ('auth','data','probe') or not endpoint:
        raise ProtectionError('PROTECTION_INVALID_INPUT')
    with _tx(conn, validate):
        row = conn.execute('''select p.id,p.auth_required,p.rate_day,p.manual_required,p.uncertain,
            p.rate_generation,b.generation,p.profile_id,p.last_finished_at,p.last_request_day from garmin.account_binding b
            join garmin.account_protection p on p.id=b.protection_id where b.target=%s for update of b,p''', (target,)).fetchone()
        if not row or row[6] != generation:
            raise ProtectionError('PROTECTION_BINDING_CHANGED')
        key, auth, rate_day, manual, uncertain, rate_generation, _, profile, last_finished, last_day = row
        if uncertain or conn.execute('select exists(select 1 from garmin.external_call_intent where protection_id=%s and outcome is null)', (key,)).fetchone()[0]:
            raise ProtectionError('PROTECTION_UNCERTAIN')
        if stage == 'auth' and conn.execute('''select exists(select 1 from garmin.external_call_intent
            where protection_id=%s and attempt_token=%s and stage='auth' and outcome in ('403','auth_required'))''', (key,attempt_token)).fetchone()[0]:
            raise ProtectionError('PROTECTION_BLOCKED')
        if manual or (auth and (stage != 'auth' or profile is None)):
            raise ProtectionError('PROTECTION_BLOCKED')
        if rate_day is not None and (stage != 'probe' or auth or now.date() <= rate_day):
            raise ProtectionError('PROTECTION_BLOCKED')
        if stage == 'probe' and rate_day is None:
            raise ProtectionError('PROTECTION_INVALID_PROBE')
        # 미확인 target은 다른 보호 대상이 있으면 discovery조차 금지한다.
        if profile is None and conn.execute('''select exists(select 1 from garmin.account_protection p
            where p.id<>%s and (p.auth_required or p.rate_day is not null or p.manual_required or p.uncertain
            or exists(select 1 from garmin.external_call_intent i where i.protection_id=p.id and i.outcome is null)))''', (key,)).fetchone()[0]:
            raise ProtectionError('PROTECTION_DISCOVERY_BLOCKED')
        if last_finished is not None:
            minimum = 5 if request_day is not None and last_day is not None and request_day != last_day else 1
            if now < last_finished + timedelta(seconds=minimum):
                raise ProtectionError('PROTECTION_PACING')
        if first_call:
            slot = conn.execute('''insert into garmin.first_call_budget(work_id,endpoint,used) values (%s,%s,1)
                on conflict (work_id,endpoint) do update set used=garmin.first_call_budget.used+1
                where garmin.first_call_budget.used<3 returning used''', (work_id,endpoint)).fetchone()
            if not slot:
                raise ProtectionError('PROTECTION_FIRST_CALL_LIMIT')
        intent = uuid4()
        conn.execute('''insert into garmin.external_call_intent(id,protection_id,work_id,attempt_token,run_generation,binding_generation,stage,endpoint,started_at,request_day,first_call)
            values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''', (intent,key,work_id,attempt_token,run_generation,generation,stage,endpoint,now,request_day,first_call))
        if stage == 'probe':
            inserted = conn.execute('''insert into garmin.probe_reservation values (%s,%s,%s,%s)
                on conflict do nothing returning intent_id''', (key,now.date(),rate_generation,intent)).fetchone()
            if not inserted:
                raise ProtectionError('PROTECTION_PROBE_RESERVED')
        return intent


def finish_call(conn, intent, outcome, clock, validate):
    if outcome not in ('success','403','429','auth_required','other'):
        raise ProtectionError('PROTECTION_INVALID_OUTCOME')
    with _tx(conn, validate):
        row = conn.execute('''select i.protection_id,i.stage,i.outcome,p.rate_generation,r.rate_generation,i.request_day,i.started_at,i.first_call
            from garmin.external_call_intent i join garmin.account_protection p on p.id=i.protection_id
            left join garmin.probe_reservation r on r.intent_id=i.id where i.id=%s for update of i,p''', (intent,)).fetchone()
        if not row or row[2] is not None:
            raise ProtectionError('PROTECTION_INVALID_INTENT')
        key, stage, _, rate_generation, reserved_generation, request_day, started_at, first_call = row
        now = clock()
        if now.tzinfo is None or now < started_at:
            raise ProtectionError('PROTECTION_CLOCK_UNCERTAIN')
        if stage == 'probe' and rate_generation != reserved_generation:
            raise ProtectionError('PROTECTION_RATE_CHANGED')
        conn.execute('update garmin.external_call_intent set outcome=%s,finished_at=%s where id=%s', (outcome,now,intent))
        conn.execute('''update garmin.account_protection set
            auth_required=auth_required or %s,
            consecutive_403=case when %s='403' and %s='data' and not %s then consecutive_403+1 when %s='success' and %s='data' and not %s then 0 else consecutive_403 end,
            rate_day=case when %s='probe' and %s='success' then null
                when %s='429' or (%s='403' and %s='data' and (%s or consecutive_403+1>=3)) then %s else rate_day end,
            manual_required=manual_required or (%s='probe' and %s in ('403','429')) or (%s and %s='403'),
            rate_generation=rate_generation+case when %s='429' or (%s='403' and %s='data' and (%s or consecutive_403+1>=3)) then 1 else 0 end,
            last_finished_at=%s,last_request_day=coalesce(%s,last_request_day),
            version=version+1 where id=%s''',
            (outcome=='auth_required' or (stage=='auth' and outcome=='403'),outcome,stage,first_call,outcome,stage,first_call,stage,outcome,outcome,outcome,stage,first_call,now.date(),stage,outcome,first_call,outcome,outcome,outcome,stage,first_call,now,request_day,key))


def release_block(conn, target, validate):
    with _tx(conn, validate):
        conn.execute('''update garmin.account_protection set rate_day=null,manual_required=false,consecutive_403=0,
            rate_generation=rate_generation+1,version=version+1 where id=(select protection_id from garmin.account_binding where target=%s)''', (target,))


def supervised_validator(work_id, attempt_token, run_generation, target, binding_generation):
    """감독자 소유 admission과 현재 시도·취소·hold를 같은 transaction에서 검사한다."""
    def validate(conn):
        return conn.execute('select garmin.admission_valid(%s,%s,%s,%s,%s)',
                            (work_id,attempt_token,run_generation,target,binding_generation)).fetchone()[0] is True
    return validate


def register_target_identity(conn, target, identity, validate):
    """검증된 디렉터리 identity를 binding한다. 검증 실패 시 기존 보호를 바꾸지 않는다.

    validator는 감독자가 보유한 admission 및 현재 작업을 검사해야 한다. 경로
    검사와 실제 library open 사이 같은 UID 교체는 별도 OS 격리가 필요하다.
    """
    if not target or not identity.path or identity.device < 0 or identity.inode <= 0 or identity.owner < 0:
        raise ProtectionError('PROTECTION_IDENTITY_UNVERIFIED')
    with _tx(conn, validate):
        conn.execute("select pg_advisory_xact_lock(hashtextextended('garmin.binding',0))")
        existing = conn.execute('''select b.identity_id,i.device,i.inode,i.owner_uid,i.canonical_path,b.protection_id,b.generation
            from garmin.account_binding b left join garmin.tokenstore_identity i on i.id=b.identity_id
            where b.target=%s for update of b''', (target,)).fetchone()
        if existing:
            if existing[0] is None or tuple(existing[1:5]) != (identity.device,identity.inode,identity.owner,identity.path):
                raise ProtectionError('PROTECTION_IDENTITY_MISMATCH')
            return existing[5], existing[6]
        found = conn.execute('''select id,owner_uid,canonical_path,protection_id from garmin.tokenstore_identity
            where device=%s and inode=%s for update''', (identity.device,identity.inode)).fetchone()
        if found:
            if (found[1],found[2]) != (identity.owner,identity.path):
                raise ProtectionError('PROTECTION_IDENTITY_MISMATCH')
            identity_id, _, _, protection = found
        else:
            identity_id, protection = uuid4(), uuid4()
            conn.execute('insert into garmin.account_protection(id) values (%s)', (protection,))
            conn.execute('''insert into garmin.tokenstore_identity(id,device,inode,owner_uid,canonical_path,protection_id)
                values (%s,%s,%s,%s,%s,%s)''', (identity_id,identity.device,identity.inode,identity.owner,identity.path,protection))
        conn.execute('insert into garmin.account_binding(target,identity_id,protection_id) values (%s,%s,%s)', (target,identity_id,protection))
        return protection, 1
