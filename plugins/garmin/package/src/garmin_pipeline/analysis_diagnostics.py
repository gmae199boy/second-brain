"""Value-free diagnostics shared by a scope attempt and its provider adapter."""
from contextvars import ContextVar
from dataclasses import dataclass

DETAIL_CODES = {
    'missing training message': 'MESSAGE_MISSING',
    'failed training message': 'FAILED_MESSAGE_PRESENT',
    'duplicate evidence reference': 'EVIDENCE_DUPLICATE',
    'unknown evidence reference': 'EVIDENCE_UNKNOWN',
    'invalid limitation target': 'LIMITATION_TARGET',
    'limitation scope mismatch': 'LIMITATION_SCOPE',
    'measurement header mismatch': 'MEASUREMENT_HEADER',
    'workout state mismatch': 'WORKOUT_STATE',
    'missing strength finding': 'STRENGTH_MISSING',
    'invalid activity reference': 'ACTIVITY_REFERENCE',
    'activity type mismatch': 'ACTIVITY_TYPE',
    'missing incline limitation': 'INCLINE_LIMITATION',
    'missing aerobic finding': 'AEROBIC_MISSING',
    'unresolved evidence source': 'EVIDENCE_SOURCE',
    'agent output too large': 'OUTPUT_LIMIT',
    'provider model effort mismatch': 'PROVIDER_SELECTION',
    'agent result or capability invalid': 'AGENT_RESULT',
}
DETERMINISTIC = {'PROVIDER_SELECTION', 'OUTPUT_LIMIT', 'agent_capability_unsupported',
                 'agent_login_required'}

@dataclass
class Attempt:
    feedback: str | None = None
    code: str = 'SUCCESS'
    input_bytes: int = 0
    output_bytes: int = 0
    event_bytes: int = 0

current = ContextVar('garmin_analysis_attempt', default=None)


def code_for(reason, detail=''):
    if detail.startswith('스키마 불일치 '):
        return 'OUTPUT_SCHEMA'
    return DETAIL_CODES.get(detail, {
        'output_invalid': 'OUTPUT_INVALID', 'codex_failed': 'AGENT_EXIT',
        'agent_failed': 'AGENT_EXIT', 'codex_timeout': 'AGENT_TIMEOUT',
        'agent_timeout': 'AGENT_TIMEOUT', 'skill_failed': 'SKILL_FAILED',
        'agent_capability_unsupported': 'agent_capability_unsupported',
        'agent_login_required': 'agent_login_required',
    }.get(str(reason), 'ANALYSIS_FAILED'))
