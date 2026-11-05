"""Supervised Garmin collect ABI entry; never expose exception details."""
import json


def main():
    try:
        # Imports belong inside the ABI boundary too.
        import collect_runtime as runtime
    except Exception:
        print(json.dumps({'abi': 1, 'type': 'error', 'code': 'COLLECT_UNAVAILABLE', 'retryable': True}))
        return 1
    try:
        summary = runtime.run()
    except (runtime.InvalidCollectInput, runtime.CredentialEvidenceError):
        event = {'abi': 1, 'type': 'error', 'code': 'COLLECT_INVALID', 'retryable': False}
    except runtime.ScheduledCollectIncomplete:
        event = {'abi': 1, 'type': 'error', 'code': 'COLLECT_INCOMPLETE', 'retryable': True}
    except runtime.store.LockTimeout:
        event = {'abi': 1, 'type': 'error', 'code': 'COLLECT_LOCKED', 'retryable': True}
    except Exception:
        event = {'abi': 1, 'type': 'error', 'code': 'COLLECT_UNAVAILABLE', 'retryable': True}
    else:
        print(json.dumps({'abi': 1, 'type': 'result', 'summary': summary}))
        return 0
    print(json.dumps(event))
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
