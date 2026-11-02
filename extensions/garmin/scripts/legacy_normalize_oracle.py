#!/usr/bin/env python3
"""Opt-in: generate the frozen fixture using the archived, isolated v8 implementation."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[3]
ARCHIVE = ROOT / '_bmad-output/personal-brain/prep-garmin-absorption/inputs/garmin-source.tar.gz'
FIXTURE = ROOT / 'extensions/garmin/tests/fixtures/normalize_v8'

CHILD = r'''
import json, sqlite3, sys
from garmin_pipeline import normalize, store
fixture = json.loads(open(sys.argv[1], encoding="utf-8").read())
conn = sqlite3.connect(":memory:", autocommit=True)
store._migrate(conn, store._load_migrations())
for item in fixture["items"]:
    conn.execute("INSERT INTO raw_response(scope,key,endpoint,raw,fetched_at,checked_at,library_version) VALUES (?,?,?,?,?,?,?)", (item["scope"],item["key"],item["endpoint"],item["raw"],item["fetched_at"],item["fetched_at"],"synthetic"))
if fixture.get("history_start"):
    conn.execute("INSERT INTO meta(key,value) VALUES ('history_start',?)", (fixture["history_start"],))
normalize.run(conn,rebuild=True,timezone=fixture["timezone"])
out = {}
for table in normalize._DERIVED_TABLES:
    columns = [r[1] for r in conn.execute("PRAGMA table_info(" + table + ")") if r[1] != "normalized_at"]
    rows = [dict(zip(columns,row)) for row in conn.execute("SELECT " + ",".join(columns) + " FROM " + table)]
    out[table] = sorted(rows, key=lambda row: json.dumps(row,sort_keys=True,ensure_ascii=False))
print(json.dumps(out,ensure_ascii=False,sort_keys=True,indent=2))
'''

def main():
    with tempfile.TemporaryDirectory(prefix='garmin-oracle-') as temporary:
        temp = Path(temporary)
        with tarfile.open(ARCHIVE, 'r:gz') as archive:
            archive.extractall(temp, filter='data')
        source = temp / 'garmin-source' / 'src'
        home = temp / 'home'
        home.mkdir()
        env = {'HOME': str(home), 'PYTHONPATH': str(source), 'PATH': os.defpath}
        result = subprocess.run([sys.executable, '-c', CHILD, str(FIXTURE / 'input.json')], cwd=temp, env=env, text=True, capture_output=True, check=True)
        (FIXTURE / 'expected.json').write_text(result.stdout, encoding='utf-8')

if __name__ == '__main__':
    main()
