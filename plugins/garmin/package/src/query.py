"""Account-scoped native read queries. Identifiers come solely from METRICS."""
from datetime import date
from math import isfinite
from uuid import UUID
from zoneinfo import ZoneInfo

# metric -> (source, native column, unit, allowed aggregates)
METRICS = {
    **{name: ('day', name, unit, aggregates) for name, unit, aggregates in (
        ('sleep_total_s','s',('sum','mean')), ('sleep_deep_s','s',('sum','mean')),
        ('sleep_light_s','s',('sum','mean')), ('sleep_rem_s','s',('sum','mean')),
        ('sleep_awake_s','s',('sum','mean')), ('sleep_score','score',('mean',)),
        ('sleep_hr_min','bpm',('mean',)), ('hrv_avg','ms',()), ('spo2_avg','%',()),
        ('spo2_min','%',()), ('resp_avg','breaths/min',()), ('wake_bb','score',('mean',)),
        ('bb_high','score',('mean',)), ('bb_low','score',('mean',)),
        ('bb_charged','score',('sum','mean')), ('bb_drained','score',('sum','mean')),
        ('stress_avg','score',('mean',)), ('stress_high_s','s',('sum','mean')),
        ('steps','count',('sum','mean')), ('active_kcal','kcal',('sum','mean')),
        ('moderate_min','min',('sum','mean')), ('vigorous_min','min',('sum','mean')),
        ('resting_hr','bpm',('mean',)), ('weight_kg','kg',('mean',)))},
    **{f'workout.{name}': ('workout', name, unit, aggregates) for name, unit, aggregates in (
        ('duration_s','s',('sum','mean')), ('hr_avg','bpm',('mean',)), ('hr_max','bpm',('mean',)),
        ('zone1_s','s',('sum','mean')), ('zone2_s','s',('sum','mean')),
        ('zone3_s','s',('sum','mean')), ('zone4_s','s',('sum','mean')),
        ('zone5_s','s',('sum','mean')), ('bb_change','score',('sum','mean')))},
    **{f'exercise.{name}': ('exercise', name, unit, aggregates) for name, unit, aggregates in (
        ('sets','count',('sum','mean')), ('reps','count',('sum','mean')),
        ('max_kg','kg',()), ('volume_kg','kg',('sum','mean')),
        ('set_peak_hr_avg','bpm',('mean',)), ('rest_drop_avg','bpm',('mean',)))},
    **{f'set.{name}': ('set', name, unit, aggregates) for name, unit, aggregates in (
        ('reps','count',('sum','mean')), ('weight_g','g',('mean',)), ('duration_s','s',('sum','mean')))},
}
SCOPES = ('day', '7d', '30d', 'all')


def validate(command, data):
    if command not in ('daily-values', 'period-summary', 'recent-evaluations') or not isinstance(data, dict): raise ValueError('invalid input')
    common = {'connection_id', 'timezone'}
    allowed = common | ({'scope', 'limit'} if command == 'recent-evaluations' else
                        {'start_date', 'end_date', 'metric', 'activity_type', 'exercise'} |
                        ({'aggregation'} if command == 'period-summary' else set()))
    required = common | ({'scope', 'limit'} if command == 'recent-evaluations' else
                         {'start_date', 'end_date', 'metric'} |
                         ({'aggregation'} if command == 'period-summary' else set()))
    if set(data) - allowed or not required <= set(data): raise ValueError('invalid fields')
    connection = UUID(data['connection_id'])
    if str(connection) != data['connection_id']: raise ValueError('invalid connection')
    if not isinstance(data['timezone'], str) or not data['timezone']: raise ValueError('invalid timezone')
    ZoneInfo(data['timezone'])
    if command == 'recent-evaluations':
        if data['scope'] not in SCOPES or type(data['limit']) is not int or not 1 <= data['limit'] <= 100: raise ValueError('invalid evaluation filter')
    else:
        for key in ('start_date', 'end_date'):
            if not isinstance(data[key], str) or date.fromisoformat(data[key]).isoformat() != data[key]: raise ValueError('invalid date')
        if data['start_date'] > data['end_date'] or data['metric'] not in METRICS: raise ValueError('invalid range or metric')
        for key in ('activity_type', 'exercise'):
            if key in data and (not isinstance(data[key], str) or not data[key].strip() or len(data[key]) > 200): raise ValueError('invalid condition')
        if command == 'period-summary' and data['aggregation'] not in METRICS[data['metric']][3]: raise ValueError('unsupported aggregation')
    return connection


def execute(conn, user, command, data):
    connection = validate(command, data)
    row = conn.execute('select timezone from garmin.account_connections where user_id=%s and connection_id=%s', (user, connection)).fetchone()
    if not row or row[0] != data['timezone']: raise ValueError('account or timezone mismatch')
    if command == 'recent-evaluations':
        rows = conn.execute('''select e.report_date,e.scope,e.summary,
          (select f.file_id from garmin.evaluation_files f where f.user_id=e.user_id and f.connection_id=e.connection_id
           and f.report_date=e.report_date and f.scope=e.scope and f.revision=e.revision and f.kind='report' and f.file_id is not null order by f.request_id limit 1)
          from garmin.evaluation e where e.user_id=%s and e.connection_id=%s and e.scope=%s
          order by e.report_date desc,e.created_at desc limit %s''', (user, connection, data['scope'], data['limit'])).fetchall()
        return {'evaluations': [{'date': r[0], 'scope': r[1], 'summary': r[2], 'file_id': str(r[3]) if r[3] else None} for r in rows]}
    source, column, unit, _ = METRICS[data['metric']]
    if source == 'day':
        sql = f'select d.date,d.{column} from garmin.day_summary d where d.user_id=%s and d.connection_id=%s and d.date >= %s and d.date <= %s'
        alias = 'd'
    else:
        join = {'workout': '', 'exercise': ' join garmin.exercise_log e on e.user_id=w.user_id and e.connection_id=w.connection_id and e.activity_id=w.activity_id',
                'set': ' join garmin.exercise_set s on s.user_id=w.user_id and s.connection_id=w.connection_id and s.activity_id=w.activity_id and s.is_rest=0'}[source]
        alias = {'workout': 'w', 'exercise': 'e', 'set': 's'}[source]
        sql = f'select w.date,{alias}.{column} from garmin.workout w{join} where w.user_id=%s and w.connection_id=%s and w.date >= %s and w.date <= %s'
    params = [user, connection, data['start_date'], data['end_date']]
    if 'activity_type' in data or 'exercise' in data:
        clauses = [f'wf.user_id={alias}.user_id', f'wf.connection_id={alias}.connection_id']
        clauses.append('wf.date=d.date' if source == 'day' else 'wf.activity_id=w.activity_id')
        if 'activity_type' in data:
            clauses.append('wf.type=%s'); params.append(data['activity_type'])
        if 'exercise' in data:
            if source in ('day', 'workout'):
                clauses.append('exists (select 1 from garmin.exercise_log ef where ef.user_id=wf.user_id and ef.connection_id=wf.connection_id and ef.activity_id=wf.activity_id and ef.exercise=%s)'); params.append(data['exercise'])
            else:
                sql += ' and ' + ('e.exercise' if source == 'exercise' else 's.exercise_name') + '=%s'
                params.insert(4, data['exercise'])
        sql += ' and exists (select 1 from garmin.workout wf where ' + ' and '.join(clauses) + ')'
    sql += ' order by ' + ('d.date' if source == 'day' else 'w.date,w.activity_id' + (',e.exercise' if source == 'exercise' else ',s.set_index' if source == 'set' else ''))
    rows = conn.execute(sql, params).fetchall()
    values = []
    for day, value in rows:
        if value is not None and not isfinite(value): raise ValueError('non-finite value')
        values.append({'date': day, 'value': value, 'unit': unit})
    if command == 'daily-values': return {'rows': values}
    observed = [row['value'] for row in values if row['value'] is not None]
    value = (sum(observed) if data['aggregation'] == 'sum' else sum(observed) / len(observed)) if observed else None
    if value is not None and not isfinite(value): raise ValueError('non-finite aggregate')
    return {'value': value, 'unit': unit, 'observed_count': len(observed), 'null_count': len(values)-len(observed), 'start_date': data['start_date'], 'end_date': data['end_date']}
