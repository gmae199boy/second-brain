from datetime import date, timedelta
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import collect_notice as n

day = date(2026, 1, 2)
snapshot = {'runs': []}
assert n.end_event(snapshot, day, 'success', '') is None
assert n.end_event(snapshot, day, 'rate_limited', 'rate_limited') == ('rate_limited', 'rate_limited')
for d in (day, day-timedelta(days=1)):
    snapshot['runs'].append(dict(local_date=str(d), status='partial', detail='transient=2', started_at=1))
assert n.end_event(snapshot, day, 'partial', 'transient=2') == ('repeated_partial', 'transient=2')
snapshot['runs'][1]['detail'] = 'rejected=1'
assert n.end_event(snapshot, day, 'partial', 'transient=2') is None
for event in n.TEXT:
    text = n.notice_text(day, event, 'error')
    assert len(text.splitlines()) == 3 and '-'.join(('synthetic','token','canary')) not in text
assert 'brain ext login garmin' in n.notice_text(day, 'auth_failed', '')
print('collect notice checks passed')

# Query contract: only native invalid running rows are candidates; failures are
# restricted to this dataset and this run's start. Legacy snapshot rows do not
# independently cause an event.
from unittest.mock import patch
import json
import collect_settings
class Rows:
    def __init__(self, rows): self.rows = rows
    def fetchall(self): return self.rows
class Conn:
    def __init__(self, failures): self.failures, self.queries = failures, []
    def execute(self, sql, args):
        self.queries.append((sql,args))
        if 'collect_runs' in sql: return Rows([])
        assert args == (n.store.dataset_for('account'), 100)
        return Rows(self.failures)
legacy = {'runs':[dict(local_date='2000-01-01',status='error',detail='abandoned',started_at=1)]}
with patch.object(n, 'write') as write:
    c=Conn([('alpha',2),('zeta',1)])
    n.notify(c,'account','UTC',day,'success','',100,'conversation','work','token',legacy)
    assert write.call_count == 1
    assert write.call_args.args[4:6] == ('normalize_failed','alpha=2 zeta=1')
    assert "r.status='running'" in c.queries[0][0] and 'not garmin.attempt_valid' in c.queries[0][0]
    write.reset_mock()
    n.notify(Conn([]),'account','UTC',day,'success','',100,'conversation','work','token',legacy)
    assert not write.called
    c=Conn([])
    n.notify(c,'account','UTC',day,'error','error',100,None,'work','token',legacy)
    assert not c.queries and not write.called
try:
    collect_settings.decode(json.dumps({'version':1,'extension':'garmin','values':{'garmin.notice_conversation_id':'not-a-uuid'}}))
    raise AssertionError('invalid UUID accepted')
except ValueError as e:
    assert str(e) == 'COLLECT_INVALID'
print('normalize, legacy, missing conversation and UUID checks passed')

import collect
with patch.object(collect.collect_notice, 'notify', side_effect=ValueError('COLLECT_INVALID_ATTEMPT')):
    try: collect._notify_checked()
    except ValueError as e: assert str(e) == 'COLLECT_INVALID_ATTEMPT'
    else: raise AssertionError('stale attempt swallowed')
with patch.object(collect.collect_notice, 'notify', side_effect=RuntimeError('private detail')):
    try: collect._notify_checked()
    except ValueError as e: assert str(e) == 'COLLECT_NOTICE_FAILED'
    else: raise AssertionError('notice error swallowed')
print('attempt fence and notice failure propagation checks passed')

class AbandonedConn(Conn):
    def execute(self, sql, args):
        if 'select r.local_date from garmin.collect_runs' in sql:
            return Rows([(date(2026,1,1),)])
        return super().execute(sql,args)
with patch.object(n, 'write') as write:
    n.notify(AbandonedConn([]),'account','UTC',day,'success','',100,'conversation','work','token',legacy)
    assert write.call_count == 1 and write.call_args.args[3:6] == (date(2026,1,1),'error','abandoned')
print('native abandoned event check passed')

# Exercise the real ABI entry point's retryable serialization.
from contextlib import redirect_stdout
from io import StringIO
out = StringIO()
with patch.object(collect, 'run', side_effect=ValueError('COLLECT_NOTICE_FAILED')), redirect_stdout(out):
    assert collect.main() == 1
assert json.loads(out.getvalue()) == {'abi':1,'type':'error','code':'COLLECT_NOTICE_FAILED','retryable':True}
print('main retryable serialization passed')

# Same-day rediscovery works through noop and skipped_blocked, but never
# rediscovers an ordinary prior-day stop event.
with patch.object(n, 'write') as write:
    today_stop = {'runs':[dict(local_date=str(day),status='auth_failed',detail='login_required',started_at=1),
                          dict(local_date=str(day),status='skipped_blocked',detail='',started_at=2)]}
    class NativeStop(Conn):
        def execute(self, sql, args):
            if 'select status,detail from garmin.collect_runs' in sql: return Rows([('auth_failed','login_required')])
            return super().execute(sql,args)
    for status in ('noop','skipped_blocked'):
        write.reset_mock()
        n.notify(NativeStop([]),'account','UTC',day,status,'',100,'conversation','work','token',today_stop)
        assert write.call_count == 1 and write.call_args.args[3:6] == (day,'auth_failed','login_required')
    write.reset_mock()
    old_stop={'runs':[dict(local_date=str(day-timedelta(days=1)),status='rate_limited',detail='rate_limited',started_at=1)]}
    n.notify(Conn([]),'account','UTC',day,'noop','',100,'conversation','work','token',old_stop)
    assert not write.called
assert 'brain failures list' in n.notice_text(day,'repeated_partial','')
assert 'brain failures list' in n.notice_text(day,'error','')
print('same-day rediscovery checks passed')

# Native errors survive a newer success; legacy-only today does not rediscover.
with patch.object(n, 'write') as write:
    class NativeError(Conn):
        def execute(self, sql, args):
            if 'select status,detail from garmin.collect_runs' in sql:
                assert args == (n.store.dataset_for('account'),day)
                return Rows([('error','error')])
            return super().execute(sql,args)
    later_success={'runs':[dict(local_date=str(day),status='error',detail='error',started_at=1),dict(local_date=str(day),status='success',detail='',started_at=2)]}
    n.notify(NativeError([]),'account','UTC',day,'success','',100,'conversation','work','token',later_success)
    assert write.call_count == 1 and write.call_args.args[3:6] == (day,'error','error')
    write.reset_mock()
    n.notify(Conn([]),'account','UTC',day,'noop','',100,'conversation','work','token',{'runs':[dict(local_date=str(day),status='error',detail='legacy',started_at=1)]})
    assert not write.called
print('native event recovery and legacy exclusion passed')
