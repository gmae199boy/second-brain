"""운동 측정 snapshot 계약. 모든 수치는 생산자가 계산하고 소비자는 그대로 읽는다."""
import json
from pathlib import Path

SCHEMA_VERSION = 'training_measurements_v1'
SCOPES = ('day', '7d', '30d', 'all')


def load_training_measurements(snapshot: Path, scope: str | None = None) -> dict:
    """기간 폴더 또는 저장된 snapshot 루트에서 C1을 읽는다. DB·에이전트 호출은 없다.

    scope 생략: snapshot/training_measurements.json.
    scope 지정: snapshot/day 또는 snapshot/period/<scope>/training_measurements.json.
    """
    folder = Path(snapshot)
    if scope is not None:
        if scope not in SCOPES:
            raise ValueError('invalid training scope')
        folder = folder / 'day' if scope == 'day' else folder / 'period' / scope
    result = json.loads((folder / 'training_measurements.json').read_text(encoding='utf-8'))
    if result.get('schema_version') != SCHEMA_VERSION or (scope and result.get('scope') != scope):
        raise ValueError('invalid training measurements version or scope')
    return result


def _number(value):
    import math
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 else None


def _load(raw):
    value = raw.get('weight')
    # [ASSUMPTION] 보조중량은 원본 명시가 있을 때만 assisted로 분류한다.
    if raw.get('loadKind') == 'assisted' or raw.get('assisted') is True:
        return 'assisted', _number(value / 1000) if _number(value) is not None else None
    if value == -1 and not isinstance(value, bool):
        return 'bodyweight', None
    if value is None or value == 0:
        return 'missing', None
    value = _number(value)
    return ('weighted', value / 1000) if value is not None and value > 0 else ('unknown', None)


def _iso(value, timezone):
    return value.astimezone(timezone).isoformat() if value else None


def _sessions(engine):
    from datetime import datetime, timedelta
    cutoff = datetime.fromisoformat(engine.manifest['data_cutoff'])
    result = []
    for activity_id, endpoints in engine.activities.items():
        record = engine.activity_record(engine, activity_id)
        if record is None or record['_end'] >= cutoff:
            continue
        source = f'activities/{activity_id}'
        raw_activity = endpoints.get('activity') or {}
        summary = raw_activity.get('summaryDTO') or {}
        raw_sets = endpoints.get('activity_exercise_sets') or {}
        sets, counts = [], {}
        for index, raw in enumerate(raw_sets.get('exerciseSets') or []):
            if not isinstance(raw, dict) or raw.get('setType') not in ('ACTIVE', 'REST'):
                continue
            candidates = [x for x in raw.get('exercises', []) if isinstance(x, dict)]
            exercise = max(candidates, key=lambda x: _number(x.get('probability')) or 0) if candidates else {}
            category, name = exercise.get('category'), exercise.get('name')
            key = '_'.join(str(x) for x in (category, name) if x) or 'UNKNOWN'
            counts[key] = counts.get(key, 0) + (raw['setType'] == 'ACTIVE')
            start = engine.to_utc(raw.get('startTime'))
            duration = _number(raw.get('duration'))
            end = start + timedelta(seconds=duration) if start and duration is not None else None
            kind, load = _load(raw)
            following = raw_sets['exerciseSets'][index + 1] if index + 1 < len(raw_sets['exerciseSets']) else {}
            rest = _number(following.get('duration')) if following.get('setType') == 'REST' else None
            sets.append({'exercise_key':key,'display_name':engine.label(category, name),
                'equipment':exercise.get('equipment') if isinstance(exercise.get('equipment'), str) else None,
                'variant':name,'order':index+1,'set_no':counts[key],'set_type':raw['setType'],
                'start_at':_iso(start,engine.timezone),'end_at':_iso(end,engine.timezone),
                'reps':_number(raw.get('repetitionCount')),'load_kg':load,'load_kind':kind,
                'duration_s':duration,'rest_s':rest,'rpe':_number(raw.get('rpe')),'rir':_number(raw.get('rir')),
                'role':raw.get('role') if raw.get('role') in ('warmup','work') else 'unknown',
                'source_ref':f'{source}/activity_exercise_sets.json#/exerciseSets/{index}'})
        duration, moving = _number(summary.get('duration')), _number(summary.get('movingDuration'))
        distance, speed = _number(summary.get('distance')), _number(summary.get('averageSpeed'))
        session = {'session_id':str(activity_id),'source_refs':[f'{source}/activity.json'],
            'type':record['type'],'start_at':_iso(record['_start'],engine.timezone),
            'end_at':_iso(record['_end'],engine.timezone),'completed_date':record['_end'].astimezone(engine.timezone).date().isoformat(),
            'status':'completed','updated_at':None,'duration_s':duration,'moving_duration_s':moving,
            'rest_s':sum(x['duration_s'] for x in sets if x['set_type']=='REST' and x['duration_s'] is not None) if sets else None,
            'distance_m':distance,'speed_m_s':speed,'pace_s_km':1000/speed if speed else None,
            'pace_basis':'summary.averageSpeed' if speed else None,'hr_avg':record['hr_avg'],'hr_max':record['hr_max'],
            'zones':[{'zone':_number(zone),'seconds':value['s'],'low_bpm':value['low_bpm'],
                      'source_ref':f'{source}/activity_hr_in_timezones.json'} for zone,value in record['zones'].items()],
            'heart_rate':[{'at':_iso(at,engine.timezone),'bpm':bpm} for at,bpm in record['_hr'] if at is not None],
            'heart_rate_source_ref':f'{source}/activity_details.json','incline':None,'limitations':[], 'sets':sets}
        if not any(x['set_type']=='ACTIVE' for x in sets): session['limitations'].append('sets_not_available')
        if 'walk' in (record['type'] or '') or 'treadmill' in (record['type'] or ''):
            session['limitations'].append('incline_not_recorded')
        result.append(session)
    return sorted(result,key=lambda x:(x['start_at'],x['session_id']))


def _coverage(sessions):
    active=[x for session in sessions for x in session['sets'] if x['set_type']=='ACTIVE']
    return {'sessions':len(sessions),'sessions_with_sets':sum(any(x['set_type']=='ACTIVE' for x in s['sets']) for s in sessions),
        'active_sets':len(active),'weighted_sets':sum(x['load_kind']=='weighted' for x in active),
        'bodyweight_sets':sum(x['load_kind']=='bodyweight' for x in active),
        'missing_load_sets':sum(x['load_kind'] in ('missing','unknown','assisted') for x in active),
        'volume_sets':sum(x['load_kind']=='weighted' and x['reps'] is not None for x in active)}


def _strength(sessions):
    groups={}
    for session in sessions:
        for item in session['sets']:
            if item['set_type']=='ACTIVE':
                # 기구·변형은 원본 canonical 종목 키와 함께 유지하며 표시명으로 병합하지 않는다.
                groups.setdefault(item['exercise_key'],[]).append((session,item))
    result=[]
    for key, observations in sorted(groups.items()):
        weighted=[x for _,x in observations if x['load_kind']=='weighted' and x['reps'] is not None]
        max_kg=max((x['load_kg'] for _,x in observations if x['load_kind']=='weighted'),default=None)
        missing=sum(x['load_kind'] in ('missing','unknown','assisted') or x['reps'] is None for _,x in observations)
        same_load={}
        for session,item in observations:
            same_load.setdefault((item['load_kind'],item['load_kg']),[]).append({'session_id':session['session_id'],'reps':item['reps']})
        monthly=[]
        for month in sorted({s['completed_date'][:7] for s,_ in observations}):
            rows=[(s,x) for s,x in observations if s['completed_date'].startswith(month)]
            volume=[x for _,x in rows if x['load_kind']=='weighted' and x['reps'] is not None]
            monthly.append({'month':month,'exposures':len({s['session_id'] for s,_ in rows}),
                'sets':len(rows),'reps':sum(x['reps'] for _,x in rows) if all(x['reps'] is not None for _,x in rows) else None,
                'volume_kg':round(sum(x['load_kg']*x['reps'] for x in volume),3) if volume else None,
                'volume_sets':len(volume),'missing_load_sets':sum(x['load_kind'] in ('missing','unknown','assisted') for _,x in rows),
                'bodyweight_sets':sum(x['load_kind']=='bodyweight' for _,x in rows)})
        result.append({'exercise_key':key,'display_name':observations[0][1]['display_name'],
            'exposures':len({s['session_id'] for s,_ in observations}),'sets':len(observations),
            'reps':sum(x['reps'] for _,x in observations) if all(x['reps'] is not None for _,x in observations) else None,
            'volume_kg':round(sum(x['load_kg']*x['reps'] for x in weighted),3) if weighted else None,
            'volume_partial':bool(missing),'volume_sets':len(weighted),'missing_load_sets':sum(x['load_kind'] in ('missing','unknown','assisted') for _,x in observations),
            'bodyweight_sets':sum(x['load_kind']=='bodyweight' for _,x in observations),'max_kg':max_kg,
            'max_kg_reps':[x['reps'] for _,x in observations if x['load_kind']=='weighted' and x['load_kg']==max_kg and x['reps'] is not None],
            'session_ids':list(dict.fromkeys(s['session_id'] for s,_ in observations)),
            'same_load_reps':[{'load_kind':kind,'load_kg':load,'observations':rows} for (kind,load),rows in same_load.items()],
            'comparability':{'status':'limited','limitations':['equipment_or_load_convention_unverified','effort_and_plan_not_recorded']},
            'monthly':monthly})
    return result


def build_training_measurements(manifest: dict, days: dict, activities: dict, labels: dict,
                                body: list, scope: str, *, profile: dict | None = None) -> dict:
    """고정 원본에서 C1 생성. DB·네트워크를 읽지 않으며 모든 기간에서 같은 계산을 쓴다."""
    from datetime import date, timedelta
    from garmin_pipeline.digest import _Digest
    if scope not in SCOPES: raise ValueError('invalid training scope')
    engine=_Digest(manifest,days,activities,labels,body)
    sessions=_sessions(engine)
    end=date.fromisoformat(manifest['report_date'])-timedelta(days=1)
    start=(end-timedelta(days={'day':0,'7d':6,'30d':29}[scope])) if scope!='all' else min([date.fromisoformat(x) for x in days]+[date.fromisoformat(s['completed_date']) for s in sessions]+[end])
    def window(first,last):
        selected=[s for s in sessions if first.isoformat()<=s['completed_date']<=last.isoformat()]
        return {'from':first.isoformat(),'to':last.isoformat(),'actual_days':sum(first.isoformat()<=d<=last.isoformat() for d in days),
                'coverage':_coverage(selected),'sessions':selected,'strength':_strength(selected)}
    current=window(start,end)
    comparison=None
    if scope!='all':
        length=(end-start).days+1
        comparison=window(start-timedelta(days=length),start-timedelta(days=1))
    if scope=='all':
        # 전체 세트는 입력에 펼치지 않는다. 월 요약과 종목별 초기/최근/최고 기록의 대표 세션을 쓴다.
        representatives=set()
        for strength in current['strength']:
            ids=strength['session_ids']
            representatives.update(ids[:1]+ids[-2:])
            strength['same_load_reps']=[{**row,'observations':row['observations'][:1]+row['observations'][-2:]} for row in strength['same_load_reps']]
        current['sessions']=[{**s,'heart_rate':[]} for s in current['sessions'] if s['session_id'] in representatives]
    recovery=[]
    for day in sorted(days):
        if start-timedelta(days=7)<=date.fromisoformat(day)<=end+timedelta(days=1):
            recovery.append({'date':day,'relation':'night_ending_on_date; compare_with_session_start_at',
                'measurements':{'sleep':engine.sleep_for(engine,day),'day':engine.full_day(engine,day)}})
    return engine.tidy({'schema_version':SCHEMA_VERSION,'scope':scope,'report_date':manifest['report_date'],
        'timezone':manifest['timezone'],'snapshot_id':manifest['snapshot_id'],'as_of':manifest['data_cutoff'],
        'data_cutoff':manifest['data_cutoff'],'partial_date':manifest['report_date'],'attribution':'completed_at',
        'current':current,'comparison':comparison,'recovery_context':recovery,
        'profile':{'status':'configured' if profile else 'unset','snapshot_id':manifest.get('profile_snapshot_id'),
                   'source_ref':'profile.json' if profile else None},
        'limitations':['equipment_or_load_convention_unverified','missing_sets_do_not_imply_no_training']})


def resolve_snapshot_root(cfg, snapshot_id: str) -> Path:
    """저장된 C7 snapshot_id를 계정 Config의 불변 입력 루트로 해석한다.

    경로는 cfg.data_dir/report-snapshots/<snapshot_id>. 경로 탈출·없는 snapshot은 오류다.
    """
    import re
    if not isinstance(snapshot_id, str) or not re.fullmatch(r'[a-f0-9]{64}', snapshot_id):
        raise ValueError('invalid report snapshot id')
    folder = cfg.data_dir / 'report-snapshots' / snapshot_id
    manifest = json.loads((folder / 'snapshot.json').read_text(encoding='utf-8'))
    if manifest.get('snapshot_id') != snapshot_id or manifest.get('complete') is not True:
        raise ValueError('incomplete or mismatched report snapshot')
    return folder
