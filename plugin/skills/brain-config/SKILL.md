---
name: brain-config
description: Brain 사용자 설정을 조회하거나 변경해 달라는 요청에 사용합니다. 메신저 토큰 등록은 brain-channels 스킬을 사용합니다.
---

# 사용자 설정

먼저 `brain guide schema config --json`으로 요청한 `config get`, `config set` 또는 `config patch`과 인자를 확인한다. 명령이 없거나 확인에 실패하면 미구현 또는 확인 불가로 보고 중단하며 설정 파일·DB로 우회하지 않는다.

키가 없으면 사용자에게 묻는다. 일반 설정만 `brain config get <key> --json`으로 읽는다. 비밀 키인지 불명확하면 비밀로 취급한다. 비밀 키는 조회하지 않고 사용자가 직접 터미널에서 확인하도록 안내한다. CLI가 모든 확장 비밀 값을 가린다고 가정하지 않는다.

변경 전 키·비밀이 아닌 값·영향을 확인하고 사용자 변경 동의를 받는다. 일반 값은 `brain config set <key> <value> --json`으로 설정하고 같은 키를 재조회한다. 비밀 값은 사용자가 직접 터미널에서 `brain config set <key> -`의 stdin에 비밀 관리자 출력을 연결하도록 안내한다. 에이전트는 이 명령의 출력도 수집하지 않는다. 비밀은 인자·셸 기록·대화·로그에 넣거나 요청하지 않는다. 사용자가 완료했다고 하면 값 대신 완료 진술과 공개 상태만 보고한다.

`ok:false`나 비정상 종료는 오류 코드를 보고하고 중단한다. 값이나 비밀이 담길 수 있는 오류 원문을 그대로 복사하지 않는다. 쓰기 응답만으로 적용을 추정하지 않는다.

`agent.codex_path`는 비밀이 아닌 global 설정이며 이 컴퓨터의 Codex 실행 파일 절대 경로다. `brain config get agent.codex_path --json`으로 확인하고, 사용자가 지정한 실행 파일을 `brain config set agent.codex_path <절대경로> --json`으로 저장한다. CLI는 파일 실행 가능성과 `--version` 응답을 검증한다. 설치·setup·Garmin 확장 설치는 비어 있는 설정에만 자동 탐지한 경로를 저장한다. 잘못되거나 오래된 경로는 `brain doctor run --json` 경고를 확인하고 같은 설정 명령으로 고친다.

설치 기본 선택 중 `mirror.path`와 `update.auto`는 DB가 아닌 해당 홈의 config.toml에 저장하며 같은 config 명령으로 읽고 바꾼다. `mirror.path`는 절대 경로(`~` 확장 가능), `update.auto`는 true 또는 false다. 미러 경로 변경은 기존 데이터를 옮기지 않으며 자동 업데이트 변경은 다음 SessionStart부터 적용한다. `timezone`은 기존 DB 사용자 설정이고 유효한 IANA 이름을 사용한다. 설치는 이 값들을 질문하지 않고 기본값을 적용하므로 변경 요청을 받으면 해당 키를 설정하고 재조회한다. 임베딩은 런타임 미지원으로 계속 꺼져 있으며 켤 수 있는 설정 키는 없다. 하네스는 config 키가 아니라 외부 hook 연결이므로 brain-setup의 `setup connect`로 추가한다.


## Garmin 분석 프로필

Garmin 목표·목표 체중·기구·운동 선호·피해야 할 동작·평소 식사·음주 단위는 사용자 scope의 `garmin.analysis_profile`이다. 현재 프로필은 `brain config get garmin.analysis_profile --json`으로 조회한다. 값은 버전 있는 JSON 문자열이며 빈 문자열은 DB 프로필 미설정이다. 옛 분석 사본이나 건강 측정값에서 현재 프로필을 채우지 않는다.

사용자의 항목 변경 요청은 전체 문서 교체 대신 `brain config patch <key> <patch> --json`으로 처리한다. `<patch>`는 `set`(점 경로와 JSON 값의 객체), `unset`(점 경로 배열), 선택 `expected_value`(조회 결과의 전체 value 문자열)이며 stdin `-`도 지원한다. 변경 요청 자체가 구체적 값과 범위를 승인했다면 재승인을 요구하지 않는다. 요청하지 않은 항목을 보충하지 않는다. 먼저 현재 값을 읽고 명시한 항목만 수정한 뒤 같은 키를 재조회한다. DB_LOCKED는 동시 변경이므로 다시 조회해 사용자 요청 항목만 재적용한다.

- “목표 체중 75kg로”: `brain config patch garmin.analysis_profile '{"set":{"goals.target_weight_kg":75}}' --json`
- “목표 체중 해제”: `brain config patch garmin.analysis_profile '{"unset":["goals.target_weight_kg"]}' --json`
- “감량 우선”: `brain config patch garmin.analysis_profile '{"set":{"goals.primary":"감량"}}' --json`
- “음주 단위 소주 1병”: 기존 `alcohol_units`에서 kind=소주 항목만 추가·교체하고 다른 종류를 보존한 배열을 `set.alcohol_units`에 넣는다. 배열 수정·해제는 `expected_value`를 필수로 전달한다. 조회 때 받은 전체 value 문자열을 그대로 넣어 조회→수정 사이의 다른 종류 변경도 충돌로 보호한다. 빈 프로필에서의 명령은 `brain config patch garmin.analysis_profile '{"expected_value":"","set":{"alcohol_units":[{"kind":"소주","unit":"병"}]}}' --json`이다. 1단위가 1병이라는 뜻이며 병 용량·도수·열량은 추정하지 않는다.

지원 항목은 `goals.primary`(문자열), `goals.secondary`(문자열 배열), `goals.target_weight_kg`(양수 kg), `goals.target_date`(유효 YYYY-MM-DD), `height_cm`(양수 cm), `equipment.gym`·`equipment.home`(문자열 배열), `equipment.availability`(문자열), `preferences.preferred`·`preferences.avoid`·`constraints`(문자열 배열), `diet.usual_pattern`(문자열), `alcohol_units`(배열)이다. 음주 항목은 `kind`, `unit`을 요구하고 `ml`, `abv_percent`(0 초과 100 이하), `grams_alcohol`, `source`는 근거가 있을 때만 추가한다. 모든 개인 항목은 선택이며 빈 목록은 명시적 없음이다. 문서와 snapshot 문자열 인코딩은 각각 8KiB 이내여야 한다. `schema_version`은 1이고 항목 수정으로 바꾸지 않는다. 전체 교체가 명시된 경우에만 `brain config set garmin.analysis_profile - --json`으로 버전 1 문서를 저장한다.

변경은 다음 새 분석부터 반영된다. 이미 생성된 평가는 자동 변경되지 않는다. 오늘 평가에 반영하려면 사용자가 재생성을 요청했을 때 Garmin 운영 스킬의 `report-regenerate`를 사용한다. 단순 재발신은 저장 평가를 다시 보내므로 새 프로필을 적용하지 않는다.
