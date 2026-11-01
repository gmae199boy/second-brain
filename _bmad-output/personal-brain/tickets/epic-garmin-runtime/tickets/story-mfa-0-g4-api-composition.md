# 16.2 g4 D2B 제한 사용자 데이터 API 구현 준비 조사

2026-11-01. 기준 HEAD는 `1d4fec9a16056b0f473967fb6fcaca8a8f37790d`이며 활성 구현자가 작업 중인 실제 소스를 읽었다. 아래 줄 번호는 조사 시점의 위치다. 계획 `story-mfa-0-plan.md` 417줄 전체와 기존 `story-mfa-0-api-map.md`를 먼저 읽었으며, 이 보고서는 기존 지도의 operation 목록을 반복하는 대신 현재 부품을 연결할 실행 단위와 호환성 함정을 보충한다. 두 문서는 모두 `_bmad-output/personal-brain/tickets/epic-garmin-runtime/tickets/` 아래에 있다.

## 전문 요약

D2A의 조회 decoder·역할 quarantine과 D3의 봉인 launch 부품을 재사용하되, D2B는 사용자 명령 façade·OS 인증 transport·보호 서비스 내부 composition·사용자 파일 취득·비권위 spool·자격 이관을 실제 호출 사슬로 연결해야 한다. 현재 `ProtectedDataPort`는 status와 축약 queue 조회만 구현하고 CLI/hook은 여전히 PG Store를 직접 생성하므로, 현 상태는 D2B 완료가 아니며 그대로 교체하면 기존 목록·오류·drain 의미를 잃는다. 아래 최소 분할과 기존 검증을 이용할 수 있지만 일반 CLI/hook의 봉인 신원, 사용자 파일 취득 방식, 응답 유실 뒤 mutation 재시도 정책 등은 근거와 대안을 남겨 결정해야 하며 실제 보호 배치·전체 T01–T28·D5–D7은 계속 미완료다.

이 조사는 읽기 전용이다. 저장소 수정·빌드·시험·하위 워커·운영 설정/토큰/DB·실제 HTTP·설치·배포를 수행하지 않았다. 작성 파일은 이 `/tmp` 보고서 하나다. 이하 “검증”은 재사용할 시험 소스와 추가 설계이며 이번 실행의 통과 주장이 아니다. native/UI/FD의 구현 소유권은 현 구현자에게 그대로 있다.

## 1. 기존 지도 이후 확인한 구현 상태와 연결상 의미

| 원본 코드 | 현재 사실 | D2B가 채울 간격 |
|---|---|---|
| `packages/core/src/protected-api.ts:2`, `:13`, `:43`, `:58` | own descriptor·추가 필드 거부, 고정 실패, 내부 token 제거가 있다. transport는 주입 interface뿐이며 실제 peer 연결은 없다 | decoder/client의 방어는 보존하되 실제 CLI 요청·응답 DTO와 연결해야 한다. transport 객체가 있다는 사실은 OS 인증 증거가 아니다 |
| `packages/core/src/protected-api.ts:49` | `queue.list({limit})`의 실패를 예외로 바꾸고 id/kind/outcome만 남긴다 | `DB_LOCKED` 등 기존 분기, all/kind, count/hasMore와 상태·시도·진행·usage를 잃는다. CLI 대체품으로 바로 사용할 수 없다 |
| `packages/postgres/protected-migrations/0028_protected_work.sql:2`, `:8`, `:43`, `:52` | 보호 kind registry와 core work/attempt/hold/extension/install/schedule/dependency trigger, supervisor grant가 있다 | 이전 지도에서 우려한 core 직접 변조의 일부가 실제 거부 경계로 추가됐다. migration은 `protected-migrations`에 있으므로 일반 설치가 적용한다고 추정하지 않는다. 테스트도 별도 복사하여 적용한다 |
| `extensions/garmin/protected-migrations/0008_protection_quarantine.sql:18`, `0009_protected_roles.sql:6`, `:30`, `:140` 이후 | 기존 app/ext/worker 권한 회수 후 supervisor admission, broker HTTP/binding/auth evidence 역할을 분리하도록 함수를 재정의했다 | 기존 0007의 session_user 판정을 그대로 따른다는 옛 지도 설명은 현재 protected migration 적용 상태에는 해당하지 않는다. 다만 역할은 NOLOGIN이고 실제 principal별 접속/서비스 composition은 미연결이다 |
| `packages/postgres/test/garmin-quarantine.test.ts:22`, `:61`, `:69`, `:75`, `:78` | 보호 migration을 격리 경로에 모아 `SET SESSION AUTHORIZATION`으로 역할별 허용/거부를 검증한다 | SQL 역할 계약의 fixture다. 실제 OS principal의 login·비밀 보관·관리 API 차단 성공 증거가 아니다 |
| `packages/core/src/queue/supervisor.ts:31`, `:234`, `:487` | sealedService의 보호 registry와 일반 host 허용 목록을 사용하며 sealed 모드에서는 사용자 manifest loader를 쓰지 않는다 | 새 감독자가 필요 없다. 실제 보호 서비스가 기존 `runSupervisor` 한 개에 sealedService를 공급하도록 연결해야 한다 |
| `apps/cli/src/daemon/sealed-garmin.ts:10`, `:22`, `sealed-launcher.ts:15` | verifyInstalledWorker/snapshot/admit/release/bootstrap port와 고정 command·env·인자 검사가 있다 | 서비스 composition에서 봉인 registry와 역할별 adapter를 주입할 자리다. 사용자 manifest/URL을 받아 port를 만들면 방어 의미가 사라진다 |
| `apps/cli/src/daemon/ordinary-worker-host.ts:6`, `:23`, `:43` | 별도 사용자 principal·같은 연결의 peer pinning을 요구하는 interface가 있다 | 실제 native peer adapter 전제는 미완료다. 이 interface를 일반 데이터 API나 임의 exec proxy로 재활용하지 않는다 |
| `apps/cli/src/daemon/supervisor.ts:25`, `:35`, `:115` | 실제 시작 경로는 app URL, 사용자 manifest/settings/env 기반 loadProtectedLaunches와 기존 launcher를 여전히 사용한다 | 봉인 부품이 작성됐다고 이 실제 조립이 옮겨진 것은 아니다. `daemon/run.ts:160`의 기존 감독자 수명주기를 보호 entry로 연결해야 한다 |
| `apps/cli/src/runtime/brain-store.ts:16`, `dispatch.ts:598`, `:628`, `:781` | 사용자 CLI의 기본 경로와 opportunistic drain 모두 PG adapter를 연다 | 사용자 경로에서 DB URL 해석·postgresStore 생성·직접 Docker 복구를 제거하고 좁은 service client를 사용해야 한다. 서비스 실패 뒤 옛 경로 fallback은 없다 |

공통 역할 scaffold `packages/postgres/src/protected-roles.ts:4`는 세 역할을 NOLOGIN으로 만들고 membership/특권 충돌을 거부한다. `packages/postgres/src/setup.ts`의 app login/table CRUD 준비와 서로 다른 책임이다. NOLOGIN을 임의로 풀거나 서비스 하나에 supervisor/broker/admin 자격을 합쳐 “동작”시키는 것은 최소 권한 완료가 아니다.

## 2. 가장 작은 실제 실행 분할

아래는 단계별 구현·검증 checkpoint 후보이며 범위를 삭제하는 순서가 아니다. D2B 완료는 B1–B6의 연결 전체가 필요하다. D1 실제 격리 미증명 중에도 fake transport·격리 PG로 코드를 작성할 수 있으나 production auth/HTTP fail-closed를 제거하지 않는다.

### B1. 명령 façade와 wire 계약: 조회 한 사슬부터 닫기

첫 수직 사슬을 `brain queue list → CommandSpec.run → 사용자 CommandBrain façade → 인증 transport → 명명된 handler → 서비스 Brain.queue.list → 내부 PG`로 만든다. `CommandContext.brain`이 현재 `Brain`인 지점(`apps/cli/src/dispatch.ts:101`)을 외부에서 허용할 명령 surface로 좁히고, 내부 `Brain`/`Store`를 RPC 구현체처럼 생성하지 않는다. core `BrainQueue`에는 hold/release, `BrainSchedules`에는 tick, drain input에는 handlers까지 섞여 있다(`packages/core/src/brain.ts:168`, `:215`, `:243`). `Pick<Brain,'queue'>`만으로 공개 범위를 제한했다는 주장은 성립하지 않는다.

구체적인 제안 타입의 형태는 다음과 같다. 이름은 구현 제안이고 현재 export가 아니다.

```ts
type UserQueue = Pick<BrainQueue, 'list' | 'cancel'> & {
  drain(input: { budgetMs: number }): Promise<BrainDrainReport>;
};
type UserSchedules = Pick<BrainSchedules, 'list' | 'add' | 'remove' | 'run'>;
type UserExtensions = Pick<BrainExt,
  'run' | 'install' | 'status' | 'publicStatus' | 'list' | 'enable' | 'disable'>;
// auth는 별도의 검증된 operator 경계이며 secrets는 데이터 wire에 없다.
```

`Parameters<BrainQueue['list']>[0]`, `Awaited<ReturnType<BrainQueue['list']>>` 등을 내부 타입 일치 확인에 활용한다. 그러나 결과는 WorkItem 전체 spread 대신 CLI에서 쓰는 필드의 명시 allowlist DTO로 변환한다. `packages/core/src/queue/list.ts:20`은 WorkItem 전체를 펼치므로 currentAttemptToken·claimedBy·직렬화 내부키를 그대로 serialize하지 않는다. `apps/cli/src/commands/queue-list.ts:11`–`:18`의 현재 출력 필드와 count/has_more를 기준으로 최소 공개 projection을 정의한다. Date 필드는 엄격한 ISO wire 문자열로 encode/decode하고 현재 renderer가 받는 Date로 복원하거나 renderer 입력을 명시 DTO로 바꾸어 전 명령에 일관되게 적용한다. JSON stringify 후 Date가 복원된다고 가정하면 `isoWithOffset()` 호출에서 깨진다.

첫 checkpoint는 실제 façade 경유 queue --all/--kind/--limit와 상태/usage/meta 비교, 잘못된 요청·위조 응답 차단, 서비스 부재 시 PG 생성 0이다. status 두 boolean은 doctor/daemon status 전체 계약을 대체하지 않는다.

### B2. 서비스 내부 composition과 peer 경계

`createBrain`은 서비스 내부에서만 `Store & SchemaStore & SettingsStore`를 받게 유지하고(`packages/core/src/brain.ts:87`, `:284`), handler는 명명된 Core use case를 호출한다. 별도 일반 데이터 principal의 최소 포트, supervisor work/admission 포트, broker evidence/HTTP 포트, installer admin 포트를 조립 단계에서 분리한다. 요청이 role/URL/schema/function/command/env를 선택하지 못하게 한다. `postgresWorkStore.reserveExtensionAdmission`은 내부에서 extension 이름으로 SQL 함수를 고르는 코드(`packages/postgres/src/work.ts:161`–`:178`)이므로 입력 extension은 반드시 봉인 registry에서 결정한다.

일반 API의 peer identity는 요청 JSON의 uid/pid/home이 아니라 인증된 연결 문맥에서 handler에 전달한다. 서비스 신원도 client가 검증한다. `extensions/garmin/native/peer.c:17`의 LOCAL_PEERTOKEN+code validity, `xpc-peer.c`/`host-client.c:47`의 검증 부품은 활용 가능한 원본이다. 다만 auth/worker 전용 메시지 protocol을 일반 data endpoint로 열거나, signed Node를 임의 JS 전체의 승인 신원으로 인정하지 않는다. 사용자 CLI/hook이 어떤 봉인 wrapper를 통해 호출할지와 동적 script injection 방지 증거는 §6의 결정 공백이다.

같은 보호 서비스의 감독자는 `runSupervisor` 하나다. 일반 확장은 `ordinaryWorkerHost`가 사용자 principal에서 실행한다. 일반 data handler의 수가 늘어도 privileged UID에서 사용자 manifest/venv/command/git를 실행하는 부작용이 생겨서는 안 된다. supervisor·broker와 서로 다른 역할 pool/port를 쓰고, 일반 handler가 내부 work claim/finish나 evidence 생성 함수를 참조하지 못하도록 타입과 실제 grant를 함께 검증한다.

checkpoint는 같은 UID 미승인 peer·가짜 서버·다른 instance 거부, 연결 교체 시 재인증, 봉인 registry가 바뀌지 않는지, 일반 endpoint에서 supervisor/broker 자격 접근 0이다. native 부품 시험만으로 이 사슬을 통과 처리하지 않는다.

### B3. 일반 명령들을 기존 use case 타입으로 연결

서버가 기존 유효성 검사와 schema guard를 다시 수행하고, CLI의 선택/preflight·한국어 text/JSON envelope·warnings·retry_argv·종료 코드를 유지한다. 서버에 CommandSpec 전체나 임의 argv를 보내 실행시키지 않는다. 다음은 연결할 정확한 타입과 함정이다.

| 명령군 | 그대로 호출할 타입/지점 | 반드시 보존할 의미 |
|---|---|---|
| sessions read, recall | `BrainSessions.read`/`ReadInput` (`brain.ts:154`, `sessions/read.ts:8`), `SearchInput` (`recall/search.ts:13`), `ExpandInput` (`recall/expand.ts:5`) | cursor/session binding·generation·동일시각 순서, limit+1의 has_more, 출력 크기 budget·다음 호출과 masking. `commands/recall-text.ts`는 text 출력 helper이며 별도 recall.text Core API가 아니다 |
| messages/files redact | `MessagesRedactInput/Result` (`messages/redact.ts:8`), `FilesRedactInput/Result` (`files/redact.ts:54`), `BrainMessages`/`BrainFiles` | confirm/REQUIRES_CONFIRMATION·공유 파일 수·원본 외부파일 보존·redaction CAS. plan callback은 서버 내부다. confirm을 auth 생체 승인으로 해석하지 않는다 |
| queue | `BrainQueueCancelResult`, `BrainDrainReport` (`brain.ts:187`, `:214`) | queued cancelled/running requested/already_closed 차이. 요청 취소가 그룹 사망 증거가 아니다. drain은 완료 보고를 돌려야 하므로 wake 요청만 하고 성공 보고를 꾸미지 않는다 |
| failures | `FailuresListInput/Result`, `FailuresRetryInput/Result` (`failures/list.ts`, `retry.ts:26`, `:58`) | added/alreadyOpen/skipped/redacted/sourceUnreachable. retry는 failures를 직접 resolve하지 않는다. `retry.ts:111`의 고정 stage/target 매핑을 보존하고 Garmin auth 승인이나 uncertain 해제 경로를 새로 추측하지 않는다 |
| schedules | `AddDailyInput`, `AddDailyResult`, `RunScheduleResult` (`queue/schedules.ts:9`, `:19`), `BrainSchedules`에서 tick 제외 | timezone은 서비스 setting으로 결정, run의 당일 범위와 created 유지. 현재 addDaily는 공백/시간만 검사하므로 서비스에서 봉인 kind/target 정책을 추가해야 한다. 요청 kind를 launch 선택 권한으로 사용 금지 |
| ext | `BrainExt` (`brain.ts:250`), `runExtension`, `installExtension` | run은 명명된 manual job만, queued/completed/report·최대 wait 의미 유지. `extensions/run.ts:14`의 installedManifest와 install runtime는 보호된 package registry로 공급. journal·설치 잠금·version 충돌·resume는 서버 내부. AbortSignal 자체는 wire가 아니다 |
| config | `SettingsBrain`, `SettingResult` (`brain.ts:623`, `settings/index.ts:35`) | unknown key·정규화·default/db source·updatedAt·schema 오류 보존. `dispatch.ts:610`의 사용자 manifest setting 정의 대신 봉인 registry. timezone 변경의 schedule 재계산도 기존 store 동작 유지 |
| channels | `BrainChannels` (`brain.ts:261`) | list/status/resend 공개 projection과 UUID·not-found/refusal. resend가 send 결과/attempt evidence를 사용자에게 쓰게 하지 않는다 |
| doctor/lifecycle | `BrainDoctor.run(): Promise<DoctorReport>` (`brain.ts:151`), 기존 daemon/setup CommandSpec | 보호 내부 probe는 고정 결과 projection, 사용자 shim/로컬 spool/설정·transcript checks는 사용자 쪽. 검사 ID·skip/fail 의미를 보존해 합성한다. setup/update/uninstall/start/stop은 별도 고정 lifecycle port이며 DB/compose/exec proxy가 아니다 |

첫 줄의 조회만 먼저 완료해도 나머지를 제거하거나 DB fallback을 남겨 D2B 완료로 표시하지 않는다. `commands/index.ts` 실제 registry가 기준이며 ext auth·setup·daemon의 standalone 경로도 별도 점검 대상이다.

### B4. ingest·사용자 파일 취득·spool의 하나의 사슬

이 단계가 단순 Store RPC보다 큰 이유는 `IngestSessionInput`이 `{session, transcriptPath?, source?}`이고 서버가 그 경로를 직접 읽는 것이 현재 use case라는 점이다(`sessions/ingest.ts:44`, `:286`, `:301`). `brainDependencies`는 source/transcript/git/files/spool을 로컬 adapter로 묶는다(`apps/cli/src/assembly.ts:76`–`:108`). 이를 보호 principal에 그대로 옮기면 사용자 경로와 git repository가 보호 UID의 read/exec capability가 된다.

최소 분리 후보는 다음 두 가지다. 어느 쪽도 이번 조사에서 확정하지 않는다.

1. 사용자 principal 취득 agent가 transcript·attachment 원본을 열고, 인증된 같은 요청에 제한된 읽기 FD/stream을 전달한다. 보호 서비스는 봉인 parser로 파싱하고 저장·ID·owner·hash·내부 work를 결정한다. 기존 `TranscriptReader.read`, `SourceFileReader.read`, `RepositoryInspector`의 책임을 분리하되 서버가 사용자 경로를 재open하지 않는다. git 조사/scan은 사용자 principal에서 실행하고 비권위 메타로 취급한다. 부분 frame·큰 transcript와 scan 부재를 처리할 계약이 필요하다.
2. 사용자 principal에서 parser와 기존 ingest 준비 부분을 돌려 검증된 일반 데이터 batch를 전송한다. 서비스는 공개 ingest 전용 DTO를 검증하고 자연키/owner/ID/work·cursor·redaction 상태를 결정한다. 내부 `IngestBatch`를 그대로 공개하면 session/user/identityWork/file locator까지 사용자가 고르므로 불가하다. 기존 parse 결과·cursor의 신뢰 범위와 증분 재파싱/동시 업데이트 처리를 명시해야 한다.

구현상 끊을 지점은 `findSession`/cursor 읽기(295) → 사용자 취득(301) → parse(309) → 첨부 기존 위치/해시·redacted 조회(402/433) → bytes put(443 이후) → owner/ensure/ingest/history다. source fallback은 32 MiB 상한(`MAX_SOURCE_FILE_BYTES:128`)이 있으나 전체 transcript/wire 한도와 같은 값이 아니다. 일반 데이터 상한을 auth의 16 KiB frame으로 묶으면 정상 입력을 손실한다. multi-part 제한·총합 제한·backpressure는 별도 제안으로 검토해야 한다.

서버 소유 blob 저장은 bytes에서 hash와 Brain locator를 다시 계산하고, 사용자 sourceRef/path는 provenance로만 저장한다. `attachmentOverrides`는 내부 replay 편의이며 공개 API input이 아니다. redacted hash를 다시 put하지 않는 `ingest.ts:423` 방어와 attachment immutable position을 유지한다. root/brain-owned 여부만으로 사용자 spool locator를 신뢰하지 않는다.

spool은 사용자 principal에 둔다. `SpoolRecordKind` 세 종류, 64 KiB line, schema version·attempt/backoff·claim/release/complete 동작을 유지한다(`domain/spool-record.ts:31`, `:42`, `:62`, `:78`; `spool/replay.ts:140`). replay의 handler는 같은 제한 data operation을 호출하며 보호 service가 사용자의 spool 폴더를 privileged 권한으로 순회하지 않는다. `brain.ts:405`의 workItemId 버리기와 replay 중 재spool 금지를 보존한다.

중요한 새 연결점: `decodeAttachmentPayload`는 locator를 비어 있지 않은 문자열로만 검사한다(`domain/spool-record.ts:583`–`:601`). 현재 내부 `brain.ts:352`–`:359`는 이를 IngestAttachment/FileLocation으로 변환한다. 외부 서비스에서 이 변환을 그대로 쓰지 말고 bytes/서버 발급 blob 참조를 확인해야 한다. `localFileStore.pathOf`(`runtime/file-store.ts:13`)의 locator·root·symlink 검사는 사용자 데이터 저장소용이며 보호 UID에서 TOCTOU까지 안전하다는 증명이 아니다.

checkpoint는 hook payload가 경로를 생략한 수집, cursor reset/파서 버전 변경, 첨부 missing/중복/redacted, 서비스 실패의 전/중/후, 두 replay 경합을 기존 건수·warnings와 비교하는 것이다. 원본 spool 파일은 재처리 성공 확인 전 제거하지 않고 권한 거부/peer 실패를 DB 부재로 둔갑시키지 않는다.

### B5. drain·예약·취소·auth의 공통 권위 연결

`Brain.queue.drain`은 단순 claim loop가 아니다. spool replay → folder scan → identity candidates → file names → extraction enqueue → queue loop를 하나의 deadline으로 수행한다(`brain.ts:534`–`:603`). 따라서 API queue.drain을 supervisor wake 한 줄로 바꾸면 replayed/spoolFailed/enqueued/rereadMissing/reextract*/stopped 의미가 사라진다. 단일 서비스의 기존 core drain engine과 사용자 취득/비권위 replay를 연결한 실행 context를 만들고, deadline 남은 시간만 전달하며 각 단계를 현재 보고서에 합산해야 한다. 사용자 handler/callback을 wire로 받지 않는다. 일반 core maintenance를 처리한다는 이유로 Garmin 전용 두 번째 supervisor를 만들지 않는다.

`dispatch.ts:701`의 opportunistic drain은 명령 결과를 만든 뒤 수행하고 결과/exit를 바꾸지 않는다. `:781`의 별도 store를 service budget 요청으로 바꾸되 hook·실패 결과·drain:false·schema mismatch에서는 요청하지 않는 기존 조건을 유지한다. 명시 queue drain은 동기 보고, opportunistic drain은 원래 관찰을 보존하는 한 범위에서 요청/예산을 제한한다. daemon `drainOnce`(`daemon/run.ts:311`)의 schedule tick·imports/channel handoff·scan도 같은 내부 composition을 사용하게 하여 CLI/daemon의 두 규칙을 만들지 않는다.

Garmin 연결은 B3 generic ext/run/schedule의 입력 그대로를 사용해 통과시키지 않는다. `extensions/run.ts:20`은 아직 extension/default target으로 enqueue하고, `queue/schedules.ts:32`는 저장된 kind/target을 복사한다. 반면 보호 `0009 reserve_work_admission`의 collect는 account target을 기대한다. 봉인 extension adapter가 stable auth target·canonical account와 generation을 선택하고 manual·schedule·retry 모두 같은 admission 규칙을 타게 연결해야 한다. 기존 명령 이름/인자를 삭제하는 해결은 아니다. 알려지지 않은 default target의 해석과 null-key 기존 open work 처리도 명시적으로 검증한다.

queue cancel/disable/hold와 native FD 폐기를 현재 attempt의 다음 boundary에 결합한다. 일반 API가 work/attempt completion·HTTP outcome·auth evidence를 제출하지 못하게 한다. `garmin.release_block`은 registry에 있으나 sealedGarminLaunches는 auth/collect 두 종류만 만든다. 정상 release-block 실행 사슬은 아직 별도 연결이 필요하며 auth/uncertain을 지우지 않는 `0009 release_protection` 계약을 유지한다. 제출별 생체 결정은 credentials/MFA의 결정이지 모든 일반 데이터 mutation의 자동 승인 정책이라고 넓혀 읽지 않는다.

### B6. 사용자 자격 이관과 우회 제거 검증

정상 서비스 경로가 fixture에서 연결된 뒤 사용자 CLI/hook/channel·daemon fallback·setup/update 경로에서 app/admin/extension DB URL을 취득하지 않게 한다. `config/codec.ts`의 resolveStoreUrl/extensionAdminUrl·postgresSecrets, `runtime/extensions.ts` provisioning/migration, `workers/channel-send.ts`의 전체 postgresStore 생성도 남김없이 점검해야 한다. 사용자 endpoint/instance selector는 보호 backend URL이나 principal 선택 권한이 아니다.

기존 자격 파일 삭제는 유출된 옛 비밀번호의 무효화가 아니다. 실제 password rotation·관리 소켓/volume/backup 차단·기존 데이터 보존·복구는 D1/D7/16.9와 연결할 실행 준비 항목으로 남긴다. 이 조사에서는 수행하지 않는다. 권위 서비스가 없으면 일반 hook은 재취득 힌트를 spool에 보존하고, 보호 auth/HTTP·작업 정산은 닫힌다. 직접 PG·Docker·사용자 manifest launcher로 fallback하지 않는다.

## 3. 그대로 재사용할 시험과 정확한 범위

새 코드를 구현할 때 아래 소스의 assertions/fixture를 재사용한다. PG 또는 native가 필요한 묶음은 격리 환경에서 구현자가 실행해야 한다. 이번 조사에서는 어떤 시험도 실행하지 않았다. PG 직접 주입 fixture가 있다는 사실은 production 사용자 PG 경로를 남길 근거가 아니다.

| 소스 | 그대로 보존할 관찰/재사용 지점 | 보충 범위 |
|---|---|---|
| `packages/core/test/protected-api.test.ts:4` | extra/hidden fields·임의 SQL/URL/path·초과 limit에서 port 호출 0, 오류 고정값, token 제거, fallback 0 | 실제 wire parser·응답 decoder·OS peer와 전체 operation은 미검증 |
| `packages/postgres/test/garmin-quarantine.test.ts:14` | 재provision/role 재생성/default grant 뒤 보호 권한 불복원, supervisor/broker/worker 교차 거부, app core work·hold·schedule·install 변조 거부 | data service principal 최소 grant·실제 LOGIN/관리 소켓 격리·서비스 handlers의 허용 동작을 추가 |
| `packages/postgres/test/extension-permissions.test.ts`, `migrate.test.ts` | 역할 충돌/owner·DDL·migration/기존 확장 권한 회귀 | protected-migrations의 명시 적용·업그레이드 실패/복구 순서 |
| `apps/cli/test/dispatch.test.ts:423`, `:459`, `:514`, `:579`, `:923`, `:1196`, `:1391` | read는 schema를 조회하지 않음, write guard가 run을 막음, spool branch, hook exit 0, confirm/retry argv, opportunistic drain 조건·독립 budget | createStore injection 대신 service fake를 주입해 같은 assertions 유지. 전송 실패에도 postgresStore/URL resolver/로컬 supervisor 호출 0 추가 |
| `apps/cli/test/sessions-ingest.test.ts:2280`, `:2418`와 `packages/core/test/sessions-ingest.test.ts` | 경로 없음 lookup·USER_MISSING·원본 저장/출력 masking·각 store 단계 unwritable→spool·중복/동시 증분·cursor reset/파서 버전·첨부 | peer/서비스 실패 전후, FD/stream 취득, 사용자 경로 보호 principal 재open 0 |
| `packages/core/test/spool-record.test.ts`, `spool-replay.test.ts`; `apps/cli/test/spool.test.ts:180`, `:206`, `:273`, `:403`, `:528` | 부분 .open 미claim, stale 일반 spool claim 회수, 경합 하나만 claim, backoff/미지원/깨진 행/부분 결과, 실패 폴더 | 일반 spool의 10분 회수를 auth attempt/gate TTL 해제로 재사용하지 않음. 서버 ack 유실·중복 전송·첨부 위조를 추가 |
| `apps/cli/test/queue-drain.test.ts:112`, `:194`, `:237`; `packages/core/test/queue-drain.test.ts` | budget, empty/unwritable, schema failure, 보고 필드와 guide 설명 | 서비스와 사용자 취득 왕복을 포함한 단일 deadline·명시 drain 완료 보고 |
| `apps/cli/test/schedules-queue-list.test.ts:74`, `queue-cancel.test.ts:10`; core `queue-list.test.ts`, `schedule-daily.test.ts`, `schedule-tick.test.ts:20` | 상태/attempt/usage, cancel 상태 차이, overdue collapse/다음 occurrence·당일 날짜·timezone | wire Date·meta 손실, 보호 kind 허용 대상 정책, cancel 후 실제 admission 금지 |
| `apps/cli/test/recall.test.ts`, core `recall-read.test.ts`/`recall-budget.test.ts`; CLI/core envelope 시험 | 페이지·cursor·동일시각·mask/크기·다음 호출·재호출 | 응답 allowlist와 wire Date/invalid enum/oversize·비밀 canary |
| CLI/core files/messages redact 및 `packages/postgres/test/redaction.test.ts`, `import-redaction.test.ts` | confirm·공유 건수·범위/CAS·원본 provenance·해시 재반입 방어 | 사용자 입력 locator가 보호 read/delete를 유발하지 않음 |
| `apps/cli/test/ext-install-resume.test.ts:65`, `:133`, `:274` | 기존 단일 daemon auth 감독·활성 work 재사용, readiness 전 schedule 금지, 취소 후 그룹 종료 확인 | 봉인 registry/operator 승인 실제 사슬로 재실행. ready 파일 성공을 auth 성공으로 해석하지 않음 |
| `apps/cli/test/sealed-garmin.test.ts`, `sealed-launcher.test.ts`, `ordinary-worker-host.test.ts`; core supervisor 시험 | 고정 launch·env·bootstrap·비특권 host·현재 attempt·그룹 unknown 보존 | 서비스 composition에서 해당 seams가 실제 사용되는지 integration 추가 |

최종 구현 검증은 계획의 T01–T28과 `story-mfa-0-supervisor-security-review.md` 추가 반례를 그대로 유지한다. 위 회귀는 이를 대체하지 않는다. 이전 계획에 적힌 통과 수는 당시 코드의 근거이며 현 g4 연결 완료 증거로 재기재하지 않는다.

## 4. D2B에서 새로 드러나는 구체적 반례

다음은 정적 소스에서 도출한 새 시험 설계다. 기존 지도의 일반 SQL/peer/spool 위조 행렬보다 API 조립·기존 의미 보존에 초점을 둔다.

| ID | 실패 주입과 원본 근거 | 기대 관찰 |
|---|---|---|
| C01 | queue --all/--kind/limit 뒤 결과가 현 `protectedDataFromCore`의 id/kind/outcome뿐 (`protected-api.ts:49`, `commands/queue-list.ts:11`) | 모든 기존 출력 필드·count/has_more 유지, private token 0. 축약 status endpoint 성공만으로 CLI 성공 판정 금지 |
| C02 | Core queue.list가 DB_LOCKED/스키마 오류를 반환; façade가 현 코드처럼 throw (`protected-api.ts:51`) | 의미 있는 기존 오류는 보존, SQL/주소/예외는 제거. 전송 unavailable/peer denied/invalid request와 구분하고 승인 거부를 spool 재시도로 바꾸지 않음 |
| C03 | server Date가 문자열·invalid date·숫자·NaN으로 변형, queue elapsed/usage null 변형 | 엄격 response decoder가 거부하거나 정상 Date 복원; ISO renderer crash 0·원문 payload 로그 0 |
| C04 | 설정/예약/enable/resend/redact가 commit된 직후 response를 버리고 client 재전송 | mutation별 중복/불명 결과 정책 관찰. 자동 재시도로 새 schedule/work/redaction side effect를 중복 생성하지 않음. 자연키 merge와 request idempotency는 별개 |
| C05 | ext install 호출 연결만 종료하고 서버 installation은 계속; reconnect 또는 취소 요청이 새 세션의 요청을 겨냥 | 취소 요청 identity를 현재 요청/peer에 scope, 다른 요청 취소 0, journal/current attempt·실제 자식 종료 확인 유지. AbortSignal JSON 직렬화로 성공 처리 금지 |
| C06 | spool의 attachment hash는 정상, locator는 존재하는 다른 Brain blob 또는 보호 경로, ownership=brain (`spool-record.ts:595`, `brain.ts:352`) | metadata만으로 서버 read/put/delete 권한이 생기지 않음. 서버 hash·발급 blob 참조와 actual bytes 대조; 다른 파일 redaction/extract 영향 0 |
| C07 | 사용자 spool failure ID가 기존 내부 failure와 충돌, stage=file_import/session_ingest 위조 후 retry (`brain.ts:409`, `failures/retry.ts:111`) | 비권위 record가 기존 내부 사실을 덮지 않고 내부 staging/보호 work를 실행하지 않음. 일반 실패 진단과 재취득만, auth/evidence/latch 변동 0 |
| C08 | replay service commit 성공 뒤 ack 유실, spool stale claim 회수 뒤 재전송; service unavailable가 10회 반복 | idempotent 재수집/행 중복 0, 저장 못 한 데이터 보존. 기존 unwritable는 attempt 소비 0·파일 release 그대로. 불명 전송 결과를 protected admission 해제로 사용하지 않음 |
| C09 | 단일 queue drain 예산 직전 취득 왕복 지연, scan/replay만 성공, supervised work는 뒤에 남음 (`brain.ts:539`, `:590`) | 하나의 총 deadline, 실제 단계별 tally만, wake했다고 completed 증가 0. 사용자 프로세스 claim/worker spawn 0 |
| C10 | 봉인 서비스 사용 중 사용자 SECOND_BRAIN_HOME/URL/env/PATH/manifest를 변경, daemon liveness 파일 삭제 (`dispatch.ts:701`) | endpoint/instance 검증 재적용, 보호 backend 재선택 0·직접 PG/Docker fallback 0·두 번째 supervisor 0 |
| C11 | settings의 garmin.tokenstore 문자열을 다른 보호 service 설정/일반 files root로 돌리거나 schema/launcher/hash 이름을 새 키로 제출 | 등록 일반 setting만 허용, tokenstore 경로 선택 계약은 유지하되 안전한 binding 재검증, launcher/role/egress/DB 자격 변경 0. 경로 변경으로 latch 초기화 0 |
| C12 | public schedules.add의 kind=garmin.auth/release, 임의 holdGroup, 기존 general schedule를 protected kind로 수정/삭제 | 봉인 허용 조합과 서버 정책 적용, auth 승인·release 증거·예약 성공 위조 0. 기존 일반 schedules 의미를 무조건 삭제하지 않음 |
| C13 | 서비스 인증은 성공하나 hook 입력 transcript FD가 FIFO/device·매우 큰 stream·중간 교체·읽기 정지; source fallback은 별도 path | read principal·객체 type·총량/시간 검사, 보호 경로 재open/exec 0, hook 지연 한도와 spool 재취득 힌트 유지. auth 16 KiB limit를 일반 데이터에 강제해 정상 입력 버리지 않음 |
| C14 | 동일 UID 악성 JS가 승인된 Node를 실행해 봉인 helper와 접속, 일반 data request에 내부 work/role/operation 필드 혼합 | OS executable 신원과 요청 허용 범위를 분리해 검증, 추가 필드 거부, privileged/internal role 접근 0. signed interpreter만으로 스크립트를 승인하지 않음 |
| C15 | JSON에서 operation/limit 중복 키·깊은 중첩·중복 callback·응답에 unknown/internal 필드 | object descriptor 검증 이전 raw wire parser에서 중복·크기·버전 정책 적용, side effect 0. JSON.parse가 중복을 소거한 뒤 exact fields 검사만 통과하는 경우를 검출 |
| C16 | 보호 서비스가 아닌 가짜 status 서버가 available=true 반환; doctor public.json/PID만 정상 | 반환값·사용자 파일은 projection, peer/registry readiness와 bootstrap 권위를 대체하지 않음. auth prompt/secret/HTTP 0 |

## 5. command compatibility와 실패 경계의 보존 기준

- `apps/cli/src/dispatch.ts:560` 이후 standalone/preflight 분기는 로컬에서 계속 처리할 수 있다. `finish/failed`와 `apps/cli/src/envelope.ts`의 단일 envelope·warnings·retry_argv·hook exit 0을 유지한다. 서버가 새 JSON envelope를 만들고 CLI가 다시 감싸 두 겹의 형식으로 만들지 않는다.
- 현재 `SpoolCause`는 DB_UNAVAILABLE/DB_LOCKED/SCHEMA_MISMATCH뿐이다. SERVICE_UNAVAILABLE를 외부 DB_UNAVAILABLE로 매핑할지, 서비스 전용 공개 코드를 추가할지는 오류 계약 결정 대상이다. 어느 경우에도 peer 거부/정책 거부/invalid request를 “잠시 DB가 없음”으로 바꾸어 권한 요청을 spool하지 않는다.
- `protectedDataClient`의 현재 catch는 모든 transport 예외를 SERVICE_UNAVAILABLE로 만든다. 실제 transport adapter는 최소한 인증 거부와 부재를 고정 진단으로 구별해 Core/CLI의 기존 실패 모델과 합성할 필요가 있다. 비밀·SQL·URL 원문은 그대로 숨긴다.
- 조회 body masking은 기존 Core use case/output 경계에서 수행하고 최종 envelope에서도 유지한다. API에서 원문 Store row를 반환한 뒤 CLI masking만 믿지 않는다. 반대로 저장 전 일괄 masking으로 기존 원문 보존 계약을 바꾸지 않는다.
- setup의 확인·delete-volume 의미와 daemon start/stop/status를 보존하면서 보호 lifecycle이 실행하는 고정 동작으로 옮긴다. 사용자 요청 path/compose/SQL을 privileged installer로 전달하는 것은 기존 명령 의미 보존이 아니다.

## 6. 결정 공백과 명시할 대안

이 항목은 새 보안 결정을 확정한 목록이 아니다. 계획의 보호 배치/제출별 승인 결정을 그대로 적용하면서도 아래 세부 계약이 소스에 없으므로 구현 전 지휘자 판단이 필요하다는 뜻이다.

1. **일반 CLI/hook의 OS 검증 신원.** 근거: `protected-api.ts`는 transport placeholder, native code는 봉인 auth/worker 신원 중심, 일반 CLI는 사용자 수정 shim과 interpreter다. 대안 A는 봉인 전용 native data client가 제한 operation만 제공하고 승인된 일반 호출자 역할을 증명하는 방식, B는 OS가 신뢰하는 별도 acquisition host가 사용자 principal에서 고정 작업만 수행하는 방식이다. 봉인 helper가 임의 같은 UID 프로세스의 요청을 그대로 받아 보호 operation을 대리하면 confused deputy가 되므로 “helper만 서명”으로 완료하지 않는다. 일반 사용자 데이터에 허용할 caller 범위와 보호 operation의 역할 차이를 명시해야 한다.
2. **ingest 취득 경계.** 근거: `ingest.ts:295` cursor 선행 읽기·301 파일 읽기·413 source fallback·repository 검사와 `assembly.ts`의 로컬 adapter 결합. 대안은 B4의 제한 FD/stream 대 파싱 batch DTO다. 파일이 크고 경로를 생략하는 기존 hook/scan을 유지하면서 same-UID 악성 프로세스를 가르는 승인 단위·신뢰할 provenance를 정해야 한다. 사용자 경로를 보호 UID로 읽는 임시 구현은 대안이 아니다.
3. **mutation 응답 유실·재시도.** 근거: `schedules.ts:16`, `failures/retry.ts:149` 등 서버 idGen으로 새 ID 생성, 기존 transport client는 연결 예외만 잡는다. 대안 A는 peer/instance/operation/payload digest에 묶은 request ID와 durable result dedupe, B는 자동 재시도 없이 고정 unknown 결과와 명령별 재조회 복구다. 모든 mutation에 “동일 요청 재시도 안전”을 가정하지 않는다. TTL 뒤 dedupe 삭제나 request ID 재사용 정책도 승인 없이 확정하지 않는다.
4. **drain/acquisition 수명과 동시성.** 근거: `brain.ts:534` 단일 deadline·여러 단계 보고, `dispatch.ts:781` 독립 opportunistic budget. 대안 A는 동일 서비스의 scoped drain context가 user acquisition/replay와 순서대로 상호작용, B는 사용자 취득 결과 제출 후 내부 drain 요청과 보고 합성이다. 단순 비동기 wake로 명시 drain을 대체하면 현재 동기 건수 의미가 달라진다.
5. **보호 release-block와 operator 권한.** 근거: registry는 release kind를 등록하나 sealed launch factory에는 두 kind만 있고 `0009 release_protection`은 broker와 현재 attempt·명시 대상 조건을 요구한다. credentials/MFA 제출별 생체 결정이 release 일반 요청까지 자동 확장된 것은 아니다. 기존 명령 → 봉인 권한 검증 → 내부 작업/증거의 실제 사슬과 필요한 operator 승인 정책을 명시해야 한다. 일반 queue/retry/schedule가 이를 대리하게 하지 않는다.
6. **오류 wire와 공개 코드.** 근거: current protected result는 INVALID_REQUEST/SERVICE_UNAVAILABLE뿐이고 Command/Spool는 기존 코드별 종료/재시도를 사용한다. 기존 공개 코드로 안전하게 매핑할지 새 서비스 코드/guide를 추가할지 선택하되 기존 정상 결과·hook exit와 spool 세 cause를 임의로 축소하지 않는다.
7. **보호 migration과 role login의 적용 소유자.** 근거: `protected-migrations`의 별도 위치, NOLOGIN scaffold와 fixture session authorization. installer가 어떤 봉인 bundle/버전에 어느 순서로 적용하고 old credential을 언제 회전하며 rollback에서 어떤 권위를 유지할지 D1/D7 계약으로 연결해야 한다. 파일 존재·SQL fixture 성공을 실제 배치 성공으로 올리지 않는다.

D2B의 다음 concrete checkpoint로는 B1의 queue 전체 projection과 strict request/response codec, B2의 서버 composition/가짜 인증 transport, B4의 취득 경계 결정을 먼저 준비하는 것이 적합하다. 이후 정상/부재/거부 전 명령 회귀와 역할별 우회 거부를 연결한다. 실제 OS peer·보호 엔진·전체 서비스·egress·생체·취소 검증 전에는 운영 auth/HTTP를 닫고 16.2 전체 미완료를 유지한다.

## 7. 16.2 수락 항목과 D2B의 연결 책임

| 계획의 수락 항목 | D2B에서 연결·관찰할 부분 | 다른 단계에 남는 증명 |
|---|---|---|
| 403 세 번/429 이후 남은 호출·당일 재실행 0 | manual/schedule/retry와 사용자 API가 동일 보호 admission에 도달, generic kind/force 우회 0 | D5의 실제 HTTP gate·OS egress, D6의 fake HTTP 누계와 전체 T18–T21 |
| 다음 날짜 성공 후 해제·재차 차단 시 명시 release·doctor 관찰 | timezone/예약 날짜·release-block의 기존 명령·public doctor projection 연결 | broker의 실제 한 HTTP probe·성공 commit과 T23–T24, release 권한 증명 |
| auth latch·동일 client MFA 최대 3회 | ext auth를 data body와 분리, 일반 enable/run/retry로 auth latch 해제 0 | D4의 제출별 새 승인/취소/FD, D5 library client와 T01–T11 |
| 보호 commit 직후 SIGKILL/쓰기 거부 후 재시작 무호출 | 사용자 API/spool이 uncertain·pending·attempt를 정산/재생성하지 않음, 단일 supervisor 재시작 경로 | 실제 worker PID/그룹 종료·DB failpoint·T17–T21 전체 |
| 같은 계정 직렬·다른 확인 계정 병렬 | 모든 enqueue가 봉인 account resolver와 admission으로 연결, 중복 merge/null-key 실패 닫힘 | discovery/canonical gate SQL·실제 supervisor의 T12–T16·T26 |
| 비밀 비노출·pacing·first-call | API request/response/envelope/spool에 auth 비밀과 내부 token 없음, 고정 오류 경계 | 실제 native/UI/library·HTTP 측정 T07·T18·T27–T28과 OS 배포 증거 |

별도 TypeScript 객체나 pool은 OS 권한 격리 증거가 아니다. 계획에서 분리한 supervisor·broker·worker principal과 봉인 실행 경계를 실제 transport/배치에 유지해야 한다. 이 연결 책임은 D2B의 일반 데이터 API를 읽기 전용 두 operation으로 축소하는 근거가 아니며, 이번 작업만 읽기 전용 조사이고 실제 D2B 구현은 기존 일반 쓰기 명령·hook·spool 의미까지 포함한다.
