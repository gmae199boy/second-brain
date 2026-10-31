"""실데이터를 포함하지 않는 schema10/15 시험 입력 생성기."""
import sqlite3
import json
import sys
from pathlib import Path


def create(path, version=15, encoding='UTF-8'):
    if version not in (10, 15):
        raise ValueError('지원하지 않는 시험 버전')
    import tarfile
    archive = Path(__file__).resolve().parents[3] / '_bmad-output/personal-brain/prep-garmin-absorption/inputs/garmin-source.tar.gz'
    with tarfile.open(archive, 'r:gz') as bundle, sqlite3.connect(path) as conn:
        if encoding not in ('UTF-8', 'UTF-16le', 'UTF-16be'): raise ValueError('지원하지 않는 시험 인코딩')
        conn.execute("pragma encoding = '" + encoding + "'")
        migrations = sorted((m for m in bundle.getmembers() if m.name.startswith('garmin-source/src/garmin_pipeline/store/migrations/') and m.name.endswith('.sql') and int(Path(m.name).name[:4]) <= version), key=lambda m: m.name)
        for migration in migrations:
            conn.executescript(bundle.extractfile(migration).read().decode('utf-8'))
        conn.execute('pragma user_version = ' + str(version))
        conn.execute('insert into raw_response values (?,?,?,?,?,?,?)', ('day','2026-01-01','user_summary','{"userProfileId": 12345, "한글": null, "order": [2,1]}',1700000000123,1700000000456,'test-1'))
        conn.execute('insert into daily_metric(day_key,steps) values (?,?)', ('2026-01-01', 1234))
        conn.execute("insert into meta(key,value) values ('normalize_version','2')")
        conn.execute("insert into meta(key,value) values ('timezone','Asia/Seoul')")


if __name__ == '__main__':
    create(Path(sys.argv[1]), int(sys.argv[2]))


def five_candidates(directory, rich=False, encoding='UTF-8'):
    """독립적인 작은 충돌 기대값을 가진 다섯 합성 DB를 만든다."""
    result = {}
    for role in ('D1', 'D2', 'D3', 'D4', 'D5'):
        path = directory / (role + '.db')
        create(path, 15 if role == 'D1' else 10, encoding if role == 'D1' else 'UTF-8')
        with sqlite3.connect(path) as conn:
            if rich:
                if role == 'D1': conn.execute('insert into meta values (?,?)', ('nul-text', '한글\x00끝'))
                if role in ('D1', 'D2'):
                    conn.execute("insert into run values (1,'2026-01-01',1,null,'running','')")
                    conn.execute("insert into fetch_error values (1,1,'day','2026-01-01','user_summary','transient','2026-01-01',1,'error')")
                conn.execute('insert into normalize_result values (?,?,?,?,?,?,?)', ('day','2026-01-01','user_summary',1,None,1700000000123,1700000000999))
            if rich and role == 'D2':
                conn.execute('insert into activity_recovery(activity_id,end_ms,end_bpm) values (42,1700000000000,100)')
            if role == 'D3':
                conn.execute('delete from raw_response')
                conn.execute('delete from daily_metric')
                conn.execute('insert into auth_event(local_date,logged_in_at) values (?,?)', ('2026-01-02', 1))
            elif role == 'D4':
                conn.execute('update raw_response set raw=?,checked_at=?', ('{"userProfileId":12345,"value":2}', 7))
                conn.execute('update daily_metric set steps=?', (100,))
                if rich: conn.execute('insert into raw_response values (?,?,?,?,?,?,?)', ('day','2026-01-01','body_battery','{"userProfileId":12345}',1700000000123,1700000000456,'test'))
                if rich: conn.execute('insert into normalize_result values (?,?,?,?,?,?,?)', ('day','2026-01-01','body_battery',1,None,1700000000123,1700000000999))
                if rich: conn.execute('insert into body_battery_sample(day_key,ts_ms,level) values (?,?,?)', ('2026-01-01',1700000000000,55))
            elif role == 'D5':
                conn.execute('update raw_response set checked_at=?', (8,))
                conn.execute('insert into raw_response values (?,?,?,?,?,?,?)', ('day', '2026-01-02', 'extra', '{"userProfileId":67890}', 1, 1, 'test'))
            if role == 'D1':
                if rich:
                    conn.execute('create table workout (activity_id integer primary key, date text not null, type text, start_ms integer, duration_s real, hr_avg real, hr_max real, zone1_s real, zone2_s real, zone3_s real, zone4_s real, zone5_s real, bb_change real, session_no integer)')
                    conn.execute('create table exercise_log (activity_id integer not null, exercise text not null, sets integer, reps real, max_kg real, volume_kg real, set_peak_hr_avg real, rest_drop_avg real, primary key(activity_id,exercise))')
                    conn.execute("create table evaluation (report_date text not null, scope text not null, summary text not null, judgments text not null, evidence text not null, next_checks text not null, report_md text not null, model text not null, created_at integer not null, primary key(report_date,scope))")
                    conn.execute("insert into workout(activity_id,date,type,duration_s) values (42,'2026-01-01','running',60)")
                    conn.execute("insert into exercise_log(activity_id,exercise,sets,reps) values (42,'squat',2,5)")
                    conn.execute("insert into evaluation values ('2026-01-01','day','합성','[]','[]','[]','본문','model',1)")
                    conn.execute("insert into activity(activity_id,day_key,type_key,start_ms,duration_s) values (42,'2026-01-01','running',1700000000000,60)")
                    conn.execute("insert into activity_hr_sample(activity_id,ts_ms,bpm) values (42,1700000000000,100)")
                    conn.execute("insert into exercise_set(activity_id,set_index,reps,weight_g,is_rest) values (42,0,5,1000,0)")
                    conn.execute("insert into hr_sample(day_key,ts_ms,bpm) values ('2026-01-01',1700000000000,null)")
                    conn.execute("insert into stress_bb_sample(day_key,ts_ms,level) values ('2026-01-01',1700000000000,44)")
                    for endpoint in ('activity','activity_details','activity_exercise_sets'):
                        conn.execute('insert into raw_response values (?,?,?,?,?,?,?)', ('activity','42',endpoint,'{"userProfileId":12345}',1700000000123,1700000000456,'test'))
                        conn.execute('insert into normalize_result values (?,?,?,?,?,?,?)', ('activity','42',endpoint,1,None,1700000000123,1700000000999))
                    conn.execute("insert into notification values ('2026-01-01','error','합성',1700000000000)")
                    conn.execute("insert into delivery(local_date,kind,event,ok,reason,at) values ('2026-01-01','notify','error',0,'network',1700000000000)")
                conn.execute('create table day_summary(date text primary key, body text, extra text)')
                conn.execute('insert into day_summary values (?,?,?)', ('2026-01-01', None, '원문'))
        result[role] = path
    return result


def capture_manifest(directory, paths):
    # [ASSUMPTION] 합성 fixture는 정규화 version1 형식을 사용한다.
    roles = {'D1': 'development', 'D2': 'production', 'D3': 'development-before-change', 'D4': 'production-pre-epic5', 'D5': 'production-before-history-start'}
    artifact = directory / 'synthetic.txt'
    artifact.write_text('합성 자료', encoding='utf-8')
    value = {'version': 1, 'capture_id': 'synthetic-capture', 'datasets': [{'dataset': 'synthetic-' + role, 'source': roles[role], 'snapshot': paths[role].name} for role in ('D1', 'D2', 'D3', 'D4', 'D5')], 'files': [{'source': 'synthetic-document', 'snapshot': artifact.name, 'bytes': artifact.stat().st_size}]}
    path = directory / 'manifest.json'
    path.write_text(json.dumps(value), encoding='utf-8')
    return path, value
