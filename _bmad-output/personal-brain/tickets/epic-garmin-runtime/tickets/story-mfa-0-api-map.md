# 16.2 g3 D2 제한 데이터 API 연결 조사

작성일: 2026-11-01. 범위: 계획과 현재 작업 트리 소스의 정적 읽기. 구현자가 별도로 활성 상태이므로 아래 파일:줄은 조사 시점의 위치이며 후속 diff에서 이동할 수 있다. 소스 변경·빌드·시험·운영 DB·실제 .env·tokenstore 읽기·설치·추가 worker 실행은 하지 않았다. 이 파일만 작성했다. 아래 권한 거부 관찰은 **검증 설계**이며 실행/통과 증거가 아니다.

## 결론과 고정 계약

계획 `_bmad-output/personal-brain/tickets/epic-garmin-runtime/tickets/story-mfa-0-plan.md:64`–`:67`은 보호된 OrbStack/DB·단일 supervisor·broker·Garmin worker principal을 구분하고 사용자 CLI/hook은 좁은 데이터 API로 연결하도록 결정했다. **현재 PostgreSQL Store 전체를 RPC로 그대로 노출하는 방식은 이 결정을 충족하지 못한다.** Store에는 일반 데이터뿐 아니라 claim/settle/admission/설치 진척과 콜백이 섞여 있다. 사용자 경계는 Core의 명명된 명령 operation, 내부 경계는 역할별 typed port로 나누고 DB 소유·자격은 보호 서비스에 남겨야 한다.

Garmin quarantine은 이미 소스에 있지만 전체 제한 API/보호 supervisor 배포의 완료 증거는 없다. 일반 brain_app과 관리 비밀번호가 사용자에게 남으면 API가 아무리 좁아도 우회 SQL·DDL·Docker exec로 권위가 위조된다. D2와 D3 연결이 완료될 때까지 auth 입력과 HTTP는 닫아야 하며, D1의 실제 보호 엔진 격리 미증명을 D2 fake/API 성공으로 대체해서는 안 된다.

## 현재 구현: 정확한 이동 지점

| 현재 소스 지점 | 현재 동작 | D2/D3에서 필요한 연결 |
|---|---|---|
| `apps/cli/src/runtime/brain-store.ts:5`, `:16`–`:23` | OpenBrainStoreOptions.createStore가 PG 옵션을 받고 resolveStoreUrl→postgresStore로 연결 | 사용자 경로는 DB URL을 받지 않는 typed service client/command client로 교체. 보호 서비스 내부에서만 PG adapter 구성. 사용자 env URL을 서비스 backend 설정으로 전달 금지 |
| `apps/cli/src/dispatch.ts:598`, `:601`–`:621`, `:628`–`:644` | 공통 DB store와 Core 생성, config 전용 경로도 동일 store 사용 | 기존 select/preflight/명령 문법·렌더러 유지. 각 명령 use case를 서비스 operation에 연결. getExtension 후 사용자 manifest를 읽어 setting 정의를 정하는 `:610`–`:615`는 보호 서비스의 봉인 registry 정의로 대체 |
| `apps/cli/src/dispatch.ts:646`–`:680`, `:701`–`:705`, `:781`–`:794` | write schema guard, hook spool fallback, daemon 부재시 CLI 자체 opportunistic drain | 서비스의 schema 결과를 동일 실패값으로 전달. 일반 입력 spool fallback 보존. drain은 서비스에 budget을 둔 요청/깨우기로 전달하고 사용자 프로세스에 claim/실행 권한을 주지 않음 |
| `apps/cli/src/assembly.ts:76`–`:108` | store 외에도 extension runtime, 로컬 files/source/importStaging/git/transcript를 조립 | 사용자 transcript/file 취득과 보호 DB 처리를 분리. 보호 서비스가 사용자 선택 파일/명령을 privileged 권한으로 열거나 실행하지 않게 사용자 principal 취득 adapter 또는 제한 FD 전송 사용 |
| `apps/cli/src/daemon/run.ts:160`, `:207`–`:223`, `:321` | supervisor 한 개 시작, Docker compose 자동 복구, drain store 생성 | 이 한 supervisor 수명주기를 보호 배치로 이동. 사용자 daemon은 필요하면 relay/관찰 역할만 맡으며 두 번째 supervisor를 만들지 않음. Docker 복구는 보호 설치 정책 내부로 이동 |
| `apps/cli/src/daemon/supervisor.ts:25`–`:28`, `:31`–`:43`, `:67`–`:98`, `:115` | app URL·Telegram secrets, 사용자 extension manifest/venv/entry·migration·.env로 launch spec 생성; runSupervisor 호출 | 보호 Garmin은 봉인 package digest/등록된 launcher/설정으로 구성. 사용자 manifest의 admission_setting/entry/PATH/venv가 보호 실행·권한 선택자가 되면 안 됨. 일반 확장은 사용자/비특권 principal로 계속 실행 |
| `apps/cli/src/daemon/supervisor.ts:47`–`:63` | admission reserve/release 콜백과 resolved target을 snapshot에 연결 | 보호 supervisor 전용 internal AdmissionPort를 연결. 사용자 API에서 해당 콜백·token·generation·resolved binding을 직접 제출하거나 결과를 확정할 수 없음 |
| `packages/core/src/queue/supervisor.ts:182`–`:190`, `:237`, `:375`–`:378`, `:435` | spawn 전 admission, OS process 기록, 성공·그룹 종료 확인 뒤 release, supervised claim | 기존 실행/회수/직렬화 engine 재사용. 보호 principal이 authoritative claim/token/incarnation/OS identity를 생성/검증; 새 Garmin 전용 supervisor 도입 금지 |
| `packages/postgres/src/work.ts:146`–`:178` | extension 문자열 검증·current work lock·generation 검사·1900ms tx 제한 뒤 동적 schema function 호출 | 내부 port로만 유지하고 보호 registry에서 extension/function을 선택. 외부 요청의 extension을 SQL 함수 라우팅 권한으로 사용 금지 |
| `apps/cli/src/workers/channel-send.ts:14`, `:20`–`:29` | ABI env app URL로 전체 postgresStore 생성 | 별도 worker용 제한 ChannelAttemptPort 또는 보호 sender와 연결. 일반 채널 worker에 app/supervisor/broker 자격을 넘기지 않음 |
| `apps/cli/src/runtime/extensions.ts:117`–`:134`, `:225`–`:231` | 사용자 app URL로 install lock, admin URL로 provisioning/migration, env secret·worker DB URL 공급 | install 요청은 package ID/version만. 보호 installer가 봉인 bundle에서 owner·migration·허용 실행물 선택. 사용자 directory/SQL/script/URL을 받아 관리자 실행하는 API 금지 |
| `apps/cli/src/config/codec.ts:742`–`:763`, `:780`–`:787` | env 우선 app URL, 사용자 .env에 app/admin password 생성·관리 URL 합성 | 사용자 CLI에서는 service endpoint/instance selector만. DB·admin·broker 자격은 보호된 설정 저장소. 이전 사용자 자격 폐기/회전은 별도 이전 단계에서 필요하며 파일만 지워도 과거 자격은 무효화되지 않음 |
| `apps/cli/src/install/postgres.ts:36`–`:64`, `apps/cli/src/install.ts:286`, `apps/cli/src/commands/setup-uninstall.ts:27`–`:35` | 사용자 Docker compose·admin prepare/migrate·직접 PG health·volume 제거 | setup/update/uninstall의 명령 surface는 남기되 보호 설치 lifecycle operation으로 분리. 임의 compose/env/volume/DB URL 인자를 받지 않으며 운영 설치·이전은 이 조사에서 수행하지 않음 |
| `packages/postgres/src/store.ts:20`–`:31`, `:32`–`:75` | 하나의 거대 Store가 모든 capability 합성, doctor 쓰기 probe와 schema 조회 | 서비스 내부 PG composition만 유지. 사용자 health에는 비밀 없는 고정 projection; 임의 probe SQL/표/함수 이름 받지 않음 |

## 최소 사용자 데이터 operation 제안 — 현재 구현 API라는 뜻이 아님

operation의 입력/결과는 현재 Core의 명령 타입을 재사용하되 wire에서 exact tagged union·버전·크기·중복 필드·범위 검증을 한다. free-form Store method name, SQL, callback, URL, 파일 경로를 가진 관리자 실행 요청은 없다. owner/instance는 OS peer 인증과 보호 서비스 설정에서 정하고 요청의 userId로 정하지 않는다.

| 제안 typed port / operation | 보존할 일반 명령 | 재사용 근거 및 서버 소유 검증 |
|---|---|---|
| `SessionDataApi.ingest/read` | sessions ingest/read, hook 입력·cursor·pagination | `commands/sessions-ingest.ts:70`–`:115`, `commands/sessions-read.ts:4`–`:6`; Core `ports/store.ts:271`–`:354`. ingest는 검증된 일반 session data/사용자 취득 transcript 입력만 받고 privileged read-file 서비스를 만들지 않음. identityWork/id/owner·내부 work는 서비스가 만든다 |
| `RecallDataApi.chunks/tools/text/expand` | recall의 기존 filter/limit/range·masked output | `commands/recall-{chunks,tools,text,expand}.ts`, `ports/recall-store.ts:8`–`:9`. query/pattern을 SQL fragment로 해석하지 않고 기존 Core validation·출력 masking 유지 |
| `RedactionApi.message/file` | messages/files redact의 현재 confirm·refusal | `commands/messages-redact.ts:31`, `commands/files-redact.ts:34`; `ports/store.ts:228`–`:231`, `:1027`–`:1030`는 plan 콜백이므로 RPC 대상 아님. 메시지/파일 ID와 명령의 declarative 입력만 받고 plan/current 읽기·tx CAS는 서비스 안에서 실행 |
| `QueueUserApi.list/cancel/drain` | queue list/cancel/drain, 기존 budget/tally | `commands/queue-list.ts:10`, `queue-cancel.ts:13`, `queue-drain.ts:79`; `ports/store.ts:695`–`:713`. cancel은 요청 사실만, drain은 단일 서비스에 수행 요청만. cancel이 death/settled 성공을 증명하지 않음 |
| `FailureUserApi.list/retry` | failures list/retry | `commands/failures-list.ts:72`, `failures-retry.ts:57`. stage/target kind를 허용 registry와 대조; retry로 privileged auth 승인·uncertain 제거·직접 claim/정산 불가 |
| `ScheduleUserApi.list/add/remove/run` | schedules 문법과 날짜/시간대 관찰 | `commands/schedules-{list,add,remove,run}.ts:6`; `ports/store.ts:1434`–`:1445`. kind/target의 등록 허용 조합만; serialization key·binding gen·schedule success·fire CAS는 서비스가 결정. force/run도 보호 검사 동일 |
| `ExtensionUserApi.list/status/enable/disable/run/install` | ext 일반 명령과 설치 resume 관찰 | `ports/store.ts:1507` 이후, `extensions/run.ts`, `extensions/install.ts:181`–`:198`. 사용자 요청은 의도. version/package/schema/auth success/OS readiness를 사용자가 확정 못함. enable은 latch 해제 아님 |
| `SettingsUserApi.get/set` | config get/set | `commands/config-get.ts:18`, `config-set.ts:20`; `ports/store.ts:1471`–`:1474`. 보호 registry의 등록키·타입·stage만; DB/admin/broker 자격·launcher·egress policy·package digest는 이 API 키가 아님. 민감값 반환은 기존 정책보다 넓히지 않음 |
| `ChannelUserApi.list/status/resend` | channels list/status/resend | `commands/channels-status.ts:9`–`:19`; `channels/store.ts:26`–`:28`. resend는 요청만; sent/gate/attempt result는 내부만 |
| `DiagnosticApi.health/schema/status` | doctor run, daemon status, ext public attention | `store.ts:83`–`:87`, `:870`–`:875`; PG `store.ts:32`–`:75`. 서버가 검사하고 고정 코드·비밀 없는 위치/상태 projection만 반환. readiness JSON/PID는 사용자 관찰용으로는 가능하나 보안 증거가 아님 |
| 별도 `AuthOperatorApi.attach` / `ProtectionOperatorApi.releaseRateBlock` | ext auth, 명시 rate/manual 해제 흐름 | Core `brain.ts:251`, `:435`의 현재 auth는 미검증 peer 실패값 지원. release는 Garmin SQL `0007_account_protection.sql:220`–`:235`에 구현 흔적이 있으나 `0008`에서 회수됨. 일반 API 요청만으로 승인하지 않고 검증된 UI/operator·현재 세대와 결합. 비밀번호/MFA는 이 데이터 API body에 넣지 않음 |

`guide show/schema/exit-codes`·명령 선택/preflight는 로컬 정적 처리로 유지할 수 있다. setup/daemon start·stop은 데이터 API와 별도 고정 lifecycle 요청이며 임의 exec/설정 복사 API로 만들지 않는다.

## 최소 내부 typed port / DB 역할 제안

1. **SupervisorWorkPort**: `claimSupervisedWork`, `renewSupervisedLease`, `recordSupervisedProcess`, `listOpenSupervisedAttempts`, `finishSupervisedWork`, `settleSupervisedAttempt`, `deferSupervisedAdmission` (`ports/store.ts:691`–`:711`). 일반 drain의 claim/complete/retry와 install journal 쓰기도 서비스 내부로 제한한다. queue list projection에서 attempt token·DB 자격·private process evidence를 내보내지 않는다.
2. **AdmissionPort**: reserve/release, canonical target/binding generation과 discovery gate 결과 (`work.ts:146`–`:178`). 보호 supervisor만 reserve. 성공 반환값은 DB commit 뒤 제공하고 저장 실패에는 spawn 없음. release는 성공·그룹 종료·pending intent 없음의 내부 증거에 결합한다.
3. **AuthEvidencePort**: 승인된 broker 세션/work/attempt/run·binding·package/OS identity·library dump/권한 검사에 결합한 evidence 생성/소비. 사용자 `authSuccess:true`, profile ID, 파일 mtime, library result JSON은 증거가 아니다. evidence row 쓰기는 broker 역할만; supervisor도 임의 성공 evidence 생성 권한을 받지 않는다.
4. **GarminHttpGatePort**: bind admitted profile, begin actual HTTP, finish observed HTTP, probe reservation, first-call budget/pacing, pending/uncertain facts. `0007_account_protection.sql:169`, `:283`–`:361` 재사용 계약을 보호 role로 재작성할 후보. worker가 임의 URL/method/body/결과 success를 제출하는 generic proxy 금지; 봉인 endpoint operation과 broker가 관찰한 전송/결과만. 실제 네트워크 경로의 OS egress 제한은 D5이며 DB API만으로 직접 HTTP 차단을 입증 못함.
5. **InstallLifecyclePort**: 허용 package ID/version의 provisioning/migration·등록·원자 publish·resume journal. 관리자 role은 여기만; 서비스 사용자 데이터 handlers·worker는 owner/admin 자격에 접근하지 않음.
6. **ChannelAttemptPort / InternalDataMaintenancePort**: 채널 gate/finish/recover, imports handoff/finish/fail, file/extraction/index transaction 등 현재 포트를 task/attempt로 scope. `channels/store.ts:35`–`:42`, `ports/import-store.ts:21`–`:31`, `ports/conversation-index-store.ts:6`–`:9`. 외부 API의 rawViews/source/locator/remove callback을 그대로 forwarding하지 않는다. 등록된 source/raw view allowlist는 서버 소유다.

이것은 새 서비스/새 supervisor를 여섯 개 만들라는 뜻이 아니라 **기존 단일 supervisor와 동일 보호 서비스 안에서 권한을 분리할 인터페이스**다. worker 별 DB credential을 주더라도 보호 상태 직접 DML/DDL/역할 변경은 금지하고, 불필요하면 DB 접근 자체를 없애 좁은 broker port만 준다. 일반 확장 SQL 권한과 관리 API는 보호 Garmin 권한으로 승격되지 않는다.

현재 역할 scaffold `packages/postgres/src/protected-roles.ts:3`–`:22`는 brain_protected_supervisor/broker/worker를 NOLOGIN·membership 없음으로만 준비하고 충돌을 거부한다. **운영 가능한 역할 login/grant·서비스 구현이 아니다.** `setup.ts:25`, `:52`는 여전히 brain_app login과 기본 table CRUD를 준다. 보호 권한에는 core work_items/work_attempts·hold/extension state·registry·schema migration도 포함해야 한다. Garmin table만 회수하고 brain_app work DML을 남기면 가짜 current attempt·cancel/hold 제거가 가능하다는 경계를 남긴다.

현재 `0007_account_protection.sql:128`, `:156`, `:262`, `:287`, `:334`는 session_user가 brain_app/brain_ext_garmin인지 하드코딩한다. 새 role에 GRANT만 추가하면 기능이 작동하지 않으며, 과거 role에 재허용하면 quarantine을 되돌린다. 전용 migration으로 role predicate와 최소 EXECUTE/테이블 권한을 함께 바꿔야 한다. SECURITY DEFINER는 고정 search_path, 안전한 소유자, PUBLIC execute 회수, object/schema CREATE 회수, role membership/소유/기본권한까지 검증해야 한다.

## 사용자 spool: 비권위 의미와 실제 상태

- 실제 형식은 `packages/core/src/domain/spool-record.ts:78`–`:81`의 session_ingest/failure/attachment_link다. 64 KiB 상한 `:42`, transcript 본문이 아닌 재수집 경로 `:91`–`:97`가 있다. 사용자 수정 가능한 파일이므로 정상 codec/UUID/타임스탬프도 인증 근거가 아니다.
- 실제 replay `packages/core/src/brain.ts:362`–`:397`은 session을 재수집하고 attachment를 연결한다. failure `:399`–`:411`은 **이미 workItemId를 버려 work를 닫지 않는다**. 이는 보존할 방어다. 다만 arbitrary stage/target/message가 일반 failures 행으로 들어오는 경로이므로 보호 상태/evidence로 소비하면 안 된다.
- 제안: 사용자 spool은 일반 입력의 재시도 힌트/비권위 진단만 허용. replay는 서비스의 동일 일반 operation으로 재검증한다. auth/collect admission, evidence, intent/outcome, rate/auth/uncertain latch, process identity, work attempt completion, package/install 성공, schedule success를 spool로 반영하지 않는다. failure의 stage가 garmin.auth처럼 보여도 보호 사실로 인정하지 않는다.
- failure retry·resolveFailures·attachment ID 충돌로 보호 work/증거를 바꾸는 연결도 차단한다. 중복 ingest의 자연키 idempotency와 spool idempotency는 유지하되 replay 시각/사용자 occurredAt으로 권위 generation/clock을 정하지 않는다.
- 서비스 부재 때 hook은 기존 `commands/sessions-ingest.ts:103`–`:115` fallback, `dispatch.ts:646`–`:670` SPOOLED/원인 코드와 `:527`–`:528` exit 0을 유지. 일반 명령은 DB_UNAVAILABLE 등 현재 실패 관찰을 보존하며 보호 auth/HTTP는 spool로 성공하지 않는다. 권한 거부를 서비스 부재로 숨기거나 승인 재시도로 바꾸지 않는다.
- 사용자 transcript 경로/attachment locator는 보호 UID의 파일 read capability가 아니다. symlink/부모 교체·상대경로·특수 파일·크기 검증과 principal 분리가 필요하다. 보호 tokenstore/.env/socket/실행물 경로를 일반 files/redact/recall-text로 읽거나 쓰거나 삭제할 수 없어야 한다.

## 권한 검증·거부 관찰 설계 (미실행)

| 시도/실패 주입 | 필요한 관찰 |
|---|---|
| 기존 사용자 app/ext credential 및 같은 UID 미승인 executable로 SQL/서비스 호출 | 보호 tables/functions/roles·core authoritative work 직접 변경 거부. 서비스 OS peer·실행물/instance 검증 거부, auth prompt/secret/HTTP 0. 단순 UID 일치로 통과 금지 |
| 일반 API에 SQL, URL, exec/args/env, migration directory, manifest/venv/PATH, DB URL·rawViews·function 이름 제출 | exact operation schema 거부, 관리자/DB/파일/HTTP 부작용 0. unknown field를 버리고 실행하지 않음 |
| 사용자 readiness/public.json/DB token/PID·package digest 위조 | projection으로만 취급; 보호 bootstrap/admission/evidence 불변, spawn/비밀/전송 0 |
| generic queue enqueue나 schedule kind로 garmin.auth/collect/release 직접 지정, stale work/attempt/run/binding 재사용 | 서버 allowlist·현재 상태·세대 CAS 거부; serialization/admission bypass 없음. 성공 queue 응답도 auth 승인이나 HTTP 허용을 뜻하지 않음 |
| spool failure에 보호 work ID·auth_success code, attachment에 tokenstore locator, 가짜 success/intent kind 주입 | 보호 정산·evidence·latch 변경 0. 알 수 없는 kind 거부/격리와 일반 spool 진단만, 실패 message를 auth 증거로 해석하지 않음 |
| queue cancel/disable/hold 이후 begin HTTP, 다른 세션 evidence 또는 forged success outcome | 다음 boundary 거부; in-flight는 uncertain. auth/rate/uncertain latch 독립 유지. 사용자 release는 검증된 operator 절차로 rate/manual만, auth/uncertain 제거 불가 |
| admission 쓰기 실패, intent commit 응답 유실, 결과 쓰기 실패, crash/lease 만료 | launch/다음 HTTP 거부. durable pending/admission 유지, 재시작 자동 해제 없음. tx는 입력/HTTP 대기와 분리하고 2초 이하 |
| role 재provision/update 후 membership·owner·PUBLIC execute·default grants·extension CREATE 재생성 | fail closed role conflict 또는 최소 권한 유지. `extension-provision.ts:63`–`:78`의 기존 migrated schema 무일괄 재grant 방어 보존 |
| 사용자 app password 교체/서비스 접속 실패 후 직접 PG/Docker fallback | fallback 0. 사용자 관찰은 고정 실패코드·masked envelope, hook만 일반 입력 SPOOLED; 원문 SQL/URL/password/예외를 로그·JSONL에 싣지 않음 |
| 일반 명령 정상/서비스 부재/거부 비교 | 명령 args·--json envelope·warnings/retry_argv·hook exit 0·spool·페이지/건수 의미 유지. `apps/cli/src/envelope.ts:14`–`:47`, `dispatch.ts:419`–`:528` 출력 경계 재사용 |

DB 권한 검증과 OS 격리 검증은 서로 대체되지 않는다. 실제 운영 사용자에게 Docker/OrbStack volume·inspect/exec/create/백업/VM 동등 경로가 열려 있으면 D2 API의 비위조성을 주장할 수 없다. 이 조사 결과는 구현 연결 지도이며 해당 격리의 실증이나 T01–T28 통과 판정이 아니다.
