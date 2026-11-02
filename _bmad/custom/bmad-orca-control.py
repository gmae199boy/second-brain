#!/usr/bin/env python3
"""Orca 제어 셸에서 실행하는 durable checkpoint·오류 복구 도구(Python 3.11+)."""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import uuid

VERSION = 1
SETTLED = {'completed', 'failed', 'stopped', 'cancelled'}
CAPACITY_TEXT = {
    'Selected model is at capacity. Please try a different model.',
    'The model is at capacity. Please try again later.',
    'The server is overloaded. Please try again later.',
}


class ControlError(Exception):
    pass


def atomic_json(path, value):
    fd, name = tempfile.mkstemp(prefix='.orca-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(name): os.unlink(name)


def timestamp(value):
    if isinstance(value, (int, float)):
        return value if value > 10**11 else value * 1000
    try:
        return dt.datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp() * 1000
    except (ValueError, TypeError):
        return None


def capacity_error(error):
    if not isinstance(error, dict): return False
    nested = error.get('error')
    code = error.get('code') or error.get('codex_error_info')
    if isinstance(nested, dict): code = code or nested.get('code') or nested.get('codex_error_info')
    if code == 'server_overloaded': return True
    return any(isinstance(error.get(key), str) and error[key] in CAPACITY_TEXT for key in ('text', 'message', 'error'))


def compact_message(message):
    payload = message.get('payload') or {}
    if isinstance(payload, str):
        try: payload = json.loads(payload)
        except ValueError: payload = {}
    if not isinstance(payload, dict): payload = {}
    fields = {'taskId', 'dispatchId', 'outcome', 'reportPath', 'filesModified', 'handle',
              'sessionId', 'requestId', 'agent', 'turnOutcome', 'failureKind', 'error', 'detail'}
    payload = {k: (v[:2048] if isinstance(v, str) else v[:32] if isinstance(v, list) else v)
               for k, v in payload.items() if k in fields}
    body = str(message.get('body') or '')
    return {**{k: message.get(k) for k in ('id', 'type', 'subject', 'from_handle', 'from')},
            'body': body[:2048], 'body_clipped': len(body) > 2048,
            'payload': payload}


class Control:
    def __init__(self, path, orca):
        self.path, self.orca = Path(path), orca
        self.state = None
        self.last_receipt = None

    def load(self):
        try:
            s = json.loads(self.path.read_text())
            mappings = ('workers', 'requests', 'capacity', 'reports', 'verification')
            if (not isinstance(s, dict) or s.get('version') != VERSION or
                type(s.get('revision')) is not int or s['revision'] < 0 or
                not all(isinstance(s.get(k), dict) for k in mappings) or
                not all(isinstance(s.get(k), str) and s[k] for k in ('run', 'caller', 'plan', 'baseline')) or
                not all(isinstance(s.get(k), str) for k in ('stage', 'next_action')) or
                type(s.get('last_capacity_scan')) not in (int, float) or
                not isinstance(s.get('events'), list) or not isinstance(s.get('decisions'), list) or
                s.get('orca') != self.orca):
                raise ValueError('invalid schema or changed Orca executable')
            for w in s['workers'].values():
                if not isinstance(w, dict) or not all(isinstance(w.get(k), str) and w[k] for k in ('task', 'dispatch', 'handle')):
                    raise ValueError('invalid worker identity')
            for req in s['requests'].values():
                if (not isinstance(req, dict) or not isinstance(req.get('id'), str) or not req['id'] or
                    not isinstance(req.get('args'), list) or not all(isinstance(x, str) for x in req['args']) or
                    req.get('outcome') not in ('prepared', 'sending', 'unknown', 'confirmed')):
                    raise ValueError('invalid request record')
            for event in s['capacity'].values():
                if (not isinstance(event, dict) or not all(isinstance(event.get(k), str) for k in ('dispatch', 'error', 'state')) or
                    type(event.get('at')) not in (int, float)):
                    raise ValueError('invalid capacity record')
            pending = s.get('pending_delivery')
            if pending is not None and (not isinstance(pending, dict) or not pending.get('deliveryId') or
                                        not isinstance(pending.get('messages'), list) or not pending.get('raw_receipt')):
                raise ValueError('invalid Delivery record')
            self.state = s
        except (OSError, ValueError, TypeError) as exc:
            raise ControlError(f'checkpoint unreadable or invalid: {exc}') from exc

    def save(self, expected=None):
        if self.path.is_symlink(): raise ControlError('checkpoint symlink refused')
        if expected is not None:
            try:
                disk = json.loads(self.path.read_text())
                if disk.get('revision') != expected: raise ControlError('stale revision')
            except (OSError, ValueError, AttributeError) as exc:
                raise ControlError('checkpoint changed or invalid') from exc
        self.state['revision'] += 1
        atomic_json(self.path, self.state)

    def commit(self):
        self.save(self.state['revision'])

    def call(self, *args):
        # 원문은 0600 파일에 보존한다. checkpoint와 모델 컨텍스트에는 작은 인덱스만 둔다.
        try:
            p = subprocess.run([self.orca, *args, '--json'], capture_output=True, text=True, timeout=60)
            raw = {'argv': list(args), 'stdout': p.stdout, 'stderr': p.stderr, 'exit': p.returncode}
            try: data = json.loads(p.stdout)
            except ValueError: data = None
        except (OSError, subprocess.TimeoutExpired) as exc:
            raw, data = {'argv': list(args), 'error': str(exc)}, None
        archive = self.path.parent / (self.path.stem + '.events')
        archive.mkdir(mode=0o700, exist_ok=True)
        receipt = archive / (str(uuid.uuid4()) + '.json')
        atomic_json(receipt, raw)
        self.last_receipt = str(receipt)
        self.state['events'] = (self.state['events'] + [
            {'file': str(receipt), 'command': list(args[:2]), 'exit': raw.get('exit'), 'at': time.time()}
        ])[-32:]
        self.commit()
        if not isinstance(data, dict) or data.get('ok') is not True or raw.get('exit') != 0:
            code = (data.get('error') or {}).get('code') if isinstance(data, dict) else 'unknown'
            raise ControlError(f'Orca result failed/unknown ({code}); raw: {receipt}')
        return data.get('result')

    def identity(self):
        status = self.call('status')
        current = self.call('orchestration', 'run-current')
        run = current.get('run') if isinstance(current, dict) else None
        # 새 Orca는 run-current를 {"runId": ...} 모양으로 돌려준다.
        if run is None and isinstance(current, dict) and isinstance(current.get('runId'), str):
            run = {'id': current['runId']}
        if not isinstance(run, dict) or run.get('id') != self.state['run']:
            raise ControlError('bound Run mismatch/unknown')
        caller = (status.get('caller') or {}) if isinstance(status, dict) else {}
        if caller.get('live') is True and caller.get('orcaSessionId') == self.state['caller']:
            return
        # Orca 셸의 status.caller는 null이다. 실제 환경 핸들·bound Run·live terminal을 대조한다.
        if (os.environ.get('ORCA_AGENT_SESSION_ID') or
            os.environ.get('ORCA_TERMINAL_HANDLE') != self.state['caller'] or
            run.get('coordinator_handle') != self.state['caller']):
            raise ControlError('coordinator caller mismatch/unknown')
        shown = self.call('terminal', 'show', '--terminal', self.state['caller'])
        terminal = shown.get('terminal') or {}
        if (terminal.get('handle') != self.state['caller'] or terminal.get('connected') is not True or
            terminal.get('writable') is not True or terminal.get('orphaned') is not False or
            terminal.get('executionHostId') != 'local' or not terminal.get('incarnationId')):
            raise ControlError('coordinator terminal not proven live')
        incarnation = terminal.get('incarnationId')
        previous = self.state.get('caller_incarnation')
        if previous and incarnation != previous: raise ControlError('coordinator terminal incarnation changed')
        if incarnation and not previous:
            self.state['caller_incarnation'] = incarnation; self.commit()

    def show(self, worker):
        r = self.call('orchestration', 'worker-show', '--dispatch', worker['dispatch'])
        d = r.get('dispatch', {}) if isinstance(r, dict) else {}
        # 새 Orca의 평평한 worker-show 모양을 같은 필드로 맞춘다.
        if not d and isinstance(r, dict) and r.get('dispatchId'):
            outcome = r.get('outcome')
            status = {'in_progress': 'dispatched', 'succeeded': 'completed', 'failed': 'failed'}.get(outcome) if outcome else (
                'completed' if r.get('state') in ('completed', 'settled', 'done') else 'dispatched' if r.get('terminalState') == 'active' else 'unknown')
            d = {'id': r['dispatchId'], 'taskId': r.get('taskId'), 'runId': r.get('runId'), 'assigneeHandle': r.get('terminal'), 'status': status}
            r = {**r, 'dispatch': d}
        if (d.get('id') != worker['dispatch'] or (d.get('taskId') or d.get('task_id')) != worker['task'] or
            d.get('runId') != self.state['run'] or d.get('assigneeHandle') != worker['handle']):
            raise ControlError('worker ownership mismatch/unknown')
        return r

    def fleet(self):
        rows, cursor, cursors = [], None, set()
        while True:
            args = ['orchestration', 'worker-list', '--run', self.state['run'], '--include-remote']
            if cursor: args += ['--cursor', cursor]
            r = self.call(*args)
            if not isinstance(r, dict) or not isinstance(r.get('workers'), list) or r.get('scope', {}).get('run') != self.state['run']:
                raise ControlError('fleet scope unknown')
            rows.extend(r['workers'])
            # 새 Orca는 한 페이지뿐이면 page를 생략한다.
            if 'page' not in r or r['page'] is None: return rows
            page = r['page']
            if page.get('hasMore') is False: return rows
            nxt = page.get('nextCursor')
            if page.get('hasMore') is not True or not nxt or nxt in cursors:
                raise ControlError('fleet pagination unknown')
            cursors.add(nxt); cursor = nxt

    def restore(self):
        self.identity()
        # 응답 손실/저장 직후 종료에도 같은 요청의 영수증으로 워커를 복원한다.
        for key, req in list(self.state['requests'].items()):
            if key.startswith('start:') and key[6:] not in self.state['workers']:
                result = self.request(key, req['args'])
                self.record_start(key[6:], result)
        fleet = self.fleet()
        for w in self.state['workers'].values():
            shown = self.show(w)
            if not any(x.get('dispatchId') == w['dispatch'] and x.get('taskId') == w['task'] for x in fleet):
                raise ControlError('recorded worker missing from fleet; do not relaunch')
            w['status'] = shown['dispatch'].get('status', 'unknown')
        self.commit()
        return self.summary(status='verified')

    def request(self, key, args):
        requests = self.state['requests']
        if key in requests:
            req = requests[key]
            if req['args'] != args: raise ControlError('request payload mismatch')
            if req.get('result') is not None:
                self.last_receipt = req.get('receipt')
                if not self.last_receipt: raise ControlError('cached request receipt missing; inspect raw events')
                return req['result']
            r = self.call('orchestration', 'request-show', '--request', req['id'])
            if not isinstance(r, dict) or r.get('state') not in ('completed', 'pending'):
                raise ControlError(f"request receipt unknown ({req['id']}); no fresh request; raw: {self.last_receipt}")
        else:
            req = {'id': str(uuid.uuid4()), 'args': args, 'result': None, 'outcome': 'prepared'}
            requests[key] = req; self.commit()
        req['outcome'] = 'sending'; self.commit()
        try: result = self.call(*args, '--retry-request', req['id'])
        except ControlError:
            req['outcome'] = 'unknown'; self.commit(); raise
        req['result'], req['outcome'], req['receipt'] = result, 'confirmed', self.last_receipt
        self.commit()
        return result

    def start(self, role, options):
        if not re.fullmatch(r'implementer|review(?:[-:][a-z0-9_-]+)?|research(?:[-:][a-z0-9_-]+)?', role):
            raise ControlError('unknown worker role')
        if (not isinstance(options, list) or not all(isinstance(x, str) for x in options) or
            any(x.split('=')[0] in ('--run', '--from', '--retry-request', '--json', '--terminal', '--on', '--environment', '--pairing-code') for x in options)):
            raise ControlError('invalid worker-start options')
        allowed = {'--spec', '--task-title', '--worktree', '--agent', '--model', '--effort'}
        parsed = {}
        if len(options) % 2: raise ControlError('worker-start options must be flag/value pairs')
        for flag, value in zip(options[::2], options[1::2]):
            if flag not in allowed or flag in parsed: raise ControlError('unsupported or duplicate worker-start flag')
            parsed[flag] = value
        model = 'gpt-6.1-terra' if role == 'implementer' else 'gpt-6.1-sol'
        if (not parsed.get('--spec') or not parsed.get('--worktree', '').startswith('path:') or
            parsed.get('--agent') != 'codex' or parsed.get('--model') != model or parsed.get('--effort') != 'medium'):
            raise ControlError('explicit checkout and configured role/model/effort required')
        self.restore()
        key = 'start:' + role
        if key not in self.state['requests'] and role == 'implementer':
            for row in self.fleet():
                # 새 Orca 행에는 dispatchStatus가 없고, release된 워커는 terminalState=released다.
                if row.get('dispatchStatus') not in SETTLED and row.get('terminalState') != 'released':
                    raise ControlError('active or unknown worker prevents duplicate implementer')
        result = self.request(key, ['orchestration', 'worker-start', *options, '--run', self.state['run']])
        self.record_start(role, result)
        return self.summary(status='started')

    def record_start(self, role, result):
        if not isinstance(result, dict): raise ControlError('start receipt unknown')
        task, dispatch = result.get('taskId'), result.get('dispatchId')
        handles = [x.get('id') for x in result.get('effects', []) if x.get('kind') == 'terminal' and x.get('role') == 'agent' and x.get('id')]
        # 새 Orca는 effects 대신 최상위 terminal에 agent handle을 둔다.
        if not handles and isinstance(result.get('terminal'), str) and result['terminal']:
            handles = [result['terminal']]
        if (not task or not dispatch or len(handles) != 1 or result.get('runId') != self.state['run'] or result.get('state') != 'ready'):
            raise ControlError('start receipt identity unknown; preserve request and inspect')
        launch = result.get('launch', {})
        # 새 Orca는 실제 적용된 agent/model/effort를 최상위에 둔다.
        if not launch and all(isinstance(result.get(k), str) and result[k] for k in ('agent', 'model', 'effort')):
            applied = {k: result[k] for k in ('agent', 'model', 'effort')}
            launch = {'requested': applied, 'effective': applied}
        w = self.state['workers'].get(role) or {'task': task, 'dispatch': dispatch, 'handle': handles[0], 'launch': launch}
        if (w['task'], w['dispatch'], w['handle']) != (task, dispatch, handles[0]):
            raise ControlError('start receipt changed worker identity')
        self.state['workers'][role] = w; self.commit()
        w['status'] = self.show(w)['dispatch'].get('status', 'unknown')
        self.commit()
        if not launch or launch.get('requested') != launch.get('effective'):
            raise ControlError('launch preferences missing or different; worker preserved')

    def transcript(self, w):
        # cursor는 EOF에서도 새 레코드를 따라간다. 상태에는 tool 출력 없이 마지막 32개만 남긴다.
        cursor = w.get('cursor')
        identity = w.get('source_identity')
        tail = list(w.get('tail', []))
        cursors, complete = set(), False
        for _ in range(64):
            args = ['orchestration', 'worker-read', '--dispatch', w['dispatch'], '--source', 'transcript', '--limit', '100']
            if cursor: args += ['--cursor', cursor]
            r = self.call(*args)
            if (not isinstance(r, dict) or r.get('dispatchId') != w['dispatch'] or r.get('source') != 'transcript' or r.get('provider') != 'codex' or
                not r.get('sourceIdentity') or r.get('archived') is True):
                raise ControlError('transcript source unavailable or archived')
            if identity and identity != r['sourceIdentity']:
                w['cursor'] = None; w['source_identity'] = None; w['tail'] = []; self.commit()
                raise ControlError('transcript source changed; next scan starts a fresh source')
            identity = r['sourceIdentity']
            t = r.get('transcript')
            if not isinstance(t, dict) or not isinstance(t.get('messages'), list): raise ControlError('transcript format unknown')
            for m in t['messages']:
                if not isinstance(m, dict) or not m.get('id') or not isinstance(m.get('blocks'), list):
                    raise ControlError('ambiguous transcript record')
                blocks = []
                for b in m['blocks']:
                    if not isinstance(b, dict): raise ControlError('ambiguous transcript block')
                    if b.get('type') == 'error':
                        error = {k: (v[:1024] if isinstance(v, str) else v)
                                 for k, v in b.items() if k in ('type', 'code', 'codex_error_info', 'text', 'message')}
                        if isinstance(b.get('error'), dict):
                            error['error'] = {k: v for k, v in b['error'].items() if k in ('code', 'codex_error_info')}
                        if any(b.get(k) is True or m.get(k) is True for k in ('truncated', 'clipped')):
                            error['clipped'] = True
                        blocks.append(error)
                    else: blocks.append({'type': b.get('type')})
                item = {'id': m['id'], 'role': m.get('role'), 'timestamp': timestamp(m.get('timestamp')), 'blocks': blocks}
                old = next((x for x in tail if x['id'] == item['id']), None)
                if old and old.get('timestamp') is not None and item['timestamp'] is not None:
                    item['timestamp'] = min(old['timestamp'], item['timestamp'])
                tail = [x for x in tail if x['id'] != item['id']] + [item]
                tail = tail[-32:]
            nxt = r.get('cursor') or t.get('nextCursor')
            # limited는 출력 클리핑에도 true다. 같은 cursor의 빈 페이지가 실제 EOF다.
            if t.get('limited') is False or (t.get('limited') is True and not t['messages'] and nxt and nxt == cursor):
                cursor, complete = nxt or cursor, True; break
            if t.get('limited') is not True or not nxt or nxt in cursors:
                raise ControlError('transcript pagination unknown')
            cursors.add(nxt); cursor = nxt
        w.update(cursor=cursor, source_identity=identity, tail=tail, tail_complete=complete)
        self.commit()
        if not complete: raise ControlError('transcript scan incomplete; preserved cursor for next scan')
        return identity, tail

    def provider_progress(self, m, after):
        mid = str(m.get('id', ''))
        kinds = {b.get('type') for b in m['blocks']}
        provider_output = mid.startswith('codex:') and bool(kinds & {'text', 'thinking'})
        provider_call = mid.startswith('orca:codex-item%3A') and 'tool-call' in kinds
        return (m.get('role') == 'assistant' and m.get('timestamp') is not None and
                m['timestamp'] > after and 'error' not in kinds and (provider_output or provider_call))

    def capacity_candidate(self, w, tail):
        errors = [m for m in tail if m.get('role') == 'assistant' and
                  any(b.get('type') == 'error' for b in m['blocks'])]
        latest = errors[-1] if errors else None
        native = w.get('native_capacity')
        other = w.get('native_other_error')
        if other and (not latest or latest.get('timestamp') is None or other['at'] >= latest['timestamp']):
            return None, 'latest native error is not verified capacity'
        candidate = None
        if latest and latest is tail[-1]:
            blocks = [b for b in latest['blocks'] if b.get('type') == 'error']
            if (latest.get('timestamp') is not None and len(blocks) == 1 and capacity_error(blocks[0]) and
                not blocks[0].get('clipped') and not any('truncated' in str(blocks[0].get(k, '')).lower() or '…' in str(blocks[0].get(k, '')) for k in ('text', 'message'))):
                candidate = {'id': latest['id'], 'at': latest['timestamp'], 'kind': 'transcript', 'transcript_error': latest['id']}
            else:
                if not native or latest.get('timestamp') is None or native['at'] < latest['timestamp']:
                    return None, 'latest transcript error is clipped, unsupported, or non-capacity'
        if native:
            if latest and (latest.get('timestamp') is None or latest['timestamp'] > native['at']) and not candidate:
                return None, 'newer transcript error supersedes native capacity'
            if not any(self.provider_progress(m, native['at']) for m in tail):
                if not candidate or native['at'] >= candidate['at']:
                    candidate = {**native, 'kind': 'native', 'native_request': native['request']}
                    if latest and all(capacity_error(b) for b in latest['blocks'] if b.get('type') == 'error'):
                        candidate['transcript_error'] = latest['id']
        return candidate, None

    def remember_delivery(self, result):
        # 새 Orca의 check 결과에는 runId가 없을 수 있다. 있으면 대조하고, 메시지는 아래에서 Dispatch·Task·handle로 귀속한다.
        if not isinstance(result, dict) or result.get('runId', self.state['run']) != self.state['run']:
            raise ControlError('Delivery Run mismatch')
        messages = result.get('messages')
        if not result.get('deliveryId'):
            # 새 Orca의 check는 deliveryId 없이 이미 소비한 messages를 돌려준다. 지역 Delivery로 보존하고 ack는 지역에서만 닫는다.
            if not isinstance(messages, list) or not messages: return
            if self.state.get('pending_delivery'):
                # 이전 지역 Delivery를 덮지 않고 메시지를 이어 붙인다.
                prev = self.state['pending_delivery']; messages = list(messages)
                result = {**result, 'deliveryId': prev['deliveryId']}
                self.state['pending_delivery'] = None
                prior = prev.get('messages') or []
            else:
                result = {**result, 'deliveryId': 'local:' + str(messages[0].get('id'))}; prior = []
        else:
            prior = []
        if not isinstance(messages, list): raise ControlError('Delivery messages missing')
        compact = [compact_message(m) for m in messages]
        self.state['pending_delivery'] = {'deliveryId': result['deliveryId'], 'count': len(prior) + len(compact),
                                          'messages': prior + compact, 'raw_receipt': self.last_receipt}
        for m, small in zip(messages, compact):
            payload = small['payload']
            for role, w in self.state['workers'].items():
                if (payload.get('dispatchId') != w['dispatch'] or payload.get('taskId') != w['task'] or
                    (m.get('from_handle') or m.get('from')) != w['handle']): continue
                if payload.get('reportPath'): self.state['reports'][m['id']] = payload['reportPath']
                if m.get('type') == 'status' and m.get('subject') == 'implementation-ready':
                    self.state['stage'] = 'implementation-ready'
                if m.get('type') == 'worker_done':
                    w['reported_outcome'] = payload.get('outcome'); self.state['stage'] = 'worker_done'
                # native runtime 오류 mail만 사용한다. 일반 worker escalation/인용은 제외한다.
                if (str(m.get('id', '')).startswith('msg_chaterr_') and m.get('type') == 'escalation' and
                    str(m.get('subject', '')).startswith('Agent hit an error: ') and
                    payload.get('handle') == w['handle'] and payload.get('sessionId') and
                    payload.get('requestId') and payload.get('agent') == 'codex'):
                    at = timestamp(m.get('created_at'))
                    if at is not None:
                        native = {'id': m['id'], 'at': at, 'request': payload['requestId'], 'session': payload['sessionId']}
                        if capacity_error(payload):
                            w['native_capacity'] = native
                            if w.get('native_other_error', {}).get('at', 0) <= at: w.pop('native_other_error', None)
                        else:
                            w['native_other_error'] = native
                            if w.get('native_capacity', {}).get('at', 0) <= at: w.pop('native_capacity', None)
        self.commit()

    def recover(self, role):
        self.identity()
        w = self.state['workers'][role]
        shown = self.show(w); d = shown['dispatch']
        if d.get('status') in SETTLED: return {'state': 'settled'}
        if d.get('status') not in ('pending', 'dispatched'): raise ControlError('Dispatch not active')
        self.recovery_host(shown)
        rows = [x for x in self.fleet() if x.get('taskId') == w['task']]
        if not rows or rows[0].get('dispatchId') != w['dispatch']: raise ControlError('not latest Dispatch')
        identity, tail = self.transcript(w)
        progress = [m for m in tail if m.get('timestamp') is not None]
        for event in self.state['capacity'].values():
            if event['dispatch'] == w['dispatch'] and event['state'] in ('enqueued', 'unconfirmed'):
                if any(self.provider_progress(m, event['at']) for m in progress):
                    event['state'] = 'recovered'; self.commit()
        candidate, reason = self.capacity_candidate(w, tail)
        if reason: return {'state': 'unknown', 'reason': reason}
        if not candidate:
            history = [e for e in self.state['capacity'].values() if e['dispatch'] == w['dispatch']]
            if history: return {'state': history[-1]['state']}
            return {'state': 'healthy-or-already-resumed'}
        if candidate.get('native_request') and candidate.get('transcript_error'):
            if any(e['dispatch'] == w['dispatch'] and e.get('transcript_error') == candidate['transcript_error'] and
                   e.get('native_request') and e['native_request'] != candidate['native_request']
                   for e in self.state['capacity'].values()):
                candidate.pop('transcript_error')
        key = hashlib.sha256(f"{w['dispatch']}\0{candidate['id']}".encode()).hexdigest()
        previous = self.state['capacity'].get(key)
        # 같은 실패의 transcript/native 관측을 한 요청에 연결한다. 불명확하면 두 번째 send를 보류한다.
        for saved_key, event in reversed(list(self.state['capacity'].items())):
            if event['dispatch'] != w['dispatch']: continue
            same_id = candidate['id'] == event['error'] or candidate['id'] in event.get('aliases', [])
            same_transcript = candidate.get('transcript_error') and candidate.get('transcript_error') == event.get('transcript_error')
            new_native_request = candidate.get('native_request') and event.get('native_request') and candidate['native_request'] != event['native_request']
            cross_source = (candidate['kind'] != event.get('kind') and not new_native_request and
                            not event.get('transcript_error') and not any(self.provider_progress(m, min(candidate['at'], event['at'])) for m in tail))
            if same_id or (same_transcript and not new_native_request) or cross_source:
                key, previous = saved_key, event
                previous['aliases'] = list(dict.fromkeys(previous.get('aliases', []) + [candidate['id']]))
                for field in ('native_request', 'transcript_error'):
                    if candidate.get(field): previous[field] = candidate[field]
                self.commit(); break
        if previous and previous['state'] != 'unconfirmed': return {'state': previous['state'], 'error': candidate['id']}
        if not previous:
            previous = {'dispatch': w['dispatch'], 'source': identity, 'error': candidate['id'],
                        'at': candidate['at'], 'state': 'unconfirmed', 'kind': candidate['kind']}
            for field in ('native_request', 'transcript_error'):
                if candidate.get(field): previous[field] = candidate[field]
            self.state['capacity'][key] = previous; self.commit()
        # Send 직전 같은 소유권과 최신 provider 진행을 다시 확인한다.
        again = self.show(w)
        if again['dispatch'].get('status') not in ('pending', 'dispatched'):
            return {'state': 'settled-before-send'}
        self.recovery_host(again)
        identity2, tail2 = self.transcript(w)
        if identity2 != identity or any(self.provider_progress(m, candidate['at']) or (m.get('role') == 'user' and m.get('timestamp') is not None and m['timestamp'] > candidate['at']) for m in tail2):
            previous['state'] = 'already-resumed'; self.commit(); return {'state': 'already-resumed'}
        fresh, reason = self.capacity_candidate(w, tail2)
        if reason or not fresh or fresh['id'] != candidate['id']:
            return {'state': 'unknown', 'reason': reason or 'error changed before send'}
        args = ['orchestration', 'send', '--to', 'dispatch:' + w['dispatch'], '--type', 'status',
                '--subject', 'capacity-resume', '--body',
                'capacity/server_overloaded 오류 뒤 같은 작업을 이어 가세요. 모델과 세션을 바꾸지 말고 기존 진행·실행 명령을 확인해 중복 실행하지 마세요.']
        self.request('capacity:' + key, args)
        previous['state'] = 'enqueued'; self.commit()
        return {'state': 'enqueued', 'error': candidate['id']}

    def recovery_host(self, shown):
        obs = shown.get('observation') or {}
        live = shown.get('projection', {}).get('liveness') or {}
        gap = live.get('verdict') == 'unverifiable' and live.get('reason') in ('missing_status', 'capability_unsupported')
        if (obs.get('exactWorker') is not True or obs.get('status') != 'live' or obs.get('addressable') is not True or
            (live.get('verdict') != 'live' and not gap)):
            raise ControlError('worker host/liveness unknown; no recovery input')

    def scan(self, force=False):
        if not force and time.time() - self.state['last_capacity_scan'] < 60: return {}
        result = {}
        for role in self.state['workers']:
            try: result[role] = self.recover(role)
            except ControlError as exc: result[role] = {'state': 'unknown', 'reason': str(exc)}
        self.state['capacity_scan'] = result
        self.state['last_capacity_scan'] = time.time(); self.commit()
        return result

    def check(self, timeout_ms):
        if not 1 <= timeout_ms <= 45000: raise ControlError('wait must be 1..45000 ms')
        self.identity()
        scans = {}
        if not self.state['pending_delivery']:
            # 최신 native 오류를 먼저 수신한다. 관측 시각이 됐으면 inbox를 짧게 읽고 바로 scan한다.
            until_scan = max(1, int((60 - (time.time() - self.state['last_capacity_scan'])) * 1000))
            r = self.call('orchestration', 'check', '--wait', '--timeout-ms', str(min(timeout_ms, until_scan)))
            self.remember_delivery(r)
            # 새 native 오류는 다음 1분을 기다리지 않고 처리한다.
            if any(str(m.get('id', '')).startswith('msg_chaterr_') for m in r.get('messages', [])):
                scans.update(self.scan(force=True))
            else: scans.update(self.scan())
        return self.summary(capacity=scans)

    def summary(self, **extra):
        return {'revision': self.state['revision'], 'plan': self.state['plan'], 'baseline': self.state['baseline'],
                'stage': self.state['stage'], 'next_action': self.state['next_action'],
                'workers': {role: {k: w.get(k) for k in ('task', 'dispatch', 'handle', 'status', 'reported_outcome')}
                            for role, w in self.state['workers'].items()},
                'reports': self.state['reports'], 'verification': self.state['verification'],
                'decisions': self.state['decisions'][-16:],
                'capacity_scan': self.state.get('capacity_scan', {}),
                'unconfirmed_requests': {k: {'id': r['id'], 'outcome': r.get('outcome'), 'receipt': r.get('receipt')}
                                         for k, r in self.state['requests'].items() if r.get('outcome') != 'confirmed'},
                'pending_delivery': self.state['pending_delivery'], **extra}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True); parser.add_argument('--orca', required=True)
    sub = parser.add_subparsers(dest='command', required=True)
    init = sub.add_parser('init')
    for name in ('plan', 'baseline', 'run', 'caller'): init.add_argument('--' + name, required=True)
    cp = sub.add_parser('checkpoint'); cp.add_argument('--revision', type=int, required=True); cp.add_argument('--data', required=True)
    start = sub.add_parser('start'); start.add_argument('--role', required=True); start.add_argument('--args', required=True)
    sub.add_parser('restore')
    check = sub.add_parser('check'); check.add_argument('--timeout-ms', type=int, default=45000)
    rec = sub.add_parser('recover'); rec.add_argument('--role', required=True)
    msg = sub.add_parser('message')
    for name in ('role', 'subject', 'body', 'key'): msg.add_argument('--' + name, required=True)
    ack = sub.add_parser('ack'); ack.add_argument('--delivery', required=True)
    a = parser.parse_args(); c = Control(a.state, a.orca)
    c.path.parent.mkdir(parents=True, exist_ok=True)
    if Path(str(c.path) + '.lock').is_symlink(): raise ControlError('checkpoint lock symlink refused')
    with open(str(c.path) + '.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if a.command == 'init':
            if c.path.exists(): raise ControlError('checkpoint already exists; restore it')
            if os.path.isabs(a.plan) or '..' in Path(a.plan).parts: raise ControlError('plan must be repository-relative')
            c.state = {'version': VERSION, 'revision': 0, 'orca': a.orca, 'plan': a.plan, 'baseline': a.baseline,
                       'run': a.run, 'caller': a.caller, 'stage': 'init', 'next_action': '', 'workers': {},
                       'reports': {}, 'verification': {}, 'decisions': [], 'pending_delivery': None,
                       'requests': {}, 'capacity': {}, 'events': [], 'last_capacity_scan': 0}
            c.save(); output = c.restore()
        else:
            c.load()
            if a.command == 'restore': output = c.restore()
            elif a.command == 'checkpoint':
                data = json.loads(a.data)
                if not isinstance(data, dict) or not set(data) <= {'stage', 'next_action', 'reports', 'verification', 'decisions'}:
                    raise ControlError('invalid checkpoint fields')
                if c.state['revision'] != a.revision: raise ControlError('stale revision')
                for key in ('stage', 'next_action'):
                    if key in data and (not isinstance(data[key], str) or len(data[key]) > 2048): raise ControlError('invalid checkpoint text')
                for key in ('reports', 'verification'):
                    if key in data and not isinstance(data[key], dict): raise ControlError('invalid checkpoint mapping')
                if 'decisions' in data and not isinstance(data['decisions'], list): raise ControlError('invalid decisions')
                c.state.update(data); c.commit(); output = c.summary(status='checkpointed')
            elif a.command == 'start': output = c.start(a.role, json.loads(a.args))
            elif a.command == 'recover': output = c.recover(a.role)
            elif a.command == 'check': output = c.check(a.timeout_ms)
            elif a.command == 'message':
                c.identity(); w = c.state['workers'][a.role]
                if c.show(w)['dispatch'].get('status') not in ('pending', 'dispatched'): raise ControlError('Dispatch is not active')
                c.request('message:' + a.key, ['orchestration', 'send', '--to', 'dispatch:' + w['dispatch'],
                          '--type', 'status', '--subject', a.subject, '--body', a.body])
                c.state['stage'] = 'finalizing' if a.subject == 'finalize' else 'fixing'
                c.state['next_action'] = 'wait for worker report'; c.commit(); output = c.summary(status='enqueued')
            elif a.command == 'ack':
                c.identity(); pending = c.state['pending_delivery']
                if not pending or pending.get('deliveryId') != a.delivery: raise ControlError('Delivery mismatch')
                if a.delivery.startswith('local:'):
                    c.state['pending_delivery'] = None; c.commit(); output = c.summary(acknowledged=a.delivery)
                    print(json.dumps(output, ensure_ascii=False)); return
                result = c.request('ack:' + a.delivery, ['orchestration', 'check', '--ack', a.delivery])
                if result.get('acknowledged') != a.delivery: raise ControlError('ack unconfirmed')
                c.state['pending_delivery'] = None
                c.remember_delivery(result); c.commit(); output = c.summary(acknowledged=a.delivery)
        print(json.dumps(output, ensure_ascii=False))


if __name__ == '__main__':
    try: main()
    except (ControlError, ValueError, KeyError, OSError, TypeError) as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
