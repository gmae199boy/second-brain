---
name: brain-config
description: Brain 사용자 설정을 조회하거나 변경해 달라는 요청에 사용합니다. 메신저 토큰 등록은 brain-channels 스킬을 사용합니다.
---

# 사용자 설정

먼저 `brain guide schema config --json`으로 요청한 `config get` 또는 `config set`과 인자를 확인한다. 명령이 없거나 확인에 실패하면 미구현 또는 확인 불가로 보고 중단하며 설정 파일·DB로 우회하지 않는다.

키가 없으면 사용자에게 묻는다. 일반 설정만 `brain config get <key> --json`으로 읽는다. 비밀 키인지 불명확하면 비밀로 취급한다. 비밀 키는 조회하지 않고 사용자가 직접 터미널에서 확인하도록 안내한다. CLI가 모든 확장 비밀 값을 가린다고 가정하지 않는다.

변경 전 키·비밀이 아닌 값·영향을 확인하고 사용자 변경 동의를 받는다. 일반 값은 `brain config set <key> <value> --json`으로 설정하고 같은 키를 재조회한다. 비밀 값은 사용자가 직접 터미널에서 `brain config set <key> -`의 stdin에 비밀 관리자 출력을 연결하도록 안내한다. 에이전트는 이 명령의 출력도 수집하지 않는다. 비밀은 인자·셸 기록·대화·로그에 넣거나 요청하지 않는다. 사용자가 완료했다고 하면 값 대신 완료 진술과 공개 상태만 보고한다.

`ok:false`나 비정상 종료는 오류 코드를 보고하고 중단한다. 값이나 비밀이 담길 수 있는 오류 원문을 그대로 복사하지 않는다. 쓰기 응답만으로 적용을 추정하지 않는다.

`agent.codex_path`는 비밀이 아닌 global 설정이며 이 컴퓨터의 Codex 실행 파일 절대 경로다. `brain config get agent.codex_path --json`으로 확인하고, 사용자가 지정한 실행 파일을 `brain config set agent.codex_path <절대경로> --json`으로 저장한다. CLI는 파일 실행 가능성과 `--version` 응답을 검증한다. 설치·setup·Garmin 확장 설치는 비어 있는 설정에만 자동 탐지한 경로를 저장한다. 잘못되거나 오래된 경로는 `brain doctor run --json` 경고를 확인하고 같은 설정 명령으로 고친다.

설치 기본 선택 중 `mirror.path`와 `update.auto`는 DB가 아닌 해당 홈의 config.toml에 저장하며 같은 config 명령으로 읽고 바꾼다. `mirror.path`는 절대 경로(`~` 확장 가능), `update.auto`는 true 또는 false다. 미러 경로 변경은 기존 데이터를 옮기지 않으며 자동 업데이트 변경은 다음 SessionStart부터 적용한다. `timezone`은 기존 DB 사용자 설정이고 유효한 IANA 이름을 사용한다. 설치는 이 값들을 질문하지 않고 기본값을 적용하므로 변경 요청을 받으면 해당 키를 설정하고 재조회한다. 임베딩은 런타임 미지원으로 계속 꺼져 있으며 켤 수 있는 설정 키는 없다. 하네스는 config 키가 아니라 외부 hook 연결이므로 brain-setup의 `setup connect`로 추가한다.

`agent.claude_path`도 비밀이 아닌 global 실행 파일 설정이다. `brain config set agent.claude_path <절대경로> --json`으로 저장하고 `brain doctor run --json`으로 확인한다. Claude native 업데이트를 위해 안정 launcher 경로를 유지한다. Claude Code 2.1.290 이상과 `claude auth login`의 구독 로그인(claude.ai)이 필요하며 API key·외부 provider 인증은 분석 자식에 전달하지 않는다.

Garmin 공통 분석 설정은 `garmin.analysis_agent`(`codex` 기본 또는 `claude`), `garmin.analysis_model`(명시 필수), `garmin.analysis_reasoning_effort`, `garmin.analysis_timeout_minutes`(기본 20분)다. 네 기간과 수동 기간 분석에 같은 선택을 적용한다. provider 변경 시 model과 effort도 함께 확인하며 미완성 조합은 실행 전에 거부한다. Claude는 `sonnet`·`opus` 또는 해당 `claude-sonnet-*`·`claude-opus-*` 모델 ID와 low/medium/high effort를 지원하고 xhigh/max는 Opus에 한정한다. Codex의 none/minimal을 Claude로 자동 변환하지 않는다. 체성분 intake는 항상 Codex이며 Claude 분석을 선택하면 intake는 Codex 로그인 기본 모델을 사용한다. 분석 선택이 API 과금 전환을 허용하지 않는다.
