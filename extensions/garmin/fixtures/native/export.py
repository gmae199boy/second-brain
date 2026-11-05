"""Use PYTHONPATH to choose pinned SQLite oracle or installed PG implementation."""
import sys
from datetime import date, time
from pathlib import Path
from types import SimpleNamespace
from garmin_pipeline import report_input

root=Path(sys.argv[1]); db=Path(sys.argv[2]); root.mkdir(parents=True,exist_ok=True)
cfg=SimpleNamespace(data_dir=root,db_path=db,timezone='Asia/Seoul',collect_time=time(11),
                    profile_path=root/'absent-profile.md',reports_dir=root/'reports')
result=report_input.build(cfg,date(2026,1,2),started_at=1767355200000)
for scope in ('7d','30d','all'):
    report_input.build_period(cfg,result.path,date(2026,1,2),scope)
