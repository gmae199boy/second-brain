"""Run the archived report-input reader against the shared synthetic fixture."""
import json
import pathlib
import sqlite3
import sys
import tarfile
import tempfile
from datetime import date

fixture = json.load(open(sys.argv[1], encoding='utf-8'))
archive = pathlib.Path(sys.argv[2])
with tempfile.TemporaryDirectory(prefix='brain-input-oracle-') as tmp:
    root = pathlib.Path(tmp).resolve()
    with tarfile.open(archive) as tar:
        tar.extractall(root, filter='data')
    sys.path.insert(0, str(root / 'garmin-source/src'))
    from garmin_pipeline import config, report_input, store
    cfgfile = root / 'config.toml'
    cfgfile.write_text('environment = "dev"\ntimezone = ' + json.dumps(fixture['timezone']) + '\ntokenstore = ' + json.dumps(str(root/'tokens')) + '\n', encoding='utf-8')
    cfg = config.load(cfgfile)
    with store.write_session(cfg) as conn:
        conn.execute("insert into run(local_date,started_at,status,detail,finished_at) values(?,?,'success','',?)", (fixture['date'],fixture['cutoff'],fixture['cutoff']))
        conn.execute("insert into run(local_date,started_at,status,detail) values(date(?,'-1 day'),?,'success','')", (fixture['date'],fixture['previous_cutoff']))
        for row in fixture['raw']:
            conn.execute('insert into raw_response(scope,key,endpoint,raw,fetched_at,checked_at,library_version) values(?,?,?,?,?,?,?)', (row['scope'],row['key'],row['endpoint'],row['body'],fixture['cutoff'],fixture['cutoff'],'test'))
        for table, rows in [('activity',fixture['activities']),('day_summary',fixture['day_summary']),('workout',fixture['workout']),('exercise_log',fixture['exercise_log'])]:
            for row in rows:
                columns = list(row)
                conn.execute('insert into ' + table + '(' + ','.join(columns) + ') values(' + ','.join('?' for _ in columns) + ')', tuple(row.values()))
        for row in fixture['evaluations']:
            conn.execute('insert into evaluation values(?,?,?,?,?,?,?,?,?)',(row['report_date'],row['scope'],row['summary'],json.dumps(row['judgments']),json.dumps(row['evidence']),json.dumps(row['next_checks']),row['report_md'],'fixture',fixture['cutoff']))
    (cfg.data_dir/'body').mkdir(parents=True,exist_ok=True)
    for row in fixture['body']:
        (cfg.data_dir/'body'/f"{row['measured_on']}.json").write_text(json.dumps(row['sidecar']),encoding='utf-8')
    cfg.profile_path.parent.mkdir(parents=True,exist_ok=True)
    cfg.profile_path.write_text(fixture['profile'],encoding='utf-8')
    yesterday = date.fromisoformat(fixture['date']).fromordinal(date.fromisoformat(fixture['date']).toordinal()-1)
    previous = next((r for r in fixture['evaluations'] if r['report_date']==str(yesterday) and r['scope']=='day'),None)
    if previous:
        cfg.reports_dir.mkdir(parents=True,exist_ok=True)
        (cfg.reports_dir / f'{yesterday}.md').write_text(previous['report_md'],encoding='utf-8')
    result = report_input.build(cfg,date.fromisoformat(fixture['date']),started_at=fixture['cutoff'])
    (result.path/'digest.json').write_text(fixture['digest'],encoding='utf-8')
    for scope in ['7d','30d','all']:
        report_input.build_period(cfg,result.path,date.fromisoformat(fixture['date']),scope)
    print(json.dumps({str(path.relative_to(result.path)):path.read_text(encoding='utf-8') for path in result.path.rglob('*') if path.is_file()},ensure_ascii=False))
