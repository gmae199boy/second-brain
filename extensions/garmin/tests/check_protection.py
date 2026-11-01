"""명시된 격리 fixture DB만 사용하여 보호 전이를 검사한다."""
from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
from pathlib import Path
import sys
import os
import signal
import tempfile
from uuid import uuid4
import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from protection import ProtectionError, create_target, bind_profile, begin_call, finish_call, release_block, supervised_validator, register_target_identity
from http_guard import GuardedTransport
from tokenstore_check import check_tokenstore, TokenstoreIdentity

if len(sys.argv) != 2 or not sys.argv[1].isdigit():
    raise SystemExit('격리 fixture 포트가 필요합니다')
conn = psycopg.connect(host='127.0.0.1', port=int(sys.argv[1]), dbname='brain_protection_fixture',
                       user='postgres', password='fixture', autocommit=True)
assert conn.execute('select current_database()').fetchone()[0] == 'brain_protection_fixture'
assert not conn.execute("select exists(select 1 from pg_namespace where nspname='garmin')").fetchone()[0]
conn.execute('create role brain_app')
conn.execute('create role brain_ext_garmin')
conn.execute('create schema brain')
conn.execute('create table brain.work_items(id uuid primary key,kind text,attempts bigint,cancel_requested_at timestamptz,hold_group text)')
conn.execute('create table brain.work_hold_groups(name text primary key)')
conn.execute('create function brain.attempt_is_current(uuid,uuid) returns boolean language sql as $$ select true $$')
conn.execute('create schema garmin')
conn.execute('grant usage on schema garmin to brain_app,brain_ext_garmin')
conn.execute((Path(__file__).resolve().parents[1] / 'migrations/0007_account_protection.sql').read_text())
now = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)
def clock(): return now
def valid(_): return True
# fake clock 전용 fixture: production admission은 DB clock과 보안 함수를 사용한다.
class ProtectionAdmission:
    def __init__(self,conn,target,generation,work,token,run,clock,validate):
        self.conn,self.target,self.generation,self.work,self.token,self.run,self.clock,self.validate=conn,target,generation,work,token,run,clock,validate
    def begin(self,stage,endpoint):
        return begin_call(self.conn,self.target,self.generation,self.work,self.token,self.run,stage,endpoint,self.clock,self.validate)
    def finish(self,intent,outcome): return finish_call(self.conn,intent,outcome,self.clock,self.validate)
def rejected(fn, code):
    try: fn()
    except ProtectionError as exc: assert str(exc) == code, str(exc)
    else: raise AssertionError(code)
def start(target, generation, stage='data'):
    global now
    now += timedelta(seconds=5)
    return begin_call(conn,target,generation,uuid4(),uuid4(),1,stage,'summary',clock,valid)
def state(target):
    return conn.execute('''select p.auth_required,p.rate_day,p.manual_required,p.uncertain,p.consecutive_403
        from garmin.account_binding b join garmin.account_protection p on p.id=b.protection_id where b.target=%s''', (target,)).fetchone()

with tempfile.TemporaryDirectory(dir=os.path.realpath(tempfile.gettempdir())) as parent:
    directory = Path(parent) / 'tokens'
    directory.mkdir(mode=0o700)
    observed = check_tokenstore(str(directory))
    protected, _ = register_target_identity(conn,'path-a',observed,valid)
    conn.execute('update garmin.account_protection set auth_required=true where id=%s',(protected,))
    alias, _ = register_target_identity(conn,'path-b',check_tokenstore(str(directory)),valid)
    assert alias == protected and state('path-b')[0]
    directory.rename(Path(parent) / 'old')
    directory.mkdir(mode=0o700)
    replacement = check_tokenstore(str(directory))
    assert replacement.inode != observed.inode
    rejected(lambda: register_target_identity(conn,'path-a',replacement,valid), 'PROTECTION_IDENTITY_MISMATCH')
    assert state('path-a')[0] and state('path-b')[0]
    conn.execute('update garmin.account_protection set auth_required=false where id=%s',(protected,))
_, gen = create_target(conn,'a',valid)
bind_profile(conn,'a','profile-a',gen,valid)
gen += 1
# discovery holder를 보호된 canonical 계정으로 원자 이전한다.
_, discover_gen = register_target_identity(conn,'discover',TokenstoreIdentity('/fixture/discover',991,992,os.getuid()),valid)
discover_work, discover_token = uuid4(), uuid4()
conn.execute("insert into brain.work_items values (%s,'garmin.auth',1,null,null)",(discover_work,))
conn.execute('set session authorization brain_app')
assert conn.execute("select garmin.reserve_admission(%s,%s,1,'discover',%s)",(discover_work,discover_token,discover_gen)).fetchone()[0]
conn.execute('reset session authorization')
conn.execute("update garmin.account_protection set auth_required=true,rate_day=%s where profile_id='profile-a'",(now.date(),))
conn.execute('set session authorization brain_ext_garmin')
new_gen = conn.execute("select garmin.bind_admitted_profile(%s,%s,1,'discover',%s,'profile-a')",(discover_work,discover_token,discover_gen)).fetchone()[0]
assert new_gen and conn.execute("select garmin.admission_valid(%s,%s,1,'discover',%s)",(discover_work,discover_token,new_gen)).fetchone()[0]
assert not conn.execute("select garmin.admission_valid(%s,%s,1,'discover',%s)",(discover_work,discover_token,discover_gen)).fetchone()[0]
conn.execute('reset session authorization')
assert state('discover')[0:2] == (True,now.date())
assert conn.execute("select i.protection_id=b.protection_id from garmin.account_binding b join garmin.tokenstore_identity i on i.id=b.identity_id where b.target='discover'").fetchone()[0]
assert conn.execute("select discovery_exclusive from garmin.admission_holder where work_id=%s",(discover_work,)).fetchone()[0] is False
# 격리 fixture의 합성 종료/정리로 이후 사례를 독립시킨다.
conn.execute('delete from garmin.admission_holder where work_id=%s',(discover_work,))
conn.execute("update garmin.account_protection set auth_required=false,rate_day=null where profile_id='profile-a'")
gen = conn.execute("select generation from garmin.account_binding where target='a'").fetchone()[0]
# 완료 시각은 DB에 남아 재실행에서도 간격을 지킨다.
first = begin_call(conn,'a',gen,uuid4(),uuid4(),1,'data','summary',clock,valid,now.date())
finish_call(conn,first,'success',clock,valid)
rejected(lambda: begin_call(conn,'a',gen,uuid4(),uuid4(),1,'data','summary',clock,valid,now.date()), 'PROTECTION_PACING')
now -= timedelta(seconds=10)
rejected(lambda: begin_call(conn,'a',gen,uuid4(),uuid4(),1,'data','summary',clock,valid,now.date()), 'PROTECTION_PACING')
now += timedelta(seconds=11)
rejected(lambda: begin_call(conn,'a',gen,uuid4(),uuid4(),1,'data','summary',clock,valid,now.date()+timedelta(days=1)), 'PROTECTION_PACING')
now += timedelta(seconds=4)

# 다른 연결에서 intent가 이미 보인 뒤에만 합성 전송이 수행된다.
_, budget_gen = create_target(conn,'budget',valid)
bind_profile(conn,'budget','profile-budget',budget_gen,valid)
budget_gen += 1
budget_work = uuid4()
for _ in range(3):
    intent = begin_call(conn,'budget',budget_gen,budget_work,uuid4(),1,'data','summary',clock,valid,first_call=True)
    finish_call(conn,intent,'success',clock,valid)
    now += timedelta(seconds=5)
rejected(lambda: begin_call(conn,'budget',budget_gen,budget_work,uuid4(),2,'data','summary',clock,valid,first_call=True), 'PROTECTION_FIRST_CALL_LIMIT')
first_denial = begin_call(conn,'budget',budget_gen,budget_work,uuid4(),2,'data','other',clock,valid,first_call=True)
finish_call(conn,first_denial,'403',clock,valid)
assert state('budget')[2] and state('budget')[4] == 0
release_block(conn,'budget',valid)
_, unverified_gen = create_target(conn,'unverified',valid)
bind_profile(conn,'unverified','profile-unverified',unverified_gen,valid)
unverified_gen += 1
conn.execute("update garmin.account_protection set rate_day=%s where profile_id='profile-unverified'",(now.date()-timedelta(days=1),))
class UnverifiedResponse: status_code=200
unverified=ProtectionAdmission(conn,'unverified',unverified_gen,uuid4(),uuid4(),1,clock,valid)
GuardedTransport(unverified,lambda _:UnverifiedResponse()).send('probe','summary',None)
assert state('unverified')[1] is not None
now += timedelta(seconds=5)
rejected(lambda: begin_call(conn,'unverified',unverified_gen,uuid4(),uuid4(),2,'probe','summary',clock,valid), 'PROTECTION_PROBE_RESERVED')
release_block(conn,'unverified',valid)
_, seam_gen = create_target(conn,'seam',valid)
bind_profile(conn,'seam','profile-seam',seam_gen,valid)
seam_gen += 1
class Response: status_code = 429
def fake_send(_):
    with psycopg.connect(host='127.0.0.1',port=int(sys.argv[1]),dbname='brain_protection_fixture',user='postgres',password='fixture',autocommit=True) as observer:
        assert observer.execute('''select count(*) from garmin.external_call_intent i join garmin.account_binding b
            on b.protection_id=i.protection_id where b.target='seam' and i.outcome is null''').fetchone()[0] == 1
    return Response()
admission = ProtectionAdmission(conn,'seam',seam_gen,uuid4(),uuid4(),1,clock,valid)
assert GuardedTransport(admission,fake_send).send('data','summary',None).status_code == 429
assert state('seam')[1] == now.date()
release_block(conn,'seam',valid)
_, auth_gen = create_target(conn,'authguard',valid)
bind_profile(conn,'authguard','profile-authguard',auth_gen,valid)
auth_gen += 1
auth_work, auth_token = uuid4(),uuid4()
auth_denial = begin_call(conn,'authguard',auth_gen,auth_work,auth_token,1,'auth','login',clock,valid)
finish_call(conn,auth_denial,'403',clock,valid)
now += timedelta(seconds=5)
rejected(lambda: begin_call(conn,'authguard',auth_gen,auth_work,auth_token,1,'auth','login',clock,valid),'PROTECTION_BLOCKED')
assert state('authguard')[0]
# 별도 승인된 합성 auth attempt는 기존 binding에만 허용된다.
reauth = begin_call(conn,'authguard',auth_gen,uuid4(),uuid4(),2,'auth','login',clock,valid)
finish_call(conn,reauth,'success',clock,valid)
assert state('authguard')[0]
conn.execute("update garmin.account_protection set auth_required=false where profile_id='profile-authguard'")
_, bgen = create_target(conn,'b',valid)
finish_call(conn,start('b',bgen),'429',clock,valid)
# 실제 자식은 intent commit 뒤에만 전송 구간에 도달한다. SIGKILL 후에도
# pending이 남고 재연결한 새 실행이 외부 호출에 진입하지 못해야 한다.
_, lost_gen = create_target(conn,'lost',valid)
bind_profile(conn,'lost','profile-lost',lost_gen,valid)
lost_gen += 1
_, clock_gen = create_target(conn,'clock',valid)
bind_profile(conn,'clock','profile-clock',clock_gen,valid)
clock_gen += 1
_, crash_gen = create_target(conn,'crash',valid)
bind_profile(conn,'crash','profile-crash',crash_gen,valid)
crash_gen += 1
read_fd, write_fd = os.pipe()
pid = os.fork()
if pid == 0:
    os.close(read_fd)
    child = psycopg.connect(host='127.0.0.1',port=int(sys.argv[1]),dbname='brain_protection_fixture',user='postgres',password='fixture',autocommit=True)
    begin_call(child,'crash',crash_gen,uuid4(),uuid4(),1,'data','summary',clock,valid)
    os.write(write_fd,b'committed')
    signal.pause()
    os._exit(0)
os.close(write_fd)
assert os.read(read_fd,9) == b'committed'
os.close(read_fd)
os.kill(pid,signal.SIGKILL)
assert os.waitpid(pid,0)[1] != 0
rejected(lambda: start('crash',crash_gen), 'PROTECTION_UNCERTAIN')
for _ in range(3): finish_call(conn,start('a',gen),'403',clock,valid)
assert state('a')[1] == now.date() and state('a')[4] == 3
rejected(lambda: start('a',gen), 'PROTECTION_BLOCKED')
now += timedelta(days=1)
class SuccessResponse: status_code = 200
probe_calls = []
probe_admission = ProtectionAdmission(conn,'a',gen,uuid4(),uuid4(),1,clock,valid)
def probe_send(_):
    probe_calls.append('send')
    assert state('a')[1] is not None
    return SuccessResponse()
probe_transport = GuardedTransport(probe_admission,probe_send,classify=lambda _: 'success')
assert probe_transport.send('probe','summary',None).status_code == 200
assert state('a')[1] is None
try: probe_transport.send('probe','summary',None)
except Exception as exc: assert str(exc) == 'HTTP_ADMISSION_FAILED'
else: raise AssertionError('second probe accepted')
assert probe_calls == ['send']
finish_call(conn,start('a',gen),'429',clock,valid)
now += timedelta(days=1)
probe = start('a',gen,'probe')
finish_call(conn,probe,'429',clock,valid)
assert state('a')[2]
now += timedelta(days=1)
rejected(lambda: start('a',gen,'probe'), 'PROTECTION_BLOCKED')
release_block(conn,'a',valid)
assert state('a')[1:3] == (None,False)
finish_call(conn,start('a',gen),'auth_required',clock,valid)
release_block(conn,'a',valid)
assert state('a')[0]
rejected(lambda: start('a',gen), 'PROTECTION_BLOCKED')
# 인증 성공은 다른 latch를 해제하지 않는다.
auth = start('a',gen,'auth')
finish_call(conn,auth,'success',clock,valid)
assert state('a')[0]
# 별도 target의 선행 intent가 commit되고 연결이 끊겨도 미확정으로 남는다.
_, cgen = create_target(conn,'c',valid)
rejected(lambda: start('c',cgen), 'PROTECTION_DISCOVERY_BLOCKED')
# 의도적으로 기존 보호를 보존한 채 alias 병합을 검사한다.
bind_profile(conn,'b','profile-a',bgen,valid)
assert state('b')[0] and state('b')[1] is not None and state('a') == state('b')
# rate latch는 auth 예외도 막으므로 수동 해제로 rate만 제거한다.
release_block(conn,'a',valid)
assert state('a')[0] and state('b')[1] is None
gen = conn.execute('select generation from garmin.account_binding where target=%s',('a',)).fetchone()[0]
# 인증 예외로 pending을 만들고 재연결한다.
conn.execute("create function garmin.reject_intent() returns trigger language plpgsql as $$ begin raise exception 'fixture reject'; end $$")
conn.execute('create trigger reject_intent before insert on garmin.external_call_intent for each row execute function garmin.reject_intent()')
try: start('a',gen,'auth')
except psycopg.errors.RaiseException: pass
else: raise AssertionError('intent write failure accepted')
conn.execute('drop trigger reject_intent on garmin.external_call_intent')
pending = start('a',gen,'auth')
conn.execute('create trigger reject_result before update on garmin.external_call_intent for each row execute function garmin.reject_intent()')
try: finish_call(conn,pending,'success',clock,valid)
except psycopg.errors.RaiseException: pass
else: raise AssertionError('result write failure accepted')
conn.execute('drop trigger reject_result on garmin.external_call_intent')
conn.close()
conn = psycopg.connect(host='127.0.0.1',port=int(sys.argv[1]),dbname='brain_protection_fixture',user='postgres',password='fixture',autocommit=True)
rejected(lambda: start('a',gen,'auth'), 'PROTECTION_UNCERTAIN')
assert conn.execute('select outcome from garmin.external_call_intent where id=%s',(pending,)).fetchone()[0] is None
# commit 응답이 사라져도 호출자는 전송하지 않고 재시작은 pending을 본다.
class LostCommit:
    autocommit = True
    def execute(self, *args): return conn.execute(*args)
    @contextmanager
    def transaction(self):
        with conn.transaction(): yield
        raise OSError('synthetic lost commit response')
transmissions = []
lost_admission = ProtectionAdmission(LostCommit(),'lost',lost_gen,uuid4(),uuid4(),1,clock,valid)
try: GuardedTransport(lost_admission,lambda _: transmissions.append('send')).send('data','summary',None)
except Exception as exc: assert str(exc) == 'HTTP_ADMISSION_FAILED'
else: raise AssertionError('lost commit accepted')
assert transmissions == []
rejected(lambda: start('lost',lost_gen), 'PROTECTION_UNCERTAIN')
clock_intent = start('clock',clock_gen)
now -= timedelta(seconds=1)
rejected(lambda: finish_call(conn,clock_intent,'success',clock,valid), 'PROTECTION_CLOCK_UNCERTAIN')
assert conn.execute('select outcome from garmin.external_call_intent where id=%s',(clock_intent,)).fetchone()[0] is None
# 감독자 전용 admission: 같은 account는 배타, 확인된 다른 account는 병렬,
# 보호된 source의 미확인 target은 거절한다. role은 실제 PG 권한으로 검사한다.
work_a, work_same, work_other, work_unknown = (uuid4() for _ in range(4))
token_a, token_same, token_other, token_unknown = (uuid4() for _ in range(4))
for work in (work_a,work_same,work_other,work_unknown):
    conn.execute("insert into brain.work_items values (%s,'garmin.collect',1,null,null)",(work,))
a_gen = conn.execute("select generation from garmin.account_binding where target='a'").fetchone()[0]
conn.execute('set session authorization brain_app')
def reserve(work,token,target,generation):
    return conn.execute('select garmin.reserve_admission(%s,%s,1,%s,%s)',(work,token,target,generation)).fetchone()[0]
assert reserve(work_a,token_a,'a',a_gen)
assert not reserve(work_same,token_same,'a',a_gen)
assert reserve(work_other,token_other,'seam',seam_gen)
assert not reserve(work_unknown,token_unknown,'c',cgen)
conn.execute('reset session authorization')
conn.execute('set session authorization brain_ext_garmin')
def admission_valid():
    return conn.execute('select garmin.admission_valid(%s,%s,1,%s,%s)',(work_a,token_a,'a',a_gen)).fetchone()[0]
assert admission_valid()
assert supervised_validator(work_a,token_a,1,'a',a_gen)(conn)
try: conn.execute('delete from garmin.admission_holder')
except psycopg.errors.InsufficientPrivilege: pass
else: raise AssertionError('worker may change admission')
conn.execute('reset session authorization')
conn.execute('update brain.work_items set cancel_requested_at=now() where id=%s',(work_a,))
conn.execute('set session authorization brain_ext_garmin')
assert not admission_valid()
assert not supervised_validator(work_a,token_a,1,'a',a_gen)(conn)
try: reserve(work_unknown,token_unknown,'c',cgen)
except psycopg.errors.InsufficientPrivilege: pass
else: raise AssertionError('worker may reserve admission')
conn.execute('reset session authorization')
conn.execute("update brain.work_items set cancel_requested_at=null,hold_group='fixture' where id=%s",(work_a,))
conn.execute("insert into brain.work_hold_groups values ('fixture')")
conn.execute('set session authorization brain_ext_garmin')
assert not admission_valid()
conn.execute('reset session authorization')
print('격리 PostgreSQL 보호 전이 및 재연결 검사 통과')
conn.close()
