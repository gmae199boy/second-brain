# 16.2 구현 복구 보고

## 현재 상태

첫 단계는 지휘자에게 phase-ready로 전달했고 지휘자가 타입 검사와 native session fixture를 재검증했다. 현재 같은 Dispatch에서 제출별 승인·GUI 신원·FD 상속과 DB ACK 연결을 구현 중이며 이 단계는 아직 phase-ready가 아니다. 운영 auth와 HTTP는 닫혀 있다. 계획·티켓·frontmatter는 이 워커가 수정하지 않았으며 커밋도 하지 않았다.

## 변경 파일과 내용

- `apps/cli/test/sealed-garmin.test.ts`: 암묵적 any와 literal discriminant 타입 오류 두 건을 수정했다.
- `extensions/garmin/native/session.c`, `session.h`, `tests/session-fixture.c`: credentials 최초 1회 및 응답 이후 같은 세션 MFA 최대 3회를 강제한다. 중복 credentials, 선행 MFA, 미완료 credentials 우회, 재전송, 네 번째 MFA를 거부한다. production의 기존 boolean 승인 거부는 유지한다.
- `presence.c`, `presence.h`, `broker.c`, `broker.h`: nonce challenge에 work/attempt/lease/package/generation과 GUI PID·boot UUID·audit session·시작 시각·GUI instance·policy 및 동결 response generation·prompt를 결합한다. broker는 현재 peer와 기한을 검사하고 callback digest와 capability를 각각 한 번 소비한다. 생체 ACL 미검증 서명 경로는 승인 근거로 사용하지 않는다.
- `broker-service.c`, `submission-ipc.c`, `submission-ipc.h`: supervisor의 broker endpoint 준비·세션 등록·GUI 인스턴스 기록·기록 ACK 및 역할별 prompt/challenge/assertion/consume을 구현했다. worker의 consume 요청이 먼저 오면 callback까지 보관한다. broker는 GUI peer의 코드 신원/PID, 프로세스 시작 시각, boot UUID, audit session, 현재 console UID와 고정 policy generation을 대조한다. 생산 서비스는 선택 직후 폐기하며 합성 빌드에서만 선택을 통과시킨다.
- `auth-channel.c`, `auth-channel.h`: broker의 인증된 control 검증이 성공하기 전에는 worker가 비밀 frame의 첫 바이트도 읽지 않는 수락 함수를 추가했다. 검증이나 전송 실패는 채널을 닫고 IPC adapter는 broker 연결도 닫는다.
- `auth-ui.m`, `secure-prompt.m`, `secure-prompt.h`, `submission-ui.m`, `submission-ui.h`: UI의 고정 버퍼와 response generation을 challenge에 묶고 생체 gate callback에서 broker 확인 뒤 전용 FD로 전송하는 경로를 작성했다. UI는 인증된 XPC의 prompt와 전달 FD를 받는다. 실제 GUI 입력·생체·AX와 보호된 배치는 검증하지 않았다.
- `host-client.c`, `host-client.h`, `worker-service.c`: 인증 전용 start 요청에서 supervisor가 broker로부터 받은 socket을 host가 자식 FD 5로 spawn 상속한다. ACK 전 raw FD 대기 바이트가 읽히지 않는 합성 자식 검증을 추가했다.
- `supervisor-bootstrap.c`, `supervisor-bootstrap.h`: admission 확인 → broker FD → spawn → 프로세스 내구 기록 확인 → broker 등록/기록 → 일시정지 GUI 등록/재개 → worker ACK 순서를 묶는다. DB 기록과 GUI launch는 아직 호출 경계이며 실패 시 admission을 자동 해제하지 않는다.
- `gui-host.c`, `gui-host.h`: GUI 사용자 host의 고정 봉인 실행물 검사, 일시정지 spawn, PID/boot/audit session/시작 시각 수집, 재개와 종료 확인 부품을 작성했다. 실제 보호 supervisor와 GUI host의 인증된 서비스 연결은 아직 없다.
- 합성 시험 변경: `tests/broker-fixture.c`, `broker-service-client.c`, `presence-signature.c`, `session-fixture.c`, `worker-success-child.c`, `worker-success-client.c`, `check-broker-service.sh`, `check-peer.sh`; 신규 `tests/submission-fixture.c`, `submission-e2e.m`, `supervisor-bootstrap-fixture.c`, `gui-host-child.c`, `gui-host-fixture.c`, `check-gui-host.sh`.

## 검증

다음 명령은 모두 종료 0이다. native 서비스 시험은 샌드박스에서 Docker socket 및 일부 프로세스 검증이 거부되어 승인된 권한 경로로 실행했다. 시험은 합성 비밀·임시 서비스만 사용했다.

- `pnpm typecheck` — `/tmp/brain162g4-typecheck.log`.
- `pnpm exec vitest run --config /tmp/brain162-vitest.config.mjs` — 해당 sealed Garmin 단위 시험 1건 통과. 일반 Vitest 설정은 샌드박스의 Docker socket 거부로 시작하지 못했다.
- `UV_CACHE_DIR=/tmp/brain162-uv-cache uv run --project extensions/garmin --frozen python extensions/garmin/tests/check_auth_flow.py` — 동일 client MFA 및 합성 오류 검사 통과.
- `sh extensions/garmin/native/tests/check-peer.sh` — `/tmp/brain162g4-peer.log`. session, broker, 동시 callback·변조·만료, 합성 UI callback과 worker 수락, 승인 전 raw FD 미읽기, bootstrap 순서, 기타 기존 native 회귀.
- `sh extensions/garmin/native/tests/check-broker-service.sh` — `/tmp/brain162g4-broker.log`. 합성 launchd broker와 XPC 세 역할, OS GUI 신원 정보, broker 생성 FD, 승인 전 대기, callback 뒤 consume과 frame 전달, 재전송 거부.
- `sh extensions/garmin/native/tests/check-worker-success.sh` — `/tmp/brain162g4-host.log`. 합성 host 서비스의 spawn 상속 FD와 ACK 전 미읽기 및 종료 관찰.
- `sh extensions/garmin/native/tests/check-gui-host.sh` — `/tmp/brain162g4-gui.log`. 합성 코드서명 실행물의 GUI 중단 spawn, 신원 수집, 재개 및 종료 확인.
- `sh extensions/garmin/native/tests/check-worker-service.sh` — peer 미확인 자식 거부 통과. `git diff --check` 통과.

## 반드시 남은 작업과 한계

실제 보호 supervisor의 durable admission과 process identity DB commit을 `supervisor-bootstrap` 호출 경계에 연결하고, 실제 supervisor가 인증된 GUI host를 통해 정확한 GUI 실행 인스턴스를 시작·기록해야 한다. 현재 GUI host는 부품이며 XPC 서비스·설치·supervisor 연결이 없다. broker FD 전달, 실제 봉인 UI callback, 별도 worker 수락을 하나의 실제 supervisor/격리 PG attempt와 연결하고 취소·hold·잠금·sleep·사용자 전환·연결 상실·세대 변경 및 callback 경합을 검증해야 한다. 합성 UI callback과 동일 프로세스 역할 클라이언트는 실기 생체나 동일 UID/AX 공격 방어의 증거가 아니다. broker recorded 호출 자체는 DB commit 증명이 아니고 GUI PID/UUID 자체도 supervisor launch 증명이 아니다.

이후 D2B의 보호 DB/API와 CLI·hook·spool 이관, D5 tokenstore/egress 및 실제 HTTP 제어, D6 전체 T01–T28과 추가 반례·독립 리뷰, D7 이전 준비가 남아 있다. 운영 OrbStack 관리 경로 격리·봉인 설치·실계정·실기 생체·실제 운영 전환은 확인하지 않았다. 기존 사용자 변경인 계획 파일은 건드리지 않았다.

## 체크포인트 이후 추가 작업

- `gui-service.c`, `gui-client.c`, `gui-client.h`: GUI 사용자 launchd 서비스가 고정 policy의 supervisor만 XPC로 인증하고 고정 서명 실행물을 일시정지 spawn한 뒤 supervisor 요청에 따라 재개·그룹 종료를 확인한다. supervisor 요청별 OS 신원과 전용 인스턴스를 대조하고 종료 불명이면 새 실행을 허용하지 않는다. `tests/gui-service-client.c`, `tests/check-gui-service.sh`의 임시 사용자 launchd 서비스 시험에서 중단·재개·종료를 확인했다. 이는 같은 UID 합성 fixture이며 실제 서로 다른 principal 배포 증거가 아니다.
- `supervisor-native.c`, `supervisor-native.h`: 앞의 GUI 서비스 client와 broker/worker host 및 supervisor-bootstrap 순서를 조합한다. admission과 identity 기록은 여전히 실제 DB callback 연결이 필요한 상태다. `submission-ipc`에는 인증된 XPC 접속과 bounded 요청 및 supervisor용 broker 준비·등록 함수를 추가했다.
- 추가 시험: `sh extensions/garmin/native/tests/check-gui-service.sh` 종료 0. `check-broker-service.sh`, `check-worker-success.sh`, `check-peer.sh`도 변경 중 각각 재실행해 통과했다. GUI 서비스와 supervisor-native는 설치 policy·보호 supervisor·실제 DB와 아직 조합하지 않았고, 실기 승인과 전체 분리 프로세스 종단 검증은 미완료다.

## 별도 프로세스·격리 DB 종단 합성 검증

`sh extensions/garmin/native/tests/check-composed-auth.sh`는 네트워크가 없는 일회용 PostgreSQL 18과 별도 supervisor·broker·GUI host/UI·worker 프로세스를 띄워 admission 및 프로세스 신원을 시험 테이블에 commit한 뒤 worker ACK, credentials 1회 및 동일 채널 MFA 3회를 처리했다. 성공 로그는 `/tmp/brain162g4-composed.log`다. `BRAIN_FIXTURE_DENY_RECORD=1` 실행은 PostgreSQL 오류를 주입해 선행 admission은 남고 identity 기록과 ACK가 진행되지 않는 경로를 검사했으며 `/tmp/brain162g4-composed-denied.log`에 기록했다. `BRAIN_FIXTURE_CASE=1,2,3,4,5`의 별도 실행은 각각 변조 callback, 취소 후 callback, 선행 MFA, 중복 callback, 네 번째 MFA 반례를 확인했고 `/tmp/brain162g4-composed-tamper.log`, `-cancel.log`, `-order.log`, `-duplicate.log`, `-limit.log`에 기록했다.

시험은 실제 PostgreSQL commit과 OS 프로세스·XPC·상속 socket을 사용하지만 시험 테이블과 합성 생체 callback이다. 제품의 `brain.work_attempts`/Garmin 보호 admission 권위 스키마, 보호 principal·봉인 설치 및 실제 생체/AX는 이 결과로 검증되지 않았다. 같은 Dispatch에서 권위 스키마와 실제 supervisor 저장 경계를 계속 연결하고 있다.

## 권위 스키마 격리 검증 추가

`BRAIN_FIXTURE_AUTHORITY=1 sh extensions/garmin/native/tests/check-composed-auth.sh`는 core migration, 보호 work migration, Garmin migration 및 보호 role migration을 일회용 PostgreSQL에 적용한 뒤 `brain_protected_supervisor` session으로 실제 `garmin.reserve_work_admission`과 `brain.work_attempts`의 현재 attempt·취소·hold 확인 및 OS PID/시각 기록을 실행했다. 격리 서비스의 별도 supervisor·broker·GUI·worker에서 credentials 및 MFA 3회가 완료됐고 `/tmp/brain162g4-authority.log`에 기록됐다. `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_DENY_RECORD=1`은 DB 오류 후 실제 `garmin.admission_holder`가 남고 `brain.work_attempts.pid`가 null인 것을 확인했으며 `/tmp/brain162g4-authority-denied.log`에 기록됐다.

DB callback은 시험 전용 `docker exec psql` 구현이고 제품의 보호 supervisor가 사용하는 저장소 adapter가 아니다. migration은 격리 DB에서 SQL 파일을 적용한 시험으로 운영 설치 및 role provisioning·보호 엔진 격리를 증명하지 않는다. 실제 UI event handler와 broker control 소스는 연결됐으나 운영 broker 선택 경로는 차단되어 있고, 실기 LA callback과 보호된 구성 전체의 검증은 여전히 필요하다.

권위 스키마 모드에서 `BRAIN_FIXTURE_CASE=1`부터 `5`까지 각각 실행해 변조·취소·최초 MFA 역순·중복 callback·네 번째 MFA 거부도 모두 종료 0이었다. 로그는 `/tmp/brain162g4-authority-tamper.log`, `/tmp/brain162g4-authority-cancel.log`, `/tmp/brain162g4-authority-order.log`, `/tmp/brain162g4-authority-duplicate.log`, `/tmp/brain162g4-authority-limit.log`이다. 별도 worker는 credentials 1회와 MFA 3회에 동일한 인증 채널을 사용한다. 생체 callback은 합성이고 실제 Garmin client 호출은 이 시험에 없다.

## 보호 DB adapter 및 취소 경계

`supervisor-store.c/.h`는 이미 인증된 libpq 연결을 사용해 `brain_protected_supervisor` 세션과 실제 `garmin.reserve_admission` binding generation을 검증하고, 현재 attempt·취소·hold를 다시 확인해 PID/OS 시각/launch lease/connection epoch를 2초 transaction 상한으로 기록한다. `broker-store.c/.h`는 `brain_protected_broker` 세션의 실제 `garmin.admission_valid`를 각 prompt·challenge·callback·consume·send-ready·confirm 경계에서 확인한다. `broker-credential.c/.h`는 고정 설치 policy의 보호된 파일에서만 broker 연결 자격을 읽는 후보이며 실제 보호 설치와 서버 인증은 검증되지 않았고 운영 policy 기본값은 비활성이다. 시험 libpq는 임시 복사본이며 제품 배포 증거가 아니다.

`packages/postgres/protected-migrations/0029_protected_auth_revoke.sql`은 활성 auth의 cancel/hold/disable에 현재 attempt·lease·epoch의 broker 폐기 기록을 요구한다. `brain_supervisor_pg_revoke_action`은 인증된 broker의 capability 폐기 및 보유 socket shutdown ACK 뒤에만 폐기 기록과 고정 mutation을 한 transaction에 commit한다. claim/hold 충돌도 직렬화한다. 일반 CLI/hook의 실제 제한 API와 기존 단일 `runSupervisor` 조립은 아직 이 경로에 연결하지 않았다.

권위 role의 직접 변경은 폐기 증거가 없으면 거부되고, 정상 폐기 뒤에는 UI가 늦게 시도한 frame 전송이 실패하는 별도 프로세스·실제 격리 PostgreSQL 사례가 통과했다. `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_NATIVE_STORE=1 BRAIN_FIXTURE_CASE=12`, `13`, `14`의 명령은 각각 취소·hold·disable이며 로그는 `/tmp/brain162g4-revoke-direct-cancel.log`, `/tmp/brain162g4-revoke-direct-hold.log`, `/tmp/brain162g4-revoke-direct-disable.log`다. DB superuser가 trigger를 우회하는 별도 `BRAIN_FIXTURE_CASE=9` 주입에서는 이미 승인된 UI의 frame이 FD에 들어갈 수 있고 worker의 재확인이 library 전달을 막는다(`/tmp/brain162g4-native-hold-inflight.log`). 이는 DB/FD가 원자적이라는 증거가 아니며, 관리자 침해 범위와 제품 권위 경로를 분리한 결과다.

지휘자의 이전 정상 시험 exit 6은 당시 단계 증거가 부족해 원인을 단정하지 않았다. 이후 안정된 코드의 동일 명령 네 번과 기록 거부 한 번은 종료 0이었으며 `/tmp/brain162g4-stable-native-1.log`부터 `-4.log`, `/tmp/brain162g4-stable-denied.log`에 있다. 재발 시 raw 출력 대신 worker의 고정 종료 단계만 기록하도록 fixture를 보강했다.

추가 보호 경계: broker의 실 DB guard는 각 입력 전이와 worker 수락 전후에 `garmin.admission_valid`를 재조회하며, producer의 단회 `send_ready`와 worker의 사후 `confirm`을 구분한다. `brain.work_attempts`의 보호 launch lease/connection epoch를 기록하고 폐기 증거가 해당 세대와 일치해야 cancel/hold/disable이 통과한다. `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_RACE=1 sh extensions/garmin/native/tests/check-composed-auth.sh`는 이미 진행 중인 hold commit과 auth claim 경합, 그리고 이전 epoch 폐기 증거의 재사용 거부를 격리 PG에서 확인했다(`/tmp/brain162g4-claim-hold-race.log`). 이 증거 기록 함수는 보호 supervisor 내부에만 있어야 하며 일반 data API에 노출하면 안 된다.

실제 DB guard의 직접 권위 변경 주입은 `/tmp/brain162g4-native-cancel-db.log`, `-hold-db.log`, `-hold-callback.log`, `-hold-inflight.log`에 구분했다. 마지막 사례는 DB superuser가 fixture에서 trigger를 명시적으로 우회한 반례다. 제품 권위 사례는 `-revoke-direct-cancel.log`, `-revoke-direct-hold.log`, `-revoke-direct-disable.log`에 있으며 broker shutdown ACK 후에만 변경이 commit되고 늦은 send가 실패한다. 관리자 trigger 우회가 불가능하다고 주장하지 않는다.

## D4A 체크포인트: registry 일반화와 최종 범위

지휘자의 수정 지시에 따라 `packages/postgres/protected-migrations/0029_protected_auth_revoke.sql`은 Garmin 이름·확장명·hold 이름을 직접 해석하지 않는다. 보호 registry의 `requires_input_revoke`, `kind`, `extension_name`, `hold_group`을 사용하며 활성 일감의 group 변경도 거부한다. Garmin의 설정은 새 `extensions/garmin/protected-migrations/0010_input_revoke.sql`에만 등록한다. 등록은 보호 설치 metadata이며 다른 일반 확장을 privileged UID로 실행하는 경로를 추가하지 않는다.

추가 변경 파일은 `broker-credential.c/.h`, `broker-store.c/.h`, `gui-client.c/.h`, `gui-service.c`, `supervisor-store.c/.h`, `supervisor-native.c/.h`, `tests/check-composed-auth.sh`, `tests/check-gui-service.sh`, `tests/composed-supervisor.c`, `tests/composed-ui.m`, `tests/composed-worker.c`, `tests/fixture-code-hash.h`, `tests/gui-service-client.c`, 그리고 위 두 보호 migration이다. 이전 절의 native 파일과 fixture 변경도 그대로 포함한다. 계획 파일과 별도 D2B 조사 보고는 지휘자 소유이며 이 워커가 편집하지 않았다.

최신 `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_GENERIC=1 sh extensions/garmin/native/tests/check-composed-auth.sh`는 다른 합성 보호 auth kind의 cancel/hold/disable 거부, 유효한 폐기 뒤 허용, Garmin과 다른 확장 간 범위 분리, 일반 kind와 입력 폐기가 필요 없는 보호 kind의 비간섭, 활성 protected work의 group 위조 거부를 검증했다(`/tmp/brain162g4-generic-registry.log`). 최신 `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_RACE=1` 실행은 claim/hold 경합과 이전 epoch 증거 거부를 통과했다(`/tmp/brain162g4-claim-hold-race.log`). 최신 `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_NATIVE_STORE=1`의 정상 종단은 `/tmp/brain162g4-d4a-success.log`, CASE=12/13/14는 앞 절의 직접 cancel/hold/disable 로그, CASE=15/16은 `/tmp/brain162g4-revoke-stale-epoch.log`, `/tmp/brain162g4-revoke-db-failure.log`에 있으며 모두 종료 0이다. 최신 `pnpm typecheck`와 `git diff --check`도 통과했다.

D4A는 native 구성요소와 격리 PG adapter·폐기 순서의 검증 체크포인트다. 시험의 별도 supervisor는 제품 core `runSupervisor`가 아니며, UI 생체는 합성이고 protected OS principal·실제 OrbStack 관리 경로 격리·서명 설치·실제 AX·sleep/lock·운영 tokenstore는 입증하지 않았다. 특히 보호 credential 후보의 TCP 경로는 현재 verify-full을 요구하는 보수적 미검증 구현이며 실제 보호 엔진 인증·설치 policy 확정 전 활성화하지 않는다. 직접 superuser trigger 우회 시나리오에서 이미 전송된 frame은 in-flight로 구분하고 worker의 DB 재확인으로 library 전달을 막는다. DB와 FD를 원자적이라고 주장하지 않는다.

D4B의 기존 단일 core `runSupervisor`/제품 저장소·launcher·취소 API 조립, D2B B1–B6 및 일반 데이터·hook·spool 연결, D5 OS egress와 library HTTP, D6 전체 T01–T28·추가 반례·독립 리뷰, D7 이전 준비는 미완료다. 운영 auth/HTTP는 여전히 닫혀 있으며 이 체크포인트는 전체 구현 준비나 티켓 완료가 아니다.

## D4A 후속: credential 경계 검증

지휘자가 지적한 4097바이트 입력의 NUL 기록 범위 초과를 수정했다. 읽기는 최대 4097바이트까지 감지하되 4096바이트 초과를 종료 문자 기록 전에 거부하고, 읽기 전후 파일 크기·식별자·시각이 달라지거나 내부 NUL이 있으면 거부한다. root 소유의 쓰기 불가능한 부모 경로, ACL 및 심볼릭 링크 검사를 유지한다.

연결 문자열은 허용 목록만 받아들이며 외부 `hostaddr`, service, options, passfile, 복수 host/port 및 TLS 우회 설정을 거부한다. TCP는 검증된 root 소유 CA와 `verify-full`을 요구하고 DNS 결과가 단일 주소일 때만 내부 고정 주소로 접속한다. Unix socket은 보호된 root 소유 디렉터리만 허용한다. libpq 환경 변수를 제거하고 인증 관련 기본 탐색 경로를 제한한다. 이는 보수적인 후보 구현이며 실제 배포 신뢰 정책, DNS 지연, 운영 서버 TLS 및 보호 principal 설치 검증은 아직 남아 있다.

`sh extensions/garmin/native/tests/check-broker-credential.sh`는 AddressSanitizer로 0, 4095, 4096, 4097바이트, stat 이후 증가·감소, 내부 NUL, 안전하지 않은 경로와 허용 목록 위반, 복수 DNS 주소를 검사했고 종료 0이었다(`/tmp/brain162g4-credential.log`). 실제 네트워크 서버와의 TLS 연결 성공을 입증하는 시험은 아니다. D4B 이후 작업과 앞 절의 미완료 범위는 그대로다.

## D4B 진행 중: UI 및 Core 실행 신원

UI는 선택 ACK보다 먼저 온 인증된 FD와 prompt를 최대 두 건까지 보류하고 ACK 뒤 순서대로 처리하며, 오류·취소 시 보류 FD를 해제한다. `tests/ui-events-fixture.c`는 보류 순서·초과 거부·취소 시 FD 해제를 검사한다. 이는 queue 부품 시험이며 실제 `auth-ui` 이벤트 handler의 전체 합성 종단 시험을 대체하지 않는다. broker가 보호 admission의 tokenstore 대상을 전달하고 UI가 아직 미확정이라고 표시한다. broker는 제출 종류와 MFA 순번을 전달하고 UI는 범위 밖 값을 거부한다. 계정의 사람에게 의미 있는 추가 식별 정보와 실제 생체·AX 증거는 계속 확인해야 한다.

Core의 입력 채널 작업은 봉인된 실행 신원이 없으면 bootstrap 전에 닫히고, `recordSupervisedProcess`는 보호된 현재 attempt에 실제 launcher가 제공한 lease와 epoch를 PID·OS 시각과 함께 기록한다. PostgreSQL 구현은 보호 registry·취소·hold 및 기존 세대의 일치를 검사한다. 보호 supervisor에 registry 읽기 권한이 필요해 보호 migration에 부여했다. 아직 제품 native launcher와 Core는 연결되지 않았으므로 실제 OS에서 제공된 lease/epoch라는 종단 주장은 하지 않는다.

`pnpm exec vitest run packages/postgres/test/garmin-quarantine.test.ts`는 격리 DB의 임시 보호 supervisor 로그인으로 정상·중복 기록, stale token·lease·epoch를 확인했고 `/tmp/brain162g4-d4b-quarantine.log`에 있다. `pnpm exec vitest run --project core --project cli supervisor.test.ts sealed-garmin.test.ts`는 44개 시험이 통과했고 `/tmp/brain162g4-d4b-core-tests.log`에 있다. `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_NATIVE_STORE=1 sh extensions/garmin/native/tests/check-composed-auth.sh`는 표시 대상과 credentials 및 MFA 1–3 순번을 합성 GUI에서 확인했다(`/tmp/brain162g4-d4b-composed.log`). 최초 실행은 합성 UI가 이전 필드 수를 기대해 실패했고 fixture를 새 프로토콜에 맞춘 뒤 통과했다. D4B는 진행 중이며 native launcher·실제 단일 Core 종단·취소 API 통합 및 전체 후속 단계는 미완료다.

## 최종 인계: D4B 진행 중 관리상 중단

지휘자가 시간 초과로 작업 중지와 인계를 명시해 소스 편집을 중단했다. 최초 타입 오류·credentials 1회 및 동일 client MFA 최대 3회와 D4A native 구성요소는 앞 절대로 구현·검증됐다. D4B와 그 이후는 미완료이며 전체 구현 준비 또는 티켓 완료를 주장하지 않는다. 계획·티켓과 `story-mfa-0-g4-*.md` 조사 문서는 지휘자 소유로, 이 워커가 편집하지 않았다.

### D4B에서 추가한 실제 변경

- `apps/cli/src/daemon/sealed-native-bridge.ts`, `extensions/garmin/native/supervisor-bridge.c`: 고정 설치 후보 bridge, bounded 제어 frame, 실제 host worker PID·lease·epoch·마이크로초 시작 시각, stdout/stderr backpressure 및 실제 leader 종료 관찰을 연결했다. 입력 secret은 제어 frame으로 보내지 않는다. 인증된 host control과 해당 lease로 TERM/KILL을 보내는 inspector를 제공하며 임의 PID에 JS `process.kill`을 보내지 않는다. 실제 `startDaemonSupervisor`의 보호 서비스 조립은 아직 이 adapter를 호출하지 않는다.
- `supervisor-bootstrap.c/.h`, `supervisor-native.c/.h`, `supervisor-store.c/.h`: Core가 예약한 holder의 supervisor 전용 DB 재확인과 spawn, Core identity commit 뒤 broker 등록·GUI·worker ACK를 분리했다. 기존 native wrapper도 같은 단계 함수를 사용한다. `broker-credential.c/.h`는 supervisor와 broker의 고정 역할·별도 credential 연결을 구분한다.
- `packages/core/src/ports/process.ts`, `ports/store.ts`, `queue/supervisor.ts`, `packages/postgres/src/work.ts`: 입력 채널 실행의 보호 lease/epoch 및 정확한 시작 마이크로초를 현재 attempt에 기록하며 stale 세대와 미등록 신원을 거부한다. leader 관찰 불명 또는 입력 폐기 ACK 불명은 정산 시 unknown으로 보존한다. 종료·중단 경로는 broker 입력 폐기 ACK를 기다린 뒤 그룹 cleanup을 시작한다.
- `packages/postgres/protected-migrations/0029_protected_auth_revoke.sql`, `extensions/garmin/protected-migrations/0010_input_revoke.sql`, `packages/postgres/src/protected-input.ts`, `src/extensions.ts`, `src/work.ts`: 현재 보호 attempt에 pending→spawning 또는 pending→closed 상태를 부여하고, 미시작 cancel/hold/disable과 spawn 진입을 직렬화한다. 보호 supervisor만 내부 전이를 호출하고 이미 시작된 입력은 기존 broker 폐기 증거를 요구한다. 보호 registry 및 schema migration 읽기 권한과 Garmin의 현재 admission context 확인도 supervisor에 제한했다.
- `auth-ui.m`, `ui-events.h`, `secure-prompt.m/.h`, `broker-service.c`: selection ACK 이전의 인증된 FD/prompt를 bounded 보류하고 ACK 뒤 처리하며 취소 시 폐기한다. 보호 admission의 tokenstore 대상을 미확정이라고 표시하고 입력 종류와 MFA 순번을 표시한다. `tests/auth-ui-handler-fixture.m`은 실제 handler 함수를 호출하되 XPC 인증·입력·생체는 합성한다.
- `worker-service.c`와 해당 fixture는 leader reap과 남은 그룹의 불명을 분리했다. `tests/core-native-runner.mjs`, `check-composed-auth.sh`는 별도 native host/broker/GUI/worker, 실제 Core `runSupervisor`, 실제 PostgreSQL 보호 role 및 제품 adapter를 한 합성 attempt에 연결한다. 제품 설치 정책 검증 seam, 같은 UID, 합성 생체, 격리 trust DB는 운영 신원 증거가 아니다.

### 실행한 추가 검증

- `pnpm build`, `pnpm typecheck`, `git diff --check`: 통과. Core/CLI 회귀 `pnpm exec vitest run --project core --project cli supervisor.test.ts sealed-garmin.test.ts`: 3개 파일 44개 통과(`/tmp/brain162g4-d4b-core-tests.log`). 이 회귀는 뒤의 마지막 Core 폐기 hook 추가 전이므로 재실행해야 한다.
- `pnpm exec vitest run packages/postgres/test/garmin-quarantine.test.ts`: 보호 supervisor role에서 실제 identity의 마이크로초 보존, stale token/lease/epoch 거부, 미시작 cancel/hold/disable 및 시작 경합을 확인하고 통과(`/tmp/brain162g4-d4b-quarantine.log`). 마지막 app 역할 EXECUTE 거부 assert 추가 뒤에는 typecheck만 실행했으므로 해당 시험을 다시 실행해야 한다.
- `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_NATIVE_STORE=1 BRAIN_FIXTURE_SPLIT=1 sh extensions/garmin/native/tests/check-composed-auth.sh`: Core 소유 단계에 대응하는 분리 native 단계와 실제 격리 PG의 admission 검증·identity commit·ACK가 통과(`/tmp/brain162g4-d4b-split.log`). `BRAIN_FIXTURE_DENY_RECORD=1` 추가 실행은 identity 기록 거부 뒤 ACK 없이 admission을 보존했다(`/tmp/brain162g4-d4b-split-denied.log`); 그 실행은 이후 pending 상태 전이 추가 전이므로 재실행해야 한다.
- `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_NATIVE_STORE=1 BRAIN_FIXTURE_CORE=1 sh extensions/garmin/native/tests/check-composed-auth.sh`: 실제 Core claim→admission→실제 worker PID/lease/epoch 기록→ACK→합성 credentials 및 MFA 3회→ABI 결과·그룹 확인·정상 정산 및 admission 해제가 통과(`/tmp/brain162g4-d4b-core-native2.log`). 최초 실행은 bridge의 출력 EOF 누락으로 `ABI_OUTPUT_UNREADABLE`이었으며 EOF 전달을 고쳐 재실행했다. 이는 합성 worker이며 실제 Garmin library 또는 HTTP 성공이 아니다.
- 위 명령에 `BRAIN_FIXTURE_CORE_SIGNAL=1`을 더한 실행은 Core 종료 시 broker 폐기 ACK와 인증된 host 신호를 거쳐 합성 worker 종료 및 admission 보존을 확인했다(`/tmp/brain162g4-d4b-core-signal.log`). 동일 UID fixture이고 별도 principal에서의 신호 권한 증거가 아니다.
- `BRAIN_FIXTURE_DESCENDANT=1 sh extensions/garmin/native/tests/check-worker-success.sh`: leader reap이 남은 손자·열린 stdout과 구분되고 host 관찰이 불명으로 남는 것을 확인했다(`/tmp/brain162g4-d4b-descendant.log`). fixture가 같은 UID에서 직접 그룹을 정리했으며 제품의 leader 사망 후 안전한 native 그룹 신호·정리 증거는 아니다. 기본 `check-worker-success.sh`도 통과(`/tmp/brain162g4-d4b-worker.log`).
- `sh extensions/garmin/native/tests/check-peer.sh`: 실제 `auth-ui` handler의 ACK 전 FD/prompt, ACK 후 순서, selection 거부 시 FD 종료, prompt 역순 거부 및 기존 native fixture 통과(`/tmp/brain162g4-d4b-ui-handler.log`). handler 시험의 peer·channel·LA는 합성이다. `check-broker-credential.sh`의 ASan 경계와 분리된 DB role parser 시험도 통과(`/tmp/brain162g4-d4b-credential.log`).

### 다음 행동과 열린 위험

1. D4B 제품 진입점을 기존 단일 보호 `runSupervisor`에 실제 조립하고, 일반 확장은 비특권 host에 남긴다. 현재 bridge adapter는 합성 runner가 호출할 뿐 사용자 daemon이나 실제 보호 서비스 진입점에 연결되지 않았다. native host는 실제 worker에 ABI work/attempt/snapshot을 전달하지 않으므로 이를 고정 필드·검증된 설정으로 연결해야 한다.
2. 활성 입력의 실제 Core cancel/hold/disable API는 아직 broker revoke ACK와 DB mutation을 조합하지 않는다. C의 단일 attempt revoke_action 부품은 있으나 다중 활성 attempt의 전체 폐기·증거·원자 mutation, 응답 유실 재조회, shutdown/restart 복구는 미완료다. pending→spawning/closed의 안전성은 모든 보호 spawn 진입점이 begin 전이를 거치는지와 중단·동시 변경 반례까지 독립 검토해야 한다.
3. host는 leader reap 후 남은 그룹을 안전하게 신호할 수 없으면 unknown을 유지한다. 실제 별도 principal에서 lease 기반 host 신호, leader 사망 후 손자 및 PID 재사용에 대한 안전한 정리, inspector.signalGroup·재시작 복구를 구현·검증해야 한다. 합성 fixture가 직접 보낸 그룹 kill을 제품 정리 성공으로 해석하면 안 된다.
4. bridge parent의 일반 서명 Node만으로 임의 script를 승인하지 않도록 production은 `BRAIN_SEALED_SUPERVISOR_POLICY`와 고정 supervisor 실행 경로를 요구한다. 이는 봉인된 supervisor package·loader 및 주입 방지의 실제 입증이 아니며 보호 설치·별도 principal·서명·OrbStack 관리 경로가 검증되지 않아 production 입력/HTTP는 계속 닫혀 있다. compile-time cdhash 구성의 상호 의존과 실제 root 소유 정책 배포 방식도 해결해야 한다.
5. 표시 대상의 사람에게 의미 있는 계정 식별 및 실제 OS 생체·AX·sleep/lock/user 전환을 별도로 검증한다. UI handler 시험은 실제 handler 경로지만 인증·channel·생체 callback을 합성했다.
6. D2B B1–B6, D5 실제 library/egress, D6 T01–T28·추가 반례·독립 리뷰, D7을 계획 및 지휘자의 `story-mfa-0-g4-api-composition.md`, `story-mfa-0-g4-core-native-map.md`, `story-mfa-0-g4-matrix-map.md`에 따라 수행한다. D4A 이후 변경된 보호 migration에 대해 generic/race/revoke CASE 전체를 재실행하고 신규 변경을 독립 보안 검토한다.

운영 DB·실계정·운영 tokenstore·배포는 사용하지 않았고 커밋·push·티켓 상태 변경은 하지 않았다. 현재 중단 사유는 지휘자의 관리상 finalize 지시이며 위 범위는 미구현 또는 미검증 상태다.
