# 16.2 g5 구현 보고

## D4B 첫 단계: 검증 요청

`apps/cli/src/daemon/protected-supervisor.ts`에 보호 서비스 조립 진입점을 만들었다. 기존 `runSupervisor`가 유일한 claim·admission·신원 기록 소유자이며, 고정 Garmin registry와 native bridge의 launcher·bootstrap·inspector를 연결한다. 설치용 진입점은 봉인 registry에서 bridge hash와 저장소 port를 받는다. 입력 없는 collect bootstrap은 아직 구현되지 않아 보호 kind로 예약만 하고 청구하지 않는다. 실제 보호 설치와 서비스 기동은 아직 연결·검증되지 않았고 운영 auth/HTTP는 열지 않았다.

`extensions/garmin/native/tests/core-native-runner.mjs`가 독자적인 조립 대신 이 제품 진입점을 호출한다. bridge는 auth work와 target, UUID, 세대 및 설정의 고정 필드를 검사하고 admission에서 확인한 target과 설정 target을 비교한다. native host는 인증된 연결에서 work/attempt/세대에 결합된 크기 제한 metadata를 검증해 worker control FD로 전달한다. worker는 bootstrap ACK 전에는 metadata를 읽지 않고, ACK 뒤 한 번만 읽어 고정 필드와 설정을 검증한다. 비밀번호·MFA·DB 자격은 metadata에 넣지 않는다. 일반 그룹 신호는 보호 PID가 아닌 경우 기존 inspector에 전달하며, 한 번 보호 PID였던 값은 재사용 시 일반 신호로 추측하지 않는다.

운영 host는 auth ACK에 metadata가 필수다. 기존 구성 요소 시험의 `BRAIN_NATIVE_FIXTURE`는 역사적으로 이 검사를 생략하지만, 새 host 경계 시험은 `BRAIN_FIXTURE_REQUIRE_METADATA`로 운영과 같은 필수 검사를 활성화한다. production 정책·서명·principal 검사까지 fixture가 증명하지는 않는다.

## 이번 검증

아래 로그는 합성 데이터와 일회용 DB만 사용한 이번 실행 결과다.

- `pnpm build`와 `pnpm typecheck`, `git diff --check`: 통과. 각각 `/tmp/brain162g5-build.log`, `/tmp/brain162g5-typecheck.log`, `/tmp/brain162g5-diff-check.log`.
- `pnpm exec vitest run packages/core/test/supervisor.test.ts packages/core/test/supervisor-abi.test.ts packages/postgres/test/work-store.test.ts apps/cli/test/sealed-garmin.test.ts apps/cli/test/sealed-launcher.test.ts apps/cli/test/process-group.test.ts packages/postgres/test/garmin-quarantine.test.ts apps/cli/test/sealed-native-bridge.test.ts`: 8개 파일 249건 통과(`/tmp/brain162g5-regression.log`). 일반 그룹 신호 비간섭과 보호 role EXECUTE 거부도 포함한다.
- `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_NATIVE_STORE=1 BRAIN_FIXTURE_CORE=1 sh extensions/garmin/native/tests/check-composed-auth.sh`: 실제 Core claim→admission→worker PID/lease/epoch 기록→ACK→합성 credentials·MFA→ABI 결과 및 정상 정산 통과(`/tmp/brain162g5-core.log`). worker가 ACK 후 work·세대·설정 metadata를 읽고 중복 읽기를 거부한다. DB는 신원 기록과 admission 해제를 확인한다.
- 위 명령에 `BRAIN_FIXTURE_CORE_RECORD=deny` 또는 `=lost`를 추가한 실행 각각 통과(`/tmp/brain162g5-core-deny.log`, `/tmp/brain162g5-core-lost.log`). deny는 실제 DB trigger로 신원 쓰기를 거부하고, lost는 실제 commit 성공 뒤 반환값을 유실된 응답으로 바꾼다. 두 경우 모두 Core authorize 호출 0, host ACK 0, broker prompt 0, 합성 worker의 ACK 이후 실행 표식 0, admission holder 보존을 검사했다. lost에서는 DB에 PID/lease가 남고 deny에서는 PID가 없다. 실제 Garmin library가 없는 합성 worker이므로 그 표식은 library 진입 전 경계의 대리 관찰이다.
- `BRAIN_FIXTURE_METADATA_CASE=1`부터 `5`까지 각각 `sh extensions/garmin/native/tests/check-worker-success.sh`: 정상 전달, attempt 변조, 중복, 크기 초과, 필수 metadata 누락 통과(`/tmp/brain162g5-metadata-1.log`부터 `-5.log`). 잘못된 host 요청에서 ACK가 없음을 검사한다. `sh extensions/garmin/native/tests/check-peer.sh`도 통과(`/tmp/brain162g5-peer.log`): worker 파서의 버전·길이·UUID·NUL·timezone·크기 거부와 ACK 전 read 거부를 포함한다. 파서 fixture 최초 실행은 송신 소켓을 너무 일찍 닫아 실패했고, 소켓 수명을 고친 뒤 재실행했다.
- `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_NATIVE_STORE=1 BRAIN_FIXTURE_SPLIT=1 BRAIN_FIXTURE_DENY_RECORD=1 sh extensions/garmin/native/tests/check-composed-auth.sh`: 분리 단계 기록 거부와 holder 보존 통과(`/tmp/brain162g5-split-deny.log`). `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_NATIVE_STORE=1 BRAIN_FIXTURE_CORE=1 BRAIN_FIXTURE_CORE_SIGNAL=1`의 동일 shell fixture도 통과(`/tmp/brain162g5-core-signal.log`).
- `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_GENERIC=1`과 `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_RACE=1`의 동일 shell fixture 통과(`/tmp/brain162g5-generic.log`, `/tmp/brain162g5-race.log`). `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_NATIVE_STORE=1 BRAIN_FIXTURE_CASE=12`, `13`, `14`, `16`도 각각 통과(`/tmp/brain162g5-revoke-12.log`, `-13.log`, `-14.log`, `-16.log`).
- CASE 15는 최초 병렬 실행에서 종료 8이었고 당시 별도 로그를 남기지 못했다. 소스에서 종료 8은 GUI 종료 확인 실패임을 확인했다. `brain_gui_cancel`의 단일 `waitpid`와 프로세스 신원 조회 사이에 자연 종료가 발생하면 재조회 없이 실패할 수 있고, reap 직후 그룹 열거가 지연되어도 즉시 실패할 수 있는 경합을 발견해, 신원이 확인된 경우만 신호하고 bounded 재조회로 실제 reap 및 빈 그룹을 확인하도록 고쳤다. 수정 후 `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_NATIVE_STORE=1 BRAIN_FIXTURE_CASE=15 sh extensions/garmin/native/tests/check-composed-auth.sh` 네 개 병렬 실행이 모두 통과했다(`/tmp/brain162g5-case15-1.log`부터 `-4.log`). 최초 실패의 내부 상태는 기록되지 않아 이 경합이 그 원인이었다고 단정하지 않는다.

샌드박스에서 Docker socket 접근이 거부된 최초 시험은 권한 경로에서 격리 컨테이너를 사용해 재실행했다. 실계정·운영 tokenstore·운영 DB는 사용하지 않았다.

## 남은 범위와 한계

이 단계는 합성 서비스와 격리 DB의 검증이며 실제 서명 설치, 별도 principal, 생체·AX, 보호 OrbStack 관리 경로 또는 운영 egress의 증거가 아니다. CASE 15 최초 실패의 정확한 내부 원인은 미확인이다. 입력 폐기·다중 attempt·복구, leader 종료 뒤 그룹 정리, D2B B1–B6, D5 library/egress, D6 전체 T01–T28과 독립 리뷰 및 D7은 남아 있다. 계획·티켓 상태 변경과 커밋은 하지 않았다.

## D4B 두 번째 단계: 세션 registry 하위 검증

`broker-service.c`의 전역 단일 세션을 supervisor 연결마다 최대 64개의 독립 세션으로 분리했다. worker와 UI는 인증된 XPC peer의 실제 PID를 이미 등록된 worker/GUI 인스턴스와 대조해 정확히 하나의 세션에 결합하며 중복·불일치는 닫는다. 연결 단절과 입력 폐기는 해당 세션에만 적용하고, broker DB 연결·guard·FD·대기 중 응답·생체 범위도 세션별이다. GUI 서비스도 supervisor 연결별 프로세스와 인스턴스를 보유하고, 종료가 불명이면 해당 인스턴스를 보존한다. 실제 서명 설치와 별도 principal은 fixture의 증거 범위 밖이다.

두 개의 합성 supervisor·broker 세션·GUI·worker를 같은 서비스에서 동시에 bootstrap ACK 이후 barrier에 세웠다. 한 세션만 폐기한 뒤 다른 세션은 credentials·MFA 합성 흐름과 결과까지 성공하고, 폐기한 세션은 입력을 받지 못한다. `BRAIN_FIXTURE_MULTI_SESSION=1 sh extensions/garmin/native/tests/check-composed-auth.sh` 통과(`/tmp/brain162g5-two-native-isolation.log`). 단일 구성 요소 회귀 `sh extensions/garmin/native/tests/check-broker-service.sh`, `sh extensions/garmin/native/tests/check-gui-service.sh` 통과(`/tmp/brain162g5-multi-broker-baseline.log`, `/tmp/brain162g5-multi-gui-baseline.log`). 실제 Core 단일 세션 회귀도 통과(`/tmp/brain162g5-multi-core-baseline.log`). 이 두 세션 시험은 독자 합성 supervisor이며 아직 실제 Core의 두 활성 attempt 또는 revoke-all 수락 증거가 아니다.

보호 서비스 내부 `protected-mutations.ts`와 PostgreSQL 전용 adapter는 모든 해당 활성 시도의 lease/epoch를 확인해 broker ACK를 수집한 뒤, 단일 짧은 트랜잭션에서 현재 목록을 재검사하고 pending 종료·폐기 증거·고정 mutation을 함께 기록한다. 목록 변경 시 재시도하고, ACK 실패나 연결 불명은 mutation을 거부하며, commit 응답 불명은 정확한 세대의 DB 상태로만 재확인한다. 증거 조회 권한은 보호 supervisor에만 추가했다. 실제 Core 단일 활성 native 시도의 cancel/hold/disable과 pending 추가 시도·연결 없는 추가 시도·목록 경합, ACK 실패·commit 응답 유실·bridge 종료 실패 닫힘의 격리 시험은 각각 `/tmp/brain162g5-core-mutation-cancel.log`, `-hold.log`, `-disable.log`, `/tmp/brain162g5-core-multi-pending.log`, `-missing.log`, `/tmp/brain162g5-core-mutation-race.log`, `/tmp/brain162g5-core-ack-fail.log`, `/tmp/brain162g5-core-commit-lost.log`, `/tmp/brain162g5-core-restart.log`에 있다. PostgreSQL 다중 증거 원자성과 사용자 role 거부는 `/tmp/brain162g5-mutation-pg.log`, ACK 순서와 실패 조립 단위 시험은 `/tmp/brain162g5-mutation-unit.log`에 있다. bridge 종료 후 증거가 불명인 기존 attempt는 보존하며 자동으로 새 세션을 재구성하지 않는다.

두 활성 시도의 실제 Core/PG/native revoke-all 종단, 보호 API의 기존 명령 의미와 조립, 별도 principal 및 종료 증명에 의한 완전 복구는 아직 미완료다. 이 절은 하위 checkpoint이며 두 번째 단계 전체 완료가 아니다.

## D4B 두 번째 단계: 보호 명령과 revoke-all

위 하위 checkpoint 이후 두 활성 attempt와 보호 명령을 연결했다. `createProtectedService`는 하나의 bridge registry와 하나의 보호 store를 Core 감독자와 기존 Brain 명령에 함께 제공하고, 제한된 `queue.cancel`, `queue.hold`, `extension.disable` API만 공개한다. 일반 kind는 기존 명령에 위임한다. 사용자 API는 attempt token·lease·epoch·폐기 증거 쓰기를 받지 않는다. 설치용 factory는 고정 bridge 검증을 사용하지만 인증된 외부 서비스 transport와 실제 보호 설치는 D2B/D1/D7에서 여전히 필요하다.

확인된 Garmin auth의 account 대상은 내부 보호 ID UUID로 표현하며, 보호 admission은 선택한 tokenstore binding의 보호 ID와 확인된 profile이 일치할 때만 허용한다. 기존 extension 대상 auth는 유지한다. work/attempt/세대뿐 아니라 대상 kind와 ID도 고정 metadata로 host와 worker에 전달하며 bridge는 실제 DB work 대상과 일치시킨다. 새 보호 migration `0011_auth_account_target.sql`이 적용된 함수를 덮어쓰지 않고 후속 버전으로 검증을 추가한다.

입력 폐기는 해당 범위의 현재 시도 모두에 대해 정확한 work/attempt/run/lease/epoch로 인증된 broker ACK를 수집한다. 그 뒤 짧은 transaction에서 목록을 다시 대조하고, 미spawn 전이 종료·폐기 증거·고정 mutation·명령 결과 receipt를 함께 commit한다. claim 경합으로 목록이 바뀌면 다시 조회하며, ACK 실패 또는 시작 신원 불명은 mutation을 하지 않는다. commit 응답이 유실된 경우에는 같은 요청의 receipt와 동일 시도 세대·증거를 조회해 기존 Core의 결과값을 복구한다. receipt와 증거 테이블은 사용자 DB role에 권한을 주지 않는다.

- `[ASSUMPTION]` broker와 GUI의 동시 세션 상한은 각각 64이며 초과·종료 불명은 보수적으로 처리한다. 목록 경합 재조회 상한은 3회이며 초과 시 실패 닫힌다. 실제 부하와 운영 복구 검증에서 재평가할 항목이다.
- `pnpm build`, `pnpm typecheck`, `git diff --check`: 통과(`/tmp/brain162g5-phase2-final-build.log`, `/tmp/brain162g5-phase2-final-typecheck.log`, `/tmp/brain162g5-phase2-final-diff.log`).
- `pnpm exec vitest run packages/core/test/protected-api.test.ts packages/core/test/supervisor.test.ts packages/core/test/supervisor-cancel.test.ts packages/postgres/test/work-store.test.ts apps/cli/test/protected-mutations.test.ts apps/cli/test/sealed-native-bridge.test.ts`: 6개 파일 258건 통과(`/tmp/brain162g5-phase2-regression-isolated.log`). `pnpm exec vitest run packages/postgres/test/garmin-quarantine.test.ts`: 1건 통과(`/tmp/brain162g5-phase2-quarantine-isolated.log`). 후자는 서로 다른 확인 계정의 동시 admission, 같은 계정 auth/collect 직렬화, 잘못된 account/tokenstore 조합 거부, 다중 증거 원자성 및 사용자 role의 증거·receipt 거부를 검사한다. 실제 Core에서 같은 계정 auth와 collect의 동시 실행은 collect의 비입력 bootstrap이 남아 아직 검증하지 않았다.
- 최초 위 테스트 묶음에 전역 role 설정을 바꾸는 quarantine 시험을 함께 병렬 실행했을 때 work-store 1건이 `보호 역할 충돌`로 실패했다(`/tmp/brain162g5-phase2-final-tests.log`). 역할 변경 시험과 나머지를 분리한 위 재실행은 각각 통과했다. 최초 실패를 성공으로 덮지 않는다.
- 다음 명령의 `ACTION`을 `hold`, `cancel`, `disable`로 각각 실행: `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_NATIVE_STORE=1 BRAIN_FIXTURE_CORE=1 BRAIN_FIXTURE_CORE_SIGNAL=1 BRAIN_FIXTURE_CORE_MUTATION=ACTION BRAIN_FIXTURE_TWO_CORE=1 sh extensions/garmin/native/tests/check-composed-auth.sh`. 실제 단일 Core가 확인된 다른 계정의 별도 native worker 둘을 동시에 진행하고, API를 통한 hold/disable은 두 ACK와 두 정확한 lease/epoch 증거 뒤 commit한다. cancel은 지정된 시도만 증거를 기록하고 다른 시도가 계속 활성임을 확인한다. 각 로그는 `/tmp/brain162g5-phase2-hold.log`, `/tmp/brain162g5-phase2-cancel.log`, `/tmp/brain162g5-phase2-disable.log`다. 일반 kind의 기존 cancel 응답도 각 실행에서 검사한다.
- 위 hold 명령에 `BRAIN_FIXTURE_CORE_ACK_FAIL=second`를 추가하면 첫 번째 ACK 뒤 두 번째 ACK 실패 시 증거와 hold가 모두 없는 것을 확인한다(`/tmp/brain162g5-phase2-ack.log`). `BRAIN_FIXTURE_CORE_COMMIT_LOST=1`은 실제 commit 뒤 응답 유실을 주입하고 receipt로 원래 `held: true`를 반환한다(`/tmp/brain162g5-phase2-lost.log`). 두 동시 hold 요청의 기존 결과값 `held: true` 한 건과 `held: false` 한 건도 통과했다(`/tmp/brain162g5-phase2-concurrent.log`; 같은 hold 명령에 `BRAIN_FIXTURE_CORE_CONCURRENT=1` 추가).
- 단일 활성 Core/native attempt에 미spawn attempt 추가와 조회 후 새 claim을 주입한 hold 시험은 각각 `/tmp/brain162g5-phase2-pending.log`, `/tmp/brain162g5-phase2-race.log`다. 명령은 위 hold 명령에서 `BRAIN_FIXTURE_TWO_CORE=1` 대신 각각 `BRAIN_FIXTURE_CORE_MULTIPLE=pending` 또는 `=race`를 사용한다. 시작했으나 연결을 확인할 수 없는 추가 attempt는 mutation을 막았다(`/tmp/brain162g5-final3-missing.log`, `BRAIN_FIXTURE_CORE_MULTIPLE=missing`).
- `BRAIN_FIXTURE_CORE_MULTIPLE=restart`는 실제 bridge를 강제 종료하고 기존 Core 감독자를 중단한 뒤 새 Core 감독자를 시작한다. 기존 attempt token·holder가 남고 새 worker launch 0이며 보호 hold는 실패 닫힘이다(`/tmp/brain162g5-phase2-supervisor-restart.log`). 이것은 미확정 시도의 보존 검증이지, 보호 principal의 독립 종료 증명 후 재개 기능을 구현했다는 뜻이 아니다.
- 대상 ABI 변경 뒤 host metadata 변조·중복·초과·누락 시험 각각 통과(`/tmp/brain162g5-phase2-metadata-2.log`부터 `-5.log`); split 신원 기록 거부도 통과(`/tmp/brain162g5-phase2-split-deny.log`). broker/GUI 단일 세션 및 두 합성 세션 격리 시험은 위 하위 checkpoint에 있다.

최초 두 Core 시도 시험은 두 번째 합성 UI가 fixture의 첫 tokenstore 이름만 허용해 실패했다(`/tmp/brain162g5-two-core-revoke.log`, `/tmp/brain162g5-two-core-diagnose.log`). fixture가 두 합성 대상을 허용하도록 수정한 뒤 위 종단 시험을 재실행했다. 실제 운영 OS 격리, 독립 종료 증명과 미확정 holder의 안전한 정상 복구, collect 비입력 bootstrap, D2B 전체 사용자 transport, D5–D7은 미완료다. 실제 승인 UI 생체, AX, 운영 DB·tokenstore·HTTP는 사용하지 않았다.

## D4B 세 번째 단계: leader 종료와 그룹 정리

native host는 `waitid(WNOWAIT)`로 leader 종료를 먼저 관찰하면서 실제 reap 전 PID를 고정한다. host는 매번 waitable 상태를 다시 확인하고 동일 lease·PID·시작 시각 및 그룹 구성원의 UID·시각을 검사한다. 종료된 leader를 제외한 실제 그룹 구성원을 인증된 bridge에 전달하며, Core는 broker 폐기 ACK 후 구성원이 남아 있을 때만 해당 고정 그룹에 신호를 보낸다. 그룹이 비었음을 확인한 뒤에만 host가 leader를 reap하고 별도의 종료 결과를 전달한다. 열린 stdout이나 자손만 남은 상태를 leader reap 또는 그룹 종료로 혼동하지 않는다.

보호 inspector는 현재 host가 소유한 시도 외의 PID를 임의의 일반 OS 신호 경로로 넘기지 않는다. 일반 worker는 검증된 일반 host가 현재 실행한 PID만 별도 등록해 기존 inspector를 사용한다. boot 불일치·시작 신원 불일치·stale lease·관찰 불명·host/bridge 연결 상실은 신호와 reap을 추측하지 않고 unknown과 holder를 유지한다. broker는 worker/UI 연결이 종료되어 입력 socket을 이미 폐기한 경우에도 동일 세대 supervisor가 폐기 ACK를 받을 때까지 상태를 보존한다. HTTP pending/uncertain latch의 복구 규칙은 바꾸지 않았다.

- `[ASSUMPTION]` 한 그룹의 관찰 응답 상한은 24명이며 초과는 unknown이다. 열거와 개별 조회 사이 종료 경합은 최대 1초간 재조회하며 계속 불명이면 unknown이다. leader 관찰 대기 상한은 10초이며 초과 시 unknown이다. 운영 부하·별도 principal 검증에서 재평가해야 한다.
- 실제 Core·격리 PG·native host: `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_NATIVE_STORE=1 BRAIN_FIXTURE_CORE=1 BRAIN_FIXTURE_CORE_DESCENDANT=1 sh extensions/garmin/native/tests/check-composed-auth.sh` 통과(`/tmp/brain162g5-phase3-core-descendant-final.log`). leader가 결과를 내고 종료한 뒤 stdout과 인증 FD를 보유한 합성 손자가 남으며, broker 폐기·leader 관찰·그룹 신호·reap 표식과 성공 정산 및 admission 해제를 검사한다. 같은 host 직접 시험 `BRAIN_FIXTURE_DESCENDANT=1 sh extensions/garmin/native/tests/check-worker-success.sh`도 통과(`/tmp/brain162g5-phase3-native-descendant-final.log`). 정상 단일 worker는 `/tmp/brain162g5-phase3-final-native-normal.log`, 두 활성 Core/native 보호 시도 회귀는 `/tmp/brain162g5-phase3-final-two-core.log`다.
- `BRAIN_FIXTURE_IDENTITY_CASE=1`, `2`, `3`, `4`로 각각 `sh extensions/garmin/native/tests/check-worker-success.sh`를 실행해 시작 시각 변조, stale lease, OS 구성원 관찰 불명, waitable 신원 상실을 주입했다. 모두 신호 없이 닫혔다(`/tmp/brain162g5-phase3-identity-1.log`부터 `-4.log`). 마지막 사례는 기존 자식을 합성으로 회수해 신원 상실을 주입한 것이며 실제 PID 숫자 재사용을 강제로 일으킨 증거는 아니다. boot 변경과 관찰 불명에서는 Core가 신호·reap을 호출하지 않는 단위 사례도 포함했다.
- `BRAIN_FIXTURE_AUTHORITY=1 BRAIN_FIXTURE_NATIVE_STORE=1 BRAIN_FIXTURE_CORE=1 BRAIN_FIXTURE_CORE_SIGNAL=1 BRAIN_FIXTURE_CORE_MUTATION=hold BRAIN_FIXTURE_CORE_MULTIPLE=restart sh extensions/garmin/native/tests/check-composed-auth.sh`와 같은 명령의 `host-restart` 각각 통과(`/tmp/brain162g5-phase3-final-restart2.log`, `/tmp/brain162g5-phase3-final-host-restart2.log`). 합성 bridge 또는 host를 종료하고 새 Core 감독자를 시작하며 임의 그룹 신호 0, 기존 attempt·holder 보존, 새 worker launch 0을 확인한다. fixture worker는 정해진 시간에 자연 종료하고 테스트는 이를 관찰한 뒤 서비스를 정리한다. 이는 OS 종료 증명 후 재개 기능의 성공 증거가 아니다.
- `pnpm exec vitest run packages/core/test/supervisor.test.ts packages/core/test/supervisor-cancel.test.ts apps/cli/test/process-group.test.ts apps/cli/test/sealed-native-bridge.test.ts`: 4개 파일 118건 통과(`/tmp/brain162g5-phase3-final-core-tests.log`). `pnpm build`, `pnpm typecheck`, `git diff --check` 통과(`/tmp/brain162g5-phase3-final-build.log`, `/tmp/brain162g5-phase3-final-typecheck.log`, `/tmp/brain162g5-phase3-final-diff.log`). 최종 split denied, claim race, generic registry shell fixture도 통과(`/tmp/brain162g5-phase3-split-deny.log`, `/tmp/brain162g5-phase3-race.log`, `/tmp/brain162g5-phase3-generic.log`).
- 지휘자가 확인한 공유 PostgreSQL role 충돌을 해결하기 위해 `packages/postgres/test/isolated-cluster.ts`를 추가하고 quarantine 시험의 실제 보호 role LOGIN 변경을 전용 일회용 PostgreSQL 클러스터로 옮겼다. 제품 role guard와 검증은 완화하지 않았다. 이전 실패와 정확히 같은 병렬 명령 `pnpm exec vitest run packages/core/test/protected-api.test.ts packages/core/test/supervisor.test.ts packages/core/test/supervisor-cancel.test.ts packages/postgres/test/garmin-quarantine.test.ts packages/postgres/test/work-store.test.ts apps/cli/test/protected-mutations.test.ts apps/cli/test/sealed-native-bridge.test.ts`에서 7개 파일 261건 통과(`/tmp/brain162g5-phase3-parallel-regression.log`). Docker를 사용할 수 없으면 이 시험은 skip하지 않고 실패한다.
- `python3 -m unittest discover -s tooling/protected-deployment -p 'test_*.py' -v`는 11개 중 일반 8개 통과·별도 principal 3개 skip(`/tmp/brain162g5-phase3-principal-fixture.log`). 새 fixture는 서로 다른 두 시험 UID에서 그룹 신호 거부와 실제 macOS audit token·고정 코드 hash peer 판정을 자동 검증하도록 작성했고 native fixture 컴파일은 통과했다. 현재 `sudo -n true`는 비대화형 관리자 권한 부재로 종료 1(`/tmp/brain162g5-phase3-sudo-check.log`)이어서 별도 UID 실기는 실행하지 못했다. 필요한 시험 principal·실행 방법은 `tooling/protected-deployment/README.md`에 기록했다. 이는 관리자/실기 operator 단계이며 실제 launchd principal·OrbStack 관리 경로 격리 증거가 아니다.

초기 Core 종단은 갱신 전 bridge 빌드로 실행되어 unknown으로 실패했고, 이후 broker가 worker 단절 때 supervisor까지 즉시 닫아 폐기 ACK를 확인하지 못하는 문제와 종료 중 그룹 구성원이 조회 사이 사라지는 경합을 각각 발견했다. broker의 세대별 폐기 ACK 보존과 bounded 그룹 재조회로 수정한 뒤 위 시험을 재실행했다. 당시 실패 로그는 `/tmp/brain162g5-pinned-core-normal-built.log`, `/tmp/brain162g5-pinned-core-descendant-built.log`, `/tmp/brain162g5-pinned-core-trace.log`, `/tmp/brain162g5-pinned-core-descendant-final.log`이다. 최초 bridge 재시작 정리 확인에서 `killpg(..., 0)`가 zombie 상태에 EPERM을 반환한 fixture 실패(`/tmp/brain162g5-phase3-final-restart.log`)도 기록하며, 시험 자체는 fixture leader의 종료 상태를 조회한 뒤 host 종료로 정리하도록 수정했다.

별도 UID의 실제 서비스 설치·공격 거부, 원래 attempt의 OS 종료 증명에 따른 정상 복구, 그룹 밖으로 이탈한 후손의 OS 격리, D2B 전체 외부 transport·D5 egress/library·D6 전체 행렬과 독립 리뷰·D7은 계속 남는다. 보호 배치와 실제 egress가 증명되기 전 운영 auth/HTTP는 닫혀 있다.

## D2B B1: queue list 단일 조회 경계

`apps/cli/src/dispatch.ts`는 `queue list`를 일반 Store 조립 전에 좁은 사용자 façade로 보낸다. `apps/cli/src/commands/queue-list.ts`는 기존 JSON·텍스트 렌더러를 공유한다. `apps/cli/src/daemon/protected-queue.ts`의 고정 `queue.list.v1` 요청은 `all`·`kind`·`limit`만 받고, `apps/cli/src/daemon/protected-supervisor.ts`의 제품 서비스 조립은 기존 Core `Brain.queue.list`를 호출한다. 응답은 명시된 공개 필드와 count·hasMore만 담으며, current attempt token·claim 소유자·직렬화 키 등 내부 Store 필드는 내보내지 않는다. 날짜는 정규 UTC 문자열로 직렬화하고 검증 뒤 Date로 복원한다. 문자열·프레임 크기를 제한하며 중복 JSON 키, 추가 필드, 잘못된 날짜·상태·건수·사용량을 거부한다. Core의 DB_LOCKED·DB_UNAVAILABLE·USAGE는 고정 메시지로 반환한다.

실제 Core와 격리 PG, 제품 서비스 객체를 in-process 시험 transport로 이어 `--all`·`--kind`·`--limit`, has_more, 완료 attempt 사용량, JSON과 텍스트 출력의 기존 Core 결과 일치 및 응답 비공개 필드 부재를 확인했다. 서비스 부재·거부·위조 응답에서 사용자 측 Store 생성이 0임을 확인했다. 요청의 중복 키와 추가 SQL 필드도 Core 호출 전에 거부한다. `pnpm exec vitest run apps/cli/test/protected-queue.test.ts packages/core/test/protected-api.test.ts apps/cli/test/protected-mutations.test.ts`는 3개 파일 11건 통과(`/tmp/brain162g5-b1-final.log`), `pnpm build`, `pnpm typecheck`, `git diff --check`도 통과했다(`/tmp/brain162g5-b1-build.log`, `/tmp/brain162g5-b1-typecheck.log`, `/tmp/brain162g5-b1-diff.log`). 처음 has_more 시험은 동일 target 두 번 enqueue가 기존 일감으로 합쳐져 실패했으며 서로 다른 합성 target을 사용해 재실행했다.

현재 기본 CLI에는 인증된 운영 transport가 아직 없어 `queue list`는 DB_UNAVAILABLE로 닫힌다. 따라서 이 중간 상태에서 기존 직접 PG 기반 `queue list` 호출은 사용할 수 없으며 B2 운영 transport 연결이 필요하다. 전송 부재·권한 거부·불량 응답은 현재 같은 DB_UNAVAILABLE 공개 오류로 모인다. 서버의 잘못된 요청은 INVALID_REQUEST로 구분하지만 클라이언트 envelope에서 peer 거부를 별도로 표현하는 기능은 아직 없다. 이 통합 시험은 in-process transport이며 OS peer 인증·서비스 설치·역할 격리를 증명하지 않는다. 나머지 사용자 명령은 아직 기존 Store 경로이며 B2–B6, D5–D7 및 전체 보안 검증은 미완료다.

## D2B B2: native 상호 신원 부품과 고정 오류 하위 단계

`extensions/garmin/native/data-peer.c`는 보호된 조립 코드가 제공한 UID·정확한 PID·고정 코드 해시와 연결의 OS audit token을 대조한다. 각 frame의 전후에 같은 연결을 재검증하고 실패 시 FD를 닫는다. 길이 접두사와 제한시간을 가진 일반 데이터 전용 frame이며 auth FD·broker evidence·worker API는 제공하지 않는다. 새 연결은 별도 신원 검증이 필요하다. native 부품만으로는 누가 신뢰된 PID와 해시를 제공하는지 또는 봉인된 실행물의 전체 로딩 경로가 안전한지 증명할 수 없으므로 아직 기본 CLI나 운영 서비스에 연결하지 않았다.

`sh extensions/garmin/native/tests/check-data-peer.sh`는 합성 서명 프로세스 사이 양방향 검사와 32 KiB frame, 같은 UID 다른 실행물, 잘못된 서버 해시, 통신 후 FD 교체 거부를 통과했다(`/tmp/brain162g5-b2-peer.log`). 실제 설치된 다른 principal이나 운영 서버 검증은 아니다. `SERVICE_UNAVAILABLE`, `SERVICE_DENIED`, `SERVICE_INVALID_RESPONSE`, `SERVICE_INVALID_REQUEST`를 공통 오류 코드에 추가하고 수신 실패 원문을 노출하지 않도록 구분했다. 직접 DB 오류는 기존 DB 코드를 유지하며 서비스 부재·거부에서 사용자 Store 생성은 0이다. `pnpm exec vitest run apps/cli/test/protected-queue.test.ts packages/core/test/protected-api.test.ts packages/core/test/codes.test.ts`는 3개 파일 304건 통과(`/tmp/brain162g5-b2-tests.log`). 최초 코드표 시험은 새 코드 네 개가 고정 기대 목록에 없어 실패했고 목록을 갱신한 뒤 통과했다. `pnpm build`, `pnpm typecheck`, `git diff --check`도 통과했다(`/tmp/brain162g5-b2-build.log`, `/tmp/brain162g5-b2-typecheck.log`, `/tmp/brain162g5-b2-diff.log`).

[ASSUMPTION] 일반 data frame 1 MiB, JSON 깊이 8, 문자열 길이 16384 상한은 미확정 보수 값이다. 실제 목록·다른 일반 데이터 부하 및 소비자 호환성에서 재평가해야 하며 지휘자의 계획 deferred 기록 대상이다. native frame 대기 최대 300초는 기존 `peer.c` 계약을 따른다. 새로운 인증 성공 정책이나 same-UID 호출자 예외를 정하지 않았다.

다음 구현은 기본 CLI의 고정 native 경로와 서비스 실제 연결, 봉인된 실행·로딩 identity 및 이를 신뢰할 보호 조립, 같은 UID 임의 JS의 helper 대리 호출 거부, 재연결마다 상대 instance 검증을 묶는 일이다. 현재 일반 CLI는 계속 서비스 부재로 닫히고, 제품 종단 정상 목록·실제 별도 principal·설치/서명/주입 방지는 미검증이다. 기존 B1 보고의 서비스 오류 통합 문장은 이 절의 코드 구분으로 갱신되었다. B3–B6와 D5–D7, 전체 검증·독립 리뷰는 그대로 남는다.

### B2 합성 peer 시험의 종료 동기화 보완

지휘자의 독립 실행에서 `check-data-peer.sh`가 한 번 종료 10으로 실패했고(`/tmp/brain162g5-parent-b2-peer.log`), 추적 재실행은 통과했다(`/tmp/brain162g5-parent-b2-peer-trace.log`). 최초 실패의 내부 단계는 기록되지 않아 원인을 단정할 수 없다. 32 KiB frame 수신과 그 뒤 peer OS 검증을 마친 후 상위가 완료 ACK를 보내고, 하위는 ACK를 읽고 상대 신원을 재검증한 뒤에만 정상 종료하도록 fixture 수명을 묶었다. 단계별 고정 진단을 추가했으며, 거부 사례에서 진단이 나올 수 있다. 인증 전후 OS 신원 검사는 유지했다.

수정 후 `sh extensions/garmin/native/tests/check-data-peer.sh` 통과(`/tmp/brain162g5-b2-peer-ack.log`); 같은 시험을 최대 4개 동시 실행으로 12회 반복해 모두 종료 0이었다(`/tmp/brain162g5-b2-peer-repeat-1.log`부터 `-12.log`). `git diff --check` 통과(`/tmp/brain162g5-b2-ack-diff.log`). 이 반복 결과는 합성 시험의 안정성 근거이며 최초 실패 원인의 증명이나 실제 운영 transport 완성은 아니다.

지휘자의 추가 검토에 따라 FD 교체 시험을 수정했다. 정상 요청·응답 및 32 KiB 수신 뒤 기존 peer가 살아 있고 해당 FD의 OS 신원이 유효함을 확인한 상태에서, 원래 연결 사본을 열어 하위를 ACK 대기 상태로 보존한다. 그 뒤 다른 socket으로 FD를 교체하고 실제 새 상대의 OS 신원 일치, 옛 자식 신원 거부, 자식 생존, frame 쓰기 거부를 각각 `REPLACE_LIVE=1 OTHER_ID=1 OLD_ID_REJECTED=1 WRITE_REJECTED=1`로 확인한다. 그 다음에만 원래 자식에게 SIGTERM을 보내고 신호 종료를 reap한다. 이전 시험의 교체 결과는 이미 종료된 peer와 구분하지 못하므로 이 새 증거로 대체한다.

`sh extensions/garmin/native/tests/check-data-peer.sh` 통과(`/tmp/brain162g5-b2-live-peer.log`) 및 최대 4개 병렬 12회 반복 모두 종료 0(`/tmp/brain162g5-b2-live-repeat-1.log`부터 `-12.log`). `git diff --check` 통과(`/tmp/brain162g5-b2-live-diff.log`). 정상 경로의 종료 ACK와 frame 전후 OS 신원 검증도 유지했다.

### B2 제품 handler의 분리 프로세스 framing 하위 단계

`apps/cli/src/daemon/queue-frame-stream.ts`는 이미 인증된 native 연결을 소유한 보호 조립을 전제로, 길이 접두사가 있는 일반 데이터 frame을 제품 서비스 객체의 `requestQueueFrame` 한 메서드에 순서대로 연결한다. 분할 입력·연속 입력을 재조립하고 frame 크기·빈 입력·잘린 입력·유효하지 않은 UTF-8을 거부하며 완성된 응답만 되돌린다. 이 코드는 OS 인증 자체나 신원 등록을 수행하지 않으므로 직접 노출하지 않는다. 1 MiB 상한은 위 미결정 가정과 같다.

`apps/cli/test/fixtures/queue-data-service.mjs`는 합성 시험 전용이며 별도 Node 프로세스에서 실제 제품 서비스 객체·Core·격리 PostgreSQL을 조립한다. 시험 CLI는 주입된 합성 transport로 frame 왕복해 정상 목록을 얻고 사용자 측 Store 생성 0을 확인했다. 테스트 자격/경로의 환경 변수 전달은 이 합성 fixture에만 있으며 보호 설치의 신원 또는 권한 정책이 아니다. `pnpm exec vitest run apps/cli/test/queue-frame-stream.test.ts apps/cli/test/protected-queue.test.ts`: 2개 파일 5건 통과(`/tmp/brain162g5-b2-process-tests.log`). `pnpm build`, `pnpm typecheck`, `git diff --check` 통과(`/tmp/brain162g5-b2-process-build.log`, `/tmp/brain162g5-b2-process-typecheck.log`, `/tmp/brain162g5-b2-process-diff.log`).

이 단계의 별도 프로세스 파이프와 앞 절의 OS peer 시험은 아직 하나의 인증된 종단이 아니다. 기본 CLI의 native transport·보호 설치 registry가 소유하는 상대 PID/hash/instance·봉인 실행 및 전체 로딩 신원·임의 JS의 대리 호출 거부·실제 서비스 principal과 재연결 증명은 계속 미완료다. 실제 운영 `queue list`는 계속 실패 닫힘이며 합성 Node 실행물의 서명은 승인 근거가 아니다.

### B2 합성 native peer와 제품 handler의 단일 사슬

`extensions/garmin/native/tests/data-gateway-fixture.c`는 합성 상위·하위 native 프로세스가 별도 socket의 OS peer UID·PID·코드 해시를 양방향 검증하고, 일반 frame을 분리 서비스 프로세스에 전달하는 시험 gateway다. `apps/cli/test/queue-frame-stream.test.ts`는 실제 CLI dispatch → 합성 native 양방향 peer → 제품 `requestQueueFrame` → 기존 Core `queue.list` → 격리 PG → 같은 경로의 응답을 한 실행에 연결한다. 완료 ACK로 검증 중 peer 수명을 유지한다. 정상 목록과 사용자 Store 생성 0을 확인했고, 양방향 각각의 합성 기대 해시 불일치 시 고정 SERVICE_DENIED와 사용자 PG fallback 0을 확인했다. 이 실패 분류는 시험 transport가 gateway 실패를 거부로 변환한 것이며 아직 운영 native 오류 전달의 증거가 아니다.

`pnpm exec vitest run apps/cli/test/queue-frame-stream.test.ts`는 1개 파일 3건 통과(`/tmp/brain162g5-b2-chain.log`). `pnpm build`, `pnpm typecheck`, `git diff --check` 통과(`/tmp/brain162g5-b2-chain-build.log`, `/tmp/brain162g5-b2-chain-typecheck.log`, `/tmp/brain162g5-b2-chain-diff.log`). 별도 native fixture의 살아 있는 peer에 대한 실제 FD 교체·다른 같은 UID 실행물 거부는 위 `check-data-peer.sh` 결과다. 이 사슬은 합성 test gateway가 입력한 신원과 Node service를 사용하며 OS peer가 CLI Node 또는 보호 서비스 Node의 전체 로딩 신원을 검증한 것은 아니다.

기본 CLI 고정 native 경로와 보호 registry가 소유하는 peer PID/hash/instance, root 소유 payload 및 허용 env·고정 argv로 실행된 정확한 CLI 인스턴스 등록, 임의 JS의 직접 접속·helper 대리 호출 거부, 실제 보호 서비스 분리 principal·재연결 인증, 실제 설치/서명/주입 방지는 남았다. 이 시험을 운영 준비 또는 B2 전체 완료로 세지 않으며 기본 queue list는 계속 닫혀 있다. 나머지 B3–B6·D5–D7 및 전체 검증과 독립 리뷰도 유지한다.

### B2 봉인 payload 파일 검증 부품

`extensions/garmin/native/sealed-files.c`는 신뢰된 설치 조립이 공급한 열린 기준 디렉터리 FD·고정 component·소유자·SHA-256을 사용해 파일을 연다. 각 디렉터리와 최종 일반 파일의 소유권·그룹/기타 쓰기 금지·macOS 확장 ACL 부재를 검사하고, `openat`과 `O_NOFOLLOW`로 symlink를 거부하며 파일 하드링크를 거부한다. 열린 FD에서 내용을 해시하고 전후 inode·크기·수정 시각을 비교한 뒤 같은 FD를 반환한다. 이 부품은 호출자가 root에서부터 기준 FD와 고정 digest를 신뢰할 수 있도록 확보해야 하며, manifest·전체 의존성·실행 코드 서명이나 동적 로딩·spawn을 검증하지 않는다. 운영 호출자의 owner는 root여야 한다. 합성 시험의 현재 사용자 소유 디렉터리는 운영 신뢰 증거가 아니다.

`sh extensions/garmin/native/tests/check-sealed-files.sh`는 합성 파일 정상 열기와 파일 내용·digest 불일치, 잘못된 owner, 쓰기 가능 root/하위 디렉터리/파일, 하드링크·symlink·상위 경로 이동, 실제 확장 ACL이 붙은 파일 거부를 통과했다(`/tmp/brain162g5-b2-files.log`). 기존 native peer 회귀 `sh extensions/garmin/native/tests/check-data-peer.sh` 통과(`/tmp/brain162g5-b2-files-peer.log`), `git diff --check` 통과(`/tmp/brain162g5-b2-files-diff.log`). [ASSUMPTION] 하나의 고정 payload 경로 component 수 상한 64는 package 구성에서 재평가할 값이며 지휘자 소관 계획 deferred 기록이 필요하다.

앞 절의 합성 native–CLI–제품 handler–Core–격리 PG 사슬은 그대로이나, 이 파일 검증 부품은 아직 그 사슬과 실제 고정 CLI spawn에 연결되지 않았다. root 소유 실행물·전체 JS 의존성 및 loader 목록과 고정 digest를 등록하고 실제 보호 실행 인스턴스를 peer에 결합하는 작업, 주입 방지, 기본 운영 transport와 실제 서비스 principal 검증이 모두 남았다. 따라서 기본 운영 queue 조회와 보호 auth/HTTP는 계속 닫힌다.

### B2 검증 파일·고정 spawn·OS 인스턴스의 합성 결합

`extensions/garmin/native/sealed-queue-spawn.c`는 신뢰된 조립이 제공한 기준 FD·고정 파일 목록·소유자·digest로 앞 절의 파일 검사를 호출하고, 열린 FD와 spawn 경로의 inode를 spawn 전후 대조한다. 고정 `--sealed-queue-client` 인자, `/` 작업 디렉터리, `PATH`와 `LANG`만 있는 환경, 명시된 표준 FD·peer FD·registry FD만 사용한다. 생성된 프로세스는 중지 상태로 반환된다. 설치 registry와 조립 자체가 신뢰 가능한지는 이 부품의 전제이며 아직 제품에 연결되지 않았다. 검증 파일을 여는 중 FIFO를 만나도 대기하지 않도록 `O_NONBLOCK`을 추가하고 거부 시험을 보강했다.

합성 gateway는 실제로 이 함수로 검증 파일을 spawn한다. 재개된 자식은 상호 OS peer 신원 검증과 승인 ACK 전에는 일반 요청을 처리하지 않는 시험 bootstrap에 머문다. 자식은 임의 `NODE_OPTIONS`, `NODE_PATH`, `DYLD_LIBRARY_PATH`, `HOME`이 전달되지 않고 작업 디렉터리가 `/`인 것을 검사한다. CLI dispatch → 고정 spawn된 합성 native 자식의 OS peer → 제품 frame handler → 실제 Core·격리 PG → 응답을 한 시험에서 확인했으며, 변조 digest·각 방향 상대 해시·다른 PID 거부 및 사용자 PG fallback 0도 확인했다. 서비스 거부 오류는 여전히 시험 transport의 분류다. `pnpm exec vitest run apps/cli/test/queue-frame-stream.test.ts apps/cli/test/protected-queue.test.ts` 2개 파일 6건 통과(`/tmp/brain162g5-b2-spawn-chain.log`), 별도 프로세스 종단 3회 재실행 모두 통과(`/tmp/brain162g5-b2-spawn-repeat-1.log`부터 `-3.log`). `sh extensions/garmin/native/tests/check-sealed-files.sh`, `pnpm build`, `pnpm typecheck`, `git diff --check` 통과(`/tmp/brain162g5-b2-spawn-files.log`, `/tmp/brain162g5-b2-spawn-build.log`, `/tmp/brain162g5-b2-spawn-typecheck.log`, `/tmp/brain162g5-b2-spawn-diff.log`).

최초 시도에서 중지 상태 자식의 socket audit token은 아직 spawn 상위 PID여서 검증이 거부됐다(`/tmp/brain162g5-b2-spawn-diagnose.log`). 자식이 인증 외 작업을 하지 않는 bootstrap에서 비권위 시작 신호를 보내고, 상위가 실제 연결의 OS token·정확한 PID·코드 해시를 확인한 뒤에만 별도 ACK를 전송하도록 시험 순서를 수정했다. 시작 신호는 신원 증거가 아니다. 최초 진단 중 필요한 SDK 헤더 누락도 고쳐 재실행했다. 최초 실패가 실제 배치 일반의 OS 동작을 모두 대표한다고 단정하지 않는다.

합성 fixture는 현재 사용자 소유 단일 native 실행물과 시험이 제공한 digest·peer hash를 사용한다. 제품의 root 소유 registry에서 고정 CLI JS·전체 의존성·Node/loader·서명을 검증하고 그 정확한 CLI 실행 인스턴스를 등록하는 경로, 임의 JS의 helper 대리 호출 거부, 실제 보호 서비스 principal 및 재연결은 여전히 미완료다. fixture native child가 Node CLI 전체 로딩 신원을 증명하지 않으며 운영 기본 transport와 queue 조회는 계속 닫혀 있다. 기존 OS peer의 살아 있는 상대 연결 교체 부정 시험은 앞 절의 별도 fixture 근거이며 이 새 종단의 교체 시험은 아직 없다. B3–B6·D5–D7 및 전체 행렬·독립 리뷰는 계속 남는다.

### B2 고정 bundle 전체 목록과 실행물 서명 검증 부품

`extensions/garmin/native/sealed-bundle.c`는 신뢰된 registry가 제공한 고정 파일 목록 각각의 경로·소유자·ACL·digest를 앞선 FD 검사로 확인한 뒤, 같은 기준 디렉터리 전체를 열거해 미등록 파일·빈 디렉터리·symlink·특수 파일을 거부한다. 목록의 중복과 경로 component 오류도 거부한다. `extensions/garmin/native/sealed-signature.c`는 열린 실행물과 경로의 inode가 같은지 확인하고 macOS Security framework의 strict static-code 검증과 registry cdhash를 비교한다. `sealed-queue-spawn.c`는 spawn 전후로 전체 bundle과 실행물 서명을 확인한다. registry 목록·hash·owner·기준 FD가 신뢰된다는 전제는 이 함수 밖의 보호 설치 조립이 충족해야 한다.

`sh extensions/garmin/native/tests/check-sealed-files.sh`는 두 합성 파일 목록 정상 검증, 미등록 파일·디렉터리·digest 변조 거부와 기존 파일·ACL 반례를 통과했다(`/tmp/brain162g5-b2-bundle.log`). `pnpm exec vitest run apps/cli/test/queue-frame-stream.test.ts apps/cli/test/protected-queue.test.ts`는 2개 파일 6건 통과(`/tmp/brain162g5-b2-bundle-chain.log`). 앞 절의 합성 CLI/native/제품 handler/Core/격리 PG 종단에서 미등록 JS·실행물 서명 hash 불일치·파일 digest·상대 hash·다른 PID 거부 및 사용자 PG fallback 0을 확인했다. `pnpm build`, `pnpm typecheck`, `git diff --check` 통과(`/tmp/brain162g5-b2-bundle-build.log`, `/tmp/brain162g5-b2-bundle-typecheck.log`, `/tmp/brain162g5-b2-bundle-diff.log`). [ASSUMPTION] bundle의 파일 상한 4096과 경로 깊이 상한 64는 실제 배포 package에서 재평가할 지휘자 소관 계획 deferred 대상이다.

현재 종단의 bundle은 합성 단일 native 실행물이고, 별도 목록 시험의 JS 파일은 실행하지 않는다. root 소유 registry로 실제 Node·CLI JS·전체 의존/loader 목록과 서명 정보를 고정하고 실제 Node CLI 실행 인스턴스를 OS data 연결에 등록하는 운영 조립은 미완료다. 임의 JS/helper 대리 호출, 실제 root 설치·별도 principal·재연결 및 기본 운영 transport 검증도 남아 있으며 운영 queue/auth/HTTP를 열지 않는다. B3–B6·collect 비입력/D5·D6 전체 행렬·독립 리뷰·D7도 그대로다.

## 관리상 인계: 전체 구현 미완료

지휘자의 시간 초과에 따른 명시적 인계로 이 Dispatch의 편집을 중단한다. 이는 관리상 인계이며 구현의 기술적 불가능 판정이 아니다. 계획 전체가 끝나지 않았으므로 완료 상태가 아니고 커밋이나 티켓 상태 변경도 하지 않았다. 앞 절들은 실제 변경·정확한 시험 명령·로그·최초 실패와 수정·합성 증거의 한계를 순서대로 기록한다.

다음 구현자는 현재 변경을 보존한 채 B2의 운영 조립을 이어야 한다. root 소유 보호 registry가 기준 FD·owner=0·고정 Node/CLI JS와 전체 의존·loader digest 및 서명을 소유하고, 고정 환경과 인자로 시작한 정확한 CLI 실행 인스턴스를 OS 인증 data peer에 연결해야 한다. 임의 같은 UID JS와 helper 대리 호출, 가짜 서비스·다른 instance·연결 교체·재연결, 서비스 부재·거부 및 사용자 직접 PG fallback 0을 실제 제품 사슬에서 검증해야 한다. 현재 정상 종단은 사용자 소유 합성 native 실행물과 합성 registry를 쓰므로 실제 Node/JS 로딩 신원·root 설치·별도 principal·보호 엔진 경계를 증명하지 않는다. 기본 운영 `queue list`는 서비스 부재로 실패 닫혀 있으며 보호 auth/HTTP도 닫혀 있다.

그 뒤 B3–B6의 나머지 사용자 명령·취득/spool·drain/예약/인증·기존 자격 이관, collect 비입력 bootstrap과 D5 library/egress, D6의 T01–T28·추가 반례·독립 보안 리뷰, D7 복구와 운영 준비가 남는다. 별도 principal 실기는 관리자 권한 부재로 미실행이며 합성 fixture와 실제 배치 증거를 혼동하지 않는다. 계획 deferred에는 지휘자 소관인 frame 1 MiB·JSON 깊이 8·문자열 16384, 경로 component 64, bundle 파일 4096·깊이 64 가정의 재평가를 유지해야 한다. 사용자 실자격·실계정·운영 tokenstore·실제 Garmin HTTP는 사용하지 않았다.
