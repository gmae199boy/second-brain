"""고정 어휘로만 실패 사유를 남긴다. 라이브러리 예외·건강값·토큰 원문은 내보내지 않는다."""
import contextlib
import contextvars
import json
import re

from garmin_pipeline import errors

REASONS = frozenset((
    'expected_weight_range_object', 'expected_daily_weight_summaries_list',
    'expected_weight_summary_object', 'invalid_weight_summary_date',
    'expected_all_weight_metrics_list', 'expected_weight_metric_object',
    'weight_summary_date_mismatch', 'invalid_weight_date', 'invalid_range_date',
    'range_date_outside_request', 'expected_range_list', 'expected_range_row_object',
    'activity_range_pagination_limit',
))
_report = contextvars.ContextVar('fetch_error_reporter', default=None)


def diagnostic(error, endpoint):
    """허용한 형식 오류·HTTP 상태만 채택하고 다른 메시지는 고정 사유로 치환한다."""
    if isinstance(error, errors.InvalidResponse):
        reason = str(error) if str(error) in REASONS else 'invalid_response'
        code = 'invalid_response'
    else:
        code = 'transient' if isinstance(error, errors.Transient) else 'rejected'
        match = re.fullmatch(re.escape(endpoint) + r': HTTP ([1-5][0-9]{2})', str(error))
        reason = 'http_' + match[1] if match else ('request_failed' if code == 'rejected' else 'network_or_service_failure')
    return code, reason


def emit(endpoint, kind, reason):
    reporter = _report.get()
    if reporter is not None:
        reporter(json.dumps({'abi': 1, 'type': 'progress',
            'message': f'garmin.fetch_error:{endpoint}:{kind}:{reason}'}))


@contextlib.contextmanager
def progress_events(reporter=print):
    token = _report.set(reporter)
    try:
        yield
    finally:
        _report.reset(token)
