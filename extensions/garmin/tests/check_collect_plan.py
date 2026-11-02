"""옛 coverage·진입표·계획의 순수 경계 검증."""
from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import collect_coverage as c
from collect_rawparse import ActivityRef, RawParseError, activity_refs, completion_stats

D = date(2026, 10, 16)
def ms(day, hour=0):
    return int(datetime(day.year,day.month,day.day,hour,tzinfo=timezone.utc).timestamp()*1000)
def snap(raw=(), runs=(), errors=()):
    return {'raw':list(raw), 'runs':list(runs), 'errors':list(errors), 'history_start':None}
def raw(key, endpoint, body, fetched=None, checked=None, scope='day'):
    return {'scope':scope,'key':key,'endpoint':endpoint,'body':json.dumps(body,ensure_ascii=False),
            'fetched_at_ms':ms(D) if fetched is None else fetched,'checked_at_ms':ms(D) if checked is None else checked,'library_version':'v'}
def run(status, detail='', started=1, finished=2):
    return {'local_date':D.isoformat(),'started_at':started,'finished_at':finished,'status':status,'detail':detail}
def error(key, endpoint, kind, local_date, scope='day'):
    return {'scope':scope,'key':key,'endpoint':endpoint,'kind':kind,'local_date':local_date}

empty = snap()
assert len(c.items(empty,D,D)) == 11 and all(x.state == 'missing' and c.incomplete(x) for x in c.items(empty,D,D))
assert [day for day, _ in c.plan(empty,D-timedelta(days=30),D)] == [D-timedelta(days=n) for n in range(10)]
assert all(endpoints == list(c.DAY_ENDPOINTS) for _,endpoints in c.plan(empty,D,D))
assert c.plan(empty,D+timedelta(days=1),D) == []
assert c.entry(empty,D,blocked=True) == 'blocked'
for status in ('not_run','error','rate_limited','blocked_403'):
    assert c.entry(empty if status == 'not_run' else snap(runs=[run(status)]),D) == 'full'
for status in ('success','partial','auth_failed'):
    assert c.entry(snap(runs=[run(status)]),D) == 'noop'
assert c.entry(snap(runs=[run('partial','rejected=1 transient=1')]),D) == 'retry'
assert c.entry(snap(runs=[run('partial','rejected=1')]),D) == 'noop'
assert c.entry(snap(runs=[run('auth_failed')]),D,token_saved_at=2) == 'noop'
assert c.entry(snap(runs=[run('auth_failed')]),D,token_saved_at=3) == 'full'
assert c.entry(snap(runs=[run('success')]),D,force=True) == 'full'
# 이전 run과 새 run은 같은 시각 단위와 열 이름으로 판정한다.
legacy = run('partial','transient=1',10,12) | {'id': 14}
new = run('partial','transient=1',10,12)
assert c.day_status(snap(runs=[legacy]),D) == c.day_status(snap(runs=[new]),D)
assert c.day_status(snap(runs=[run('success',started=1),run('error','lock_timeout',2),run('skipped_blocked',started=3)]),D).status == 'success'
assert c.day_status(snap(runs=[run('error','lock_timeout',1),run('error','lock_timeout x',2)]),D).detail == 'lock_timeout x'

key=D.isoformat()
r = raw(key,'sleep_data',{'sleep':1},checked=ms(D+timedelta(days=1)))
e = [error(key,'sleep_data','rejected',f'2026-10-{n:02}') for n in (13,14,15)]
x = next(i for i in c.items(snap([r],errors=e),D,D) if i.endpoint == 'sleep_data')
assert x.state == 'data' and x.final and not x.plannable and not c.incomplete(x)
assert c.incomplete(x._replace(plannable=True,final=False))
assert c.incomplete(x._replace(plannable=True,fresh=False))
assert not c.incomplete(x._replace(scope='activity',plannable=True,final=False,fresh=True))
assert c.incomplete(x._replace(scope='activity',plannable=True,fresh=False))
assert next(i for i in c.items(snap(errors=e[:2]+e[:1]),D,D) if i.endpoint == 'sleep_data').plannable
checked_today = raw(key,'sleep_data',{},checked=ms(D,2))
retry = snap([checked_today], errors=[error(key,'hrv_data','rejected',key)])
assert 'sleep_data' not in c.plan(retry,D,D,mode='retry')[0][1]
assert 'hrv_data' not in c.plan(retry,D,D,mode='retry')[0][1]
assert 'stress_data' in c.plan(retry,D,D,mode='retry')[0][1]
complete = [raw(key,ep,None,checked=ms(D+timedelta(days=1))) for ep in c.DAY_ENDPOINTS]
assert c.plan(snap(complete),D,D) == []
assert c.plan(snap(complete),D,D,recent_lists=True) == [(D,['activities_by_date'])]
assert c.first_call_endpoints(empty) == c.FIRST_CALL_ENDPOINTS
assert 'daily_weigh_ins' not in c.first_call_endpoints(snap([raw(key,'daily_weigh_ins',{'x':1})]))
assert 'daily_weigh_ins' in c.first_call_endpoints(snap([raw(key,'daily_weigh_ins',None)]))

activities = [{'activityId':12,'startTimeLocal':key+' 23:59:00','totalSets':1}, {'activityId':13,'startTimeLocal':key+'T10:00:00'}, {'activityId':12,'startTimeLocal':key}]
assert activity_refs(json.dumps(activities)) == [ActivityRef(12,key,True),ActivityRef(13,key,False)]
assert activity_refs('null') == [] and activity_refs('[]') == []
for bad in ('{', '{}', '[{}]', '[{"activityId":true,"startTimeLocal":"2026-10-16"}]', '[{"activityId":1,"startTimeLocal":"2026-10-16","totalSets":true}]'):
    try: activity_refs(bad)
    except RawParseError: pass
    else: raise AssertionError(bad)
listing = raw('2026-10-15','activities_by_date',activities,fetched=ms(D))
sets = raw('12','activity_exercise_sets',{'x':1},fetched=ms(D-timedelta(days=1)),checked=ms(D-timedelta(days=1)),scope='activity')
activity_items = [i for i in c.items(snap([listing,sets]),D,D) if i.scope == 'activity']
assert len(activity_items) == 7 and activity_items[3].endpoint == c.EXERCISE_SETS and not activity_items[3].fresh
assert len(c.pending_activities(snap([listing,sets]),D)) == 7
broken = raw(key,'activities_by_date',{},checked=ms(D+timedelta(days=1)))
assert not next(i for i in c.items(snap([broken]),D,D) if i.endpoint == 'activities_by_date').final
assert completion_stats('{"completionStats":[{"calendarDate":"2026-10-15","completedTracking":2}]}') == {'2026-10-15':2}
old = raw('2026-10-15','lifestyle_logging_data',{'completionStats':[{'calendarDate':'2026-10-15','completedTracking':1}]},checked=ms(D-timedelta(days=1)))
new = raw(key,'lifestyle_logging_data',{'completionStats':[{'calendarDate':'2026-10-15','completedTracking':2}]},fetched=ms(D))
assert c.stale_lifestyle([old,new]) == {'2026-10-15'}
recent_rejected = snap(complete,errors=[error(key,'activities_by_date','rejected',key)])
assert c.plan(recent_rejected,D,D,mode='rejected',recent_lists=True) == []
past = D - timedelta(days=1)
past_list = raw(past.isoformat(),'activities_by_date',[{'activityId':99,'startTimeLocal':past.isoformat()}])
past_error = error('99','activity','rejected',key,scope='activity')
assert 'activity' not in [i.endpoint for i in c.pending_activities(snap([past_list],errors=[past_error]),past,mode='retry',today=D)]
print('check_collect_plan: all checks passed')
