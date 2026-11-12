"""실행 결과와 구별되는 수집 대기량. 원문 내용 없이 집계만 반환한다."""
from datetime import date
from garmin_pipeline import coverage, store


def summarize(items, today):
    pending = [i for i in items if
               i.state in (coverage.CoverageState.MISSING, coverage.CoverageState.FAILED)
               or not i.fresh
               or (i.day_key < today.isoformat() and not i.final and coverage.incomplete(i))]
    return {'remaining_endpoints': len(pending),
            'remaining_activities': len({i.key for i in pending if i.scope == 'activity'}),
            'remaining_dates': len({i.day_key for i in pending}),
            'unplannable': sum(not i.plannable for i in pending)}


def snapshot(conn, cfg, start, today):
    with store.transaction(conn):
        return summarize(coverage.items(conn, cfg, start, today), today) if start <= today else summarize([], today)
