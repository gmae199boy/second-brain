"""실데이터를 포함하지 않는 schema10/15 시험 입력 생성기."""
import sqlite3
import sys
from pathlib import Path


def create(path, version=15):
    if version not in (10, 15):
        raise ValueError('지원하지 않는 시험 버전')
    import tarfile
    archive = Path(__file__).resolve().parents[3] / '_bmad-output/personal-brain/prep-garmin-absorption/inputs/garmin-source.tar.gz'
    with tarfile.open(archive, 'r:gz') as bundle, sqlite3.connect(path) as conn:
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
