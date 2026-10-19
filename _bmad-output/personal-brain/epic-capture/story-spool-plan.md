---
title: '수집 일감: 내역 스캔, 세션 토큰 수집, 재시도, spool 재주입'
type: 'feature'
ticket: '12'
created: '2026-10-19'
status: 'built'
baseline_revision: 'db54e6809a3b04c203a896385f7266cb8fad8b1f'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md'
warnings: [multiple-goals, oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 대기열과 drain(2.11), spool(2.10)은 있지만 일감 종류가 하나도 없다. 그래서 hook이 놓친 세션이나 턴을 아무도 줍지 않고, spool에 남은 수집 표시와 실패 기록도 다시 들어가지 않는다. 실패한 수집은 볼 수도 다시 할 수도 없고, doctor는 미수집 세션을 모른다(FR-5, SM-5, AD-7·9·21).

**Approach:** `brain.queue.drain`은 세 단계를 차례로 돈다. 먼저 spool을 재주입하고(시도 횟수, 일부 줄 다시 쓰기, `spool/failed/`), 다음에 transcript 폴더를 스캔하고(`transcript_files` 내역과 비교해 새로 생기거나 커진 파일만 `session_ingest` 일감으로 넣음), 마지막으로 2.11의 청구 루프를 돈다. 수집 use case는 세 가지를 새로 받는다: 세션 토큰만으로 transcript 찾기, `ingest_source` 지정, 성공 뒤 `transcript_files` 기록. 그 밖에 `brain failures list`·`failures retry`와 doctor의 `failures`·`transcripts` 점검, spool 점검의 `failed/` 건수를 더한다. 실제 `~/.claude` 스캔은 기본으로 꺼 두고, 2.14가 켠다.

## Boundaries & Constraints

**Always:**
- **transcript 폴더(새 Core port `TranscriptFolder`).**
  - `{ harness; list(): {ok:true, files: TranscriptListing[]} | {ok:false, message} }`이다. `TranscriptListing = {harness, harnessSessionId, path, sizeBytes, modifiedAt}`이다.
  - Claude Code 구현은 `<configDir>/projects/<폴더>/<id>.jsonl`만 낸다. 각 프로젝트 폴더 바로 아래의 일반 파일만 보고, `<id>` = 파일 이름에서 `.jsonl`을 뺀 것이다. 그 아래의 `subagents/`·`tool-results/`와 더 깊은 곳은 보지 않는다. `projects/`가 없으면 빈 목록이다.
  - `configDir`은 `CLAUDE_CONFIG_DIR`(비어 있지 않으면)이고, 없으면 `~/.claude`이다.
- **수집 스위치(Decision 1).** CLI는 환경 변수 `SECOND_BRAIN_CAPTURE=1`일 때만 `transcriptFolders`에 Claude Code 폴더를 넣고, 아니면 `[]`이다. 폴더가 없으면 다음이 모두 꺼진다:
  - 스캔
  - 토큰만으로 찾기(`TRANSCRIPT_UNREADABLE`, "트랜스크립트를 찾을 수 없습니다")
  - doctor `transcripts`(`skip`, detail에 수집이 꺼져 있음)
  
  2.14가 이 스위치를 없애고 기본으로 켠다. hook 경로(`transcriptPath`가 있는 수집)는 스위치와 무관하다.
- **수집 use case.** `IngestSessionInput`에 두 칸을 더한다.
  - `transcriptPath?`: 비었거나 없으면 그 harness의 폴더 목록에서 `harnessSessionId`로 찾는다.
  - `source?: 'live' | 'import'`: 기본 `live`이고, 세션을 처음 만들 때만 쓰인다.
  
  성공하면(메시지 0건이어도, 세션 행이 없어도) `transcript_files`를 기록한다. 읽은 바이트 수, `fingerprint`(읽은 바이트 전체의 `sha256:`), 이번 커서, `scanned_at`=now를 쓴다. 이 기록이 실패해도 수집은 성공으로 답한다(다음 스캔이 다시 읽고, 다시 읽어도 멱등이다). drain 안에서 부를 때는 DB에 쓸 수 없으면 spool로 보내지 않고 그 코드를 돌려준다(옵션 하나).
- **`TranscriptReader`.** 성공 결과에 `sizeBytes`와 `fingerprint`를 더한다. 파일 adapter가 바이트로 읽어 `node:crypto`로 계산한다.
- **`transcript_files` 기록 규칙(Store).**
  - `(harness, path)` 한 행이다.
  - 크기는 줄지 않는다. 더 작은 크기는 무시한다. 단 `reset: true`(이번 parse가 `cursorReset`)이면 바꾼다.
  - 커서는 크기와 함께 바뀐다.
- **스캔(drain 2단계, Core `scanTranscripts`).** 폴더마다 목록과 `transcript_files` 행을 읽는다(잠금 없는 읽기). 바뀐 파일은 행이 없거나 `sizeBytes`가 다른 파일이다. 다음 대상은 건너뛴다:
  - 이미 열린 `session_ingest` 일감이 있는 대상
  - `stage = 'session_ingest'`인 미해결 실패가 있는 대상(그 세션은 `failures retry`로 다시 한다)
  
  나머지를 `modifiedAt` 오래된 순으로 `addWork({kind: 'session_ingest', targetKind: 'session', targetId: <token>, nextAttemptAt: now})`한다. 바뀐 것이 없으면 쓰지 않는다. 예산이 다 되면 멈춘다(남은 것은 다음 drain이 다시 찾는다). 바뀌지 않은 파일은 열지 않는다.
- **일감 종류 `session_ingest`(Core가 소유하고, `createBrain`의 `coreHandlers`에 둔다).**
  - 수집 호출: `{session: targetId, source: 'import'}`, spool로 보내지 않는 옵션으로 부른다.
  - 결과 매핑:
    - DB 코드는 그대로 돌려준다(→ 돌려주기).
    - `TRANSCRIPT_UNREADABLE`(찾지 못함·읽지 못함)과 `USER_MISSING`은 `retryable: false`다.
    - 그 밖은 코드 그대로다.
  - 성공하면 `resolveFailures({targetKind: 'session', targetId, stage: 'session_ingest', now})`를 부른다.
  - 정책은 기본값이다(표에 넣지 않음). 실패 기록의 `harness`는 토큰의 harness, `session_id`는 세션 행이 있으면 그 id다.
- **spool 재주입(drain 1단계).**
  - **줄 형식:** 줄에 선택 키 `attempts`(0 이상의 정수, 없으면 0)를 더한다. `SPOOL_RECORD_VERSION`은 1 그대로다(옛 빌드도 모르는 키를 무시하고 읽는다). 레코드의 `id`·`occurred_at`은 바꾸지 않는다.
  - **줄마다 판정:**
    - **성공:** 빠진다.
    - **DB에 쓸 수 없음:** 파일 전체를 되돌리고(`release`) 멈춘다. 시도 횟수는 그대로다.
    - **그 밖의 실패:** `attempts + 1`이다. 10이 되면 `recordFailure`로 남긴다(대상은 레코드가 가리키는 것, stage는 레코드 kind). 그 줄은 `spool/failed/`로 간다.
    - **읽을 수 없는 줄**(깨진 JSON, 모르는 버전·kind): 곧바로 `failed/`로 간다.
  - **파일 끝에서:** 남은 줄과 failed 줄이 있으면 새 Spool 동사 `rewrite(handle, {keep, failed})`가 처리한다. `keep`은 새 `.jsonl`, `failed`는 `failed/`의 새 파일로 쓰고, 다 쓴 뒤 청구 파일을 지운다. 모두 성공했으면 `complete`다.
  - **handler:**
    - `session_ingest` 표시: 수집 `{session, transcriptPath: payload 값(빈 문자열이면 토큰으로 찾음), source: 'live'}`, spool 금지 옵션. 성공하면 해결을 기록한다.
    - `failure` 레코드: payload 그대로 `recordFailure`(id는 레코드 id, `closeWork` 없음).
- **`.open` 회수.** `claim`이 할 일이다. 이름의 pid가 살아 있지 않고 mtime이 `SPOOL_CLAIM_STALE_MS`보다 오래된 `.open`은 `failed/`로 옮긴다. 쓴 쪽이 이미 실패로 답한 쓰기라서 재주입하지 않는다.
- **`Spool.stats`.** 결과에 `failed`(`failed/`의 줄 수)를 더한다. doctor `spool` 점검은 `failed > 0`이어도 `warn`이고, detail에 "실패로 옮긴 줄 N건"을 덧붙인다.
- **새 Store 메서드.** Core port, `memoryStore`, SQLite, `failedConfigStore`, 계약 사례를 모두 둔다.
  - `listTranscriptFiles({harness})`
  - `recordTranscriptFile({id, harness, path, sizeBytes, fingerprint, cursor, scannedAt, reset})`
  - `listOpenWorkTargets({kind})`(잠금 없는 읽기)
  - `listFailures({targetKind?, stage?, includeResolved?, limit?})`: `occurred_at desc, id desc`이다.
  - `resolveFailures({targetKind, targetId, stage, now})`: 미해결 행만 바꾼다.
- **`brain failures list [--target-kind <kind>] [--all] [--limit <n>]`.**
  - 메타: `risk: read`, `writes: false`, `hook: false`.
  - 기본은 미해결만이다. `--all`이면 해결된 것도 낸다. `--limit`은 1~1000이고 기본 100이다. 범위 밖이면 `USAGE`다.
  - `data.failures[]`(snake_case, 시각은 오프셋 ISO)와 `meta.count`·`has_more`를 낸다.
  - 텍스트는 한국어로, 실패마다 한 줄과 끝에 건수 줄이다.
- **`brain failures retry [--target-kind <kind>]`.**
  - 메타: `risk: write`, `writes: true`.
  - 미해결 실패의 대상마다 Core 표 `FAILURE_RETRY_KINDS = {session: 'session_ingest'}`의 일감을 `addWork`한다(due now). 대상이 같으면 한 번이다.
  - 표에 없는 대상 종류는 건너뛰고 건수로 알린다.
  - `data = {added, already_open, skipped: [{target_kind, count}]}`다.
  - 실패 행은 바꾸지 않는다. 해결은 그 일감의 성공이 한다. 끝의 기회적 drain이 곧바로 처리한다.
  - SDK는 `brain.failures.list`·`brain.failures.retry`이다.
- **doctor.** Core `runDoctor`가 `schema-version` 뒤에 두 점검을 돈다. DB 점검이 실패하면 둘 다 `skip`이다.
  - `failures`: 미해결 실패가 0건이면 `ok`, 있으면 `warn`이다. detail은 종류별 건수다.
  - `transcripts`: 폴더 목록과 내역을 스캔과 같은 함수로 비교한 미수집 건수다. 다음 중 하나라도 맞으면 `warn`이다:
    - 미수집 파일 중 `modifiedAt`이 `TRANSCRIPT_RETENTION_DAYS(30) − TRANSCRIPT_DEADLINE_WARN_DAYS(5)`일보다 오래된 것이 있다
    - 목록을 읽지 못했다
    
    그 밖은 `ok`다(detail "미수집 N건"). 폴더가 없으면 `skip`이다.
  
  새 경고 코드는 더하지 않는다(`code` 없음).
- `brain queue drain`의 `data`에 세 칸을 더한다: `replayed`, `spool_failed`, `enqueued`. 텍스트 줄에도 그 절을 더한다(절마다 `건`).
- 사람이 읽는 새 문구는 한국어다. 출력 언어 검사와 README 코드 대조가 통과해야 한다. 모든 CLI 테스트 환경은 `CLAUDE_CONFIG_DIR`을 빈 임시 폴더로 둔다. 개발자의 실제 `~/.claude`를 읽지 않게 하기 위해서다.
- Decision(2026-10-19, 무인 실행에서 에이전트가 고름):
  1. 실제 스캔은 `SECOND_BRAIN_CAPTURE=1`일 때만 켠다. 에픽 결정("실제 수집은 14에서 켠다")을 지키기 위해서다. 다른 안: 기본으로 켬(17·19·20 전에 실제 세션이 원문·옛 parser 규칙으로 저장되고, 저장된 메시지는 바뀌지 않는다).
  2. `transcript_files`는 스캔뿐 아니라 모든 성공한 수집이 기록한다(Table Contract 작성자를 넓힌다). 다른 안: 스캔만 기록. 그러면 hook이 수집한 활성 세션을 drain마다 다시 읽는다.
  3. 스캔은 일감 종류가 아니라 drain의 한 단계다. 바뀐 파일마다 `session_ingest` 일감을 하나 만든다. 다른 안: 스스로 다시 넣는 `transcript_scan` 일감.
  4. 미해결 `session_ingest` 실패가 있는 세션은 스캔이 다시 넣지 않는다. 다른 안: 매번 다시 넣음(10번 규칙을 우회하는 무한 재시도).
  5. spool `attempts`는 줄 형식 버전을 올리지 않는 선택 키다. 깨진 줄은 막지 않고 `failed/`로 옮긴다.
  6. 비정상 종료로 남은 `.open`은 재주입하지 않고 `failed/`로 옮긴다.

**Never:**
- 플러그인 hook 등록이나 SessionStart drain 연결은 하지 않는다(2.14). 마이그레이션도 더하지 않는다(`first_occurred_at`·`occurrences`는 18).
- 새 오류·경고 코드를 코드 표에 더하지 않는다. Core에서 파일 I/O를 하지 않는다(AD-1).
- 다른 대상 종류의 retry 일감(2.20 `session_identity`, 다른 에픽)과 데몬 예외(epic 9)는 하지 않는다.
- 서브에이전트 파일을 세션으로 세거나 읽지 않는다. 테스트에서 실제 `~/.claude`·`~/.second_brain`을 읽거나 바꾸지 않는다.
- 저장된 메시지·커서를 뒤로 돌리지 않는다. spool 레코드의 `id`·`occurred_at`도 바꾸지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 첫 drain | `projects/-demo-a/<A>.jsonl`, `<A>/subagents/agent-x.jsonl`, `<A>/tool-results/x.txt`, `projects/-demo-b/<B>.jsonl`, 빈 내역 | 세션 2개 `ingest_source='import'`. 서브에이전트 파일은 세지 않음. `transcript_files` 2행 | — |
| 다음 drain | A에 턴을 덧붙이고, 새 C를 더하고, B는 그대로(읽기 권한 제거) | A의 새 메시지만, C는 import, B는 열리지 않음(실패 없음, B 행의 `scanned_at` 그대로) | — |
| 바뀐 것 없음 | 내역과 같은 폴더 | `addWork`·쓰기 잠금 없음, `enqueued: 0` | — |
| 토큰만 | 이어 쓴 A, payload `{"session_id":"<A>"}`, 스위치 켬 | 새 턴만 들어감 | 스위치 끔이면 `TRANSCRIPT_UNREADABLE` |
| spool 표시 | 잠금 중 hook 수집 → 표시 1줄, 잠금 풀림 → drain | 그 세션이 `live`로 들어가고 spool이 빔 | 아직 잠김이면 파일 그대로, `stopped: 'unwritable'` |
| 일부 실패 | 표시 3줄, 가운데만 읽을 수 없는 transcript | 1·3 들어감, 새 `.jsonl`에 가운데 줄이 `attempts: 1` | 10번째에 `failures` 한 행 + `failed/` |
| 깨진 줄 | JSON이 아닌 줄 하나 | 그 줄만 `failed/`, 나머지는 들어감 | doctor `spool` warn |
| `.open` 고아 | 죽은 pid, mtime 11분 전 | `failed/`로 감, 다시 넣지 않음 | 살아 있는 pid나 10분 안이면 그대로 |
| 수집 실패 | 목록에 있지만 읽을 수 없는 A | 첫 시도에서 `failures`(session, A 토큰, `session_ingest`), 다음 스캔은 A를 넣지 않음 | — |
| 다시 하기 | 그 뒤 권한 복구, `failures retry --target-kind session` | `added: 1`, 끝의 drain이 수집, 실패 `resolved_at` 채워짐, `failures list` 빔 | 모르는 종류는 `skipped` |
| 기한 경고 | 미수집 파일 mtime 26일 전 | doctor `transcripts` warn | 20일 전이면 ok, 미수집 1건 |

</intent-contract>

## Code Map

Core(`packages/core/src`, node·fs 없음; `Failure` 이름은 루트에서 envelope 타입이 가리므로 도메인 타입은 깊은 import):
- `ports/transcript.ts` -- `ReadTranscriptResult` ok에 `sizeBytes`·`fingerprint`. 새 `TranscriptListing`·`TranscriptFolder`(+ `ports/index.ts`).
- `ports/hook.ts` -- hook 입력의 `transcriptPath`를 `string | null`로(payload에 없을 수 있음).
- `ports/store.ts` -- `TranscriptFileStore`(새 능력, `Store`에 합침, 508행), `WorkStore`(462행)에 `listOpenWorkTargets`·`listFailures`·`resolveFailures`. 결과는 값(`DB_UNAVAILABLE`; 쓰기는 `DB_LOCKED`도). 주석 문체는 기존 그대로. `domain/transcript-file.ts`의 `TranscriptFile` 재사용.
- `sessions/ingest.ts` -- 입력 `transcriptPath?`·`source?`(280행 `'live'` 하드코딩 제거), 토큰 찾기(`transcriptFolders`), 성공 뒤 `recordTranscriptFile`, 옵션 `{spoolOnUnwritable?: false}`(154행 `unwritable` 갈래). 빈 경로 `USAGE`(현재)는 토큰 찾기로 바뀐다. `spool-ingest.ts`는 그대로.
- 새 `capture/scan.ts` -- `transcriptChanges(listing, rows)`(순수, 스캔과 doctor 공용)와 `scanTranscripts(deps, {deadline})`.
- 새 `capture/session-ingest-work.ts` -- `SESSION_INGEST_KIND = 'session_ingest'`, handler 팩토리, `FAILURE_RETRY_KINDS`.
- 새 `failures/{list,retry}.ts` -- use case.
- `spool/replay.ts` -- 줄마다 판정, `rewrite`, 10번 규칙, `recordFailure`. 결과에 `replayed`·`failed`·`unwritable?`. 머리 주석의 "story 12" 문단 고침. `domain/spool-record.ts` -- `attempts`(기본 0, 0이면 쓰지 않아도 됨) 인코드·디코드.
- `ports/spool.ts` -- `rewrite`, `stats().failed`.
- `brain.ts` -- `BrainDependencies.transcriptFolders: readonly TranscriptFolder[]`. `coreHandlers`(134행)에 `session_ingest`. `queue.drain` = 재주입 → 스캔 → `drainQueue`(남은 예산). 보고에 `replayed`·`spoolFailed`·`enqueued`. `failures: {list, retry}`. doctor에 store·폴더 전달.
- `doctor/doctor.ts` -- `runDoctor` 옵션에 store(넓힌 타입)·폴더·clock. `schema-version` 뒤 `failures`·`transcripts`. 상수 `TRANSCRIPT_RETENTION_DAYS`·`TRANSCRIPT_DEADLINE_WARN_DAYS`는 `domain/transcript-file.ts`에 둔다.
- `queue/drain.ts` -- `WorkHandlerFailure`(31행)에 선택 정보 칸 `harness?`·`sessionId?`를 더하고 `record()`(363행)가 그것을 `recordFailure`에 넘긴다(없으면 null). drain 루프 규칙은 바꾸지 않는다.
- `testing/fakes/{store,spool,transcript…}.ts`, 새 `memoryTranscriptFolder`, `contracts/{work-store,spool}.ts`·새 `contracts/transcript-file-store.ts`, `contracts/index.ts`, `testing/index.ts`, `fixtures.ts`(`sampleSpoolRecord`에 `failure` kind·`attempts`) -- 가짜·계약. 본보기 `contracts/user-store.ts`, `contractCase`·`withSubject`. 음성 가짜는 `test/contracts.test.ts:340+` 방식.

어댑터:
- 새 `packages/claude-code/src/transcript-folder.ts` + `index.ts` -- `claudeCodeTranscriptFolder({configDir})`(node:fs 허용, parser도 node:crypto 씀). 테스트 `packages/claude-code/test/transcript-folder.test.ts`.
- `packages/sqlite/src/transcript-files.ts`(새, 본보기 `users.ts`), `work.ts`(+3 메서드), `store.ts:79-82` 펼치기, `index.ts`. 쓰기는 `withWrite` 안에서 `held`만 쓴다. 읽기는 `opened.connection.db`이다. 시각은 `formatInstant`·`parseInstant`. 테스트 `packages/sqlite/test/{work-store,transcript-file-store}.test.ts`(`migratedPath()`).
- `apps/cli/src/runtime/transcript.ts` -- 바이트로 읽고 크기·sha256 계산.
- `apps/cli/src/runtime/spool.ts` -- `rewrite`(keep은 `append`와 같은 `.open`→rename, failed는 `failed/`의 새 파일, 0700/0600), `failed/` 통계, `.open` 회수(stem의 pid, `isAlive`·`clock` seam), `list`가 `failed/` 폴더를 무시.
- `apps/cli/src/harnesses.ts` -- 항목에 `transcriptFolder(env)`; `dispatch.ts:544-565` 의존성에 `transcriptFolders`(스위치 `SECOND_BRAIN_CAPTURE`, `CLAUDE_CONFIG_DIR`). `install/store.ts` `doctorAt`도 같은 폴더를 넘긴다. `doctor/store.ts` `failedConfigStore` 스텁.
- `apps/cli/src/commands/{failures-list,failures-retry}.ts`(새, 본보기 `queue-drain.ts`; 옵션 검사 `/^\d+$/`), `commands/index.ts` 등록, `queue-drain.ts` 새 칸·절, `sessions-ingest.ts`의 output·examples(경로 없는 payload). `packages/claude-code/src/hook.ts` -- `transcript_path` 선택.
- `apps/cli/src/doctor/checks.ts:150-165` -- `spool` detail의 failed 건수.
- 점검 id 목록을 박은 테스트(새 id `failures`·`transcripts`는 `schema-version` 뒤): `apps/cli/test/doctor-run.test.ts:48-70`(+줄 수 219·272·283·361), `doctor-checks.test.ts:89-97`, `install-store.test.ts:25-38·360-397`, `setup.test.ts:~660`(모두 ok를 단정한다. 스위치가 없는 그 테스트에서 `transcripts`는 `skip`이므로, 그 한 id만 `skip`을 기대하게 고친다), `packages/core/test/doctor.test.ts:172·227·244`.
- CLI 테스트 환경 헬퍼(`childEnvironment` 여러 벌, `runShim`)에 빈 `CLAUDE_CONFIG_DIR`. 새 `apps/cli/test/capture-scan.test.ts`(매트릭스 CLI 행: 스위치 켜고 `queue drain`, 토큰 수집, spool 표시, 실패·retry, doctor). 잠금은 `apps/cli/test/fixtures/lock-holder.mjs`, `.open`·rewrite는 `apps/cli/test/spool.test.ts`. 세션 fixture는 `packages/claude-code/test/fixtures/{full-session,two-turns}.jsonl`을 복사하되 `sessionId`를 파일 이름에 맞춰 바꾼다(`two-turns`는 `"key": "value"` 공백 형식).
- `README.md` -- `## 하네스 세션 읽기`(239-283, 275행 문장), `## 밀린 일 처리`(284-336, 331-335행 "일감 종류가 없음"), 새 `## 실패 보기와 다시 하기`, doctor 표(675-688)·요약 예시(696). 코드 표는 그대로.
- 문서: `_bmad-output/personal-brain/deferred-work.md`(`.open` 회수·`failure` 재주입 해결, 새 항목 "2.14: `SECOND_BRAIN_CAPTURE` 스위치를 없애고 기본으로 켬"), architecture Table Contract `transcript_files` 작성자 칸에 `sessions.ingest`(Decision 2).

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/ports/{transcript,hook,spool,store}.ts`, `domain/spool-record.ts`, `domain/transcript-file.ts` -- port·타입·상수·`attempts` 코덱 -- 규칙을 Core 한 곳에.
- [x] `packages/core/src/testing/**`, `packages/core/test/{contracts,spool-record}.test.ts` -- 가짜·계약(transcript-file store 단조, failures 목록·해결, open targets, spool rewrite·failed 통계)과 음성 가짜.
- [x] `packages/core/src/sessions/ingest.ts`, `packages/core/test/sessions-ingest.test.ts` -- 토큰 찾기, source, 내역 기록, spool 금지 옵션.
- [x] `packages/core/src/{capture,failures}/**`, `spool/replay.ts`, `brain.ts`, `doctor/doctor.ts`, `index.ts`, `packages/core/test/{capture-scan,spool-replay,failures,doctor,queue-drain}.test.ts` -- 스캔·일감·재주입·failures·doctor, 매트릭스 Core 행.
- [x] `packages/claude-code/src/{transcript-folder,hook,index}.ts`, `packages/claude-code/test/{transcript-folder,hook}.test.ts` -- 폴더 adapter(subagents·tool-results·깊은 파일 무시, 없는 폴더).
- [x] `packages/sqlite/src/{transcript-files,work,store,index}.ts`, `packages/sqlite/test/{transcript-file-store,work-store}.test.ts` -- adapter, 계약.
- [x] `apps/cli/src/{runtime/transcript,runtime/spool,harnesses,dispatch,install/store,doctor/store,doctor/checks}.ts`, `apps/cli/test/{spool,dispatch,doctor-*,install-store,setup}.test.ts` -- 배선, 스위치, `.open` 회수, rewrite, 점검 목록.
- [x] `apps/cli/src/commands/{failures-list,failures-retry,queue-drain,sessions-ingest,index}.ts`, `apps/cli/test/{capture-scan,queue-drain,sessions-ingest}.test.ts`, 모든 CLI 테스트 환경 헬퍼 -- 명령, 매트릭스 CLI 행, `CLAUDE_CONFIG_DIR` 격리.
- [x] `README.md`, `deferred-work.md`, architecture Table Contract 한 칸 -- 문서.

**Acceptance Criteria:**
- Given `setup run --yes`로 만든 임시 home과 `SECOND_BRAIN_CAPTURE=1`, `CLAUDE_CONFIG_DIR`=세션 2개(서브에이전트·도구 결과 폴더 포함) fixture, when `brain queue drain --json`을 부르면, then `sessions` 행 수가 fixture의 세션 파일 수(2)와 같고 모두 `import`이며, 다시 부르면 `enqueued: 0`이고 모든 테이블 건수가 같다(SM-5).
- Given 같은 home에서 `SECOND_BRAIN_CAPTURE`가 없을 때, when `brain doctor run --json`·`brain queue drain --json`을 부르면, then 새 세션이 생기지 않고 `transcripts`는 `skip`이며 종료 코드는 0이다.
- Given `brain guide schema failures list --json`·`failures retry --json`, when 부르면, then 메타 7칸이 나오고 `--help`가 한국어다.
- Given `pnpm test`, when 실행하면, then build·typecheck·vitest가 모두 통과하고 출력 언어 검사와 README 코드 대조도 통과하며, 어떤 테스트도 실제 `~/.claude`를 읽지 않는다.

## Implementation Notes

- (후속, 2026-10-19 사용자 "둘 다 고쳐") 남은 위험 둘을 실측한 뒤 spool 쪽을 고쳤다.
  - 막힘: 다시 쓴 줄은 이제 새 이름(`<다음 시도 시각>-<pid>-<순번>-r.jsonl`)으로 기다리는 파일들 뒤에 간다. claim은 그 시각 전의 `-r` 파일을 건너뛴다. 재주입은 일부만 들어간 파일 뒤에도 멈추지 않고 다음 파일로 간다. 막힘 재현에서 정상 줄이 11번째 drain이 아니라 첫 drain에 들어갔다.
  - 재시도 간격: 줄에 선택 키 `next_attempt_at`이 생겼다(줄 형식 버전 1 그대로). 실패할 때마다 `DEFAULT_WORK_POLICY.retryDelayMs`로 정하고, 아직 때가 안 된 줄은 그대로 둔다.
  - `maxFiles`는 이제 완료한 파일이 아니라 집은 파일 수를 센다.
  - 바뀐 곳: `domain/spool-record.ts`, `ports/spool.ts`(`keepDueAt`), `spool/replay.ts`, 가짜 spool, spool 계약(같은 자리에 둔다는 사례를 "뒤로 간다"로 뒤집고 "때가 되기 전엔 안 집힌다"를 더함), `apps/cli/src/runtime/spool.ts`, 테스트, README.
  - 2초 예산은 실측 규모(세션 133개, 319MB, 최대 19.3MB)에서 문제가 없어 고치지 않았다. 설치 직후 첫 두 명령만 약 2.1초 걸리고, 그 뒤 조용한 명령은 약 0.12초로 스캔을 켜도 꺼도 같았다.

## Plan Change Log

## Review Triage Log

### 2026-10-19 — Review pass
- verdicts: 6 findings — high 0, medium 1, low 5, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` `failures list`의 텍스트 줄(`<시각> <kind> <id> <stage> <code>: …`)에 한글 없는 절(`session`)이 생겨 출력 언어 검사기에 걸린다. 유일한 텍스트 모드 테스트는 실패 0건이라 놓쳤다 — 검사기로 재현됨. 고침: 줄을 `<시각> 대상 <kind> <id>, 단계 <stage>, 코드 <code>: …`로 바꾸고, 실패 1건을 기록한 텍스트 모드 테스트에서 `assertKoreanLines`로 단정한다.
  - `[low]` `[reject]` drain이 스캔·재주입의 `stopped` 문장을 버려서, 읽을 수 없는 폴더가 있어도 `queue drain`은 `empty`로 답한다 — 사실이다. 하지만 doctor `transcripts`가 같은 경우를 `warn`으로 보이고, 고치려면 drain 보고에 새 칸(공개 표면)이 필요하다. 일상에서 만나기 어렵다.
  - `[low]` `[reject]` cursor reset 없이 크기가 줄어든 transcript는 내역이 크기를 낮추지 않아 drain마다 다시 넣힌다 — 코드로는 맞다. 하지만 Claude Code는 transcript를 덧붙이기만 한다(compact도 덧붙임, 연구 §4). 바깥에서 파일을 줄여야만 생긴다. 고치려면 단조 규칙이나 판정 규칙에 갈래를 더해야 한다.
  - `[low]` `[patch]` 가짜 spool의 `rewrite`는 남은 줄을 청구 순서의 맨 뒤 새 파일로 두고, 파일 adapter는 같은 stem으로 맨 앞에 둔다. 계약이 이를 고정하지 않는다. 고침: 가짜가 원래 자리를 지키게 하고, 두 파일로 "다시 쓴 줄이 더 새 파일보다 먼저 청구된다"는 계약 사례를 더했다(두 구현 모두 실행).
  - `[low]` `[patch]` `rewrite`가 `failed/`에 `.jsonl.open`을 쓴 뒤 rename 전에 죽으면 `countFailed`가 그 줄을 세지 않아 doctor가 0건이라 한다. 고침: `failed/` 안의 `.jsonl.open`도 센다, 테스트 추가.
  - `[low]` `[patch]` `apps/cli/src/doctor/store.ts` 머리 주석이 "`doctor run`은 그 능력을 묻지 않는다"고 말하지만 이제 `listFailures`·`listTranscriptFiles`를 묻는다. 한 줄이 너무 길기도 하다. 고침: 문장을 바로잡고 80칸으로 다시 감쌌다.

## Design Notes

drain 한 번:
```ts
const deadline = now + budgetMs;
const replay = await replaySpool({ spool, handlers: spoolHandlers, store, clock }, { deadline });
if (replay.unwritable) return { ...empty, stopped: 'unwritable', code: replay.unwritable };
const scan = await scanTranscripts({ store, folders, clock, idGen }, { deadline }); // reads first, writes only for changes
const queue = await drainQueue({ store, spool, clock, idGen }, { budgetMs: remaining(deadline), handlers });
return { ...queue, replayed: replay.replayed, spoolFailed: replay.failed, enqueued: scan.enqueued };
```

스캔이 쓰기 잠금을 아끼는 순서는 다음과 같다. 목록 → 내역 → 열린 일감 → 미해결 실패, 이 넷은 모두 잠금 없는 읽기다. 남은 것이 있을 때만 `addWork`를 부른다. 그래서 기회적 drain(AD-7)은 할 일이 없으면 잠금을 잡지 않는다.

`transcript_files`를 수집이 기록하는 이유: hook(2.14)이 매 턴 활성 세션을 넣을 때 내역도 함께 앞으로 가야, 스캔이 그 파일을 "커졌다"며 다시 읽지 않는다.

## Verification

**Commands:**
- `pnpm test` -- expected: build → typecheck → vitest 모두 통과(Postgres 프로젝트는 globalSetup이 준비)
- `pnpm typecheck` -- expected: 오류 없음

**Manual checks (if no CLI):**
- 임시 `SECOND_BRAIN_HOME`과 임시 `CLAUDE_CONFIG_DIR`(fixture 복사)에서 `SECOND_BRAIN_CAPTURE=1 node apps/cli/dist/bin.js queue drain`, `failures list`, `doctor run`의 한국어 줄을 읽는다. 실제 `~/.claude`·`~/.second_brain`은 건드리지 않는다.

## Auto Run Result

**요약:** drain이 세 단계가 되었다.
1. spool 재주입: 줄마다 판정하고, 시도 횟수를 줄에 남긴다. 일부 줄만 다시 쓰고, 10번 실패하면 `failures`에 남기고 `spool/failed/`로 옮긴다. 읽을 수 없는 줄과 버려진 `.open`도 `failed/`로 간다.
2. 폴더 스캔: `transcript_files`와 크기를 비교해, 바뀐 파일마다 `session_ingest` 일감을 넣는다.
3. 2.11의 청구 루프.

그 밖에 바뀐 것은 다음과 같다.
- 첫 일감 종류 `session_ingest`(Core 소유). 수집은 세 가지를 새로 받는다: 세션 토큰만으로 transcript 찾기, `ingest_source` 지정, 성공 뒤 `transcript_files` 기록.
- `brain failures list`·`failures retry`.
- doctor의 `failures`·`transcripts` 점검과 spool의 `failed/` 건수.
- 실제 하네스 폴더는 `SECOND_BRAIN_CAPTURE=1`일 때만 본다(2.14가 스위치를 없앤다).

**바뀐 파일:**
- `packages/core/src/ports/{transcript,hook,spool,store}.ts` — `TranscriptFolder`, 읽기 결과의 크기·해시, `rewrite`·`failed`, `TranscriptFileStore`, `listOpenWorkTargets`·`listFailures`·`resolveFailures`
- `packages/core/src/capture/{scan,session-ingest-work}.ts` — 스캔과 `session_ingest` handler, `FAILURE_RETRY_KINDS`
- `packages/core/src/failures/{list,retry}.ts` — 실패 조회와 다시 하기
- `packages/core/src/sessions/ingest.ts` — 토큰으로 찾기, `source`, 내역 기록, spool 금지 옵션
- `packages/core/src/spool/replay.ts`, `domain/spool-record.ts` — 줄마다 판정, `attempts` 키
- `packages/core/src/brain.ts`, `doctor/doctor.ts`, `queue/drain.ts`, `index.ts` — 배선, 두 점검, 실패 정보 칸
- `packages/core/src/testing/**` — 가짜·계약(transcript-file store, spool rewrite, work-store 추가 사례)
- `packages/claude-code/src/{transcript-folder,hook,index}.ts` — `projects/<폴더>/<id>.jsonl` 목록, `transcript_path` 선택
- `packages/sqlite/src/{transcript-files,work,store,index}.ts` — adapter
- `apps/cli/src/{harnesses,dispatch,install,install/store,runtime/transcript,runtime/spool,doctor/checks,doctor/store}.ts` — 스위치, 배선, `.open` 회수·rewrite·`failed/`
- `apps/cli/src/commands/{failures-list,failures-retry,queue-drain,sessions-ingest,index}.ts` — 명령
- 테스트: `packages/core/test/{capture-scan,brain-drain,failures,spool-replay,…}.test.ts`, `packages/claude-code/test/transcript-folder.test.ts`, `packages/sqlite/test/transcript-file-store.test.ts`, `apps/cli/test/{capture-scan,spool,…}.test.ts`와 공용 `apps/cli/test/environment.ts`(모든 CLI 테스트가 빈 `CLAUDE_CONFIG_DIR`, 스위치 끔)
- `README.md`, `deferred-work.md`, architecture Table Contract `transcript_files` 작성자 칸

**리뷰:** quick 1회, 6건이다.
- 패치 4건: medium 1(출력 언어), low 3(가짜 spool 순서, `failed/`의 `.open` 집계, 주석)
- 기각 2건(low): 드레인 보고가 폴더 오류 문장을 버림(doctor가 경고함), 크기가 줄어든 transcript(Claude Code는 덧붙이기만 함)
- 보류 0건

**후속 리뷰 권고: false** — 패치한 것은 medium 1건과 low 3건이고, high는 없다.

**검증:**
- `pnpm test`(build → typecheck → vitest, Postgres 포함): 패치 전 59파일 1872건, 패치 뒤 59파일 1876건 통과
- 매트릭스 11행 모두 실행된 테스트가 덮음(CLI `capture-scan`, Core `capture-scan`·`spool-replay`·`brain-drain`·`failures`, CLI `spool`)
- 구현 서브에이전트의 수동 확인: 임시 home과 임시 `CLAUDE_CONFIG_DIR`에서 `queue drain`이 세션 하나를 `import`로 넣었고, `failures list`는 0건, doctor `failures`·`transcripts`는 ok였다

**에이전트가 대신 내린 결정**(Always의 Decision 1~6, 그리고 구현 중 정한 것):
1. 실제 폴더 스캔은 환경 변수 스위치로만 켠다(에픽의 "실제 수집은 14에서").
2. `transcript_files`는 성공한 모든 수집이 기록한다(Table Contract 작성자 칸을 넓혔다).
3. 스캔은 일감 종류가 아니라 drain의 단계다.
4. 미해결 수집 실패가 있는 세션은 스캔이 다시 넣지 않고, `failures retry`를 기다린다.
5. spool `attempts`는 줄 형식 버전을 올리지 않는 선택 키다. 깨진 줄은 `failed/`로 간다.
6. 버려진 `.open`은 재주입하지 않고 `failed/`로 옮긴다.

구현 중 정한 것도 넷 있다.
- 일부 줄만 들어간 파일은 다시 쓴 뒤 그 실행을 멈춘다. 같은 실행에서 다시 집어 10번을 몇 초에 써 버리는 것을 막는다.
- handler가 없는 kind는 파일을 그대로 되돌리고 멈춘다.
- 읽을 수 없는 프로젝트 폴더가 하나라도 있으면 목록 전체가 실패한다. 조용히 빠뜨리지 않고 doctor에 보인다.
- `TRANSCRIPT_UNREADABLE`·`USER_MISSING`은 `session_ingest`에서 영구 오류다.

**남은 위험:**
- 실제 `~/.claude`로는 돌려 보지 않았다(스위치가 꺼져 있다). 합성 실측 규모에서는 기회적 drain 2초 예산이 괜찮았다(Implementation Notes 후속). 실제 세션은 새 세션마다 git 조회가 붙어 설치 직후 첫 가져오기가 조금 더 걸릴 수 있다.
- (해결됨, 후속) 계속 실패하는 spool 줄이 뒤 파일을 막던 문제와 재시도 간격이 없던 문제.
- `rewrite` 도중 죽으면 남긴 줄이 한 번 더 시도된다(레코드는 id로 멱등).
- 성공한 `session_ingest`마다 `resolveFailures` 쓰기 트랜잭션이 하나 더 든다.

**사람 확인 필요:** Decision 1(스위치)과 2(Table Contract 작성자 확대)가 맞는지 확인해야 한다. 기각한 두 건도 그대로 둘지 정해야 한다.
