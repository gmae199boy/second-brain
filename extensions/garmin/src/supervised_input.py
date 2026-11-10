"""Pure validation of supervised Garmin envelopes and typed settings."""
import json
from uuid import UUID

from garmin_pipeline import store


_STRING_SETTINGS = {'garmin.timezone', 'garmin.connection_id', 'garmin.tokenstore', 'garmin.capture_manifest',
                    'garmin.legacy_conversation_id', 'garmin.analysis_agent',
                    'garmin.analysis_model', 'garmin.analysis_reasoning_effort'}
# 하위 호환 설정은 허용만 하고 분석·수집 입력으로 검증하거나 사용하지 않는다.
_ALLOWED = _STRING_SETTINGS | {'garmin.analysis_timeout_minutes', 'garmin.channel_conversation_id'}


def validate_settings(values):
    if not isinstance(values, dict) or not set(values) <= _ALLOWED:
        raise ValueError('invalid settings')
    if any(not isinstance(values[k], str) for k in _STRING_SETTINGS & values.keys()):
        raise ValueError('invalid string setting')
    if values.get('garmin.analysis_agent', 'codex') != 'codex':
        raise ValueError('invalid analysis agent')
    if 'garmin.analysis_model' in values and not values['garmin.analysis_model'].strip():
        raise ValueError('invalid model')
    if values.get('garmin.analysis_reasoning_effort', 'high') not in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh'):
        raise ValueError('invalid reasoning effort')
    timeout = values.get('garmin.analysis_timeout_minutes', 20)
    if type(timeout) not in (int, float) or not 1 <= timeout <= 9007199254740991 or int(timeout) != timeout:
        raise ValueError('invalid timeout')


def canonical_uuid(value):
    parsed = UUID(value)
    if str(parsed) != value:
        raise ValueError('non-canonical UUID')
    return parsed


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate snapshot key')
        result[key] = value
    return result


def decode_envelope(env, *, work_kinds, reject_duplicate_keys):
    if env['BRAIN_ABI_VERSION'] != '1' or env['BRAIN_WORK_KIND'] not in work_kinds or env['BRAIN_TARGET_KIND'] != 'extension':
        raise ValueError('wrong work')
    if not env['BRAIN_DATABASE_URL'].startswith(('postgres://', 'postgresql://')):
        raise ValueError('invalid database')
    generation = env['BRAIN_RUN_GENERATION']
    if not generation.isascii() or not generation.isdigit() or generation.startswith('0') or len(generation) > 9:
        raise ValueError('invalid generation')
    user = canonical_uuid(env['BRAIN_USER_ID'])
    account = store.AccountContext(user, canonical_uuid(env['BRAIN_TARGET_ID']), canonical_uuid(env['BRAIN_WORK_ID']), canonical_uuid(env['BRAIN_ATTEMPT_TOKEN']))
    if reject_duplicate_keys:
        snapshot = json.loads(env['BRAIN_SETTINGS_SNAPSHOT'], object_pairs_hook=_unique_object)
    else:
        snapshot = json.loads(env['BRAIN_SETTINGS_SNAPSHOT'])
    if not isinstance(snapshot, dict) or set(snapshot) != {'version', 'extension', 'user_id', 'values'} or type(snapshot['version']) is not int or snapshot['version'] != 1 or snapshot['extension'] != 'garmin' or snapshot['user_id'] != str(user):
        raise ValueError('invalid snapshot')
    values = snapshot['values']
    validate_settings(values)
    return account, values
