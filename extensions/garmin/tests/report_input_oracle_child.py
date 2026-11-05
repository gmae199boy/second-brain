"""Consume the shared synthetic fixture with the unchanged pinned SQLite source."""
import json
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

from garmin_pipeline import body, config, digest, report, report_input, store

fixture = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
with tempfile.TemporaryDirectory(prefix='report-oracle-') as tmp:
    root = Path(tmp)
    cfgfile = root / 'config.toml'
    cfgfile.write_text('environment = "dev"\ntimezone = ' + json.dumps(fixture['timezone']) + '\ntokenstore = ' + json.dumps(str(root / 'tokens')) + '\n', encoding='utf-8')
    cfg = config.load(cfgfile)
    with store.write_session(cfg) as conn:
        conn.execute("insert into run(local_date,started_at,status,detail,finished_at) values(?,?,'success','',?)", (fixture['date'], fixture['cutoff'], fixture['cutoff']))
        conn.execute("insert into run(local_date,started_at,status,detail) values(date(?,'-1 day'),?,'success','')", (fixture['date'], fixture['previous_cutoff']))
        for row in fixture['raw']:
            conn.execute('insert into raw_response(scope,key,endpoint,raw,fetched_at,checked_at,library_version) values(?,?,?,?,?,?,?)', (row['scope'],row['key'],row['endpoint'],row['body'],fixture['cutoff'],fixture['cutoff'],'test'))
        for table, rows in [('activity',fixture['activities']),('day_summary',fixture['day_summary']),('workout',fixture['workout']),('exercise_log',fixture['exercise_log'])]:
            for row in rows:
                columns = list(row)
                conn.execute('insert into ' + table + '(' + ','.join(columns) + ') values(' + ','.join('?' for _ in columns) + ')', tuple(row.values()))
        for row in fixture['evaluations']:
            conn.execute('insert into evaluation values(?,?,?,?,?,?,?,?,?)',(row['report_date'],row['scope'],row['summary'],json.dumps(row['judgments']),json.dumps(row['evidence']),json.dumps(row['next_checks']),row['report_md'],'fixture',fixture['cutoff']))
    (cfg.data_dir / 'body').mkdir(parents=True, exist_ok=True)
    for row in fixture['body']:
        (cfg.data_dir / 'body' / (row['measured_on'] + '.json')).write_text(json.dumps(row['sidecar']),encoding='utf-8')
    cfg.profile_path.parent.mkdir(parents=True,exist_ok=True)
    cfg.profile_path.write_text(fixture['profile'],encoding='utf-8')
    yesterday = date.fromisoformat(fixture['date']) - timedelta(days=1)
    previous = next ( (r for r in fixture['evaluations'] if r['report_date']==str(yesterday) and r['scope']=='day'), None)
    if previous:
        cfg.reports_dir.mkdir(parents=True,exist_ok=True)
        (cfg.reports_dir / (str(yesterday) + '.md')).write_text(previous['report_md'],encoding='utf-8')
    result = report_input.build(cfg,date.fromisoformat(fixture['date']),started_at=fixture['cutoff'])
    measurements = digest.build(result.manifest,result.days,result.activities,result.labels,result.body)
    report_input.write_json(result.path / 'digest.json', measurements)
    for scope in ('7d','30d','all'):
        report_input.build_period(cfg,result.path,date.fromisoformat(fixture['date']),scope)
    files = {str(p.relative_to(result.path)):p.read_text(encoding='utf-8') for p in result.path.rglob('*') if p.is_file()}
    schemas = Path(report.__file__).parent / 'schemas'
    contracts = {'prompts': [report.codex_prompt(['report-input/day']), *(report.codex_prompt(['report-input/period','profile.md'],scope=s) for s in ('7d','30d','all')), report.codex_prompt(['body/a.png'],intake=True)], 'schemas': {name:json.loads((schemas / name).read_text()) for name in ('body.schema.json','body_intake_output.schema.json','daily_analysis_output.schema.json','period_review_output.schema.json')}}
    measurement = json.loads((Path(sys.argv[1]).parent / 'report_v8/measurement.json').read_text(encoding='utf-8'))
    measurement_error = body._first_error(body._measurement_schema(body.load_schema()), measurement)
    print(json.dumps({'files':files,'contracts':contracts,'digest':measurements,'measurement_error':measurement_error},ensure_ascii=False))
