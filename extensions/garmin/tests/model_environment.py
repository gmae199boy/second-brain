# 가짜 실행기 관측용 식별자는 시험 설치본에만 주입한다. 제품은 token을 전달하지 않는다.
import os as _fixture_os
_fixture_model_environment = _codex_env

def _codex_env():
    return {**_fixture_model_environment(), **{key: _fixture_os.environ[key] for key in
        ('BRAIN_EXTENSION_HOME', 'BRAIN_USER_ID', 'BRAIN_TARGET_ID', 'BRAIN_WORK_ID', 'BRAIN_ATTEMPT_TOKEN')
        if key in _fixture_os.environ}}
