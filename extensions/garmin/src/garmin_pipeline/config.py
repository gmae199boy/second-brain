"""Validated runtime settings supplied by the core supervisor snapshot."""
from dataclasses import dataclass
from datetime import time
from pathlib import Path
from typing import Literal

DB_FILENAME = "garmin.db"

@dataclass(frozen=True, kw_only=True)
class Config:
    """검증을 마친 설정. 경로는 모두 절대경로이고 `resolve`하지 않은 그대로다."""

    path: Path
    environment: Literal["runtime", "dev"]
    tokenstore: Path
    data_dir: Path
    reports_dir: Path
    inbox_dir: Path
    timezone: str
    collect_time: time
    retry_time: time
    report_time: time
    report_wait_minutes: int
    report_codex_timeout_minutes: int
    report_model: str | None
    report_reasoning_effort: str
    profile_path: Path
    date_pause_seconds: float
    call_pause_min_seconds: float
    call_pause_max_seconds: float
    max_dates_per_run: int
    max_rejected_attempts: int
    max_consecutive_403: int
    lock_wait_seconds: float
    cffi_api_session: bool

    analysis_profile: str | None = None
    profile_snapshot_id: str | None = None

    @property
    def db_path(self) -> Path:
        """SQLite DB 파일: `<data_dir>/garmin.db`."""
        return self.data_dir / DB_FILENAME
