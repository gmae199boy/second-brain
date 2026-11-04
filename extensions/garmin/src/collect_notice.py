"""Collection events and the atomic channel handoff."""
from datetime import date, datetime, timedelta, timezone
import uuid
import collect_coverage as coverage
import collect_store as store

TEXT = {
    'auth_failed': ('Garmin 인증 실패', '`brain ext login garmin`으로 다시 로그인하거나 Garmin Connect 프로필 공개 범위를 확인한다.'),
    'rate_limited': ('Garmin 요청 제한', '오늘 추가 호출을 멈추고 다음 날 다시 확인한다.'),
    'blocked_403': ('Garmin 접근 차단', '오늘 추가 호출을 멈추고 다음 날 다시 확인한다.'),
    'normalize_failed': ('정규화 실패', '원문 구조와 코드를 확인하고 정규화를 다시 실행한다.'),
    'repeated_partial': ('이틀 연속 수집 미완료', '다음 실행 뒤에도 이어지면 `brain failures list`로 항목 실패를 확인한다.'),
    'error': ('수집 오류', '`brain failures list`로 사유를 확인한다. block_file_invalid면 block.json을 확인한다.'),
}

def notice_text(day, event, detail):
    title, action = TEXT[event]
    return f'[Garmin] {day.isoformat()} {event} {title}\n{action}\n사유: {detail or "-"}'

def end_event(snapshot, day, status, detail):
    if status in ('auth_failed', 'rate_limited', 'blocked_403', 'error'):
        return status, detail
    if status == 'partial':
        states = [coverage.day_status(snapshot, d) for d in (day, day - timedelta(days=1))]
        if all(s.status == 'partial' and any(t.startswith('transient=') for t in s.detail.split()) for s in states):
            return 'repeated_partial', states[0].detail
    return None

def hook(stage):
    """Fixture replaces this no-op at process startup."""

def write(conn, account, zone, day, event, detail, conversation, work, token):
    with store._write(conn, account, work, token) as (cur, _dataset):
        notice_id = uuid.uuid7()
        now = datetime.now(timezone.utc)
        cur.execute('''insert into garmin.collect_notices(id,source,account,timezone,local_date,event,detail,created_at,work_id,attempt_token)
            values (%s,'garmin',%s,%s,%s,%s,%s,%s,%s,%s) on conflict (source,account,timezone,local_date,event) do nothing returning id''',
            (notice_id,account,zone,day,event,detail,now,work,token))
        if cur.fetchone() is None:
            return
        hook('insert')
        cur.execute('''insert into brain.channel_requests(id,conversation_id,producer,producer_result_id,purpose,revision,body,created_at,source_work_item_id,source_attempt_token)
            values (%s,%s,'garmin',%s,%s,'collection-notice-v1',%s,%s,%s,%s)''',
            (uuid.uuid7(),conversation,str(notice_id),'collection-notice:'+event,notice_text(day,event,detail),now,work,token))
    hook('commit')

def notify(conn, account, zone, day, status, detail, started, conversation, work, token, snapshot=None):
    if not conversation:
        return
    snapshot = store.coverage_snapshot(conn,account) if snapshot is None else snapshot
    abandoned = conn.execute('''select r.local_date from garmin.collect_runs r
        join garmin.datasets d on d.dataset=r.dataset
        where d.account=%s and d.account_confirmed and d.account_raw is null
          and r.status='running' and not garmin.attempt_valid(r.work_id,r.attempt_token)''', (account,)).fetchall()
    events = [(day, 'error', 'abandoned') for (day,) in abandoned]
    event = end_event(snapshot,day,status,detail)
    if event:
        events.append((day,*event))
    native = conn.execute('''select status,detail from garmin.collect_runs
        where dataset=%s and local_date=%s and status not in ('running','success','skipped_blocked')
        order by started_at,run_id''', (store.dataset_for(account),day)).fetchall()
    yesterday = coverage.day_status(snapshot,day-timedelta(days=1))
    for old_status, old_detail in native:
        old_detail = old_detail or ''
        if old_status in ('auth_failed','rate_limited','blocked_403','error'):
            events.append((day,old_status,old_detail))
        elif (old_status == 'partial' and any(t.startswith('transient=') for t in old_detail.split())
              and yesterday.status == 'partial' and any(t.startswith('transient=') for t in yesterday.detail.split())):
            events.append((day,'repeated_partial',old_detail))
    rows = conn.execute('''select endpoint,count(*) from garmin.normalize_items where dataset=%s and not ok and normalized_at_ms >= %s group by endpoint order by endpoint''', (store.dataset_for(account),started)).fetchall()
    if rows:
        events.append((day,'normalize_failed',' '.join(f'{endpoint}={count}' for endpoint,count in rows)))
    for event_day, kind, value in events:
        write(conn,account,zone,event_day,kind,value,conversation,work,token)
