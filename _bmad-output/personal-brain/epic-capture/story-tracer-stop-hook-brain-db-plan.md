---
title: 'Tracer: Stop hook 한 턴이 brain.db에 남는다'
type: 'feature'
ticket: '2'
created: '2026-10-16'
status: 'built'
baseline_revision: 'a6576865b45514e988fb41bb94b078272d63fa82'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Stop hook의 한 턴이 DB까지 가는 경로가 아직 없다. Core에는 수집 use case가 없고, Claude Code parser와 SQLite `SessionStore`, `sessions ingest` 명령도 없다.

parser 계약은 `seq`를 parser에게 맡긴다. 그래서 compact·fork로 transcript 앞부분이 바뀌면, 이미 저장된 번호가 다른 메시지에 갈 수 있다. 메모리 가짜는 seq가 같고 harness id가 다른 메시지를 조용히 버린다.

`sessions.user_id`도 문제다. 가리킬 사용자 테이블이 없고 값의 출처도 정해지지 않았다.

**Approach:**
- 계약: parser는 순서만 내고, `seq`는 Store가 삽입 트랜잭션 안에서 정한다(AD-4·8). 계약, 가짜, 계약 사례를 그에 맞게 바꾼다.
- `users`: `users` 테이블과 "나" 행을 만든다. 행은 `setup run`이 만든다.
- 그 위에 다음을 잇는다.
  - 본문만 읽는 Claude Code parser
  - Core `sessions.ingest`: Clock·IdGen·parser·transcript 읽기를 주입받는다.
  - SQLite `SessionStore`
  - `brain sessions ingest <harness>`: hook stdin을 읽는다.
- 확인: 사람이 임시 home과 개발용 Stop hook으로 실제 세션을 열어 본다.

## Boundaries & Constraints

**Always:**
- **seq 배정**
  - Store가 `withWrite` 안에서 정한다. 그 세션의 `max(seq)+1`부터 배치 순서대로 매기고, 이미 저장된 `harness_message_id`는 건너뛴다.
  - 삽입은 `on conflict (session_id, harness_message_id) do nothing`만 쓴다. 그래서 seq 충돌은 조용히 버려지지 않고 오류가 된다.
- **ID와 시각**
  - 세션·메시지·도구 메모·사용자 ID와 `ingested_at`은 Core use case나 설치기가 IdGen·Clock으로 정해서 Store에 넘긴다. Store는 ID를 만들지 않는다.
  - ID는 UUIDv7이다.
- **세션 행**
  - `sessions.ingest`만 만들고, 메시지가 하나 이상 있을 때만 만든다.
  - 값: `ingest_source='live'`, `started_at`은 첫 메시지의 발화 시각, `user_id`는 "나" 행의 id. 꼬리표와 `start_source`는 null이다.
- **읽기 위치**
  - transcript 읽기와 parse는 쓰기 트랜잭션 밖에서 한다(AD-7).
  - Core는 파일을 직접 읽지 않고 `TranscriptReader` port를 거친다.
- **hook 경로**
  - hook stdin 해석은 claude-code adapter가 맡는다(AD-4).
  - hook 경로는 무엇이 나도 exit 0이다. 성공하면 텍스트 모드 stdout은 비어 있다.
- **fixture**
  - 실제 transcript 구조에 중립 문장을 넣어 만든다(공개 저장소).
- Decision(2026-10-16): 플랜 크기(약 5,000토큰)가 권장을 넘지만 나누지 않는다. tracer의 목적은 hook→parser→Core→SQLite→CLI를 한 번에 잇는 것이고, verify가 그 전부를 요구한다(사용자).
- Decision(2026-10-16): 사용자 정체성은 `users` 테이블에 둔다(사용자).
  - 마이그레이션 0003이 `users`를 만든다. 칸은 `id` UUIDv7 PK, `name`(OS 사용자 이름), `is_self`(1인 행은 하나뿐), `created_at`이다.
  - `sessions.user_id`가 FK로 `users.id`를 가리킨다.
  - "나" 행은 `setup run`이 마이그레이션 직후 찾거나 만든다. 수집은 그 id를 쓴다.
  - ID는 UUIDv7을 유지한다(ULID로 바꾸지 않음).
  - 정체성은 DB와 함께 옮겨진다. 두 DB 합치기는 epic 5 가져오기 몫이다. 이때 들어오는 "나"를 받는 쪽 "나"로 바꾼다.

**Never:**
- 다음 스토리 몫:
  - 2.7: 커서와 증분 읽기, `CURSOR_RESET`, 도구 메모, 서브에이전트, 추적 정보(브랜치·cwd·`start_source`), 커서가 뒤로 가지 않게 하는 보장
  - 2.8: 프로젝트·워크트리 꼬리표
  - 2.9: 마스킹
  - 2.10: spool. `DB_LOCKED`는 지금은 실패 값으로 둔다.
  - 2.11·2.12: drain과 폴더 스캔
  - 2.14: 플러그인 hook, `connectors` 등록, `setup connect claude-code`
  - 2.3: 명령 메타 7칸
- `users.name`의 갱신 정책과 DB 합치기(epic 5).
- 실제 `~/.claude/settings.json`과 실제 `~/.second_brain`은 건드리지 않는다.
- Postgres의 `SessionStore`와 `users`(epic 7).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 첫 수집 | Stop stdin `{session_id, transcript_path, …}`, fixture(두 턴 + 도구·thinking·메타·사이드체인·attachment 항목) | 세션 행 1개(`live`, `user_id`=나). 사용자·에이전트 본문만 seq 0부터 파일 순서로 들어간다 | exit 0, stdout 비어 있음 |
| 다시 수집 | 같은 stdin을 다시 넣음 | 모든 테이블의 건수가 같다. `inserted.messages = 0` | — |
| 겹친 수집 | 같은 stdin으로 두 프로세스를 동시에 | 한 번 넣은 만큼만 들어가고 seq는 0..n-1로 겹치지 않는다 | 늦은 쪽은 잠금을 기다린다(turn 3초) |
| 이어 쓴 transcript | 턴 하나가 더 붙음 | 새 메시지만 이어지는 seq로 들어간다. 기존 메시지의 seq·본문·ID는 그대로다 | — |
| 앞부분이 바뀐 transcript | 기존 메시지 앞에 새 메시지가 끼어 있음 | 기존 seq는 그대로이고, 새 메시지는 맨 뒤 번호를 받는다 | — |
| 대화 없는 transcript | user·assistant 본문이 하나도 없음 | 세션 행을 만들지 않는다. inserted 0 | exit 0 |
| 잘린 마지막 줄 | 마지막 줄이 `\n` 없이 반만 쓰임 | 그 줄만 건너뛴다 | — |
| 깨진 중간 줄 | 중간 줄이 JSON이 아님 | 아무것도 쓰지 않는다 | `TRANSCRIPT_UNREADABLE`. hook 경로라 stderr 한 줄, exit 0 |
| transcript 없음 | 경로에 파일이 없음 | 아무것도 쓰지 않는다 | `TRANSCRIPT_UNREADABLE`, exit 0 |
| stdin 잘못됨 | 비어 있음, JSON이 아님, `session_id`·`transcript_path` 없음 | 아무것도 쓰지 않는다 | `USAGE`, exit 0 |
| 모르는 harness | `sessions ingest other` | — | `USAGE`, exit 0 |
| "나" 행 없음 | 버전 3 DB인데 `users`에 `is_self=1` 행이 없음 | 아무것도 쓰지 않는다 | `USER_MISSING`(hint `brain setup run`), exit 0 |
| setup 첫 실행 | 새 DB | `users`에 "나" 1행이 생긴다(`name`=OS 사용자 이름). 안내 줄이 나온다 | — |
| setup 재실행·옮겨 온 DB | "나" 행이 이미 있음 | 같은 id 그대로이고 행 수도 그대로다 | — |
| 버전 2 DB 마이그레이션 | 0002까지 적용된 DB(세션 없음) | 데이터를 보존한 채 3이 된다. `sessions.user_id` FK가 생긴다 | — |
| `--json` | 성공 | 엔벨로프 `data{session, created, inserted{messages, toolNotes}}` | — |

</frozen-after-approval>

## Code Map

- `packages/core/src/domain/ingest-batch.ts` -- `ParsedMessage.seq`("parser's"), `IngestTracking`, `IngestBatch`. `domain/message.ts:11-15`의 seq 주석("chosen by the parser")도 고친다.
- `packages/core/src/ports/parser.ts:26-27` -- "it alone decides `seq`" 문구. `ParseResult`의 실패 코드는 `TRANSCRIPT_UNREADABLE`이다.
- `packages/core/src/ports/store.ts`:
  - 타입: `EnsureSessionInput`(호출자가 `id`를 정함), `EnsureSessionResult`, `IngestResult`, `ReadSessionResult`, `SessionStore`(141-148), `Store`(155), `SchemaStore`(174)
  - 실패 union에 `DB_LOCKED`가 없다. `withWrite`는 `packages/sqlite/src/write.ts:16-18`에서 그것을 돌려준다.
- `packages/core/src/codes.ts` -- `ERROR_CODES`. 각 항목에 `exit`, `retryable`, `hint`가 있다. 2.1에서 hint 문체를 테스트로 검사하게 했다. `USER_MISSING`(exit 2)의 출처는 spine Conventions의 CLI `--json` 응답 행과 AD-12다.
- 문서는 이미 맞춰져 있다(`change-users-and-review-gaps`): spine AD-12·Table Contract `users` 행, epic 5 Notes(가져오기 합치기·`users.name`), epic 7 첫 대상(`users`·FK). 그래서 이 스토리는 deferred-work에 문서·epic 5·7 항목을 적지 않는다.
- `packages/core/src/brain.ts`:
  - 지금 모양: `BrainDependencies{store: HealthStore & SchemaStore, schemaVersion, checks?}`, `Brain{admin, close}`
  - 호출처는 두 곳뿐이다: `apps/cli/src/dispatch.ts:376`, `packages/core/test/doctor.test.ts:321·340`
- `packages/core/src/testing/fakes/store.ts:110-175` -- `memoryStore.ingest`:
  - 127-131행이 같은 seq를 조용히 버린다. 136행은 `seq: parsed.seq`, 164행은 seq로 정렬한다.
  - ID는 `idGen`으로, `ingestedAt`은 `clock`으로 만든다.
- `packages/core/src/testing/fakes/parser.ts:82` -- `seq: index`. `memoryTranscript`는 메시지 3개와 msg-2의 도구 2개로 이루어진다.
- `packages/core/src/testing/fixtures.ts` -- `sampleEnsureSessionInput`(`userId: 'owner'`), `sampleIngestBatch`(memoryParser 출력에서 만듦).
- `packages/core/src/testing/contracts/session-store.ts` -- 사례 8개:
  - 사례 4(190-194행)는 읽은 seq가 배치의 seq와 같다고 단정한다.
  - 동시성, 이어 넣기, 앞부분 변경 사례는 없다.
- `packages/core/src/testing/contracts/parser.ts:52-64·87` -- "seq starts at 0 and grows by one"과 `assertInteger(seq)`.
- `packages/core/test/contracts.test.ts` -- 음성 사례:
  - 405-432행: "catches a parser whose seq does not start at 0"
  - 276-360행: wrong-store 음성 사례
- `packages/sqlite/src/store.ts:52` -- `sqliteStore({path, busyTimeoutMs?})`:
  - 지금은 `HealthStore & SchemaStore`만 낸다.
  - 연결은 처음 쓸 때 열고(`connect()` 61행), 실패하면 `DB_UNAVAILABLE`이다.
  - SQL은 모두 `` sql`…`.execute(held) ``로 쓴다(스키마 타입 없음).
  - 시각은 `formatInstant`/`parseInstant`로 바꾼다. `Date`를 바인딩하면 드라이버가 거부한다.
- `packages/sqlite/src/write.ts` -- `withWrite(connection, work, options)`. `work` 안에서는 `held`만 써야 한다(`connection.db`를 쓰면 영원히 멈춤). BUSY는 `DB_LOCKED`로 돌아온다.
- `packages/sqlite/src/migrate.ts:19` -- `SQLITE_SCHEMA_VERSION = 2`. 마이그레이션 파일은 `packages/sqlite/migrations/`에 있다.
- `packages/sqlite/migrations/0001_initial.sql`:
  - `sessions`(69-105행): `user_id text not null`, FK 없음, 인덱스·trigger 없음.
  - 다른 테이블들이 `sessions(id)`를 FK로 가리킨다: messages, tool_notes, log_entries, chunks, context_injections, failures, sessions 자기 자신.
  - `messages`(107행)에는 UNIQUE 두 개와 불변 trigger(331-371행)가 있다.
- `packages/sqlite/migrations/0002_files_and_work.sql:490-552` -- `index_configs` 재생성의 본보기다. `pragma defer_foreign_keys = ON` → temp stash → drop → 재생성 → 복원 순서로 하고, 주석이 이유를 설명한다. 0003의 `sessions` 재생성이 이 방식을 따른다.
- 버전 2를 박아 둔 테스트:
  - `packages/sqlite/test/migrate.test.ts:52·77·91`
  - `store.test.ts:319`
  - `schema-files.test.ts:90·327`
  - `schema.test.ts:115·375`
- `apps/cli/src/install/store.ts` -- `prepareStore(path)`(파일 0600 → `runSqliteMigrations`)와 `doctorAt`.
- `apps/cli/src/install/flow.ts:84-97·227-241` -- `deps.store.prepare`와 그 안내 줄. 흐름 테스트 `install-flow.test.ts`는 가짜 deps를 쓴다.
- `apps/cli/src/dispatch.ts`:
  - `DispatchRuntime`(210-217)에는 stdin·idGen이 없다.
  - `CreateStore`(208)와 `failedConfigStore`도 고친다.
  - `CommandContext`(69-81)
  - hook 출력(285-311): 실패는 stderr 한 줄을 내고 0으로 끝난다. 성공은 `outcome.text`를 stdout에 낸다.
  - 쓰기 가드(383-397)
- `apps/cli/src/commands/index.ts:16-20` -- 등록부. 비슷한 예로 `setupConnectCommand(connectors)`가 있다.
- `apps/cli/src/runtime/{clock,id-gen}.ts` -- `systemClock`, `uuidV7IdGen()`. `uuidV7IdGen()`은 아직 src 어디에도 연결되지 않았다.
- `apps/cli/src/connectors/index.ts` -- 비워 둔다. 채우면 `setup.test.ts:338-348`이 깨진다.
- `apps/cli/test/dispatch.test.ts` -- `homeFor`, `migratedDatabase`, hook 단정(418-494)이 있다. 지금은 stdin을 `ignore`로 둔다.
- `packages/second_brain/test/import-side-effects.test.ts` -- 지금은 Postgres TCP 연결이 0인지만 본다.
- README 73-81·113-125·146-149·172 -- 명령 개요, connect 문단, shim 절, Layout의 `claude-code (placeholder)`.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/domain/{ingest-batch,message,user}.ts`, `ports/parser.ts` -- 도메인 타입을 바꾼다:
  - `ParsedMessage`에서 `seq`를 뺀다.
  - `IngestMessage`·`IngestToolNote`(Parsed* + `id`)와 `IngestTracking.ingestedAt`을 더한다.
  - `User{id, name, isSelf, createdAt}`를 더한다.
  - 주석은 "순서는 배열 순서, seq는 Store"로 고친다.
- [x] `packages/core/src/ports/store.ts` -- port를 바꾼다:
  - `UserStore`를 더한다.
    - `ensureSelfUser({id, name, createdAt})`: 찾거나 만들고 `created`를 돌려준다.
    - `readSelfUser()`: 없으면 `user: null`
  - `Store`에 `UserStore`를 합친다.
  - ensure·ingest 실패 코드에 `DB_LOCKED`를 더한다.
- [x] `packages/core/src/codes.ts` -- `USER_MISSING`(exit 2, hint ``run `brain setup run` ``)을 더한다.
- [x] `packages/core/src/ports/{transcript,hook}.ts`(신규) -- 두 port를 만든다:
  - `TranscriptReader.read(path)`: `{ok, content}` 또는 `TRANSCRIPT_UNREADABLE`
  - `HookInput{harnessSessionId, transcriptPath}`와 `HookInputReader(stdin)`: 실패는 `USAGE`
- [x] `packages/core/src/sessions/ingest.ts`(신규), `brain.ts` -- Core 수집 use case:
  - `BrainDependencies`에 `clock`, `idGen`, `parsers`, `transcripts`, `machine`을 더하고, `store`를 `Store & SchemaStore`로 넓힌다.
  - `Brain.sessions.ingest({session, transcriptPath})`의 순서: 토큰 → parser → 읽기 → parse → (메시지가 있으면) "나" 읽기 → ensure → ingest
  - 토큰이나 harness가 맞지 않으면 `USAGE`, "나"가 없으면 `USER_MISSING`
  - 결과는 `{session, created, inserted, warnings}`
- [x] `packages/core/src/testing/fakes/{store,parser}.ts`, `fixtures.ts`, `index.ts` -- 가짜를 새 계약에 맞춘다:
  - 메모리 store는 seq를 정하고, 배치의 ID와 `ingestedAt`을 쓰고, `UserStore`를 구현한다. `idGen`·`clock` 옵션은 뺀다.
  - `memoryParser`는 seq를 내지 않는다.
  - `sampleIngestBatch`가 ID를 붙인다.
  - `memoryTranscriptReader` 가짜를 더한다.
- [x] `packages/core/src/testing/contracts/{session-store,user-store,parser}.ts` -- 계약 사례:
  - session-store 사례 4: seq가 배치 순서대로 0..n-1이고, 저장된 ID가 배치의 ID와 같다.
  - session-store 새 사례: 이어 넣은 배치는 저장된 메시지 뒤 번호를 받는다.
  - session-store 새 사례: 앞부분이 바뀐 배치를 넣어도 기존 seq·본문·ID가 그대로다.
  - user-store: 두 번째 `ensureSelfUser`는 다른 id·이름을 줘도 첫 행을 돌려준다(`created:false`). 만들기 전 `readSelfUser`는 null이다.
  - parser: seq 사례를 "한 번의 parse 안에서 `harnessMessageId`가 겹치지 않는다"로 바꾼다.
- [x] `packages/core/test/{contracts,doctor,sessions-ingest,codes}.test.ts` -- 테스트:
  - 음성 사례: 배치 순번을 그대로 seq로 쓰는 store, harness id가 겹치는 parser, "나"를 둘 만드는 store가 잡히는지
  - `createBrain` 호출 갱신
  - use case 테스트(메모리 store·parser·reader): 매트릭스의 Core 행
- [x] `packages/sqlite/migrations/0003_users.sql`(신규), `src/migrate.ts` -- 마이그레이션:
  - `users` STRICT 테이블. `is_self`는 0/1 CHECK와 `where is_self = 1` 부분 UNIQUE, `created_at`은 GLOB CHECK
  - `sessions`를 0002의 `index_configs` 방식으로 재생성해 `user_id references users (id)`를 더한다. 나머지 칸·제약은 그대로 둔다.
  - `SQLITE_SCHEMA_VERSION = 3`
- [x] `packages/sqlite/src/{sessions,users}.ts`(신규), `store.ts`, `index.ts` -- `sqliteStore`가 `SessionStore`·`UserStore`도 구현한다:
  - 공개 이름에 `sqlite` 접두사를 붙인다.
  - `ensureSelfUser`·`ensureSession`: insert `on conflict do nothing` 뒤 다시 읽는다.
  - `ingest`: 한 `withWrite` 안에서 차례로 한다:
    1. 세션 조회
    2. `max(seq)`
    3. 행 삽입(삽입 여부는 `returning`이나 변경 건수로 판정)
    4. 도구 메모
    5. 세션 추적 칸 갱신
  - `readSession`: 메시지는 seq 순서, 도구 메모는 메시지 seq와 ordinal 순서로 읽는다.
- [x] `packages/sqlite/test/{session-store,users}.test.ts`(신규), 기존 버전 2 단정 -- SQLite 테스트:
  - 계약: `sessionStoreContract`·`userStoreContract` 통과
  - 일부러 만든 seq 충돌은 조용히 버려지지 않고 오류가 난다.
  - "나" 행 두 개는 DB가 거부한다.
  - 버전 2 DB가 데이터를 보존한 채 3이 된다.
  - 없는 user를 가리키는 세션은 FK가 거부한다.
- [x] `apps/cli/src/install/{store,flow}.ts`, `install.ts` -- 설치기:
  - 마이그레이션 직후 `deps.store.self(path)`를 부른다. 이 단계는 `ensureSelfUser`(UUIDv7, `os.userInfo().username`)를 하고, 실패하면 exit 1과 안내 줄을 낸다.
  - 안내 줄 "the brain belongs to <name>" 또는 "already belongs to <name>"
- [x] `apps/cli/test/{install-flow,install-store,setup}.test.ts` -- 설치기 테스트:
  - 흐름 가짜 deps에 `self`를 더한다.
  - 첫 실행·재실행 행 수
  - 버전 3을 단정하도록 고친다.
- [x] `packages/claude-code/src/{parser,hook,index}.ts` -- Claude Code adapter:
  - `claudeCodeParser()`: harness `claude-code`, version `1`
    - 줄은 `\n`으로만 나눈다. 끝의 미완성 줄은 건너뛰고, 중간의 깨진 줄은 `TRANSCRIPT_UNREADABLE`이다.
    - 들어가는 항목: `type`이 user·assistant이고 `isSidechain`·`isMeta`·`isCompactSummary`가 아닌 것. 본문은 문자열이거나 `text` 블록을 이은 것이고, 빈 본문은 넣지 않는다.
    - 칸: `harnessMessageId`=`uuid`, `occurredAt`=`timestamp`. `model`은 assistant의 `message.model`이다.
    - 같은 uuid는 처음 것만 넣는다.
    - 커서: 마지막 메시지의 uuid와, 그 줄까지 내용의 sha256
  - `readClaudeCodeHookInput(stdin)`
- [x] `packages/claude-code/test/{parser,hook}.test.ts`, `test/fixtures/two-turns.jsonl` -- `parserContract`, 매트릭스의 parser 행, hook 입력 오류를 시험한다.
- [x] `apps/cli/src/runtime/{transcript,stdin}.ts`, `harnesses.ts`, `commands/{sessions-ingest,index}.ts`, `dispatch.ts`, `bin.ts` -- CLI 연결:
  - `runtime/transcript.ts`: fs 읽기로 `TranscriptReader`를 구현한다.
  - `runtime/stdin.ts`: TTY면 곧바로 `''`를 돌려준다.
  - `harnesses.ts`: `[{parser, readHookInput}]`
  - `commands/sessions-ingest.ts`: `sessionsIngestCommand(harnesses)`(`hook`, `writes`, `arguments:['<harness>']`, 성공 시 `text: []`)
  - `dispatch.ts`:
    - `DispatchRuntime`에 `stdin?`·`idGen?`을 더한다(기본값 `uuidV7IdGen`).
    - `CommandContext.stdin`을 둔다.
    - `createBrain`에 새 의존성을 넘긴다. `machine`=`os.hostname()`
- [x] `apps/cli/test/sessions-ingest.test.ts`(신규) -- 매트릭스의 CLI 행을 시험한다. `dist/bin.js`를 stdin pipe로 띄우고, 겹친 수집은 두 프로세스를 동시에 돌린다.
- [x] `packages/second_brain/test/import-side-effects.test.ts` -- import만으로 DB가 열리지 않는지 본다:
  - 마이그레이션한 DB를 가리키는 home에서 `second_brain`을 import한 자식 프로세스를 `lsof -p`로 본다. DB 경로가 열려 있지 않아야 한다.
  - 대조군: `sqliteStore(…).checkHealth()` 뒤에는 그 경로가 보여야 한다.
- [x] `tooling/dev/tracer-session.sh`(신규), `README.md` -- 스크립트와 README:
  - 스크립트: 임시 home에서 `setup run --yes --json`을 돌리고, 개발용 Stop hook settings 파일을 만든 뒤 `claude --settings <file>` 명령을 알려 준다.
  - README: `sessions ingest` 문단, setup의 "나" 단계, Layout

**Acceptance Criteria:**
- Given 마이그레이션한 SQLite DB, when `sessionStoreContract()`와 `userStoreContract()`를 돌리면, then 모든 사례가 통과하고 메모리 가짜도 같은 사례를 통과한다.
- Given 두 턴 fixture, when `sessions ingest claude-code`를 한 번, 다시 한 번, 그리고 두 프로세스로 동시에 돌리면, then `messages` 건수는 첫 수집 때와 같고 seq는 0부터 구멍 없이 한 번씩만 나온다.
- Given `second_brain`을 import한 프로세스, when 열린 파일을 보면, then 설정의 DB 경로가 없다.

## Design Notes

- **명령 모양**
  - `brain sessions ingest <harness>`이고, stdin은 그 harness의 hook payload다.
  - Claude Code hook stdin에는 harness가 적혀 있지 않다. 그래서 어느 adapter가 stdin을 해석할지를 위치 인자로 받는다.
  - SDK 입력은 표면 중립인 `{session, transcriptPath}`다(AD-28: 쓰기 verb에는 `session`이 필요하다).
- **등록부**
  - `harnesses.ts`는 수집용 등록부이고 `connectors`와 따로 둔다.
  - connector 등록은 2.14 몫이고, 채우면 설치 흐름이 바뀐다. 2.14가 connector에 `readHookInput`을 붙일 때 둘을 합친다.
- **"나" 행**
  - 마이그레이션 SQL은 OS 사용자 이름을 읽거나 UUIDv7을 만들 수 없다. 그래서 "나" 행은 설치 흐름이 만든다.
  - 이미 있으면 그대로 둔다. 이름은 갱신하지 않는다.
  - `sessions` 재생성은 세션이 없는 DB에서 안전하다. SessionStore는 이번에 처음 생기므로 기존 DB에는 세션이 없다.
- **도구 메모 ordinal**
  - `ordinal`은 메시지 하나 안의 번호다. 메시지 내용은 바뀌지 않으므로 이 번호도 안정적이고, 그래서 parser가 계속 정한다.
  - AD-8의 "tool_notes 순번"은 세션 단위 seq를 두지 않는다는 뜻으로 읽는다.
- **마지막 답과 순서**
  - Stop hook이 돌 때 이번 턴의 마지막 답이 아직 파일에 없을 수 있다(research §1). 그 답은 다음 수집이 줍는다.
  - 순서는 파일 안의 위치로 정하고, 시각으로 정렬하지 않는다(research §4).

## Verification

**Commands:**
- `pnpm test` -- expected: build·typecheck·vitest가 모두 통과한다.

**Manual checks (if no CLI):**
- `sh tooling/dev/tracer-session.sh`가 알려 준 `claude --settings …`로 두 턴 대화한다.
- 세션을 끝낸 뒤 같은 stdin으로 한 번, 두 프로세스로 동시에 한 번 더 수집한다.
- 그다음 `sqlite3 <home>/brain.db 'select seq, role, substr(body,1,40) from messages order by seq'`와 `select id, name, is_self from users`를 실행한다.
- 기대 결과: 발화가 seq 0부터 대화 순서대로 있고, 건수가 바뀌지 않는다. `users`에는 "나" 한 행이 있다.

## Implementation Notes

Built as planned. Four things are worth reading before the diff.

**`sessions` rebuild back-fills `users`.** Migration 0003 stashes `sessions`,
drops it and rebuilds it with `user_id text not null references users (id)`,
following 0002's `index_configs` recipe. The plan called that safe because no
build before this story could write a session -- true, and the rebuild still
needs one more step: a stashed session names a `user_id`, and the new foreign
key refuses it unless something points it at a row. So 0003 inserts a
non-owner row (`is_self = 0`, name = the id, `created_at` = the epoch) for
every user id the stash names and `users` does not hold. It fires on no
database any released build wrote; it is there because a migration that would
strand the row it is meant to preserve is one nobody can run on the database
that turns out to have one. `schema-files.test.ts`'s 0001-to-0002 upgrade test
is the case: it seeds a session at version 1, so it walks through 0003 too and
now asserts the session survived and its user got a row.

**`sessionStoreContract` takes `SessionStore & UserStore`.** It had to: the
fixture session points at a user, and with the foreign key in place a case
cannot create one without making the owner first. Each case starts with
`ensureSelfUser(sampleSelfUserInput())`. `sampleEnsureSessionInput().userId` is
no longer the string `owner` but `sampleUserId`, a UUIDv7.

**`ensureSelfUser` and `ensureSession` read `created` off `returning`.**
`insert ... on conflict do nothing returning id` inside the one `withWrite`,
then a read of the row by its natural key. Comparing the read row's id against
the proposed one would also work and would be wrong for the one case where a
caller proposes an id that is already there.

**`seq` never leaves a gap.** `ingest` reads the session's stored
`harness_message_id`s and `max(seq)` before any insert, in the same
transaction, and numbers from there in batch order, skipping what it already
holds. The inserts conflict on `(session_id, harness_message_id)` alone, so a
`seq` collision -- which would mean this code numbered two messages the same --
raises instead of being swallowed. `session-store.test.ts` holds a deliberate
collision against the unique index.

Smaller decisions:

- The Claude Code cursor fingerprints the content **up to the end of the line
  the cursor names, that line's newline excluded**. Not the whole file, because
  a transcript grows by appending and a whole-file fingerprint would change
  every turn and never match; and not the newline either, because a Stop hook
  can read the file with the cursor's own line written and the newline after it
  not yet, which would give one message two fingerprints. Nothing reads the
  cursor yet (2.7), but it is stored, so it had to be a value 2.7 can use.
- `bin.ts` is unchanged. `DispatchRuntime.stdin` and `.idGen` default to
  `readStdin` and `uuidV7IdGen()` inside `dispatch`, so the entry point stays
  the one line it was.
- `CommandContextBase.stdin` is a function, not a string. A command that does
  not want a hook payload must not wait on a pipe nobody is writing to, and a
  TTY answers with `''` at once rather than waiting for a Ctrl-D nobody
  mentioned.
- `USER_MISSING`'s hint reads "record who this **database** belongs to": the
  hint-style test refuses the word `brain` outside backticks.
- The parser contract's "every message is well formed" case lost its
  `assertInteger(seq)` and its id-uniqueness check; uniqueness is now the one
  case the negative test in `contracts.test.ts` aims at.

## Plan Change Log

- 2026-10-16 -- Migration 0003 back-fills a `users` row for every `user_id` a
  stashed session names. Without it the new foreign key refuses data the
  migration is meant to preserve, and `schema-files.test.ts`'s existing
  0001-to-0002 upgrade test (which seeds a session at version 1) would fail.
- 2026-10-16 -- `sessionStoreContract`'s subject widened from `SessionStore` to
  `SessionStore & UserStore`, and `sampleEnsureSessionInput().userId` changed
  from `'owner'` to a UUIDv7 fixture. With the foreign key in place a case
  cannot create a session without creating the owner first.

## Review Triage Log

### Pass 1 (2026-10-16, lens: quick)

Verdicts: high 0, medium 0, low 9, false 1, maybe-false 0. Patch 6, defer 1, reject 3.

| # | Finding | Verdict | Route | Evidence |
|---|---------|---------|-------|----------|
| 1 | `claude-code/src/parser.ts` cursor fingerprint changes with whether the cursor line ended the file | low | patch | `fingerprintEnd` adds the newline only when `index !== lastIndex`; the reviewer reproduced two fingerprints for one cursor. Fix: always hash up to the line end without its newline |
| 2 | `core/src/sessions/ingest.ts` `started_at` is the batch minimum, not the first message | low | patch | Frozen Boundaries: `started_at`은 첫 메시지의 발화 시각; `firstOccurredAt` loops for the minimum while the parser orders by file position |
| 3 | `TRANSCRIPT_UNREADABLE`·`SESSION_NOT_FOUND` absent from `ERROR_CODES` | low | defer | Both codes predate this story (port failure codes since epic 1); `errorEnvelope` gives them exit 1 and no hint. Hidden on the hook path; fix adds public surface the plan does not settle |
| 4 | `sqlite/src/sessions.ts` `nextSeq` advances on a conflicting insert | low | patch | Unreachable under `BEGIN IMMEDIATE` and the `seen` set, but a direct correction (`+= inserted.rows.length`) keeps the memory store and SQLite identical |
| 5 | `sqlite/test/users.test.ts` "too old" test never reaches the `catch` | low | patch | It opens a path with no file, so `connect()` fails first (`connect.ts` `mode=rw`) |
| 6 | `dispatch.ts` hands Core the module registry, not the command's | low | reject | Production passes the same constant; only a test building a different registry meets it, and the fix adds a parameter through dispatch |
| 7 | `apps/cli/test/sessions-ingest.test.ts` concurrency test throws `SyntaxError` when a run is refused | low | reject | The test still fails, only less readably; the fix adds a guard. Not met in everyday use |
| 8 | Plan Change Log lacks the deleted deferred-work task | false | reject | The task was removed during planning before approval (CHECKPOINT 1 summary), not an implementation deviation; the fix would edit this plan |
| 9 | `README.md` two prose lines over the ~79-column wrap | low | patch | Lines 46 and 50 of the new paragraph; direct rewrap |
| 10 | `sqlite/test/schema-files.test.ts` describe title still says 0001 to 0002 | low | patch | Its assertions now walk through 0003; direct rename |
