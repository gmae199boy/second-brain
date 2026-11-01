# 16.2 D4B: 단일 Core와 native 연결 경계 읽기 전용 조사

작성일: 2026-11-01. 확인 기준 HEAD는 `1d4fec9a16056b0f473967fb6fcaca8a8f37790d`이며 같은 작업공간의 구현자가 편집 중인 소스도 읽었다. 따라서 아래 줄 번호는 조사 시점이며 구현자가 수정한 뒤 재확인이 필요하다. 기능·수락 기준은 `_bmad-output/personal-brain/tickets/epic-garmin-runtime/tickets/story-mfa-0-plan.md` 전체이고 `story-mfa-0-g4-native-report.md` 전체를 함께 읽었다. 저장소 수정, 빌드·시험 실행, 추가 워커, 운영 설정·tokenstore·DB 읽기, HTTP, 설치·배포는 하지 않았다. 이 파일만 작성했으며 기존 실행 로그를 직접 재검증했다고 주장하지 않는다.

## 판단과 D4A/D4B 구분

가장 작은 유효 구현 단위는 기존 `runSupervisor`가 청구한 **한 auth attempt**를 실제 native host의 자식과 연결하고, 같은 attempt의 DB commit을 확인한 뒤 broker·GUI·worker ACK를 진행하는 제품 adapter다. native 프로그램에 claim/retry/lease/결과 정산 loop를 복제하면 안 된다. 단일 청구·용량·재시작 정산의 소유자는 계속 Core다(`packages/core/src/queue/supervisor.ts:480`, `:501`, `:145`). helper는 인증된 실행·FD·관찰 명령만 수행한다.

D4A의 수락은 native 부품, libpq 저장 adapter, broker DB guard, revoke ACK 선행 mutation 및 격리 권위 스키마 fixture 범위다. 실제 Core 조립은 명시적으로 미완료다(계획 `:108`, `:122`, `:124`; native 보고 `:75`–`:93`). `tests/composed-supervisor.c:49`의 독립 main은 Core가 아니고, `:43`의 fixture claim은 제품의 `claimSupervisedWork`가 아니다. 이 fixture가 실제 PG와 별도 프로세스를 써도 D4B 완료 증거로 재명명할 수 없다.

현재 제품 진입점 `apps/cli/src/daemon/supervisor.ts:25`–`:29`, `:115`–`:141`은 사용자 설정 store·manifest loader·일반 system launcher를 조립한다. `sealedGarminLaunches`와 `sealedProcessLauncher`에 구현체를 넣는 제품 경로는 이곳에 없다. 사용자 daemon에 보호 자격을 추가하는 것은 해결이 아니다. 보호 principal의 서비스 진입점에서 같은 `runSupervisor`를 조립하고, 사용자 측에 두 번째 청구자를 남기지 않는 구성이 필요하다. 일반 확장은 기존 `sealedService.ordinaryWorkerHost`의 비특권 host로 보낸다(`packages/core/src/queue/supervisor.ts:33`–`:43`, `:489`–`:495`). D2B 전체 API 지도를 이 보고에 반복하지 않는다.

## 현재 계약의 정확한 충돌

| 경계 | 기존 Core/제품 | native | 그대로 연결했을 때 |
|---|---|---|---|
| admission | `ProtectedLaunch.admit`가 spawn 전 실행되고 busy는 defer (`queue/supervisor.ts:208`–`:231`) | bootstrap 첫 단계에서 `ops.admit` 재호출 (`supervisor-bootstrap.c:8`) | 동일 holder를 다시 예약해 거부되거나 일감이 busy로 보임 |
| spawn/DB/ACK | launcher가 handle 반환 → inspector → `recordSupervisedProcess` → `bootstrap.authorize` (`queue/supervisor.ts:236`, `:268`–`:324`) | native bootstrap 자체가 spawn→record callback→broker→GUI→host ACK (`supervisor-bootstrap.c:9`–`:17`) | launcher.start에서 전체 bootstrap을 호출하면 Core DB 기록 전에 worker 실행이 허용됨 |
| 실행 입력 | 고정 command·빈 args·허용 ABI env·snapshot (`sealed-garmin.ts:25`–`:32`) | host start wire에는 work/attempt/run/binding/epoch/package와 auth FD만 존재 (`host-client.c:61`–`:76`) | work kind·target·snapshot을 실제 worker가 받는 제품 transport가 없음 |
| 자식 환경 | Core spec에는 ABI 메타데이터가 있음 | `worker-host.c:97`–`:102`는 FD 3/4/5와 PATH/LANG만 spawn | port 호출이 성공해도 실제 Python 인증/ABI 실행 연결은 증명되지 않음 |
| 관찰 | PID, stdout/stderr, leader reaping, 그룹 멤버 목록, boot/start | host client는 실제 PID와 FD, 집계 group 상태, exit/unknown 이벤트 | helper PID 대입, group 존재를 가짜 멤버 목록으로 변환, 연결 상실을 exit로 해석하면 계약 손상 |
| 취소 | `requestWorkCancel`·hold가 직접 DB 쓰기 (`postgres/src/work.ts:180`, `:313`) | broker revoke ACK 뒤 evidence와 mutation (`supervisor-store.c:75`–`:84`) | Core poll이 취소를 본 뒤 revoke하는 방식은 너무 늦고 trigger가 정상적으로 변경을 거부함 |

위 표의 축약 경로는 각각 `packages/core/src/`, `apps/cli/src/daemon/`, `extensions/garmin/native/` 아래 파일이다.

### admission은 한 번 예약하고 같은 세대를 증명해야 한다

활성 보호 정책은 원래 일반 migration이 아니라 `extensions/garmin/protected-migrations/0009_protected_roles.sql`이다. `:11`의 session_user는 `brain_protected_supervisor`, `:34`의 admission_valid는 `brain_protected_broker`다. 일반 app 역할로 호출하거나 role 검사를 완화하면 안 된다.

`reserve_work_admission`은 auth target과 collect의 canonical profile→target 선택을 하고 busy/blocked/admitted를 반환한다(`0009_protected_roles.sql:45`–`:66`). `reserve_admission`은 holder 존재 시 실패하며 같은 attempt라도 재진입 성공 계약이 없다(`:21`–`:27`). libpq adapter 역시 `s->admitted`일 때 admit을 거부한다(`supervisor-store.c:46`–`:51`). 따라서 Core admit과 native admit을 둘 다 실행하는 것은 실제 결함 경로다.

추천은 **Core admit이 유일한 예약 단계**를 유지하고 native 시작은 이미 commit된 admission과 정확한 binding generation을 검증하는 단계로 분리하는 것이다. native `ops.admit=항상 1`은 검증 대체가 아니다. 현재 WorkStore 응답은 resolved target만 선택적으로 노출하고 binding generation·package generation·connection epoch는 공급하지 않는다(`packages/postgres/src/work.ts:161`–`:178`). 보호 adapter가 DB holder에서 검증된 비밀 없는 launch context를 얻거나, 예약 결과의 내부 타입을 보강해야 한다. 이름 예시 `ProtectedAttemptContext`는 **신규 제안**이다. target과 generation을 사용자 snapshot 문자열만 믿고 만들지 않는다.

대안은 libpq adapter의 admission을 Core admit에서 한 번 호출하고 동일 객체를 native 단계에 유지하는 방식이다. 다만 현재 boolean native admit은 Core의 busy/defer 구분을 잃으므로 이를 복원해야 하고, collect의 target 선택도 유지해야 한다. 어느 방안이든 중복 reserve를 idempotent 성공으로 바꾸어 은폐하지 않는다. 같은 holder 재검증과 새 예약은 구별한다.

## 최소 연결 구조와 호출 순서: 제안

아래 함수·타입 이름 중 기존 소스에 없는 것은 모두 제안이다. 이번 조사에서 API를 추가하지 않았다.

1. 보호 서비스가 설치 policy와 고정 registry를 읽고 보호 store, native bridge, inspector를 만든다. `sealedProcessLauncher(native)`와 `sealedGarminLaunches(ports)`를 같은 수명의 adapter에 연결한다. `runSupervisor`는 이 객체들을 한 번 주입받는다. 사용자 manifest·임의 URL·실행 경로는 보호 조립 입력이 아니다.
2. Core가 기존 `claimSupervisedWork`로 work/attempt를 얻고 prepare→snapshot 검증→현재 attempt/hold/cancel 확인→admit commit을 수행한다. busy/defer, commit 불명 실패 닫힘을 그대로 보존한다.
3. launcher.start는 **spawn까지** 수행하고 ACK를 보내지 않는다. auth이면 인증된 broker의 `prepare_channel`로 받은 socket만 host `start_auth`에 넘긴다. host 응답의 실제 자식 PID, 시작 시각, launch lease, stdout/stderr FD를 받아 미승인 handle을 반환한다. `brain_host_recorded`를 호출하지 않는다.
4. Core inspector가 실제 worker boot/start를 관찰하고 `store.recordSupervisedProcess`로 PID=PGID, OS 신원, lease/epoch를 현재 attempt에 commit한다. DB 결과가 done인 경우만 다음 단계다. nil·unknown·실패·응답 유실은 ACK 0이다. native bootstrap의 `record_identity`를 다시 실행하지 않는다.
5. `ProtectedLaunch.bootstrap.authorize`가 같은 opaque context를 통해 broker register→recorded→GUI suspended start→broker gui_instance→GUI resume→최종 현재 상태 확인→host recorded/ACK를 수행한다. 필요한 순서 부품은 `supervisor-bootstrap.c:12`–`:17`에 이미 있다. 이를 spawn 이전·이후의 단계 함수로 나누고 기존 composed wrapper도 같은 내부 함수를 쓰게 하면 재사용성이 높다. 예시 `spawnPending`/`authorizeRecorded`는 **제안**이다. 전체 bootstrap을 launcher에서 먼저 호출하는 방식은 추천하지 않는다.
6. Core가 기존 ABI stdout 처리·lease 갱신·stall·cancel poll·그룹 cleanup·정산을 계속 수행한다. 정상 result+exit 0+그룹 비움이 확인된 경우만 admission release를 시도하는 기존 조건을 유지한다(`queue/supervisor.ts:438`–`:441`). 불명/실패 시 holder를 놓지 않는다.

현재 Core `bootstrap.authorize`는 handle·identity·work·token·AbortSignal을 이미 받는다(`queue/supervisor.ts:25`). 이 계약은 재사용 가능하다. launch context는 `WeakMap<ProcessHandle, context>` 같은 내부 보관 또는 opaque native handle로 묶을 수 있다. 전역의 마지막 실행 context, PID 단독 키, snapshot에 capability를 넣는 방식은 피한다. 연결은 attempt별이며 승인 성공 뒤에도 broker/UI 폐기·worker 종료 관찰에 필요하므로 authorize 반환 직후 닫으면 안 된다.

`brain_supervisor_native_bootstrap`은 GUI와 store callback을 조합하는 얇은 wrapper다(`supervisor-native.c:9`–`:12`). 이 함수를 둘째 supervisor로 키울 이유가 없다. libpq 연결은 헤더의 단독 소유권 계약에 맞춰 해당 adapter가 직렬 사용하고, Core의 Node DB connection과 열린 transaction을 공유한다고 가정하지 않는다(`supervisor-store.h:4`, `supervisor-store.c:22`). DB tx는 IPC나 UI 대기 동안 열지 않는다.

### 타입·세대·시각

필요한 내부 context는 work/attempt UUID, run generation, 선택된 target, binding generation, package digest+generation, connection epoch, auth session, 실제 PID, lease, 정확한 OS 시작 시각 및 GUI scope다(`native/session.h:8`–`:13`, `gui-client.c:11`–`:18`). PID/UID/hash는 메시지의 자칭 값이 아니라 인증된 서비스/설치 policy에서 와야 한다. Core incarnation과 boot UUID/boot timestamp는 서로 다른 값이며 하나로 대체하지 않는다.

C의 uint64를 JS number로 무조건 변환하지 않는다. Core 현 `protectedIdentity.connectionEpoch`는 양의 safe integer만 저장한다(`postgres/src/work.ts:351`–`:354`). bridge wire는 범위 검증 또는 십진 문자열/bigint 인코딩을 명시해야 한다. UUID와 package 길이·고정 필드·최대 frame을 검증한다.

중복 신원 쓰기는 정밀도 문제가 있다. native는 시작 시각을 마이크로초로 저장하고 boot는 초로 저장한다(`supervisor-store.c:56`–`:60`). JS Date는 밀리초이며 Postgres `recordSupervisedProcess`는 기존 보호 identity와 정확한 시각 일치를 요구한다(`work.ts:361`–`:365`). native가 먼저 기록하고 Core가 잘린 Date로 재기록하면 같은 프로세스여도 거부될 수 있다. 하나의 기록 소유자를 두는 이유다. 정밀도를 낮추어 CAS를 통과시키기보다 관찰용 Date와 권위 exact timestamp를 구분해야 한다.

또한 protectedIdentity 분기는 `requires_input_revoke` registry 행을 요구한다(`work.ts:366`–`:368`). `sealedGarminLaunches`는 collect도 만들지만 native PG store는 auth kind만 받는다(`supervisor-store.c:60`, `:65`). auth D4B 성공을 collect 완료로 넓히거나 collect에 가짜 GUI/입력권한을 붙이지 않는다. collect는 FD 5·GUI 없이 별도 non-input protected launch의 기록/ACK 계약을 명시하고 검증해야 한다.

## 실제 ProcessHandle과 그룹 관찰의 남은 작업

`ProcessHandle.pid`는 native host가 반환한 **worker PID**여야 한다(`host-client.h:13`, `host-client.c:74`). bridge helper·host·GUI PID는 별도 관찰 대상이다. stdout/stderr는 XPC로 받은 FD를 owning stream으로 변환해 AsyncIterable을 제공한다. `runtime/process-group.ts:14`–`:41`의 backpressure·queued chunk 보존·읽기 오류 계약을 재사용할 수 있으나 그 Node child 객체 자체를 native 자식으로 가장할 수 없다. supervisor는 stderr를 신원 저장 중에도 배출하고 보호 stderr를 버린다(`queue/supervisor.ts:249`–`:254`). stdout도 ACK 전 무한 누적하지 않도록 bounded queue가 필요하다.

C host가 부모이므로 Node의 child_process exit를 worker reaping 증거로 쓰지 않는다. host의 인증된 wait_status 이벤트를 code/signal로 변환해야 한다. 현재 중요한 불일치가 있다. host는 leader를 reap했어도 그룹이 남으면 `unknown`만 보낸다(`worker-service.c:79`–`:92`). client observer는 `exit`만 성공으로 받고 unknown을 -1로 만든다(`host-client.c:29`–`:38`). 하지만 Core handle의 exited는 자손 stdio와 독립인 leader reaping이다(`ports/process.ts:10`). 따라서 leader reaped 이벤트와 그룹 상태를 분리해 전달하는 확장이 필요하다. unknown 연결을 성공 exit로 변환하거나 exited Promise를 영원히 보류해 shutdown이 멈추게 하지 않는다. 필요하면 관찰 불명을 명시하는 port 결과 확장을 검토하고 해당 Core 오류 경로까지 연결한다.

현재 `brain_host_inspect`는 그룹 0/1만 반환하고 leader exited 이후에는 조회하지 못한다(`host-client.c:94`–`:103`). Core inspector는 `ProcessGroupMember[]`와 found/none/unknown, boot/start, signal 결과를 요구한다(`ports/process.ts:24`–`:30`). 그룹 1을 `[{pid:workerPid,...}]`로 꾸미면 leader가 죽고 손자만 남은 상황과 PID 재사용을 감춘다. 보호 principal에서 실제 OS 목록을 읽을 권한이 입증되면 기존 system inspector를 사용하고, 그렇지 않으면 인증된 native 관찰 adapter에 실제 멤버 목록·시각·빈 그룹/불명 응답을 추가해야 한다.

`cleanProcessGroup`의 실제 신호 경로는 handle.signalGroup이 아니라 inspector.signalGroup이다(`queue/process-cleanup.ts:27`). handle 하나만 구현하면 cleanup이 연결됐다고 볼 수 없다. host signal 역시 현재 leader가 reap되면 실패한다(`worker-host.c:158`–`:161`); leader 뒤 남은 손자 그룹을 처리하려면 검증된 그룹 identity 기반 신호 경계가 필요하다. 종료는 leader reap과 빈 그룹 확인을 모두 만족해야 한다(`process-cleanup.ts:41`–`:50`). 권한 부족·XPC 단절·불완전 proc 목록은 unknown이다.

재시작도 live map만으로 해결되지 않는다. `listOpenSupervisedAttempts`는 lease/epoch를 반환하지 않고 unknown을 channel_send에만 재조회한다(`postgres/src/work.ts:383`–`:390`). native host ledger는 프로세스 메모리다(`worker-service.c:37`–`:55`). DB에 남은 attempt의 정확한 launch identity로 재접속/관찰·입력 폐기하는 보호된 복구 경계가 필요하거나, 이를 입증할 때까지 unknown/gate를 유지해야 한다. PID만 보고 host 상태를 새 세대로 재생성하지 않는다.

## 취소·hold·disable은 revoke 이후 commit

기존 `requestWorkCancel`/`holdWorkGroup`을 먼저 호출하고 나중에 native cancel을 보내는 방식은 잘못이다. 보호 migration은 현재 attempt·run·lease·epoch의 폐기 증거가 없으면 cancel/hold/disable을 거부한다(`protected-migrations/0029_protected_auth_revoke.sql:19`–`:32`, `:52`–`:75`). broker는 capability를 폐기하고 socket shutdown한 다음 ACK한다(`broker-service.c:191`–`:198`). native adapter는 이 ACK 뒤 transaction을 시작해 evidence와 mutation을 함께 commit한다(`supervisor-store.c:75`–`:84`).

제품의 좁은 내부 mutation adapter에서 현재 활성 보호 attempt들을 조회해 **모두** revoke한 뒤 범위별 mutation을 수행해야 한다. 일반 데이터 API에 `record_protected_auth_revoke`나 lease/epoch 기반 증거 쓰기를 노출하지 않는다. 현재 native revoke_action은 하나의 store/세션과 Garmin 고정 action이다. registry가 일반화되어 있다는 이유만으로 multi-attempt hold/disable orchestration까지 구현됐다고 주장하지 않는다. Core registry와 일반 kind의 동작은 유지한다.

취소 단계는 broker revoke ACK→해당 세대 evidence+고정 mutation commit→Core poll의 종료 처리→GUI 및 worker 그룹 종료 확인→정산이다. daemon shutdown·protocol/stall 오류도 입력권한을 먼저 폐기하도록 정리 경계를 연결해야 한다. `closeBootstrap(): void`는 대기 가능한 broker revoke ACK가 아니다. async 폐기 완료 후 cleanup을 시작하는 내부 hook 또는 명시 adapter 계약이 필요하다. 이름 예시 `revokeInput`은 **제안**이다. timeout 시 폐기/종료를 성공으로 기록하지 않는다.

특히 claim 직후 아직 PID/lease가 DB에 없는 취소 경합이 남는다. migration trigger는 token이 생긴 보호 work에도 revoke evidence를 요구하지만 evidence 함수는 DB lease/epoch 일치를 요구한다(`0029:24`–`:26`, `:52`–`:58`). 현재 libpq revoke_action은 `s->admitted`와 등록된 broker 세션을 전제한다(`supervisor-store.c:76`); 등록 전 취소를 그대로 처리하지 못한다. 이를 blanket 예외로 풀면 취소 뒤 늦은 spawn이 생긴다. 선택지는 (가) 보호 supervisor가 cancel/launch 진입을 직렬화하고 미spawn 상태를 권위 있게 기록해 늦은 spawn을 영구 차단하는 별도 상태 전이, (나) 최초 claim에서 미입력 세션/launch epoch를 할당하고 모든 경계가 같은 상태 기계를 따르는 방식이다. 어느 방식도 현재 구현됐다고 확정하지 않는다. 보안 결정이 필요한 무spawn 증거 권한·재시작 의미는 계획 근거와 함께 지휘자에게 확인해야 한다.

revoke 후 DB commit 응답이 유실되면 입력은 다시 열지 않고 DB 상태를 확인한다. 같은 revocation을 무조건 재기록하면 `record_protected_auth_revoke`의 on conflict do nothing/return found 때문에 false일 수 있다(`0029:27`–`:29`). 재조회와 정확한 세대 일치로만 복구한다. DB/FD는 원자적이지 않으며 이미 전송된 frame/HTTP는 in-flight다. native 보고 `:67`, `:83`의 관리자 trigger 우회와 정상 제품 취소를 혼동하지 않는다.

## bridge 배치와 신뢰: 구현 선택 및 미확정 부분

Node↔C 연결 방식은 아직 위 파일에 없다. 가능한 최소 방안은 (가) 보호 supervisor 프로세스에 고정 native addon을 로드, (나) 보호 설치된 전용 bridge 실행물을 자식으로 띄워 bounded 제어 protocol을 사용하는 것이다. 어느 쪽도 새로운 claim loop를 만들지 않는다. (가)는 FD의 직접 소유가 간단하지만 Node 실행물·로더·addon·JS 전체 봉인과 코드 신원을 입증해야 한다. (나)는 제어와 ABI stdout의 별도 채널·helper 소실·backpressure·취소 관찰 설계가 더 필요하다. 실제 worker stdout을 helper의 일반 진단과 섞으면 안 된다. 이 선택은 **제안**이며 실제 배포 구조를 확정하지 않는다.

양쪽 모두 설치 policy가 Mach service 이름·상대 UID·cdhash·고정 package·GUI 경로를 공급해야 한다. `xpc-peer.c:9`–`:19`, `:27`–`:48`은 code signing requirement와 XPC 메시지의 실제 code, UID, 첫 peer PID pinning을 검사한다. worker control FD도 audit token+UID+실제 PID+cdhash를 검사한다(`peer.c:17`–`:35`). 일반 signed Node/Python 실행물의 cdhash는 그 실행물이 읽는 임의 script를 승인하지 않는다. 사용자 수정 JS/venv·NODE_OPTIONS/PYTHONPATH·동적 library·cwd/module 탐색 경로로 다른 코드를 실행할 수 있으면 보호 supervisor/worker 신뢰가 성립하지 않는다. 고정 봉인 launcher 또는 서명 bundle 전체의 코드·로딩 경로·주입 방지 정책이 필요하다. 이를 해소하지 않은 addon/bridge는 fixture 단계만 가능하다.

worker의 현재 고정 경로는 `worker-host.c:59`–`:84`와 `sealed-garmin.ts:3`–`:4`의 설치 후보다. root부터 각 부모 openat/O_NOFOLLOW·root owner·그룹/타인 쓰기 금지·ACL 부재와 최종 실행물 단일 링크·서명을 검사한다(`worker-host.c:22`–`:52`). fixture의 사용자 소유 허용 분기는 운영 증거가 아니다(`:70`–`:76`). 새 bridge에도 같은 신뢰 수준이 필요하다. 사용자 spec의 command/args/env, install 정책 헤더 경로, UID/hash를 런타임 임의 입력으로 받지 않는다. `sealed-launcher.ts:14`–`:25`의 허용 목록은 유지하되 그 검사가 native peer 검증을 대체하지 않는다.

보호 PGconn은 supervisor 역할만 소유하고 broker 역할의 연결을 빌려 admission_valid를 호출하는 방식은 피한다. 역할을 합치지 않는다. native PG store의 제한 tx/role 검사를 재사용하되 실제 자격 취득·보호 엔진 인증·설치는 별도 미완료다. native 보고 `:89`–`:93`의 credential parser/ASan 범위는 실제 서버 TLS·principal 격리 성공이 아니다. `tooling/protected-deployment/README.md:7`–`:9`도 fixture 설치와 실제 운영 설치의 차이를 명시한다. 보호 OrbStack·서명 배포·egress가 미입증이면 auth 입력/HTTP는 계속 닫는다.

ABI/snapshot 전달을 위해 필요한 추가 wire는 고정 필드의 비밀 없는 launch 메타데이터만 받게 한다. 현재 FD 4 control은 peer hello 경계이며 임의 실행 명령 통로가 아니다. 고정 bootstrap frame을 추가하거나 검증된 host가 허용 ABI env를 생성하는 후보가 있으나 설정 snapshot 최대 길이·schema·attempt binding을 양쪽에서 검사해야 한다. 비밀번호/MFA/token·DB URL은 그 frame/env에 넣지 않는다. worker principal의 자격/HTTP 권위 경계는 D5와 보호 배치 결정을 보존한다.

## 실행할 검증 설계: 이번 조사에서는 실행하지 않음

기존 port 단위 시험은 회귀 근거로 재사용하고, 핵심 수락은 **실제 `runSupervisor`+제품 adapter+격리 권위 PG+별도 native 서비스/worker**로 새 harness를 만들어야 한다. 현재 composed-supervisor fixture의 자체 claim을 제거하고 Core claim을 쓰게 하는 것이 핵심 차이다. fixture 코드서명·같은 UID·합성 생체라는 라벨은 그대로 유지한다. 실계정/운영 DB/HTTP는 필요 없다.

| 검증 묶음 | 재사용할 소스 | 추가로 실제 관찰할 내용 |
|---|---|---|
| 조립 및 경로 봉인 | `apps/cli/test/sealed-launcher.test.ts:6`, `sealed-garmin.test.ts:5`; `core/test/supervisor.test.ts:441`, `:460`, `:475`, `:495` | native backend 실제 호출까지 연결, 일반 kind는 privileged host 시작 0, 사용자 manifest/PATH/args/unknown env/교체 package 전부 거부 |
| 순서와 중복 admission | `apps/cli/test/process-group.test.ts:211`의 success/record-failed/cancel/hold/identity-unknown/shutdown 행렬; `native/tests/supervisor-bootstrap-fixture.c` | admission insert 1회, host spawn 1회, 실제 Core attempt와 worker PID 일치, identity commit barrier 전 ACK/constructor/비밀 read 0, commit 응답 불명도 ACK 0 |
| 종단 native+PG | `native/tests/check-composed-auth.sh:105`, `:127`의 libpq/별도 프로세스 조립; `composed-supervisor.c:49` | 동일 migration/서비스를 Core runner로 구동, `brain.work_attempts`와 admission holder의 token/run/lease/epoch 대조, fixture의 stdout `ok` 대신 ABI 1 heartbeat/progress/result/error 사용 |
| stdout·leader·손자 | `apps/cli/test/process-group.test.ts:103`, `:270`, `:288`; `core/test/supervisor-abi.test.ts:52`, `:60`, `:151`; `daemon-supervisor-cancel.test.ts:37` | 큰 stdout backpressure·stderr canary 배출, leader reap 뒤 손자 pipe/group 유지, signal 실제 대상·group empty와 출력 EOF 독립, XPC 소실은 unknown |
| 취소와 세대 | 기존 composed CASE 12/13/14/15/16, RACE, GENERIC (`story-mfa-0-g4-native-report.md:65`–`:81`) | 제품 requestCancel/hold/disable 진입에서 broker shutdown ACK가 DB mutation보다 먼저임, 이전 epoch 실패, 모든 활성 세션 revoke, claim→prepare→spawn→record→GUI→ACK 각 barrier의 취소, 실패 시 재입력 0 |
| 재시작과 OS 신원 | `apps/cli/test/daemon-supervisor-cancel.test.ts:53`, `:73`, `:83`; `core/test/supervisor-cancel.test.ts` | Core/bridge/host 각각 kill, 실제 worker PID의 OS 시작 시각·boot 변경/PID 재사용, 불명 시 signal·새 claim·gate release 0, 권위 복구 후에만 정산 |
| 승인과 worker 수락 | composed CASE 1–5, `native/tests/composed-ui.m`, `composed-worker.c`, broker/session fixture | 정확한 credentials 1회+동일 worker/client MFA 3회, callback 변조·중복·역순·취소·fourth MFA 거부, consume 전 FD 첫 바이트 read 0, UI scope/package/binding/context 변경 실패 |
| 계정 직렬화 | `core/test/supervisor.test.ts:154`, `apps/cli/python-test/garmin-admission.test.ts`, 보호 PG fixture | dedupe되지 않는 auth/collect 같은 계정 비중첩, 확인된 다른 계정 병렬, discovery/binding 전환 gap 없음, busy defer가 중복 admission 실패로 오염되지 않음 |

위 표의 `core/`는 `packages/core/`, `native/`는 `extensions/garmin/native/`다. 기존 shell harness 명령을 그대로 재실행하는 것만으로 Core 연결 시험이 되지 않는다. libpq role fixture의 superuser를 통한 session authorization은 격리 스키마 시험일 뿐 실제 자격 설치를 입증하지 않는다.

각 barrier는 비밀 없는 고정 단계 식별자로 관찰한다. 기록할 것은 work/attempt의 시험용 내부 UUID, 실제 PID, 단계·카운터·commit 전후 상태이며 raw frame·사용자 profile·DB 자격·libpq 예외는 기록하지 않는다. canary는 임의 문자열로 정하고 stdout/stderr·ABI·work_attempts·failures·로그에 0인지 확인한다. 격리 fixture cleanup은 barrier 해제→해당 합성 자식만 종료/reap→Core abort/await→store close→서비스/fixture 제거 순서다. unknown이면 ‘정리 완료’로 쓰지 않는다.

D4B 완료 표시는 포트 fake의 호출 성공이 아니라 위 실제 Core attempt에서 worker identity commit 이전 실행 0, 이후 정상 ABI 및 정산, revoke 선행 취소와 재시작 불명 보존이 관찰될 때만 가능하다. 이때도 보호 principal 설치·실기 생체/AX/lock/sleep·OrbStack 관리 경로·D5 실제 library/egress·D6 전체 T01–T28·추가 반례·독립 리뷰·D7은 별도 미완료로 남는다. 계획 `:439`–`:442`의 제출별 생체 정책은 이미 확정되어 있으므로 이번 연결 편의를 위해 완화하거나 재선택하지 않는다.
