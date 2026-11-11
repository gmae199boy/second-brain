---
name: operations
description: Garmin 수동 수집, 이관 사전 점검·이관·검증, 리포트 생성·재생성 또는 건강 수치·최근 평가 조회 요청에 사용합니다.
---

# Garmin 운영

먼저 `brain guide schema ext --json`으로 `ext status`와 `ext run`을 확인하고 `brain ext status garmin --json`으로 installed와 enabled를 확인한다. 미설치·비활성이면 그 상태를 안내하고 중단한다. 자동 설치·활성화하지 않는다. 조회 요청은 이어 `brain guide schema ext.garmin --json`으로 진입점과 입력 schema를 확인한다. 수동 일감은 core schema의 `ext run`을 사용하며 이름은 이 플러그인 `package/manifest.json`의 work.manual에서 확인한다. 현재 CLI는 manual을 ext.garmin 조회 명령으로 등록하지 않는다. 명령이 없거나 schema 확인이 실패하면 미구현 또는 확인 불가로 보고 중단하며 Python·DB 직접 실행으로 우회하지 않는다.

- `brain ext run garmin import-preflight --json`: 기존 자료 이관의 계정 귀속·선택·충돌 사전 점검이다.
- `brain ext run garmin import --json`: 확인된 capture manifest의 자료를 이관한다. 계정 귀속·범위·충돌·제외를 사전 점검 결과로 설명하고 명시적 사용자 동의 후 실행한다. manifest나 건강값을 추정해 만들지 않는다.
- `brain ext run garmin import-verify --json`: 이관 결과의 검증을 요청한다.
- `brain ext run garmin collect --target <connection-id> --json`: 외부 계정에서 실제 수집한다. 계정·기간·변경 영향을 확인하고 명시적 동의 후 실행한다. 로그인은 사용자가 직접 터미널에서 한다.
- `brain ext run garmin report --target <connection-id> --json`: 리포트 생성을 요청한다. 결과가 외부로 발신될 수 있으므로 날짜·대상·발신 범위를 설명하고 명시적 동의 후 실행한다.
- `brain ext run garmin report-regenerate --target <connection-id> --json`: 기존 리포트 재생성을 요청한다. 대체 범위와 외부 발신 가능성에 대해 명시적 확인 후 실행한다.
- 조회는 `brain ext garmin daily-values --input '<json>' --json`, `brain ext garmin period-summary --input '<json>' --json`, `brain ext garmin recent-evaluations --input '<json>' --json`을 사용한다. 입력 키·허용 지표는 현재 schema에서만 가져오고 연결·시간대는 config 스킬의 일반 키 조회로 확인한다. 건강 기간·NULL/0 구분과 집계는 core recall 스킬을 따른다. 최근 평가는 실제 반환된 근거와 범위만 보고한다.

수집·리포트·재생성의 target은 일반 설정 `garmin.connection_id`에서 읽은 정규형 UUID다. `brain guide schema config --json` 지원 확인 후 `brain config get garmin.connection_id --json`과 `brain config get garmin.timezone --json`으로 연결·시간대를 읽는다. 연결 ID가 없거나 UUID 형식이 잘못되었으면 접수하지 말고 설정 필요를 보고한다. 사용자 제공 값도 설정과 대조하고 다르면 확인한다. 이관 3개 manual은 capture manifest를 쓰므로 같은 target 계약을 임의 적용하지 않는다.

수동 작업에 필요한 `--target` 등 옵션은 core ext schema로 확인하고 값의 의미는 해당 manual의 요구에 따른다. schema만으로 일감 이름이나 target 의미를 알 수 있다고 가정하지 않는다. 이름만 보고 기본 계정·기간을 추정하지 않는다. 비밀번호·MFA·토큰을 요청·출력·저장하지 않고 인증 화면을 읽지 않는다. 공개 상태·집계와 종료 코드·오류 코드만 보고하며 건강 원문·개인 경로·비밀은 로그에 복사하지 않는다. 실패하면 중단하고 접수를 완료·검증 통과·발신 성공으로 말하지 않는다. 작업 후 공개 status를 다시 읽고 확인되지 않은 상태는 미확인으로 보고한다.
