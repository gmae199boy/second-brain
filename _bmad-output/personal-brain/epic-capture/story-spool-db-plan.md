---
title: 'spool: DB에 못 쓴 것의 대기열'
type: 'feature'
ticket: '10'
created: '2026-10-19'
status: 'built'
baseline_revision: 'a14eae40e2c443d38385b3ec629b6a98778aff9b'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 지금은 DB에 쓸 수 없으면(파일 열기 실패, 쓰기 잠금 3초 초과, 스키마 불일치) hook 수집이 stderr 한 줄을 남기고 끝난다. 무엇을 놓쳤는지 어디에도 남지 않고, doctor도 모른다(AD-9, NFR-2). 디스패처의 쓰기 가드는 스키마 불일치를 거부만 한다(AD-20은 spool로 보내라고 한다).

**Approach:** `<home>/spool/`에 줄 단위 레코드 파일을 쓰는 Core `Spool` port와 그 파일 adapter, claim·재주입 틀을 만든다. `sessions.ingest`는 수집 도중 DB에 쓸 수 없으면 "이 세션을 다시 수집할 것" 표시 한 줄을 spool에 쓰고 성공(`SPOOLED`)으로 답한다. 쓰기 가드가 거부할 때는 명령을 돌리지 않는다. 명령이 `spool` 갈래를 선언했으면 디스패처가 brain 없이 그 갈래만 불러 같은 표시를 쓴다. 그래서 어긋난 DB에는 어떤 쓰기도 닿지 않는다. doctor에 `spool` 점검을 더한다.

**Decision(2026-10-19, 사용자):** 스키마 불일치는 고칠 대상이고, 고치는 길은 업그레이드 경로의 마이그레이션이다. 이 스토리의 spool은 그 전까지 남는 틈을 받치는 안전망일 뿐이다. 그래서 "명령을 돌리되 거절 store를 준다"는 방식은 쓰지 않는다. "마이그레이션이 끝난 뒤에만 새 빌드로 전환, 실패하면 마이그레이션부터 다시"와 "업그레이드 때 마이그레이션 승인"은 AD-19·20을 바꾸는 일이라 deferred-work에 correct-course 입력으로 남긴다.

## Boundaries & Constraints

**Always:**
- 파일: 한 번의 `append`는 새 파일 하나다. `<stem>.jsonl.open`으로 다 쓴 뒤 `<stem>.jsonl`로 rename한다. `<stem>`은 `<처음 레코드의 occurred_at 압축형>-<pid>-<프로세스 안 순번>`이다. 이름순이 시간순이고, 두 프로세스가 같은 파일을 쓰는 일은 없다(AD-9).
- 줄은 JSON 한 개다. 키는 snake_case다: `schema_version`(spool 줄 형식의 버전, Core 상수 `SPOOL_RECORD_VERSION = 1`. DB 스키마 버전이 아니다), `id`(UUIDv7), `kind`, `occurred_at`(저장 정규형, AD-13), `payload`. UTF-8로 `\n`까지 65,536바이트를 넘는 줄은 쓰지 않고 실패로 답한다. `id`·`occurred_at`은 Core가 `idGen`·`clock`으로 정하고, adapter는 바꾸지 않는다.
- 수집 표시는 `kind: 'session_ingest'`, `payload: {session, transcript_path, cause}`다. `cause`는 `DB_UNAVAILABLE | DB_LOCKED | SCHEMA_MISMATCH`이고, transcript는 넣지 않는다(다시 읽는다, 12).
- claim은 `<stem>.jsonl`을 `<stem>.<pid>-<claim epoch ms>.claiming`으로 rename한다. rename이 ENOENT면 다른 drain이 먼저 잡은 것이다. 실패가 아니며 다음 파일로 간다. claim 전에, pid가 살아 있지 않거나(`kill(pid, 0)`이 ESRCH) 이름의 청구 시각에서 `SPOOL_CLAIM_STALE_MS = 600_000`이 지난 `.claiming`을 `<stem>.jsonl`로 되돌린다. `.open`은 절대 claim하지 않는다.
- 재주입 틀(Core `replaySpool`)은 claim한 파일의 줄을 kind별 handler에 넘긴다. 모두 성공하면 파일을 지운다. 그렇지 않으면 그 파일을 `.jsonl`로 되돌리고 그 실행을 멈춘다. 일부 줄 다시 쓰기, 시도 횟수, `spool/failed/`, `session_ingest` handler는 12가 한다.
- 표시를 쓰는 것은 Core 함수 하나 `spoolSessionIngest({spool, clock, idGen}, {session, transcriptPath}, cause)`다. store가 필요 없다. 이 함수는 `{ok: true, spooled: true, created: false, inserted: 0·0·0}`를 돌려준다. `warnings`는 `SPOOLED`이고, 원인이 경고 코드면(`DB_UNAVAILABLE`·`SCHEMA_MISMATCH`) 그 원인도 붙는다. spool 쓰기가 실패하면 원인 코드의 실패를 돌려주고, 메시지에 spool 실패를 덧붙인다.
- `sessions.ingest`: `findSession`·`readSelfUser`·`ensureSession`·`ingest` 중 하나라도 `DB_UNAVAILABLE`·`DB_LOCKED`로 답하면 곧바로 위 함수로 간다. 잠금은 처음 실패한 곳에서 끝나므로 hook은 3초 예산을 한 번만 쓴다. 그 밖의 실패(`USER_MISSING`, `TRANSCRIPT_UNREADABLE`, `USAGE`)는 spool로 보내지 않는다.
- 쓰기 가드: `writes: true`이고 `checkSchema`가 실패하면 명령의 `run`은 절대 부르지 않는다. 명령이 `spool` 갈래를 선언했으면 디스패처가 그것을 부른다. 그 갈래가 받는 것은 args·options·stdin·`cause`와 위 Core 함수뿐이고, brain도 store도 받지 않는다. 선언하지 않은 명령은 지금처럼 거부하되 종료 코드는 코드 표를 따른다(`DB_UNAVAILABLE` 2, `SCHEMA_MISMATCH` 1). deferred-work의 exit 1 vs 2 항목은 표에 맞추는 것으로 닫는다.
- doctor `spool`: `.jsonl`·`.claiming`의 레코드 수와 가장 이른 `occurred_at`이다. 0건이면 `ok`, 있으면 `warn`(`code: 'SPOOLED'`)이고 detail은 한국어로 "N건, 가장 오래된 것 <isoWithOffset>"이다. 폴더가 없으면 0건이다.
- 사람이 읽는 새 문구는 한국어다(Conventions '출력 언어'). hook 경로는 여전히 exit 0이다.

**Never:**
- 데몬의 구간 rotate, `log append`·주입 기록·첨부 레코드(그 에픽들), drain 명령과 `work_items`(11), 재주입 handler와 일부 줄 다시 쓰기(12)는 하지 않는다.
- 비정상 종료로 남은 `.open` 회수는 하지 않는다(deferred-work에 적는다).
- 거절 store나 "가드 실패에도 run을 부르는" 방식을 쓰지 않는다. runtime에서 마이그레이션하지 않는다(AD-20). `messages redact` 같은 spool 금지 쓰기에는 `spool` 갈래를 두지 않는다. spool 파일을 여럿이 함께 append하지 않는다.
- Core에서 파일 I/O를 하지 않는다(AD-1). 새 오류 코드를 코드 표에 더하지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 잠금 초과 | 다른 프로세스가 `begin immediate`로 잠금을 쥔 동안 Stop 페이로드로 `sessions ingest claude-code --json` | 약 3초 뒤 exit 0, envelope `ok`, `warnings: ['SPOOLED']`, `data.spooled: true`. spool에 `.jsonl` 하나, 그 줄의 `cause: 'DB_LOCKED'` | 잠금을 쥔 쪽이 풀기 전에 끝난다 |
| 스키마 불일치 | `schema_version`을 +1 한 DB | exit 0, `warnings`에 `SPOOLED`·`SCHEMA_MISMATCH`, 줄의 `cause: 'SCHEMA_MISMATCH'`, 모든 테이블 행 수 그대로 | `run`은 불리지 않음 |
| DB 파일 없음 | 설치 뒤 `brain.db`를 지움 | 가드가 `DB_UNAVAILABLE`로 거부하고 `spool` 갈래가 표시를 쓴다. `SPOOLED`·`DB_UNAVAILABLE`, 파일은 다시 생기지 않는다 | — |
| 이어진 잠금 | 세션 행 만들기는 됐고 메시지 넣기에서 잠금 | 기다림은 그 한 번(약 3초)뿐이고 곧바로 spool | — |
| spool 쓰기 실패 | spool 폴더 자리에 일반 파일 | 원래 실패 코드, hook은 stderr 한 줄, exit 0 | 메시지에 spool 실패 |
| 64KB 초과 | 65,536바이트를 넘는 줄 | `append`가 실패로 답하고 파일을 남기지 않는다 | — |
| `.open` | 쓰는 중인 `.jsonl.open`만 있음 | `claim`은 `null` | — |
| 죽은 청구자 | 청구한 프로세스를 SIGKILL | 다음 `claim`이 `.jsonl`로 되돌린 뒤 다시 잡는다 | 살아 있는 pid라도 10분이 지나면 같다 |
| 겹친 청구 | 두 claim이 같은 파일 | 하나만 잡고, 다른 쪽은 다음 파일이나 `null` | ENOENT는 실패가 아님 |
| guard, spool 없는 명령 | `writes: true`, `spool` 갈래 없음, DB 파일 없음 | run 없이 거부, exit 2 `DB_UNAVAILABLE` | — |

</frozen-after-approval>

## Code Map

- `packages/core/src/sessions/ingest.ts` -- `ingestSession`. store 실패는 156·160·184·256·275행에서 그대로 돌아간다. 여기를 spool 갈래로 바꾼다. `IngestSessionData`에 `spooled`를 더한다. 9의 마스킹 코드(196-224행)는 건드리지 않는다(17이 뺀다).
- 새 `packages/core/src/sessions/spool-ingest.ts`(+ `src/index.ts`) -- `spoolSessionIngest`. ingest use case와 CLI의 `spool` 갈래가 함께 쓴다.
- `packages/core/src/brain.ts` -- `BrainDependencies`에 `spool: Spool`을 더하고 ingest deps로 넘긴다. 호출처는 `apps/cli/src/dispatch.ts:459`, `packages/core/test/doctor.test.ts:353·373`이다.
- 새 `packages/core/src/ports/spool.ts` + `ports/index.ts`에서 export -- `Spool { append, claim, complete, release, stats }`. 결과는 모두 값이다.
- 새 `packages/core/src/domain/spool-record.ts`(+ `domain/index.ts`) -- 레코드 타입, 상수 셋, `encodeSpoolLine`·`decodeSpoolLine`(순수. 깨진 줄은 `{ok:false}`).
- 새 `packages/core/src/spool/replay.ts`(+ `src/index.ts`) -- `replaySpool`.
- `packages/core/src/testing/fakes/` + `contracts/` + 각 `index.ts` -- `memorySpool`과 `spoolContract`(append→claim 순서, 두 번 claim 안 됨, complete는 지움, release하면 다시 잡힘, stats). 본보기는 `contracts/session-store.ts`, `contract.ts`의 `contractCase`·`withSubject`다. 음성 사례는 `packages/core/test/contracts.test.ts`에 둔다.
- `packages/core/test/sessions-ingest.test.ts` -- 806행 사례("passes a held lock back as DB_LOCKED")를 spool 사례로 바꾼다. deps를 만드는 곳에 `memorySpool()`을 더한다.
- `apps/cli/src/config/paths.ts` -- `SPOOL_FOLDER = 'spool'`과 `spoolPath(home)`.
- 새 `apps/cli/src/runtime/spool.ts` -- `fileSpool({folder, clock, pid?, isAlive?})`. 폴더는 처음 `append`할 때 만든다. pid 생존 확인의 본보기는 `tooling/bootstrap/src/bootstrap.ts:1250-1262`다(EPERM은 살아 있음).
- `apps/cli/src/dispatch.ts` -- `DatabaseCommandSpec`(231)에 `spool?(context: SpoolCommandContext): Promise<CommandOutcome<T>>`을 더한다. context는 `CommandContextBase`에 `cause: 'SCHEMA_MISMATCH' | 'DB_UNAVAILABLE'`, `message`, `spoolIngest`(Core 함수에 deps를 묶은 것)를 더한 것이다. 쓰기 가드(478-493): `spool`이 있으면 그것의 결과를 `finish`로 넘기고, 없으면 `exit: 1`과 그 주석을 지워 코드 표의 종료 코드를 따른다. `createBrain`(459)에 `spool: fileSpool(...)`을 넣는다(설정이 없어도 home은 안다).
- `apps/cli/src/commands/sessions-ingest.ts` -- stdin 해석(56-78)을 `run`과 `spool`이 함께 쓰는 함수로 뺀다. `spool`은 해석한 `{session, transcriptPath}`를 `spoolIngest`에 넘긴다. `data.spooled`, `output` 설명, 머리 주석도 고친다.
- `apps/cli/src/doctor/checks.ts` -- `runtimeChecks`(103-125)의 `plugin` 뒤에 `{id: 'spool'}`을 더한다. 주석의 예시가 이미 있다. 점검 id 목록을 박아 둔 테스트: `apps/cli/test/doctor-checks.test.ts:92`, `doctor-run.test.ts:59-63`, `install-store.test.ts:36`.
- `apps/cli/test/dispatch.test.ts` -- 가드 사례(391-432, 488-496): `spool` 없는 fake는 그대로 거부하고, DB 파일 없음은 exit 2다. `spool`을 선언한 fake를 더해 `run`은 불리지 않고(`RAN` 없음) `spool` 갈래가 `cause`를 받아 도는지 본다.
- `apps/cli/test/sessions-ingest.test.ts` -- 헬퍼 `installedHome`·`runBrain`·`stopPayload`·`transcriptIn`·`rowCounts`를 재사용한다. 잠금은 `packages/sqlite/test/fixtures/lock-holder.mjs`처럼 다른 프로세스가 쥐어야 한다(같은 프로세스면 멈춘다). `notes` 테이블이 없으니 `begin immediate` 뒤 임시 테이블을 만드는 holder를 `apps/cli/test/fixtures/`에 둔다(`doctor-run.test.ts:341` 방식).
- `README.md` -- "하네스 세션 읽기"(239-)에 spool 문단, doctor 점검 표(606-620)에 `spool` 행.
- `_bmad-output/personal-brain/deferred-work.md` -- 45행 항목과 72행 표 행을 해결로 고친다. 두 항목을 더한다: `.open` 회수, 그리고 Intent의 Decision에 적은 업그레이드 경로 correct-course 입력(마이그레이션 완료 뒤 전환·실패 시 마이그레이션부터 재시도·마이그레이션 승인. bootstrap 2.5, shim, `setup upgrade`, AD-19·20).

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/domain/spool-record.ts`, `ports/spool.ts`, export, `packages/core/test/spool-record.test.ts` -- 타입·상수·코덱과 64KB 경계, 깨진 줄, 모르는 `schema_version` -- 줄 형식을 한 곳에.
- [x] `packages/core/src/testing/{fakes,contracts}/…spool.ts`, `packages/core/test/contracts.test.ts` -- 가짜와 계약, 음성 가짜 하나(두 번 claim되는 spool) -- 두 구현이 같은 규칙.
- [x] `packages/core/src/spool/replay.ts`, `packages/core/test/spool-replay.test.ts` -- 틀: 모두 성공이면 지움, 실패·handler 없음·깨진 줄이면 되돌리고 멈춤.
- [x] `packages/core/src/sessions/{ingest,spool-ingest}.ts`, `brain.ts`, `packages/core/test/{sessions-ingest,doctor}.test.ts` -- `spoolSessionIngest`, 수집 중 spool 갈래, `spooled`. 잠금은 첫 실패에서 끝남.
- [x] `apps/cli/src/config/paths.ts`, `apps/cli/src/runtime/spool.ts`, `apps/cli/test/spool.test.ts` -- adapter, 계약 실행, `.open`, 죽은 청구자(자식 프로세스가 claim 뒤 SIGKILL), 10분 규칙(`clock` seam), 겹친 청구.
- [x] `apps/cli/src/dispatch.ts`, `commands/sessions-ingest.ts`, `apps/cli/test/dispatch.test.ts` -- 가드 두 갈래와 종료 코드.
- [x] `apps/cli/src/doctor/checks.ts`, `apps/cli/test/{doctor-checks,doctor-run,install-store}.test.ts` -- `spool` 점검.
- [x] `apps/cli/test/sessions-ingest.test.ts`, `apps/cli/test/fixtures/` -- 매트릭스의 잠금·불일치·DB 없음·spool 쓰기 실패를 CLI 수준으로.
- [x] `README.md`, `_bmad-output/personal-brain/deferred-work.md` -- 문서와 항목.

**Acceptance Criteria:**
- Given 잠금 초과로 spool에 표시 하나가 남은 home, when `brain doctor run --json`을 부르면, then `spool` 점검이 `warn`·`SPOOLED`이고 detail에 1건과 그 표시의 시각이 있으며, exit 0이다.
- Given 빈 spool, when 설치 흐름의 마지막 doctor가 돌면, then `spool`은 `ok`이고 설치는 지금처럼 끝난다.
- Given `pnpm test`, when 실행하면, then build·typecheck·vitest가 모두 통과하고 출력 언어 검사와 README 코드 대조도 통과한다.

## Implementation Notes

구현 중 플랜이 정하지 않아 고른 것들.

- **port 모양.** `Spool { append(records), claim(), complete(handle), release(handle), stats() }`. `append`는 레코드 목록을 받는다(한 번이 파일 하나이므로 줄이 여럿일 수 있다). 한 줄이라도 64KB를 넘거나 코덱이 거부하면 **배치 전체를 거부하고 파일을 남기지 않는다** — 반쪽 배치가 든 파일은 불완전함을 알 길이 없는 파일이다. `claim`은 `{handle, lines}`를 준다: `handle`은 불투명(파일 adapter에서는 claim한 경로)이고, 줄은 **텍스트**다. 디코딩은 Core가 하므로 깨진 줄을 재주입 틀이 볼 수 있다.
- **경고 소유.** 쓰기 가드는 `spool` 갈래의 결과에 자기 코드를 더하지 않는다. `SPOOLED`와 원인 코드는 `spoolSessionIngest`가 내는 것이고, 가드가 또 더하면 `warnings`에 같은 코드가 두 번 들어가 두 문제로 읽힌다. 거부 쪽(갈래 없는 명령)은 지금처럼 자기 코드를 더한다.
- **원인 메시지.** `spoolSessionIngest`는 cause 코드만 받으므로(플랜의 signature), spool 쓰기가 실패했을 때의 메시지는 `ERROR_CODES[cause].meaning` + spool 실패 사유로 만든다.
- **파일 권한.** spool 폴더 0700, 파일 0600(AD-10의 저장소 권한과 같은 이유). 플랜이 정하지 않았다.
- **doctor seam.** `runtimeChecks`에 선택 `spool?: Spool`을 더했다. 기본값은 그 home의 `fileSpool`이고, 테스트가 가짜를 넣어 "읽을 수 없는 spool"·"읽을 수 없는 줄만 있는 spool" 같은 폴더로 만들기 어려운 답을 본다.
- **점검 수.** doctor 점검이 11개에서 12개가 되었으므로 README의 요약 예시(`통과 9` → `통과 11`)와 점검 id를 박아 둔 테스트 다섯 곳(`doctor-checks`, `doctor-run`, `install-store`, `setup`)을 함께 고쳤다.
- **CLI 잠금 테스트.** `apps/cli/test/fixtures/lock-holder.mjs`는 `begin immediate` 뒤 자기 테이블을 만들고 끝에 rollback한다(`doctor-run.test.ts` 방식). 이 스키마의 테이블은 모두 불변이라 테스트가 쓸 수 있는 테이블이 없다.
- **죽은 청구자 테스트.** `apps/cli/test/fixtures/spool-claimer.mjs`가 빌드된 `dist/runtime/spool.js`로 진짜 claim을 하고, 테스트가 SIGKILL한다. pid 생존 확인은 주입하지 않은 실제 경로를 지난다. 10분 규칙은 `clock` seam으로 본다.

## Plan Change Log

## Review Triage Log

### 2026-10-19 — Review pass (lens: quick)
- verdicts: 4 findings — high 0, medium 1, low 3, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` `apps/cli/src/runtime/spool.ts` — `serial`이 `fileSpool` 클로저마다 따로라서, 한 프로세스 안의 두 인스턴스가 같은 폴더에 같은 밀리초에 쓰면 stem이 같아진다. `rename`이 앞 파일을 조용히 덮는다 — 코드로 확인했다(디스패처의 `createBrain`용과 `runtimeChecks` 기본값, 인스턴스가 이미 둘이다. doctor 쪽은 `stats`만 불러서 지금은 잠재 상태다). 고침: serial을 모듈 범위로 옮기고, 두 인스턴스 테스트를 더한다.
  - `[low]` `[patch]` `packages/core/src/testing/fakes/spool.ts` — `memorySpool.append([])`는 성공하고 0줄 파일을 claim에 내준다. `fileSpool`은 거절한다. 계약이 이 차이를 잡지 못한다 — 확인했다. 고침: 가짜도 거절하게 하고 계약 사례를 더한다.
  - `[low]` `[reject]` `apps/cli/src/runtime/spool.ts` `complete` — `release`와 달리 handle 이름을 검사하지 않는다 — 사실이다. 하지만 호출자는 `replaySpool` 하나뿐이고, `claim`이 준 handle만 넘긴다. 고치려면 가드를 더해야 하는데, 일상에서 만날 일이 없다.
  - `[low]` `[patch]` `apps/cli/test/sessions-ingest.test.ts` — 첫 AC 테스트가 표시를 스키마 불일치로 만든다. 그래서 doctor는 exit 1이고, 테스트는 exit 코드를 단정하지 않는다 — 확인했다(1437행 주석). 고침: 잠금 holder로 표시를 만들고 `exit 0`을 단정한다.

## Design Notes

갈래를 둘로 나눈 이유: 스키마가 어긋났을 때 `run`을 부르지 않으면, 어긋난 DB에 쓰기가 닿을 길이 구조적으로 없다. `spool` 갈래는 brain을 받지 않는다. 쓰기가 DB에 닿지 않는다는 것을 타입이 지킨다. 수집 도중의 잠금 초과·파일 없음은 use case 안에서 같은 Core 함수로 간다.

```ts
// ingest, every store step
const found = await store.findSession(key);
if (!found.ok) return unwritable(found) ? spoolSessionIngest(spoolDeps, input, found.code) : found;
```

## Verification

**Commands:**
- `pnpm test` -- expected: 모두 통과(Postgres 프로젝트는 globalSetup이 테스트 DB를 준비한다)
- `pnpm typecheck` -- expected: 오류 없음

**Manual checks (if no CLI):**
- 잠금 사례 테스트의 경과 시간이 3초 이상, 잠금을 쥔 시간보다 짧다.
