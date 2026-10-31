"""JSON 출처 분석 문자열의 단독 surrogate를 기존 SQLite 원문과 구분한다."""
import json
from raw_codec import project


def project_analysis(value):
    # SQLiteText는 str의 하위 타입이므로 원래 bytea/encoding 경로를 유지한다.
    if type(value) is str and any(0xd800 <= ord(char) <= 0xdfff for char in value):
        display = ''.join('\ufffd' if char == '\0' or 0xd800 <= ord(char) <= 0xdfff else char for char in value)
        return display, json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode('ascii'), 'json-string-v1'
    return project(value)
