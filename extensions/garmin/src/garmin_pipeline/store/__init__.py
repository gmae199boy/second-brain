"""Supervised PostgreSQL store for a single confirmed Garmin account.

The caller must bind every native SQL statement to ``conn.user_id`` and
``conn.connection_id``; no SQL is rewritten here. Use psycopg ``%s``
parameters and cursor row factories explicitly. Runtime identity is taken
only from the supervisor envelope, and the account must already exist in
``garmin.account_connections``. Schema migrations belong to the core runner.
"""
from __future__ import annotations

import contextlib
import contextvars
import json
import os
import re
import time
from dataclasses import dataclass
from typing import Iterator
from uuid import UUID

import psycopg
from psycopg.pq import TransactionStatus

NORMALIZE_VERSION = 8
NORMALIZE_VERSION_KEY = "normalize_version"
NATIVE_SCHEMA_VERSION = 19
_write_held = contextvars.ContextVar("garmin_write_held", default=False)
_report_held = contextvars.ContextVar("garmin_report_held", default=False)
_account_context = contextvars.ContextVar("garmin_account_context", default=None)


class StoreError(Exception):
    """Store contract or context failure."""


class ReportLockBusy(StoreError):
    pass


class LockTimeout(StoreError):
    pass


class SchemaMismatch(StoreError):
    def __init__(self, found: int | None, expected: int) -> None:
        super().__init__(f"Garmin schema version mismatch: found {found}, expected {expected}")
        self.found, self.expected = found, expected


class DbMissing(StoreError):
    pass


class MigrationError(StoreError):
    pass


class RawConflict(StoreError):
    """An existing raw identity cannot be changed."""


class StaleAttempt(StoreError):
    pass


@dataclass(frozen=True)
class AccountContext:
    user_id: UUID
    connection_id: UUID
    work_id: UUID
    attempt_token: UUID


class Cursor:
    """Restricted cursor: transaction ownership remains with the store."""
    def __init__(self, connection, cursor):
        self._connection, self._cursor = connection, cursor

    def execute(self, query, params=None, **kwargs):
        self._connection._validate_statement(query)
        self._cursor.execute(query, params, **kwargs)
        return self

    def executemany(self, query, params):
        self._connection._validate_statement(query)
        return self._cursor.executemany(query, params)

    def fetchone(self): return self._cursor.fetchone()
    def fetchall(self): return self._cursor.fetchall()
    def fetchmany(self, *args): return self._cursor.fetchmany(*args)
    def __iter__(self): return iter(self._cursor)
    @property
    def rowcount(self): return self._cursor.rowcount
    @property
    def description(self): return self._cursor.description
    def close(self): self._cursor.close()
    def __enter__(self): return self
    def __exit__(self, *args): self.close()


class Connection:
    """Scoped account context; writable statements require store.transaction.

    SQL itself must filter by both account keys; this API does not rewrite it.
    A private driver exists solely for the store's transaction and lock control.
    """
    def __init__(self, raw: psycopg.Connection, account: AccountContext, *, readonly: bool):
        self.__driver, self.account, self.readonly = raw, account, readonly
        self._depth = 0

    @property
    def user_id(self): return self.account.user_id
    @property
    def connection_id(self): return self.account.connection_id

    def _validate_statement(self, query):
        if not isinstance(query, str) or re.match(r"\s*(?:begin|start|commit|end|rollback|savepoint|release|prepare|set|reset)\b", query, re.I):
            raise StoreError("transaction control belongs to the store")
        if not self.readonly and (self._depth == 0 or _driver(self).info.transaction_status != TransactionStatus.INTRANS):
            raise StoreError("writable connection requires store.transaction")
        # No multi-statement SQL or comment-prefixed transaction control on this API.
        if not self.readonly and (";" in query or "--" in query or "/*" in query):
            raise StoreError("one uncommented statement is required")

    def execute(self, query, params=None, **kwargs):
        return self.cursor().execute(query, params, **kwargs)

    def executemany(self, query, params):
        with self.cursor() as cursor:
            return cursor.executemany(query, params)

    def cursor(self, *args, **kwargs):
        if not self.readonly and self._depth == 0:
            raise StoreError("writable cursor requires store.transaction")
        return Cursor(self, self.__driver.cursor(*args, **kwargs))

    def close(self): self.__driver.close()


def _driver(conn: Connection):
    # Internal use only: callers receive neither this object nor a raw cursor.
    return conn._Connection__driver


@contextlib.contextmanager
def supervised_account(account: AccountContext):
    """Bind a validated supervisor selection for this execution only."""
    token = _account_context.set(account)
    try:
        yield
    finally:
        _account_context.reset(token)


def _envelope():
    try:
        database_url = os.environ['BRAIN_DATABASE_URL']
        user_id = UUID(os.environ['BRAIN_USER_ID'])
        work_id = UUID(os.environ['BRAIN_WORK_ID'])
        token = UUID(os.environ['BRAIN_ATTEMPT_TOKEN'])
        selected = _account_context.get()
        identity = os.environ.get('BRAIN_ACCOUNT') if selected is None else None
        if selected is not None and (selected.user_id != user_id or selected.work_id != work_id or selected.attempt_token != token):
            raise ValueError('account context mismatch')
        if not database_url or (selected is None and not identity):
            raise ValueError('empty context')
    except (KeyError, ValueError, TypeError) as exc:
        raise StoreError('missing or invalid supervised account context') from exc
    return database_url, user_id, work_id, token, identity


def _connect(*, readonly: bool) -> Connection:
    database_url, user_id, work_id, token, identity = _envelope()
    options = '-c transaction_timeout=2000 -c statement_timeout=1900 -c lock_timeout=1500'
    raw = psycopg.connect(database_url, autocommit=True, **({} if readonly else {'options': options}))
    try:
        if readonly:
            raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        version = raw.execute('select garmin.native_schema_version()').fetchone()[0]
        if version != NATIVE_SCHEMA_VERSION:
            raise SchemaMismatch(version, NATIVE_SCHEMA_VERSION)
        selected = _account_context.get()
        if selected is None:
            row = raw.execute(
                'select connection_id from garmin.account_connections where user_id=%s and external_identity=%s',
                (user_id, identity),
            ).fetchone()
        else:
            row = raw.execute(
                'select connection_id from garmin.account_connections where user_id=%s and connection_id=%s',
                (user_id, selected.connection_id),
            ).fetchone()
        if row is None:
            raise StoreError('confirmed account connection not found')
        account = AccountContext(user_id, row[0], work_id, token)
        return Connection(raw, account, readonly=readonly)
    except BaseException:
        raw.close()
        raise


def _fence(conn: Connection) -> None:
    if conn.readonly:
        raise StoreError('write attempted on read-only connection')
    row = _driver(conn).execute('select garmin.attempt_valid(%s::uuid,%s::uuid)',
                       (conn.account.work_id, conn.account.attempt_token)).fetchone()
    if not row or not row[0]:
        raise StaleAttempt('stale or invalid Garmin attempt')


def account_write_lock_key(user_id, connection_id) -> str:
    return f'garmin:write:{user_id}:{connection_id}'


def _lock_key(conn: Connection, kind: str) -> str:
    if kind == 'write': return account_write_lock_key(conn.user_id, conn.connection_id)
    return f'garmin:{kind}:{conn.user_id}:{conn.connection_id}'


def _try_lock(conn: Connection, kind: str, *, transaction: bool) -> bool:
    fn = 'pg_catalog.pg_try_advisory_xact_lock' if transaction else 'pg_catalog.pg_try_advisory_lock'
    return bool(_driver(conn).execute(f'select {fn}(pg_catalog.hashtextextended(%s, 0))',
                             (_lock_key(conn, kind),)).fetchone()[0])


def _acquire(conn: Connection, kind: str, *, transaction: bool, timeout: float | None) -> bool:
    deadline = None if timeout is None else time.monotonic() + max(0, timeout)
    while True:
        if _try_lock(conn, kind, transaction=transaction):
            return True
        if deadline is not None and time.monotonic() >= deadline:
            return False
        time.sleep(0.1 if deadline is None else min(0.1, max(0, deadline - time.monotonic())))


@contextlib.contextmanager
def write_session(cfg) -> Iterator[Connection]:
    """Hold only a session advisory lock; external work happens while idle."""
    if _write_held.get():
        raise StoreError("nested write session")
    conn = _connect(readonly=False)
    held_token = None
    try:
        if not _acquire(conn, 'write', transaction=False, timeout=cfg.lock_wait_seconds):
            raise LockTimeout('Garmin write lock unavailable')
        held_token = _write_held.set(True)
        yield conn
    finally:
        if held_token is not None:
            _write_held.reset(held_token)
        conn.close()  # Session lock is released even on exception.


def read_connection(cfg) -> Connection:
    """Return a single read-only repeatable-read snapshot; caller closes it."""
    del cfg
    return _connect(readonly=True)


@contextlib.contextmanager
def transaction(conn: Connection) -> Iterator[Connection]:
    """A short atomic unit; the attempt's FOR SHARE locks survive until commit."""
    driver = _driver(conn)
    if conn.readonly and driver.info.transaction_status != TransactionStatus.INTRANS:
        raise StoreError('no active read snapshot')
    with driver.transaction():
        conn._depth += 1
        try:
            if not conn.readonly:
                _fence(conn)
            yield conn
            if not conn.readonly:
                _fence(conn)
        finally:
            conn._depth -= 1


@contextlib.contextmanager
def savepoint(conn: Connection) -> Iterator[Connection]:
    if not conn.readonly and conn._depth == 0:
        raise StoreError('savepoint requires a store transaction')
    with transaction(conn):
        yield conn


@contextlib.contextmanager
def report_session(cfg, blocking: bool) -> Iterator[None]:
    del cfg
    if _write_held.get() or _report_held.get():
        raise StoreError('nested report session or report inside write session')
    conn = _connect(readonly=False)
    held_token = None
    try:
        if not _acquire(conn, 'report', transaction=False, timeout=None if blocking else 0):
            raise ReportLockBusy('Garmin report lock unavailable')
        held_token = _report_held.set(True)
        yield
    finally:
        if held_token is not None:
            _report_held.reset(held_token)
        conn.close()


def write_lock_held(cfg) -> bool:
    del cfg
    if _write_held.get():
        return True
    conn = _connect(readonly=False)
    try:
        return not _try_lock(conn, 'write', transaction=False)
    finally:
        conn.close()


def identity_lock(conn: Connection, table: str) -> None:
    """Serialize identity allocation with explicit-ID native imports."""
    if table not in ('auth_event', 'run', 'fetch_error', 'delivery'):
        raise StoreError('invalid identity table')
    conn.execute('select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(%s,0))', ('garmin:sequence:' + table,))


def insert_run_unlocked(cfg, *, local_date: str, started_at: int, finished_at: int,
                        status: str, detail: str) -> None:
    del cfg
    conn = _connect(readonly=False)
    try:
        with transaction(conn):
            identity_lock(conn, 'run')
            conn.execute('''insert into garmin.run
                (user_id,connection_id,local_date,started_at,finished_at,status,detail)
                values (%s,%s,%s,%s,%s,%s,%s)''',
                (conn.user_id, conn.connection_id, local_date, started_at, finished_at, status, detail))
    finally:
        conn.close()


def upsert_raw(conn: Connection, *, scope: str, key: str, endpoint: str,
               payload: object, library_version: str, now_ms: int) -> None:
    """Save an immutable observation and publish the original SQLite current row."""
    if conn.readonly:
        raise StoreError("write attempted on read-only connection")
    raw = json.dumps(payload, ensure_ascii=False)
    try:
        raw.encode('utf-8')
    except UnicodeEncodeError:
        raw = json.dumps(payload, ensure_ascii=True)
    identity = (conn.user_id, conn.connection_id, scope, key, endpoint)
    with transaction(conn):
        # This is the same account key as write_session and native import.
        conn.execute('select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(%s,0))',
                     (account_write_lock_key(conn.user_id, conn.connection_id),))
        existing = conn.execute('select raw,fetched_at,checked_at,library_version from garmin.raw_current where user_id=%s and connection_id=%s and scope=%s and key=%s and endpoint=%s', identity).fetchone()
        conn.execute('insert into garmin.raw_observations(user_id,connection_id,scope,key,endpoint,raw,observed_at,library_version) values (%s,%s,%s,%s,%s,%s,%s,%s)', (*identity, raw, now_ms, library_version))
        if existing is None:
            current = (raw, now_ms, now_ms, library_version)
            # Preserve the first original in the existing immutable native table.
            conn.execute('insert into garmin.raw_response(user_id,connection_id,scope,key,endpoint,raw,fetched_at,checked_at,library_version) values (%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict do nothing', (*identity, *current))
        elif payload is None or existing[0] == raw:
            current = (existing[0], existing[1], now_ms, existing[3])
        else:
            current = (raw, now_ms, now_ms, library_version)
        conn.execute('insert into garmin.raw_current_state(user_id,connection_id,scope,key,endpoint,raw,fetched_at,checked_at,library_version) values (%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict (user_id,connection_id,scope,key,endpoint) do update set raw=excluded.raw,fetched_at=excluded.fetched_at,checked_at=excluded.checked_at,library_version=excluded.library_version', (*identity, *current))


def append_evaluation(conn: Connection, *, report_date: str, scope: str, summary: str,
                      judgments: str, evidence: str, next_checks: str, report_md: str,
                      model: str, created_at: int, message: dict | None = None, structured: dict | None = None) -> int:
    """Append a monotonically increasing revision while holding a transaction lock."""
    if conn.readonly:
        raise StoreError("write attempted on read-only connection")
    with transaction(conn):
        lock = json.dumps([str(conn.user_id), str(conn.connection_id), report_date, scope], separators=(',', ':'))
        conn.execute('select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(%s, 1))', (lock,))
        row = conn.execute('''insert into garmin.evaluation_revisions
            (user_id,connection_id,report_date,scope,revision,summary,judgments,evidence,next_checks,report_md,model,created_at,message,structured)
            select %s,%s,%s,%s,coalesce(max(revision),0)+1,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb
            from garmin.evaluation_revisions where user_id=%s and connection_id=%s and report_date=%s and scope=%s
            returning revision''', (conn.user_id,conn.connection_id,report_date,scope,summary,judgments,evidence,
                                    next_checks,report_md,model,created_at,json.dumps(message, ensure_ascii=False),json.dumps(structured, ensure_ascii=False),conn.user_id,conn.connection_id,report_date,scope)).fetchone()
        return row[0]


def latest_evaluation(conn: Connection, *, report_date: str, scope: str):
    return conn.execute('''select report_date,scope,summary,judgments,evidence,next_checks,report_md,model,created_at,revision
        from garmin.evaluation where user_id=%s and connection_id=%s and report_date=%s and scope=%s''',
        (conn.user_id,conn.connection_id,report_date,scope)).fetchone()


def successful_scope_results(conn: Connection, *, report_date: str, snapshot_id: str) -> dict:
    """동일 snapshot에서 이미 성공한 각 기간의 최신 구조체·revision을 반환한다."""
    rows = conn.execute('''select distinct on (scope) scope,revision,structured
        from garmin.evaluation_revisions
        where user_id=%s and connection_id=%s and report_date=%s
          and structured->>'snapshot_id'=%s and structured->>'schema_version'='garmin.scope_analysis.v2'
        order by scope,revision desc''', (conn.user_id,conn.connection_id,report_date,snapshot_id)).fetchall()
    return {scope:{'revision':revision,'structured':structured} for scope,revision,structured in rows}
