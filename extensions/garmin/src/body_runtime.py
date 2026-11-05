"""Narrow supervised body commands; no standalone configuration is loaded."""
import argparse
import json
import os
import sys
from datetime import date
from pathlib import Path

import report_runtime
import body_ipc
from garmin_pipeline import body, store


def execute(env, action, *, measured_on=None, sources=(), text=None, path=None):
    """Fence each account-scoped file operation with the current attempt."""
    account, cfg = report_runtime.envelope(env)
    with store.supervised_account(account), store.write_session(cfg) as conn:
        # Keep the attempt row locked through file publication and input moves.
        with store.transaction(conn):
            row = conn.execute(
                'select timezone from garmin.account_connections where user_id=%s and connection_id=%s',
                (account.user_id, account.connection_id),
            ).fetchone()
            if not row or row[0] != cfg.timezone:
                raise report_runtime.InvalidReportInput('account timezone mismatch')
            if action == 'pending':
                return body.pending(cfg)
            if action == 'write':
                if not isinstance(measured_on, date) or not isinstance(text, str):
                    raise ValueError('invalid write arguments')
                result = body.write(cfg, measured_on, sources, text)
                return {'measured_on': result.measured_on, 'body_path': result.body_path,
                        'processed': result.processed}
            if action == 'reject' and isinstance(path, str):
                return body.reject(cfg, path)
            raise ValueError('invalid body action')


def main(argv=None):
    parser = argparse.ArgumentParser(prog='body_runtime')
    commands = parser.add_subparsers(dest='action', required=True)
    commands.add_parser('pending')
    write = commands.add_parser('write')
    write.add_argument('measured_on')
    write.add_argument('--source', action='append', required=True)
    reject = commands.add_parser('reject')
    reject.add_argument('path')
    args = parser.parse_args(argv)
    try:
        measured_on = None
        if args.action == 'write':
            measured_on = date.fromisoformat(args.measured_on)
            if measured_on.isoformat() != args.measured_on:
                raise ValueError('invalid date')
        result = body_ipc.request(os.environ['BRAIN_BODY_IPC_DIR'], {
            'action': args.action, 'measured_on': measured_on.isoformat() if measured_on else None,
            'sources': list(getattr(args, 'source', ())),
            'text': sys.stdin.read() if args.action == 'write' else None,
            'path': getattr(args, 'path', None)})
        if args.action == 'pending':
            for item in result:
                print(item)
        elif args.action == 'write':
            print(json.dumps(result, ensure_ascii=False))
        else:
            print(result)
        return 0
    except Exception:  # Never expose database, paths, or measurement values on the command surface.
        print('body command failed', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
