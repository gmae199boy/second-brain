# 에픽 3 작업 로그와 시작 맥락 — 현재 코드 조사

조사일: 2026-10-23. 기준 커밋: `69b3b7b`. 대상은 `packages/`, `apps/`, `plugin/`의 현재 코드이며, 테스트 파일은 구현 선례를 읽는 데만 사용했다. 테스트·빌드는 실행하지 않았다. 저장소 루트에 `.codegraph/`가 없어 CodeGraph는 사용하지 않았다. 이 보고서 이외의 파일은 수정하지 않았다.

범위 원천: `epic-log-and-context.md:15`의 로그·규칙·맥락, `:19`의 Stop 점검, `:31`의 완료 조건, `:66`의 Carry. 아래 경로는 모두 저장소 상대 경로다. '없음'은 이 범위의 소스·등록부를 확인한 결과이며, 계획상 확장 위치와 충돌 등급은 **추정**이다. 에픽 10은 아직 구현이 아니라 `epic-attachments/tickets.toml`의 계획과 `epic-attachments-research-code.md:102`의 §9를 대조했다(두 파일의 상위 경로는 `_bmad-output/personal-brain/`).

## 1. 스키마 — 일부

테이블과 기본 제약은 있다. 로그 동작을 강제하는 불변 trigger와 Stop 확장 칸은 없다.

| 대상 | 현재 칸·제약 | 파일:줄 근거 |
| --- | --- | --- |
| `log_entries` | `search_rowid` PK, `id` unique, `kind`, `session_id` FK, `occurred_at`, `recorded_at`, nullable `author_model`, `text`, nullable `rule_state`, nullable `apply_project_id` FK, nullable `supersedes_id` 자기 FK. kind는 progress/decision/rule/preference; rule만 rule_state 필수; pending/on/off; 두 시각 형식 검사 | `packages/sqlite/migrations/0001_initial.sql:147` |
| `log_entry_edits` | `id` PK, `log_entry_id` FK, `previous_text`, `edited_at`와 시각 형식 검사 | `packages/sqlite/migrations/0001_initial.sql:174` |
| `context_injections` | `id` PK, `session_id` FK, `attempted_at`, `ok` 0/1, nullable `code`, `chars`; 시각 형식 검사. **kind·elapsed_ms 없음** | `packages/sqlite/migrations/0001_initial.sql:247` |
| 로그 FTS | external-content FTS5, text, content_rowid=search_rowid, trigram, secure-delete=1. insert/delete/text update 동기화 trigger 셋 | `packages/sqlite/migrations/0001_initial.sql:406`, `:411`, `:415`, `:420` |
| 순번 제거 후 | 0006이 `anchor_seq`, `joined_upto_seq`만 DROP COLUMN. search_rowid와 FTS는 유지. 로그의 대화 위치는 occurred_at으로 읽을 때 계산하며 메시지 연결을 저장하지 않음 | `packages/sqlite/migrations/0006_drop_message_seq.sql:178`, `:188`; `packages/core/src/domain/log-entry.ts:21` |

0001~0007에서 `log_entry_edits`·`context_injections`의 UPDATE/DELETE 불변 trigger는 없고, 로그 id/kind/session/occurred_at 등의 불변성도 도메인 주석만으로 강제되지 않는다(위 DDL 및 전체 마이그레이션의 trigger 정의 대조). I60은 실제 남은 일이다. pending 출처 메시지를 별도로 지정·보존하는 칸도 현재 로그 DDL에 없다.

현재 코드의 기대 SQLite schema version은 **7**(`packages/sqlite/src/migrate.ts:20`), 마지막 파일은 `0007_session_tag_source.sql`이다. 현재 트리만 보면 다음 번호는 **0008**이나, 에픽 10.6이 0008/version 8을 예약했다(`_bmad-output/personal-brain/epic-attachments/tickets.toml:28`). **추정 제안: 에픽 3은 10.6 뒤의 0009/version 9**로 kind·elapsed_ms 및 합의한 불변 trigger를 묶는다. 최종 번호는 병합 시 다시 확인한다. 마이그레이션은 번호순·파일별 쓰기 트랜잭션이고 버전도 함께 기록한다(`packages/sqlite/src/migrate.ts:149`, `:169`). 기존 0001을 고치는 방식은 쓰지 않는다.

## 2. Core 도메인·port·수집 재사용 — 일부

- **있음: 타입.** `LogEntryKind`, `RuleState`, `LogEntry`, `LogEntryEdit`가 `packages/core/src/domain/log-entry.ts:2`, `:8`, `:14`, `:47`에 있다. `applyProjectId`, `supersedesId`, occurredAt/recordedAt을 이미 구분한다. `ContextInjection`은 `packages/core/src/domain/context-injection.ts:6`에 있으나 start 전용 설명과 여섯 칸뿐이며 kind·elapsedMs는 없다. 공개 export도 있다(`packages/core/src/domain/index.ts:25`, `:57`; `packages/core/src/index.ts:1`).
- **없음: 사용 사례와 저장 능력.** Brain 공개 표면은 messages/doctor/sessions/failures/queue뿐(`packages/core/src/brain.ts:163`). Store 합성은 Health/Session/User/Work/TranscriptFile뿐(`packages/core/src/ports/store.ts:718`), SQLite도 해당 네 저장 모듈만 합성한다(`packages/sqlite/src/store.ts:80`). 로그 append/list/edit/set-state/set-scope, 규칙 대조·대체 체인, 맥락 렌더링, 주입 기록 read/write port 및 fake/계약은 새로 필요하다.
- **있음: 세션 토큰 선수집 진입점.** `brain.sessions.ingest`가 `ingestSession`을 호출한다(`packages/core/src/brain.ts:284`). `parsers`, `TranscriptReader`, `transcriptFolders` 의존성을 받으며(`packages/core/src/sessions/ingest.ts:118`), 경로가 없으면 `locateTranscript`가 토큰으로 찾는다(`:511`). 버전이 다른 저장 cursor는 버리고 전체 parse한다(`:283`). log append는 이 Core 진입점을 앞에 붙일 수 있다(**추정**). 다만 transcript를 못 읽을 때 ingest 자체는 실패를 돌려준다(`:280`); **로그 본문을 보존하는 spool fallback은 별도 구현**해야 한다.
- **있음: 원문 대조 재료.** `SessionStore.findSession`, `readSession`이 세션과 원문 메시지를 읽는다(`packages/core/src/ports/store.ts:265`, `:303`). Message에는 role/body/occurredAt/harnessMessageId가 있다(`packages/core/src/domain/message.ts:18`). 원문 저장·출력 마스킹 계약도 명시돼 있다(`packages/core/src/ports/store.ts:296`). 이 재료로 규칙 인용 대조를 만들 수 있지만 정확 인용 일치·pending 승격·off 보존 로직은 없다. 출력에서 받은 `[REDACTED:…]` 인용을 원문과 대조할 정책은 미결이며 에픽 문서 `:63`의 인셉션 결정이다.
- **없음: Core `isUserTurn` 술어·최소 발화 수 상수.** parser 결과의 `ParsedMessage.role`은 재사용 가능(`packages/core/src/domain/ingest-batch.ts:14`). 단순 role 확인과 원본 JSON 재해석을 혼합하지 말고 parser가 남긴 발화 기준을 계약으로 정할 필요가 있다(**추정**). `startCwd ?? firstCwd(messages)`를 이미 사용하므로 프로젝트 규칙은 이전 Notes의 첫 cwd만을 재구현하면 안 된다(`packages/core/src/sessions/ingest.ts:409`; `packages/sqlite/migrations/0007_session_tag_source.sql:3`).

## 3. 출력·시작 맥락·안내문 — 일부

- **있음:** `encodeHookOutput`은 값을 재귀 마스킹한 뒤 JSON을 만든다(`packages/core/src/output/codecs.ts:58`). `encodeHookLine`, `encodeTextLine`도 있다(`:63`, `:68`), OUTPUT_CODECS는 envelope/hook/text를 등록한다(`:72`). `maskOutputText`, `maskOutputValue`가 공통 출력 경계다(`packages/core/src/output/mask.ts:19`, `:40`). 시작 맥락과 Stop reason도 이 경계를 거칠 자리다(**추정**). hook 코덱 주석 자체가 에픽 3의 소비를 기다린다고 명시한다(`codecs.ts:51`).
- **없음:** 시작 맥락 조립기, 고정 머리말·세션 토큰·날짜/시간대·규칙/최근 로그/안내 요약 순서, 프로젝트/전체 규칙 우선순위, 생략 줄, 10,000자 상한 및 설정 크기 상수. 기존 `TOOL_NOTE_TARGET_LIMIT=500`은 도구 메모용이지 맥락 한도가 아니다(`packages/core/src/domain/tool-note.ts:15`).
- **일부:** `guideShow()`가 Core의 단일 본문 원천이며 export된다(`packages/core/src/guide.ts:37`; `packages/core/src/index.ts:32`). 지금 본문은 CLI 호출/엔벨로프·종료 코드 표·여섯 금지 사항·stderr 해석이다(`guide.ts:38`). 기록/인용/질의 규율은 의도적으로 빠졌다고 명시돼 있다(`:12`). 전용 discipline 상수와 시작 요약·Stop reason은 아직 없다.
- CLI `guide show`는 standalone/read이며 Core 전문을 markdown/text로 전달한다(`apps/cli/src/commands/guide-show.ts:24`, `:37`). 기존 명령은 확장해서 재사용하고 새 명령으로 중복하지 않는다.

## 4. spool → drain — 일부

현재 줄 버전은 1, 상한은 개행 포함 65,536 UTF-8 바이트다(`packages/core/src/domain/spool-record.ts:30`, `:41`). kind는 **session_ingest, failure 둘뿐**(`:77`, `:140`). log append와 context injection record는 없다. encode의 switch와 decode 검증이 모두 중앙에 있다(`:285`, `:332`, `:535`). 새 union만 더하고 코덱을 빠뜨릴 수 없는 형태다.

`Spool.append`/claim/complete/release/rewrite/stats port(`packages/core/src/ports/spool.ts:120`)와 파일 구현(`apps/cli/src/runtime/spool.ts`)은 재사용할 수 있다. 그러나 stats는 전체 건수/최초 시각/실패 건수일 뿐(`ports/spool.ts:101`), **Stop 점검에 필요한 '이 세션의 로그가 spool에 있는가' 비파괴 조회는 없다.** claim으로 점검하면 drain 소유권을 건드리므로 별도 읽기 능력이 필요하다(**추정**).

`SPOOLED` 코드는 이미 있다(`packages/core/src/codes.ts:24`). DB 불가 때 성공+SPOOLED를 내는 선례는 `spoolSessionIngest`(`packages/core/src/sessions/spool-ingest.ts:71`, `:138`)와 CLI `sessions ingest`의 spool 분기(`apps/cli/src/commands/sessions-ingest.ts:101`)다. **log append 명령 자체의 SPOOLED 경로는 없음**을 구별해야 한다.

주입 시도는 새 record 타입·검증/코덱 → `brain.ts`의 `spoolHandlers` 등록(`packages/core/src/brain.ts:225`) → 새 Store insert 능력으로 연결하는 것이 기존 확장 방식이다(**추정**). drain은 replay → scan → work 순서(`brain.ts:316`). replay handler 타입은 kind별 partial map(`packages/core/src/spool/replay.ts:72`)이며 재주입 중 다시 spool로 돌리지 않는 선례가 있다(`brain.ts:220`). start/stop hook은 DB 쓰기 트랜잭션 없이 spool만 남기고, drain에서 멱등 id로 저장하도록 해야 한다. FK상 세션 행이 아직 없는 시작 시도의 보존·선수집 순서도 새 계약이 필요하다.

추가 주의: decoder가 모르는 kind/버전은 failed로 옮기지만, 아는 kind의 handler 누락은 파일을 돌려놓는다(`packages/core/src/spool/replay.ts:38`). 따라서 에픽 3과 10의 새 record를 쓰는 빌드와 drain 빌드를 함께 배포할 필요가 있다(**추정**); 버전 번호 하나를 독립적으로 올리는 것으로 호환성이 보장되지는 않는다.

## 5. CLI·hook only·MCP·stdin — 일부

- **없음:** log/context namespace. 실제 registry는 `apps/cli/src/commands/index.ts:30`의 11개 항목이며 `:24`의 logAppend는 설명 예시다.
- **일부:** 명령 메타·write guard·hook 종료 0 규약은 있으나 `hook`은 boolean뿐(`apps/cli/src/dispatch.ts:239`), guide schema도 boolean(`apps/cli/src/commands/guide-schema.ts:31`, `:121`). **`hook: only`와 AD-28의 MCP 노출 제외 로직은 없다.** MCP/daemon에 대한 주석은 있으나 현재 코드에 MCP 서버·도구 생성 registry는 없다. 에픽 3은 메타 타입·검증·schema/표시와 hook 분기를 같이 바꾸고 후속 MCP가 제외를 소비할 계약을 남겨야 한다(**추정**).
- **있음:** lazy stdin reader, TTY면 즉시 빈 문자열 반환(`apps/cli/src/runtime/stdin.ts:14`). sessions ingest는 required에 stdin을 선언하고 hook payload를 읽는다(`apps/cli/src/commands/sessions-ingest.ts:79`, `:89`). 본문 stdin 입력·개행/제어문자 정제·본문 길이 상한은 새 구현이다.
- **없음:** hook 이벤트와 `stop_hook_active` 해석. 현재 hook reader는 session_id와 optional transcript_path만 꺼낸다(`packages/claude-code/src/hook.ts:49`, `:65`). fixtures에 Stop 값이 있어도 동작 구현의 근거는 아니다.
- **조기 반환 설계 자리:** standalone은 config/Store보다 먼저 실행(`apps/cli/src/dispatch.ts:524`), preflight도 config 읽기 전이며 현재는 동기 실패 반환용(`:528`). 일반 명령은 config 뒤 Store를 조립한다(`:531`, `:550`); 실제 SQLite 연결은 첫 메서드 때 열리는 lazy 방식(`packages/sqlite/src/store.ts:72`). Stop off 분기는 config/표식만 읽고 DB 메서드·opportunistic drain을 호출하지 않게 설계·검증해야 한다(**추정**). 현재 preflight를 설정 기반 성공 조기 반환으로 그대로 쓸 수 있다고 가정하면 안 된다.

## 6. 플러그인·생성/검증 선례 — 일부

| 현재 항목 | 코드 근거 |
| --- | --- |
| SessionStart | `plugin/hooks/hooks.json:3`: session-start.sh를 `|| exit 0`으로 감싸며 async=true(`:8`). bootstrap 후 queue drain을 실행하는 런처(`plugin/bin/session-start.sh:158`). 동기 context show 줄은 없음 |
| Stop | `plugin/hooks/hooks.json:14`: brain.sh sessions ingest claude-code, async=true(`:19`). 동기 log remind·5초 timeout 없음 |
| SessionEnd | `plugin/hooks/hooks.json:25`: 같은 ingest 명령, async=true(`:30`) |
| 공통 런처 | `plugin/bin/brain.sh:3`: plugin root 결정 → home/bin/brain shim 확인 → plugin root/PATH 전달 → exec(`:7`, `:13`). shim 부재 시 조용히 exit 0 |
| 버전·ref | `plugin/.claude-plugin/plugin.json:3`의 version은 **0.1.6**. `plugin/app-ref:1`은 `65fa3f1db96c369def03cac6a74a33cdc11fab21` |

`plugin/skills/`는 현재 없다. Core discipline에서 스킬 Markdown을 생성하는 스크립트, `tested_against`, 생성물 parity 검사는 없다. 루트 build는 workspace build 호출뿐(`package.json:17`). **재사용 선례**는 생성 shell과 커밋 shell의 node finder 문자열 일치 검사(`tooling/bootstrap/test/plugin.test.ts:173`), 명령 예시가 registry에서 실제 선택되는지 검사(`apps/cli/test/command-meta.test.ts:53`), guide schema가 실제 registry를 반환하는 검사(`apps/cli/test/guide.test.ts:93`)다. 이는 스킬 생성이 이미 있다는 뜻이 아니라 검증 방식을 옮겨 쓸 근거다.

릴리스 시 app-ref 변경은 plugin version을 같은 커밋에서 올리고, ref는 그 변경 커밋보다 이전 커밋을 가리켜야 한다(`AGENTS.md:11`). 에픽 3/10이 독립적으로 ref/version을 갱신하면 같은 줄 충돌이므로 릴리스 담당 하나로 모으는 것을 제안한다(**추정**).

## 7. 설정 — 일부

`config.toml` 코덱의 현재 schema version은 1, 알려진 키는 schema_version/timezone/store.path/files.path/mirror.path/update.auto뿐(`apps/cli/src/config/codec.ts:19`, `:29`). discipline·맥락 크기 설정은 없다.

**추정 확장 절차:** `KNOWN_KEYS`에 `discipline.stop_remind`를 등록하고 default false, `BrainConfig` 필드, 런타임 read의 boolean 검사/기본값, `SetupConfig`·관대한 setup reader, `WriteConfigInput`·TOML writer까지 함께 확장한다. boolean 선례는 `update.auto`(`codec.ts:213`, `:411`, `:569`). setup의 잘못된 값은 해당 키만 reset 경고로 바꾸고, 알려지지 않은 키는 extra로 보존한다(`:385`, `:462`, `:628`). flatten은 섹션을 점 표기로 만든다(`:676`); 테이블 자체를 특별 처리하는 새 parser는 필요 없다.

설치기가 **묻지 않는 키 보존** 선례는 files.path이다(`apps/cli/src/install/flow.ts:410`). settings 조립에서 기존 timezone도 그대로 전달하고 extra를 보존한다(`:694`). stop_remind도 여기서 기존 값 또는 false를 넘기되 질문을 추가하지 않아야 한다(**추정**). 키를 KNOWN_KEYS에만 등록하고 setup→write 전달을 빠뜨리면 재설치에서 사용자 값을 잃을 수 있다.

## 8. doctor — 일부

Core `runDoctor`는 DB 상태·adapter probe·schema-version·failures·untagged·transcripts를 넣고 외부 check source를 순서대로 실행한다(`packages/core/src/doctor/doctor.ts:146`, `:158`, `:173`). `DoctorCheckSource`는 id/run, 상태는 ok/warn/fail/skip이며 개별 실패로 뒤 검사를 중단하지 않는다(`:82`, `:124`). 런타임 목록은 config/shim/node-path/node-version/plugin/last-hook/spool(`apps/cli/src/doctor/checks.ts:118`, `:130`)이고 dispatcher/설치기가 공유한다.

**없음:** 미대조 규칙 인용, 규칙 크기, 세션 수 대비 주입 시도 검사 및 그 집계 Store 읽기. `DoctorReadStore`도 현재 세 종류 읽기만 합성(`packages/core/src/doctor/doctor.ts:98`). **추정:** DB 집계는 Core 목록/DoctorReadStore에, spool/표식/마지막 hook 같은 파일 사실은 runtimeChecks에 둔다. 규칙만으로 10,000자 초과 시 context 렌더러와 같은 크기 계산으로 fail을 내야 하며, 단순 전체 로그 길이 합산으로 대신할 수 없다. kind별 start/stop 시도와 세션 모집단·시도 누락/실패를 구분할 새 집계가 필요하다. DB 실패 분기의 skip id 목록도 함께 갱신해야 한다(`doctor.ts:158`).

## 9. Carry 상태 — 일부

| Carry | 판정·현재 근거·남은 일 |
| --- | --- |
| I50 중앙 코드 표 | **없음.** 두 코드는 타입/사용 사례에는 있다(`packages/core/src/ports/parser.ts:66`; `packages/core/src/ports/store.ts:168`; `packages/core/src/sessions/ingest.ts:108`). 그러나 `packages/core/src/codes.ts:160`의 CODES에는 없다. 미등록 코드는 exit 1/hint 없음으로 만드는 실제 fallback이 있다(`packages/core/src/envelope.ts:118`, `:126`). 중앙 등록 여부·사용자 hint를 결정해야 함 |
| I155 harness 등록부 주입 | **일부.** CLI Harness 목록과 `harnessParsers(registry)`, `transcriptFolders(env, registry)` 매개변수는 있음(`apps/cli/src/harnesses.ts:17`, `:29`, `:39`, `:47`). sessions 명령 factory는 registry 주입을 받음(`apps/cli/src/commands/sessions-ingest.ts:69`). 하지만 dispatcher Core 조립은 import한 전역 harnesses로 고정(`apps/cli/src/dispatch.ts:573`, `:576`). Brain은 이미 parsers/folders port를 받으므로 Core에 CLI Harness 타입을 밀어 넣기보다 런타임 조립 주입 seam을 완성할 자리(**추정**) |
| 회고 A2 패키지 경계 | **일부.** `packages/second_brain/test/boundaries.test.ts:25`는 package.json 의존성만 검사하고 Core runtime dependency 없음·adapter→Core·CLI→bundle을 확인. 실제 TS import graph/상대 경로 우회/Core의 node: API까지 검사하는 구현은 이 suite에 없음. 새 도메인 로직에서 FS를 Core로 가져오지 않도록 확장 필요 |
| I94 잘림 정보 | **일부.** target을 UTF-16 500 단위로 자르며 surrogate 경계를 보존(`packages/core/src/domain/tool-note.ts:15`; `packages/claude-code/src/tool-target.ts:163`). ToolNote에는 target 외에 truncated 플래그/원래 길이 없음(`domain/tool-note.ts:22`); 출력은 길이 ≥499를 잘림으로 간주해 마지막 토큰을 가림(`packages/core/src/output/mask.ts:96`). 정확히 그 길이인 원래 문자열도 가릴 수 있음. 다음 migration에 명시적 메타데이터를 둘지는 미결 |
| I105 Orca 워커 지시 | **일부 구현됨.** parser v4는 origin이 human/없음인 user만 받고, Orca 고정 머리말 둘과 메시지 묶음 패턴을 제외(`packages/claude-code/src/parser.ts:66`, `:93`, `:99`, `:647`, `:657`, `:982`). Core의 isUserTurn이나 워커 세션 자체 분류는 없음. 모든 워커 지시를 일반적으로 식별한다고 보장할 수 없고 현재는 텍스트/출처 휴리스틱. Stop은 전체 transcript를 parser로 읽은 결과를 세어 이 필터를 재사용할 수 있음(**추정**) |

## 10. 에픽 10과의 충돌 지도 — 추정

모든 행은 **계획 대 현재 확장 지점의 추정**이며 실제 diff가 아니다. '진짜 충돌'은 같은 선언/객체/목록/상수 줄을 양쪽이 바꿀 가능성이 큰 경우, '병합만 필요'는 같은 파일의 다른 능력·구간인 경우다. 파일이 다르더라도 공용 계약·배포 자원 충돌은 별도로 적었다. 스토리 번호는 구현 순서가 아닌 영구 id다.

| 에픽 10 스토리·계획 근거(tickets.toml) | 에픽 3과 겹칠 파일·자원 및 현재 근거 | 충돌 판정(추정) | 교차 선행·조정 제안(추정) |
| --- | --- | --- | --- |
| 10.1 닫힌 세션 재읽기·실패 해소 (`:4`) | `packages/core/src/capture/scan.ts:41`, `sessions/ingest.ts:283`, `brain.ts:225`, `:284`. log append 선수집이 같은 ingest를 사용 | brain.sessions.ingest 래핑·실패 해소를 둘 다 직접 고치면 **진짜 충돌**; log use case에서 기존 API 호출만 하면 **병합만 필요**. parser version 재읽기 정책은 공용 동작 | 10.1의 ingest 성공/실패 의미를 먼저 확정; 에픽 3은 호출 재사용. Stop은 DB cursor가 아닌 전체 transcript parse |
| 10.2 이미지 tracer·FileStore·새 spool (`:16`) | `ports/parser.ts:9`, `domain/ingest-batch.ts:14`, parser.ts:66/627, `domain/spool-record.ts:77/140/285/332`, `brain.ts:43/225/272`, `ports/store.ts:718`, `packages/sqlite/src/store.ts:80`, CLI dispatch.ts:566. 가장 넓은 공용 조립 | spool union/종류 목록·코덱, Brain deps/handler/API 객체, Store 교집합/SQLite spread는 **진짜 충돌**. FileStore와 LogStore 개별 메서드는 **같은 파일 다른 자리(병합만 필요)**. parser를 Stop용으로 별도 변경하면 같은 필터/버전은 진짜 충돌 | 공통 spool 계약·종류별 payload/등록 작업 담당을 먼저 배정; 10.2의 parser v5/이미지 전용 발화를 Stop 임계값 계약에 반영. 양쪽 신규 타입·export 누락을 함께 확인 |
| 10.3 FileStore 완성 (`:40`) | 10.2에서 늘어날 Brain/CLI FileStore 조립, fake/계약 export(`packages/core/src/testing/contracts/index.ts:1`), I155 조립 주입 자리 | 파일 저장 구현 자체는 **직접 겹침 없음**. shared factory 옵션/계약 export는 **병합만 필요**, 동일 deps 선언을 수정하면 진짜 충돌 | FS/표식/spool 읽기를 구분한 런타임 port 설계; FileStore를 로그 본문 저장소로 쓰지 않음 |
| 10.4 @파일·이름 FTS·parser 상승 (`:51`) | parser.ts:627의 메시지 필터, parser version 상수 `:66`; `sessions/ingest.ts:288`; 10.2가 더할 attachment spool encoder/handler | Stop이 parser 동작을 고치면 **진짜 충돌**; parser 결과를 읽기만 하면 **직접 줄 충돌 없음**. 신규 log/injection record와 첨부 record 코덱 등록은 공용 switch에서 진짜 충돌 가능 | 10.4 뒤 최종 parser 버전에 맞춰 발화 수 기준 재확인. 이미지/@파일만 있는 사람 발화 포함 여부를 계약으로 확정; 버전을 에픽 3이 독립적으로 덮어쓰지 않음 |
| 10.5 기존 첨부 채우기 (`:63`) | scan/ingest 재사용(`capture/scan.ts:128`, `sessions/ingest.ts:288`), 필요시 doctor 집계(`doctor/doctor.ts:165`) | ingest를 호출만 하면 **병합만 필요**. 사라진 transcript 수를 doctor에 넣으면 에픽 3 새 검사와 같은 checks/skip 목록에서 **진짜 충돌** | 첨부 backfill을 로그/규칙 생성 계기로 삼지 않음. 재읽기로 예전 user 메시지가 살아나 규칙 대조가 달라질 수 있어 대조는 멱등/off 보존 |
| 10.6 0008 trigger (`:28`) | 다음 migration 번호·schema version 상수 `packages/sqlite/src/migrate.ts:20`, schema 기대 테스트. 에픽 3 kind/elapsed_ms·I60·선택적 I94 | **진짜 충돌: 0008/version 8 자원 및 동일 상수 줄**. 실제 trigger 대상 테이블은 서로 다름 | **10.6 → 에픽 3 migration 0009**. 0008 수정 대신 후속 파일. I94 채택 여부도 번호 배정 전에 결정 |
| 10.7 chunk locator (`:75`) | Core domain/index·공개 export(`packages/core/src/domain/index.ts:25`, `:57`; `src/index.ts:1`)와 에픽 3 타입 확장 | 도메인 구현은 **직접 겹침 없음**, export 목록은 **같은 파일 다른 자리(병합만 필요)** | 독립 진행 가능. 페이지/코드 포인트 단위를 context의 글자 수 단위와 혼용하지 않음 |
| 10.8 추출 handler·일감·retry (`:99`) | `brain.ts:207` handler 맵, WorkStore 합성(`ports/store.ts:718`), fake, failures retry 등록. 에픽 3 pending 대조/표식 정리를 drain에 연결할 자리 | coreHandlers 같은 객체·deps 선언은 **진짜 충돌**; 새 use case/handler 파일은 독립, WorkStore의 다른 메서드는 **병합만 필요** | drain handler 등록과 budget 정책을 공동 조립. hook 경로에 document extraction/규칙 승격 쓰기를 끌어오지 않음 |
| 10.9 EXIF (`:110`) | 추출기 등록부·file_metadata와 에픽 3 로그/맥락은 직접 연결 없음. 공통 codes/버전 export가 늘면 접점 | 현재 확인 가능한 구현 접점은 **직접 겹침 없음**; 공통 export·코드 목록을 함께 바꿀 경우 **병합만 필요** | 독립 진행 가능; 에픽 3은 extractor version을 parser version과 혼동하지 않음 |
| 10.10 files reindex (`:121`) | `apps/cli/src/commands/index.ts:30`, `packages/core/src/brain.ts:163/272`, codes.ts의 FILE_SOURCE_UNREACHABLE. 에픽 3 log/context 등록·hook 메타 타입 | commands 배열·Brain API 객체에 동시 삽입은 **진짜 충돌**. 개별 command 파일은 독립. 메타 모델 변경은 같은 파일 다른 자리이나 API 호환 조정 필요 | 에픽 3의 hook boolean→only 지원을 먼저 계약화; 10.10의 일반 write 명령은 그대로 허용. registry 최종 합성 담당 한 명 |
| 10.11 고아 블롭·doctor (`:132`) | `brain.ts:207`, `doctor/doctor.ts:158/165`, `apps/cli/src/doctor/checks.ts:130`, Store 집계와 에픽 3 세 검사 | handler/doctor 목록·skip id 배열은 **진짜 충돌**; blob 집계와 rule/injection 집계 메서드는 **같은 파일 다른 자리(병합만 필요)** | 검사 id/DB 전제/skip 등록 방식을 선행 합의; 주입 비율과 blob 건수는 별도 검사로 유지 |
| 10.12 파일 가리기·첨부 경고 (`:143`) | Brain/Store/fake 합성, CLI registry, `packages/core/src/codes.ts:59/99`의 기존 경고 설명; 에픽 3 I50 코드 등록·RULE_UNVERIFIED 사용 | registry/Brain/Store 합성은 **진짜 충돌**. codes.ts에서 ATTACHMENT_NOT_REDACTED 설명과 I50/RULE_UNVERIFIED는 **같은 파일 다른 자리(병합만 필요)** | 에픽 10의 출력 마스킹 B 계약 유지. 규칙 인용은 원문 대조하되 가려진 메시지로 규칙이 재승격되는지 정책 확정 필요 |
| 10.13 Refactor sweep (`:155`) | 범위 미정. sessions.ingest 시작 지연 실측과 패키지 경계 검사(`:159`)는 에픽 3 SM-7/I155/A2와 접함. hooks.json은 현 계획에 직접 수정 지시 없음 | 리팩터가 brain/dispatch/Store/registry 구조를 이동하면 **진짜 충돌 가능**; 확정할 수 없는 부분은 **추정·미정** | 에픽 3 통합 전에 공용 파일 구조 변경을 통지. 에픽 10 종료 sweep과 에픽 3 조립 통합을 동시에 하지 않음. A2를 한 번 강화해 양쪽 공유 |
| 10.14 추출 세대 Store (`:87`) | `ports/store.ts:718`, `packages/sqlite/src/store.ts:80`, fake Store·계약 export와 에픽 3 LogStore/ContextStore | 교집합/spread 선언은 **진짜 충돌**, 서로 다른 능력 인터페이스/SQL 모듈은 **같은 파일 다른 자리(병합만 필요)** | 능력별 새 모듈로 분리하고 합성만 공동 순서로 반영; 10.14 완료가 에픽 3 도메인 구현 전체의 선행은 아님 |

### 교차 선행을 최소화한 병렬 진행 제안 — 추정

1. **먼저 합의할 공용 계약:** spool 종류/코덱·replay 등록, Store 능력 이름/합성, Brain deps/API, hook 메타의 only 표현, doctor id·skip 목록. 여기만 공동 조립하고 로그/첨부의 개별 구현 파일은 나눠 맡긴다.
2. **필수 번호 순서:** 10.6(0008) → 에픽 3 migration(0009). 에픽 3의 도메인·안내문·스킬 생성·순수 맥락 렌더링 설계는 기다릴 필요 없다. schema 상수와 기대 테스트는 두 migration이 공존하는 최종 버전으로 맞춘다.
3. **발화 수 계약 순서:** 10.1의 재읽기 정책 → 10.2(v5) → 10.4(추가 상승) 후 Stop parser 연동을 다시 검증한다. 에픽 3은 현재 v4로 순수 술어/전체 parse 소비를 먼저 개발할 수 있으나, 이미지 전용 발화를 살리는 변경 때문에 임계값 의미가 변한다. parser 버전 숫자를 에픽별로 따로 예약하지 않는다.
4. **선수집 조립:** 에픽 3 log append는 10.1·10.2·10.4가 확장하는 sessions.ingest의 소비자다. 첨부가 붙은 세션을 log append로 선수집해도 첨부 기록을 잃지 않도록 최신 경로를 호출한다. 시작/Stop hook은 읽기+spool만 사용하고 ingest/추출/일반 opportunistic drain의 쓰기 경로에 합류시키지 않는다.
5. **hooks.json은 현재 에픽 3 소유:** 에픽 10 1~14에는 hooks.json 직접 수정이 명시되지 않았다. 에픽 3은 기존 비동기 Stop/SessionEnd 수집을 유지하고 동기 SessionStart context 및 Stop remind를 추가한다(`plugin/hooks/hooks.json:8/19/30`). 10.13이 지연 개선을 위해 hooks를 바꾸면 같은 Stop/SessionStart 배열이 진짜 충돌이 되므로 그때 소유권을 재합의한다. plugin version/app-ref 배포 갱신도 단일 담당으로 모은다.
6. **코드 표와 경계 검사는 공용:** RULE_UNVERIFIED는 이미 등록돼 있어 중복 추가하지 않는다. I50의 중앙 오류 등록은 에픽 3에서 결정하고 10.12의 첨부 경고 문구 변경과 병합한다. I155/A2 정리는 양쪽의 새 port/런타임 조립에 공통 적용하고 에픽 전체를 순차화하지 않는다.

## 이 에픽이 새로 만들어야 하는 것

- LogStore/ContextStore 읽기·쓰기·집계 능력, SQLite 구현·fake·계약, log append/list/edit/set-state/set-scope와 Brain/CLI 연결. 선수집 실패에도 본문이 남는 로그 spool 및 기록 id/시각의 멱등성.
- 본문 stdin·정제·길이 상한, 원문 규칙 인용 정확 대조·pending/on/off 전이·off 보존·범위와 결정/선호 supersedes 정책. pending 출처 메시지 저장 자리 결정.
- 시작 맥락 순서·머리말·시간대·세션 토큰·규칙/로그 선택·설정 크기/10,000자 한도·규칙 생략, Core 규율 원본/전문/요약/Stop reason과 스킬 생성·tested_against·명령/flag/parity 검사.
- 주입 record의 kind/elapsedMs 타입·후속 migration·불변 trigger, 성공/실패 시도 spool와 drain 저장·세션 FK 순서·지연 계측.
- log remind의 hook only 메타, Stop 이벤트/stop_hook_active 판독·isUserTurn/발화 임계값·spool 세션 로그 조회·차단 출력 후 표식 생성·30일 정리·5초 timeout·모르면 조용히 종료·off면 DB 무접근 경로.
- discipline.stop_remind 코덱/설치 보존과 새 doctor 세 검사·read 집계. Carry I50/I60/I94/I155/A2/I105의 남은 결정/보완을 스토리에 명시.

## 이미 있어 재사용할 것

- 0001 로그/편집/주입 DDL·로그 trigram FTS/secure-delete 동기화, 0006 occurred_at 기반 위치와 기존 LogEntry/LogEntryEdit/RuleState/ContextInjection 타입·공개 export.
- 세션 토큰·sessions.ingest/locateTranscript·버전별 cursor reset·TranscriptReader/Folder·원문 readSession·startCwd 및 tag_source 기반 프로젝트 정체성.
- parser v4의 user 출처·meta/sidechain/도구 결과/Orca 고정 프롬프트 필터. Stop의 user 집계는 이 결과를 소비하되 후속 parser의 이미지 전용 메시지 변경을 반영.
- 출력 마스킹 B·encodeHookOutput/Line·OUTPUT_CODECS와 계약 검사. 기존 guideShow/guide show/guide schema와 명령 메타·registry·예시 검증.
- spool 파일 어댑터·코덱 틀·replay/queue drain·SPOOLED 코드와 선수집 spool 성공 패턴. RULE_UNVERIFIED는 이미 중앙 등록됨.
- TOML flatten/KNOWN_KEYS·setup 관대한 읽기·unknown extra 보존·boolean 키 선례, doctor 등록/check source·실패 격리/skip 구조, shim 런처 및 node finder parity 선례.
