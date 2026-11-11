"""Supervised report ABI entry; never reveal private inputs or diagnostics."""
import json


def main():
    try:
        import period_analysis_runtime as runtime
        from garmin_pipeline import report, store
    except Exception:
        print(json.dumps({'abi': 1, 'type': 'error', 'code': 'REPORT_UNAVAILABLE', 'retryable': True}))
        return 1
    try:
        summary = runtime.run()
    except runtime.InvalidReportInput:
        event = {'abi': 1, 'type': 'error', 'code': 'REPORT_INVALID', 'retryable': False}
    except store.StaleAttempt:
        event = {'abi': 1, 'type': 'error', 'code': 'REPORT_STALE', 'retryable': False}
    except (store.LockTimeout, store.ReportLockBusy):
        event = {'abi': 1, 'type': 'error', 'code': 'REPORT_LOCKED', 'retryable': True}
    except report.SupervisedReportFailed:
        event = {'abi': 1, 'type': 'error', 'code': 'REPORT_FAILED', 'retryable': True}
    except Exception:
        event = {'abi': 1, 'type': 'error', 'code': 'REPORT_UNAVAILABLE', 'retryable': True}
    else:
        print(json.dumps({'abi': 1, 'type': 'result', 'summary': summary}))
        return 0
    print(json.dumps(event))
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
