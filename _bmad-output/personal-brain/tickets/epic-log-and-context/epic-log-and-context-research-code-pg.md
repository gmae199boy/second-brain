# epic 3 작업 로그와 시작 맥락 — PostgreSQL·공통 작업 runtime 위 정적 조사

2026-10-28, `plan/epics-12-on` worktree. 소스와 계획 파일을 읽은 결과이며 실행 성공의 증거가 아니다. 테스트·빌드·Docker·설치·패키지 추가·커밋은 하지 않았다. 편집 범위는 이 보고서 하나다. 아래 제안은 결정이 아니라 재분할 입력이다.

근거 약칭은 다음 저장소 상대 파일을 가리키며, `약칭:행`도 `파일:행` 인용이다.

| 약칭 | 파일 |
|---|---|
| E3 | `_bmad-output/personal-brain/tickets/epic-log-and-context/epic-log-and-context.md` |
| T3 | `_bmad-output/personal-brain/tickets/epic-log-and-context/tickets/tickets.toml` |
| R3 | `_bmad-output/personal-brain/tickets/epic-log-and-context/epic-log-and-context-research-code.md` |
| S3 | `_bmad-output/personal-brain/tickets/epic-log-and-context/epic-log-and-context-research-sources.md` |
| V3 | `_bmad-output/personal-brain/tickets/epic-log-and-context/epic-log-and-context-validate-set.md` |
| V3b | `_bmad-output/personal-brain/tickets/epic-log-and-context/epic-log-and-context-validate-set-2.md` |
| A | `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` |
| I | `_bmad-output/personal-brain/initiative-personal-brain.md` |
| D | `_bmad-output/personal-brain/decisions-by-recommendation.md` |
| T11 | `_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/tickets.toml` |
| T12 | `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/tickets.toml` |
| T13 | `_bmad-output/personal-brain/tickets/epic-extensions/tickets/tickets.toml` |
| E17 | `_bmad-output/personal-brain/tickets/epic-search-and-health-query/epic-search-and-health-query.md` |
| T17 | `_bmad-output/personal-brain/tickets/epic-search-and-health-query/tickets/tickets.toml` |
| E5 | `_bmad-output/personal-brain/tickets/epic-operations/epic-operations.md` |

## 0. 기준과 현재지

E3-1~9·Done when 1~9를 유지한다. FR-20의 별도 주제·이유·상태 칸은 되살리지 않고, 내용·이유는 문장, 상태는 `supersedes_id`로 해석한다. 규칙은 저장 전 고치지 않고 입력 거절, 가린 인용은 특별 처리 없이 pending, off는 자동 승격 금지, 대화 연결은 사건 시각뿐이다. startCwd 우선 꼬리표와 I94/I105 연기도 유지한다(E3:27, E3:39, E3:78, E3:84, E3:85, E3:86, E3:89, E3:90, E3:92, E3:93).

기존 조사는 SQLite 기준 커밋의 정적 조사이고(R3:3), 이전 set 검증은 pending 보존·후속 명령 의존·주입 경로 소유·한 세션 크기 등을 다뤘다(V3:9, V3:79; V3b:25, V3b:31, V3b:78). 재사용할 것은 그 계약과 실패 사례이며 `0009`·SQLite adapter·당시 parser 버전·epic 10 병렬 순서는 현행 근거로 다시 읽어야 한다. 기존 15개 entry 중 13은 문서에 남아 있지만 drop된 입력이고, 나머지 14개도 새 실행 세트로 승인된 상태가 아니다(E3:98, E3:99, E3:100, E3:101, E3:103; T3:168).

**코드와 결정의 어긋남:** 이 worktree의 PG는 아직 HealthStore & SchemaStore뿐이고 CLI는 `sqliteStore`를 기본으로 쓴다. PG의 현 0001도 초기 설계로, `messages.seq`, 로그 anchor, 단일 schema_version·now()가 남아 있다. epic 11은 이를 새 PG baseline과 소유자별 실행기로 바꾸는 계획이다. 메인 쪽 작업 완료를 이 보고서가 관측했다고 해석하면 안 된다(`packages/postgres/src/store.ts:49`, `apps/cli/src/dispatch.ts:435`, `packages/postgres/migrations/0001_initial.sql:72`, `packages/postgres/migrations/0001_initial.sql:106`, `packages/postgres/src/migrate.ts:123`; A:483, A:486; T11:32, T11:128).

## 1. 기존 15개 entry의 유지·수정·삭제와 교차 after 후보

아래 교차 after는 **최소 능력 공급자 후보**다. 최종 구현 진입점에서 실제 완료 HEAD를 읽고 중복 선행을 줄여야 한다. `11.10`은 baseline 고정·PG fixture, `11.11`은 SQLite 삭제, `12.1`은 실행 분류, `12.5`는 core 성공/실패 결과, `13.7`은 스킬 검사, `17.5`는 recall 스킬 방식이다(T11:128, T11:140; T12:8, T12:56; T13:80; T17:56). 아래 내부 숫자는 같은 epic 3 id다.

| entry·현 근거 | 그대로 쓸 것 | 고쳐 쓸 것 / 지울 전제 | 새 교차 after 후보 |
|---|---|---|---|
| 3.1 경계 시험(T3:4) | 실제 import·상대 경로 우회·Core Node API 감시 | 현 시험은 manifest만 검사하며 sqlite 허용도 남음. 11의 삭제 뒤 그래프/금지 API 검사를 보강; 이미 앞 에픽에서 해결되면 증거와 함께 흡수/완료 취급 후보 | `11.11`(T11:140); 현재 `after=[]`는 새 기준선 미반영 |
| 3.2 규율 원본(T3:16) | B1~B7·C3/C5/C6, 전문·요약·Stop reason 한 원본 | 기존 guide 확장 유지. install/recall 스킬의 별도 문구를 복제하지 않도록 생성 대상 경계 명시 | 필수 PG after 없음; 스킬까지 합칠 경우만 `13.7`, `17.5`(T13:80; T17:56) |
| 3.3 Stop spike(T3:28) | 두 출력 방식·실제 발화 차·parser 버전·결과 기록 | v4 고정 삭제(현 v6). 사람 실측 Decision을 최신 위임과 구분; 제품 코드 미포함 유지 | 현 parser가 11 뒤 이어지므로 `11.10`; 플러그인 시험 harness 재사용은 `13.7` 선택(T11:128; T13:80) |
| 3.4 tracer(T3:40) | 한 진행 로그 → 다음 시작 맥락, 토큰/날짜, 읽기 전용, only 메타, harness 주입 | SQLite/fake/계약 중 SQLite를 PG로. `10.2`의 조립 방식을 최종 PG factory 기준으로 교체. hook only 메타가 앞 에픽에 생겼으면 재구현 삭제 | `11.7`, `11.10`, `11.11`; 공통 core 등록을 쓰면 `12.1`(T11:92, T11:128, T11:140; T12:8) |
| 3.5 DDL(T3:52) | kind/elapsedMs·pending 보존 계약·불변성 직접 SQL 검증 | 제목/verify의 SQLite 0009·schema 9·10.6 뒤·Postgres epic 7 삭제. core 다음 번호, owner/checksum 검사. baseline에 이미 있는 trigger는 중복 생성 안 함 | `11.2`, `11.10`; 최종 번호는 이후 12~18·8 migration까지 읽어 배정(T11:32, T11:128; A:483) |
| 3.6 append 완성(T3:64) | 네 종류·stdin·정제/거절·선수집·SPOOLED·대체·I50·FR-20 반영 | `10.1`·옛 Store/spool 조립 직접 의존을 PG 공급자로 교체. 로그 원문과 spool payload의 NUL/크기 계약 추가 | `11.7`, `11.10`; 대체 직렬화/일감은 `12.1`, `12.5`를 쓰는 범위만(T11:92, T11:128; T12:8, T12:56) |
| 3.7 인용 대조(T3:76) | NFC·원문 코드 포인트·유일 일치·pending/off·프로젝트 | 수집 뒤 막연한 drain 대신 core 일감 등록/성공 조건; messages raw 복원 후 대조. 인용·위치 수명은 5 선행 유지 | `11.1`, `11.14`, `11.10`, `12.1`, `12.5`; 수집→재대조 의존 그래프를 쓰면 `12.6`(T11:20; T12:68; A:222) |
| 3.8 관리(T3:88) | edit+이력 원자성, 규칙 edit 거절, state/scope, 공용 유효성 읽기 | PG transaction/CAS·현재/이력 정렬 계약. 명령/SDK 1:1와 hook only 일관성 | `11.10`; 검색까지 넓히지 않음(E17:55). 내부 6·7 유지 |
| 3.9 시작 맥락(T3:99) | 섹션·범위·선호 제외·상한·생략·대체 출력·SM-7 | 크기/시간대 사용자 설정은 11.6의 DB settings, stop 토글만 기계 TOML. DB 실패 fallback과 connect 예산 명시 | `11.6`, `11.7`, `11.10`; 17 출력 변경 통합 필요 시 `17.5`(T11:80, T11:92; T17:56) |
| 3.14 주입 경로(T3:111) | start/stop 공용 record, ID/시도 시각, 세션 FK 대기·만료, 멱등 | SQLite Store→PG. spool 재생과 work_items 전환을 구분. 없는 세션을 일반 10회 실패로 소진하지 않을 계약 | `11.3`, `11.7`, `11.10`, `12.1`, `12.5`(T11:44, T11:92; T12:8, T12:56) |
| 3.10 doctor(T3:123) | pending·동일 렌더러 크기·start 시도 모집단 | PG doctor/소유자별 schema·runtime 실패에 맞춰 DB skip 목록 통합 | `11.8`, `12.5`; 기존 검색 확장 상태 검사와 통합은 `17.5` 선택(T11:104; T12:56; T17:56) |
| 3.11 스킬(T3:134) | 생성/커밋 parity·tested_against·명령/flag 검사 | 첫 plugin 스킬이라는 전제 삭제. install의 정적/행동 두 층과 recall의 case 방식 위에 기록 스킬 추가. 이미 구현된 17 recall을 '아직 없는 epic 4'로 배제하지 않음 | `13.7`, `17.5`(T13:80; T17:56). 내부 2·8 유지 |
| 3.12 Stop(T3:145) | off 조기 반환·네 조건·표식·실패 무출력·5초·시도·30일 정리 | 10.4/parser 고정·DB 파일 차단 삭제→현 parser/PG 접속 차단. 비파괴 spool 조회가 claim 중 파일도 다룰 계약, 청소는 core runtime | `11.7`, `11.10`, `12.1`, `12.5`; 내부 3·5·9·14 유지(T11:92; T12:8, T12:56) |
| 3.15 배포/설치(T3:157) | 이전 커밋 app-ref+version, 설치된 plugin에서 조건별 확인 | epic 10 공동 배포라는 당시 순서와 DB 파일 전제 삭제. 로컬 에이전트 확인/사람 판단/원격 push 분리 후보 | `13.7`, `17.5`(스킬 묶음 수용); PG 설치 확인 수단은 `11.10` 코드. `11.13` 사람 확인을 무조건 gate로 만들 근거 없음(I:187, I:189) |
| 3.13 sweep(T3:168) | 재개 때 확인된 결함만 기능 스토리에 흡수 | **drop 유지**, id 재사용 금지. 전 Done when을 이 dropped entry 하나에 떠넘기지 않음 | 없음(E3:99) |

실제 package 경계 시험은 의존 manifest만 검사한다(`packages/second_brain/test/boundaries.test.ts:25`, :37). CLI registry에는 log/context 구현이 없고 logAppend는 주석 예시다(`apps/cli/src/commands/index.ts:29`, :36). 따라서 3.4·6·8을 '이미 있는 명령 수정'으로 축소할 수 없다. epic 10의 산출물은 이미 attachment_link spool, 추출 handler, parser v6로 나타나므로 옛 10.N 의존을 그대로 새 세트에 복사하지 않는다(`packages/core/src/domain/spool-record.ts:78`; `packages/core/src/brain.ts:275`; `packages/claude-code/src/parser.ts:67`).

## 2. 스키마와 U+0000

| 대상 | 이 worktree의 코드 | PG baseline 이후 epic 3 후보 |
|---|---|---|
| log_entries | PG 0001에 네 종류·rule_state·scope·supersedes·FK 있음. 옛 anchor도 남음(`packages/postgres/migrations/0001_initial.sql:95`, :106) | 새 표를 다시 만들지 않는다. baseline의 anchor 제거·검색 lower expression GIN을 수용한 뒤 LogStore verb와 pending 증거 저장을 추가(T11:32; A:561) |
| log_entry_edits | PG 0001에 previous_text·edited_at 있음(:117) | edit와 이전 문장 INSERT를 한 transaction으로. baseline에서 불변 trigger를 먼저 확인하고 빠진 경우만 후속 DDL(A:232, A:562; T11:33) |
| context_injections | PG 0001에 id·session FK·attempted_at·boolean ok·code·chars 있음(:165) | kind start/stop CHECK·기존 start backfill·elapsed_ms nullable/비음수. 미측정은 NULL, 0 아님. Core ContextInjection도 kind/elapsedMs 추가(T3:55; `packages/core/src/domain/context-injection.ts:6`) |
| 불변성 | 현 PG trigger 대상은 messages·tool_notes뿐(:260, :268) | baseline의 UPDATE/DELETE/TRUNCATE 방어 범위를 확인. log_entries의 kind/session/occurred_at/author_model 및 edits/injections 방어가 없으면 다음 core migration에서 보충(A:550, A:561, A:562, A:567; T11:33) |

**책임 중복 주의:** E3-8은 I60 trigger를 3.5에 두지만, 최신 A Conventions는 불변 trigger가 core baseline에 함께 들어간다고 하고 11.2도 불변 표 UPDATE/DELETE/TRUNCATE 검증을 약속한다. 이것은 결정 재논의가 아니라 공급 범위 대조다. 11.2 최종 SQL을 먼저 읽어 '이미 강제함/부족함'을 명시하고, kind·elapsed와 pending 증거 등 실제 차이만 다음 번호에 싣는 두 경로가 있다(E3:34; A:642; T11:32, T11:33). 현재 `SCHEMA_VERSION=1`이나 SQLite의 이미 존재하는 `0009_schedules.sql`을 새 번호 근거로 삼지 않는다(`packages/postgres/src/migrate.ts:12`; E3:101). 11.10 checksum 고정 뒤 0001 수정은 금지이며 AD-31 owner/core 연속 번호를 따른다(T11:128; A:483).

AD-11 NUL 코덱은 transcript 텍스트 전 경로에 text(U+FFFD 투영)+nullable bytea 원문 짝을 요구한다. 현 messages.body에는 짝 칸이 없어 **어긋남**이며 11의 완료를 기다리는 부분이다(`packages/postgres/migrations/0001_initial.sql:75`; A:222). 인용 대조는 복원된 논리 원문으로 해야 한다. body text의 U+FFFD와 직접 대조하면 원래 U+0000과 U+FFFD를 구분할 수 없어 false match/false pending이 생긴다(A:222, A:223; E3:28).

로그 본문은 E3의 정제/거절을 먼저 통과한다. 규칙 본문의 U+0000은 제어문자이므로 USAGE 거절, 다른 종류는 정제로 제거하는 현재 Decision을 유지한다(E3:84). 반면 인용 증거가 transcript에서 복사된 문자열이면 같은 쓰기 코덱을 적용할 후보이며, JSONB에 escape만 해 넣는 것은 안 된다. 별도 quote text+quote_raw 또는 같은 코덱을 쓰는 증거 표가 선택지다. `previous_text`·spool payload까지 어디서 정제되고 어디서 원문을 유지하는지 계약을 써야 한다. AD-11을 '모든 입력에서 NUL 거절'로 바꾸거나 로그 정제를 핑계로 messages 원문을 잃으면 안 된다(A:222; T3:55, T3:67). 현 PG 0001의 로그 text·previous_text에는 raw 짝이 없으므로 향후 허용 입력을 넓히면 그 칸을 만드는 migration에서 함께 설계해야 한다(`packages/postgres/migrations/0001_initial.sql:102`, :120; A:222).

검색 색인과 검색 명령은 별개다. 11.2가 `log_entries.text` expression GIN을 만들고, 17은 대화/문서 검색과 recall 스킬을 만든다. 작업 로그 검색·index rebuild는 epic 4에 남는다. epic 3에서 새 FTS5·검색 명령·재색인 daemon을 만들 근거가 없다(T11:32; E17:18, E17:55, E17:68; A:278).

## 3. SessionStart·Stop의 읽기 경로와 주입 기록

현 hooks.json은 SessionStart bootstrap과 Stop 수집이 모두 async이고 동기 context/remind 줄이 없다(`plugin/hooks/hooks.json:8`, :9, :19, :20). 기존 session-start.sh는 bootstrap 뒤 queue drain도 실행한다(:158, :160). 새 동기 맥락 경로를 여기에 그대로 묶으면 설치·drain 쓰기를 포함하므로 AD-6과 어긋난다. 기존 비동기 bootstrap/수집은 유지하고 같은 brain.sh 런처를 통한 **별도 동기 줄**을 더하는 것이 기존 결정의 소비 방식이다(E3:68, E3:76; A:144).

PG는 로컬 TCP 연결이 필요하므로 AD-6의 '네트워크 호출 없음'은 문자 그대로는 PG 접속과 긴장 관계다. 외부 API/컨테이너 시작/모델 호출을 hook에 넣지 않는 취지는 유지하되 이 문구의 PG 해석을 계획에서 명시해야 한다. 접속/SELECT 시간 상한은 11.7이 공급하고 hook lock_timeout은 1초다. 현 connect 기본은 이미 5초이므로 이것에 여러 SELECT 시간을 더한 것을 Stop 5초 전체 보장이라고 부르면 안 된다(A:144, A:172; T11:92, T11:116; `packages/postgres/src/connect.ts:16`, :34).

후보 경로는 설정/표식 조기 반환 → hook payload 해석 → 읽기용 PG factory/짧은 SELECT snapshot → 출력 코덱 → 시도 spool → 종료다. hook에서는 세션 생성·선수집·migration·health 쓰기 탐침·opportunistic drain을 호출하지 않는다. 여러 SELECT 일관성이 필요하면 READ ONLY transaction을 후보로 둘 수 있으나 쓰기 transaction은 금지다. query spy뿐 아니라 PG 읽기 전용 권한/transaction fixture로 INSERT/UPDATE/addWork와 migration 호출 0회를 관측할 수 있다(A:144, A:174; T3:44, T3:115). 현 dispatch는 boolean hook이고 실패 종료 0 처리는 있으나 'only'를 표현 못 하므로 타입·검증·guide schema·hook 출력 분기·drain 제외를 함께 확인해야 한다(`apps/cli/src/dispatch.ts:239`, :429, :495, :694, :1009).

DB가 꺼지면 context는 exit 0+대체 안내/systemMessage와 실패 시도 spool, remind는 아무 출력 없이 exit 0+토글 on 점검 시도 spool이다. schema 불일치도 session을 막으면 안 된다. 11.7의 DB_UNAVAILABLE/SCHEMA_MISMATCH 매핑을 사용하고 hook이 compose up을 직접 하지 않는다(T3:102, T3:148; T11:92, T11:116). off일 때 Store factory/DB method/드레인 호출 자체가 0회인지 별도 spy가 필요하다. 현 일반 dispatcher는 config 뒤 Store를 조립하므로 성공 조기 반환을 위한 명시적 seam이 필요하다(`apps/cli/src/dispatch.ts:573`; A:144).

Stop 표식은 `<home>/run/stop-remind/<harness>-<id>`이며 출력 뒤에만 생성하고 30일 뒤 drain이 지운다. 겹친 호출의 출력 1회 보장과 '출력 뒤 표식' 사이 crash 창은 별도 runtime port/동시성 fixture의 대상이다. 세션이 없거나 spool 상태를 못 읽으면 묻지 않는다. 현 hook decoder는 session_id/transcript_path만 꺼내므로 Stop 이벤트·stop_hook_active를 명시적으로 파싱할 경계가 더 필요하다(A:307; E3:94; `packages/claude-code/src/hook.ts:49`, :65).

주입 경로 선택지는 다음과 같다. 어느 쪽도 동기 hook에서 DB 일감을 만들지는 않는다(A:311).

| 선택지 | 장점과 남은 계약 |
|---|---|
| spool replay handler가 세션 존재를 읽고 injection INSERT | 현 drain이 replay부터 하는 구조를 직접 재사용. 중간 work row 없이 ID로 멱등. 세션 미존재는 재시도 실패 횟수와 분리해 만료까지 보존해야 함(`packages/core/src/brain.ts:443`; T3:114) |
| replay가 payload를 영속화하고 core `context_injection` 일감을 등록 | 12의 결과·재시도·조회가 통일됨. 세션 FK 없는 staging의 수명, payload 이관+addWork 원자성, hook 시각 보존, orphan 만료 추가 필요(T12:8, T12:56; A:357) |

짧은 PG 쓰기라면 실행 분류는 `core` 후보이며 supervised 자식/ABI가 필요한 근거는 없다. 같은 spool 레코드를 work row에도 무조건 복제하면 두 큐 사이 소유권을 새로 풀어야 한다. 원래 Decision은 'spool→drain→context_injections'이므로 첫 안도 만족한다(T3:114; T12:80). 대화 없이 끝난 세션의 FK 대기는 정상이며 보존기간은 3.14 소유로 정한다. 현 spool 일반 10회 실패 종료에 맡기지 않는다(E3:87; T3:114; `packages/core/src/spool/replay.ts:38`).

## 4. pending 규칙 재대조와 원문 좌표

수집 뒤의 재대조는 durable core 일감 후보가 적합하다. 수집 성공 transaction에서 세션 단위 열린 `rule_recheck`를 멱등 생성하거나, pending 행 단위로 만들 수 있다. 전자는 수집 횟수 대비 중복을 줄이고 후자는 개별 실패/완료가 분명하다. 실행 시 `pending`만 읽고 대조 성공 시 `WHERE rule_state='pending'` CAS로 올려 사람의 off와 경쟁해도 다시 켜지 않게 한다. 실패 대조는 정상 pending이며 외부 오류처럼 10회 실패로 만들지 않는다(E3:28; T3:79; A:357, A:360; T12:8, T12:56). 수집→재대조를 일감 그래프로 묶을 필요가 있을 때만 12.6 의존을 쓴다(T12:68).

증거는 quote·선택 message id·코드 포인트 `[start,end)`를 재대조 시점까지 보존해야 한다. 로그 spool을 성공 후 지우면서 quote를 함께 잃는 안은 불가하다. 3.5에서 DB 증거 칸/별도 표 또는 수명 보장 spool 중 하나를 먼저 정하는 기존 검증 결론을 유지한다(T3:55, T3:79; V3b:25). 좌표는 저장 원문의 코드 포인트이므로 raw bytes 복원 → 원래 좌표로 자름 → 양쪽 NFC → 일치 판정 순서 후보이며, normalize한 본문에 원래 offset을 바로 적용하면 결합 문자 길이 변화로 어긋난다(A:631; S3:38; A:222).

원문 bytea와 표시 text가 다른 NUL 사례, NFC/NFD, 중복 문장, 이미지/파일 전용 사용자 발화, redact 후 불일치, off와 재대조 경쟁을 fixture로 고정할 필요가 있다. 가린 인용의 특별 비교나 redact 전 원문을 별도 보존해 자동 on을 유지하는 정책은 만들지 않는다(E3:85, E3:95; A:223). 사용자 발화 수는 DB messages 건수가 아니라 transcript parser와 Core `isUserTurn` 하나를 사용한다(A:307). 현 parser v6를 읽어 최종 기준을 확인해야 하며 v4 실측 수치를 그대로 적용할 근거는 없다(`packages/claude-code/src/parser.ts:67`; T3:31).

## 5. 시작 맥락 budget·출력·스킬

머리말→켜진 규칙→최근 로그→안내 요약, 날짜/요일/시간대/토큰, 데이터는 지시가 아님·현재 발화 우선·샘플 안내는 유지한다. 규칙 과다 시 프로젝트→전체 각각 최신 순, 생략 줄, doctor fail이며 선호는 제외한다(E3:30, E3:72; A:310). 총 10,000자는 토큰 수가 아니다. 코드 포인트·가림 뒤·머리말/요약/생략 줄 포함 여부는 기존 계획 질문이므로 여기서 확정하지 않는다. 추천 후보는 실제 사용자에게 전달할 마스킹된 문자열을 코드 포인트로 세고 고정 영역과 생략 줄 예산을 먼저 남기는 방식이다(E3:94; T3:102; A:631).

현 hook 출력 코덱은 maskOutputValue 후 JSON.stringify며 주석상 아직 소비하지 않는다. JSON escape 길이와 해석된 맥락 길이를 혼동하지 말고 emoji·NFD·마스킹으로 길어지는 치환·NUL 표시·생략 줄 자리까지 같은 순수 budget 함수로 context와 doctor가 공유해야 한다(`packages/core/src/output/codecs.ts:51`, :58; T3:126). AD-11의 text 모드 NUL escape는 현 encodeTextLine의 단순 mask 호출과 차이가 있으므로 11 이후 최종 출력 코덱을 확인하고 중복 구현하지 않는다(`packages/core/src/output/codecs.ts:68`; A:222).

시간대와 사용자 budget 설정은 DB settings port/키 검증을 쓰는 후보이고, DB 접속 전 필요한 stop_remind는 TOML에 남아야 한다. 설정 실패 시 대체 안내의 날짜/시간대를 어떻게 표시할지도 정해야 한다(T11:80; A:318; T3:102). SM-7은 내부 elapsed_ms와 프로세스 시작 포함 전체를 분리하여 환경·샘플 수·중앙값을 기록한다. spool의 내부값만으로 전체 지연을 주장할 수 없다(S3:47; A:311).

3.11은 install/recall을 교체하지 않고 기록·규칙·로그 관리 스킬을 추가한다. 규율 상수와 명령 메타에서 생성하여 커밋하고 재생성 parity·tested_against·코드블록 명령/flag를 검사하는 기존 요구는 유지한다. 13.7의 정적 검사에 생성물 검사 층을 얹고 가짜 CLI 행동 시험은 기본 suite 밖의 같은 진입점 계열로 둔다. case 후보는 정상 기록, 기록할 것 없음, quote 불일치, 규칙 edit 거절 안내, 명령 미구현, SPOOLED 성공/DB 오류 구별이다(T3:137; T13:80; T17:56). 실제 guide/명령 예시 검사와 런처 parity는 재사용 선례이며 생성 스킬 시험 자체가 이미 있는 것은 아니다(`apps/cli/test/guide.test.ts:93`; `tooling/bootstrap/test/plugin.test.ts:173`).

## 6. Spike 3.3과 위임 경계

명시된 기존 Decision은 3.3을 **사람 실측**으로 두며, 결과가 Stop 구현 방식을 정한다(E3:88). 최신 이니셔티브의 자동 로컬 설치/명령/doctor/배포 위임은 남은 V1 에픽을 이름으로 나열하고, V1 뒤 3은 같은 방식 재분할 대상으로 적혀 있다. 따라서 '3.3 hitl이 이미 false로 확정됐다'고 쓸 수 없다. 에이전트 수행으로 고칠 후보와 사람 판단을 남기는 후보를 분리해야 한다(E3:103; I:188, I:189, I:192, I:194; D:3).

에이전트가 할 수 있는 부분은 격리 홈/plugin fixture 준비, 두 hook 출력 payload·timeout 비교, `claude -p` 로컬 세션 실행, Stop 시 transcript 수와 나중의 최종 수 대조, 모델 추가 턴의 기계적 관측, parser 버전/표본/결과 기록이다. epic 12.12에 새 Claude Code 세션을 `claude -p`로 여는 선례가 있다(T12:139). 이는 실제 plugin 설치 경로를 사용한 증거여야 하며 가짜 CLI 결과만으로 실제 모델 재개를 대신할 수 없다(T3:32; E3:47).

사람에게 남길 수 있는 부분은 사용자 화면의 오류/피드백 체감과 실사용 중 억지 기록/방해 정도의 판단이다. 위임 해석을 확장해 자동 측정은 에이전트, 체감은 operator_actions로 분리하는 안 또는 기존 hitl spike를 유지하는 안이 있다. 원격 push는 위임에서도 사람 몫이며 로컬 배포를 그것 때문에 멈출 필요는 없다(I:189, I:192). 이 정적 조사에서는 어느 측정도 실행하거나 hitl을 변경하지 않았다.

## 7. stats show를 마지막 스토리로 받을 때

E5 Done when 6은 기간별 SM-4a(전체·적격)·SM-5·SM-C1·SM-C3·§8-8 대리 지표, text/JSON, import 기본 포함/옵션 제외, 0과 측정 불가 null+경고, 독립 SQL 일치를 요구한다. E5가 먼저인데 epic 3의 kind/elapsed_ms를 소비한다는 순서 충돌이 이미 적혀 있다(E5:40, E5:65, E5:73). **이전 확정이 아닌 후보**로 epic 3 끝 새 id에 수용하거나 epic 5의 해당 entry를 유지하고 epic 3 코드 story after를 걸 수 있다.

`--from`·`--to`는 날짜+설정 시간대를 반열린 UTC로 바꾸고 meta에 되울리는 계약이다. 지표에는 SM-7 내부 시간과 과거형 단서 이후 recall 여부 대리 지표, Stop 성공 뒤 같은 세션 로그 비율도 포함하며, 사람이 채점하는 SM-1·2·3·4b·6은 제외한다(E5:23). 입력은 기간과 시간대, 세션/ingest_source, 메시지·도구 메모, 로그의 사건 시각과 대체/규칙 상태, start/stop injection의 ok/code/chars/elapsed_ms, capture 누락을 잴 transcript 목록이다. recall 호출은 공용 Core 접두사 술어 하나, Stop 뒤 로그 비율 분모는 stop+ok=true, start 모집단 지표는 start만이다. 이미 17에서 만들어진 recall/sessions read 명령을 인식하되 MCP 이름은 데이터 판정의 호환 목록이며 MCP 서버 구현까지 확대하지 않는다(A:311; E5:65; T17:32).

범위는 집계 port/PG read/fake/계약·Core metric 함수·stats show CommandSpec/SDK/출력 코덱·기간/timezone/NULL 경계 fixture까지다. 백업·복구·export·원격 사본·2주 경과를 이 스토리에 넣을 근거는 없다(E5:40, E5:67; I:57). 독립 oracle은 제품 집계 함수를 재사용하지 않은 수작업 기대값과 직접 SQL이며, 0로그 기간·미측정 시간·transcript 없음·import 제외·기간 경계·StopFailure 제외를 구별해야 한다(E5:40, E5:65). 실제 2주 비교와 기본값 변경은 관측 후 판단이며 기본 false를 이 보고서에서 뒤집지 않는다(E3:75; A:307).

## 8. 파일 충돌 레인과 세션 크기

아래 새 모듈명은 후보이며 현재 존재한다고 뜻하지 않는다. 여러 작업을 병렬로 쪼개더라도 공용 목록은 한 조립 레인에서 순서대로 반영하는 안과 전체 한 줄 순서 안이 있다. 옛 epic 10 병합 예외를 새로운 epic 11/12 미완성 조립에 자동 적용하지 않는다(E3:91, E3:103; I:184).

| 레인/함께 고칠 파일 | 관련 story 후보와 충돌 |
|---|---|
| PG DDL·`packages/postgres/src/migrate.ts`·PG migration 시험 | 5·pending 증거·stats 읽기, 앞 에픽의 다음 core 번호/기대 버전. baseline checksum 고정 뒤 번호만 전진(T11:128; A:483) |
| `packages/core/src/ports/store.ts`, `brain.ts`, testing fakes/contracts export, PG Store 합성 | 4·6·7·8·14·10·stats 모두 연결. 공용 합성 수정은 같은 레인, SQL/use case는 능력별 모듈 후보(`packages/core/src/brain.ts:264`, :281; T11:20) |
| `domain/spool-record.ts`, `spool/replay.ts`, `ports/spool.ts`, `apps/cli/src/runtime/spool.ts` | 6 로그 record·14 injection·12 비파괴 조회. codec/종류/등록이 함께 배포되어야 함(`packages/core/src/domain/spool-record.ts:78`; `packages/core/src/spool/replay.ts:72`) |
| `apps/cli/src/dispatch.ts`, `assembly.ts`, `commands/index.ts`, guide schema·command meta | 4 only/읽기 경로·6/8/12·stats. PG factory/조기 반환/SDK 합성에서 충돌(`apps/cli/src/dispatch.ts:573`; `apps/cli/src/commands/index.ts:36`) |
| `packages/core/src/output/codecs.ts`, 규율/맥락 새 모듈, `guide.ts` | 2·9·10·11·12. budget/마스킹 원본 하나와 17 OutputProbe 변경 수용(`packages/core/src/output/codecs.ts:41`; T17:8; T3:126) |
| 설정 코덱·install flow·doctor | 9 크기/11.6 settings·12 토글·10 skip·stats. 기계/사용자 키 분리(A:318; T11:80; `packages/core/src/doctor/doctor.ts:158`) |
| plugin hooks·스킬·app-ref/version·bootstrap plugin 시험 | 4·11·12·15; 앞 install/recall 스킬 보존. ref/version은 최종 배포 한 곳(T3:160; T13:80; T17:56) |

고위험 크기는 4(두 CLI+Store+hook only+주입), 6(입력·선수집·spool·대체), 9(규칙 선택·budget·설정·성능), 12(토글·parser·spool 조회·표식 경쟁·시도·청소)다. 이전 검증도 같은 위험을 지적했고 이후 9/14와 12/15는 이미 분리됐다(V3:79; E3:96). 기존 결정상 4 tracer와 6 명령 완성은 유지하되 plan에서 한 경로의 최소 case로 제한하고, 실제 한 세션 초과가 확인되면 별도 새 id 선택지를 제시할 수 있다. 준비 DDL/메타를 tracer 안에 묶을지 앞 준비 story로 둘지도 같은 파일 충돌과 첫 관통의 크기를 보고 고르는 문제다(E3:96; T12:8).

## 9. Done when별 기존 시험 기반과 공백·이 Mac 확인

시험 파일을 읽은 기반이며 아래 어느 suite도 이번에 실행하지 않았다. PG 계약 runner와 격리 홈은 11.10, timer/clock·fake process는 12.1, 스킬 정적/행동 진입점은 13.7, 검색 fixture/실제 질문 private 기록 방식은 17.1·17.7을 받는 후보이다(T11:128; T12:8; T13:80; T17:8, T17:79).

| Done when(E3:39~47) | 기존 기반 | 빠진 증거 / 담당 후보 |
|---|---|---|
| 1 정확 규칙→다음 시작, 불일치 점검 | parser 공통 case 실행(`packages/claude-code/test/parser.test.ts:469`), output codec 경계(`packages/core/src/output/codecs.ts:72`) | log/rule PG 계약, NFC·NUL 원문·유일성·프로젝트 fixture와 실제 새 plugin 세션. 7·9·10·15 |
| 2 off 보존 | domain 주석은 계약 의도일 뿐(`packages/core/src/domain/log-entry.ts:5`) | off fixture 재대조 반복·set-state→drain·동시 off CAS. 7·8 |
| 3 대체와 두 사건 시각 | LogEntry 두 시각/supersedes 타입(:21, :42), PG FK/시각 칸(`packages/postgres/migrations/0001_initial.sql:99`) | 대체 종류/없는 id/중복 대체·동시성·edit 이전 문장 원자성·현재/이력 정렬. 6·8; 원문 검색은 4 경계 |
| 4 장애 중 SPOOLED와 무손실 복원 | spool port 계약(`packages/core/src/ports/spool.ts:120`), replay handler frame(`packages/core/src/spool/replay.ts:140`) | 로그 record 코덱·stdin byte 상한·PG 끊김/commit 응답 유실·동일 ID/occurredAt 재생. 6·11.7 기반 |
| 5 날짜·budget·시도·SM-7 | hook codec와 clock seam(`packages/core/src/output/codecs.ts:47`, :58) | 순수 맥락 렌더러·실패 fallback·생략/emoji/마스킹 길이·PG settings·start/stop 시도·내부/전체 실측. 9·14·15 |
| 6 doctor pending·크기·start 수 | DoctorReadStore·DB skip/등록 방식(`packages/core/src/doctor/doctor.ts:98`, :158, :173) | 집계 능력과 검사, 규칙만 초과 fail, 같은 budget 함수, DB 불가 skip, start/stop 혼합 fixture. 10 |
| 7 hook 무쓰기·spool→drain | 현재 drain replay 진입(`packages/core/src/brain.ts:443`), hook drain 제외(`apps/cli/src/dispatch.ts:694`) | PG READ ONLY/spy에서 migration·write·addWork·drain 0회, FK 대기/만료·멱등·spool 실패. 4·14 |
| 8 규율·스킬·token | guide 실제 registry 메타 검사(`apps/cli/test/guide.test.ts:93`), node finder parity(`tooling/bootstrap/test/plugin.test.ts:173`) | 실제 context/Stop renderer까지 OutputProbe 확장, 생성물·tested_against·flags parity·가짜 CLI 행동. 2·4·11 |
| 9 설치 plugin Stop 동작/음성 조건 | 실제 plugin SessionStart harness(`tooling/bootstrap/test/hook.test.ts:163`), Stop 수집 case(:284) | remind 자체는 없음. 토글/표식/발화/spool 존재/없는 세션/재진입/DB 중단·timeout·start/stop drain·모델 추가 턴 관측. 3·12·15 |

Mac에서 에이전트가 수행 가능한 증거는 로컬 app-ref/version 배포, 격리 PG/Brain 홈과 실제 plugin 스킬 발견, 명령/doctor/DB 행/시도 ID 대조, `claude -p` 새 세션, elapsed 측정, DB 중단·재연결 fixture, 체크리스트 기록이다. 설치/실측은 이 정적 조사 권한 밖이라 실행하지 않았다(I:189; T12:139; T17:79). 사람만 할 수 있는 것은 원격 push 및 실사용자 체감/분석 품질 판단이며, 3.3의 hitl 변경은 §6의 결정 범위 대조를 거쳐야 한다(I:192; E3:88). 실제 개인 발화/로그·transcript 원문은 공개 plan에 넣지 않고 private 검증 기록에 두며 공개에는 중립 case id·결과만 남기는 17.7 방식을 재사용할 수 있다(T17:79).

## 스토리 후보

아래는 tracer와 순서의 **선택지**이며 새 tickets.toml이나 Decision을 만들지 않는다. id는 영구이므로 같은 책임을 갱신하면 기존 id를 고쳐 쓰고, 책임이 없어지면 drop, 완전히 새 산출물에만 미사용 id(예: 16부터)를 배정한다. 13은 drop 유지한다(T3:1; E3:99, E3:103).

| 후보·기존 id | tracer/범위와 순서 후보 | 고칠 파일 후보 |
|---|---|---|
| 경계 보강 1·규율 원본 2 | PG 기준선 이후 병렬 가능한 준비. 앞 에픽이 경계 해결했으면 1은 중복 구현 없이 증거 정리 후보(T11:140; T3:7) | `packages/second_brain/test/boundaries.test.ts`, `packages/core/src/guide.ts`, 새 `discipline` 모듈·guide 시험 |
| PG tracer 4 | 진행 한 줄→동기 다음 시작, 고정 날짜/토큰, only 메타·읽기 무쓰기. 첫 관통을 PG의 기존 표로 만들고 5의 증분 DDL은 뒤에 두는 기존 순서 안(T3:43; T3:58) | Core log/context use case·port·PG/fake/계약, `brain.ts`, CLI assembly/dispatch/commands/guide schema, hooks.json·통합 시험 |
| 증분 schema 5 | 11.2/10 완료 baseline 차이 확인 후 다음 core migration. 7의 인용 보존을 여기서 선결(T11:32, T11:128; T3:55) | `packages/postgres/migrations/` 새 파일, migration 시험, domain/context-injection, 증거 타입 |
| append 6 | 네 종류·선수집·로그 spool·대체 완성. tracer 다음, 규칙은 pending까지. 5의 증거 저장이 필요해지면 해당 부분만 선행(T3:67) | 새 log append/유효성 모듈, store/PG/fake/계약, spool codec/replay, codes, CLI append, FR-20 문서 |
| 대조 7 → 관리 8 | pending 증거·core 재대조 일감 후 list/edit/state/scope. off fixture는 8 없이 7에서 검증(T3:79, T3:91; V3b:27) | 새 rule verifier/recheck handler, session 수집 일감 연결, PG log verb·증거 DDL 소비, CLI 관리 명령·계약 |
| 맥락 9 → 주입 14 | 9가 규칙/최근 로그·budget/settings·fallback·SM-7, 14가 start/stop spool/재생·FK 보존. 주입 runtime 작업화는 §3 두 안 중 선택(T3:102, T3:114) | 새 context renderer/budget, settings 키·코덱, injection spool/PG/fake/계약, `brain.ts`·spool runtime |
| doctor 10·스킬 11 | 10은 9+14 뒤, 11은 2+8+13.7+17.5 뒤 가능. 생성물 검증과 행동 시험 분리(T3:126, T3:137; T13:80) | Core doctor/PG 집계/skip, output probe, 생성 script·plugin/skills 기록 스킬·parity/행동 시험 |
| spike 3 → Stop 12 | spike는 기존 사람 책임 유지 또는 자동 측정+사람 체감 분리 두 안. 12는 결과·14를 받고 동작/조회/표식/청소, 배포는 15(T3:31, T3:148; E3:88, E3:96) | spike private 측정+공개 plan, 새 remind/marker port·Node runtime, parser hook payload, settings TOML/install 보존, core handler·hooks.json·시험 |
| 설치 확인 15 | 로컬 app-ref/version 한 번, start/stop 조건별 실제 plugin·스킬 확인. 원격만 operator_actions 후보(T3:160; I:189) | `plugin/app-ref`, `plugin/.claude-plugin/plugin.json`, 설치 검증 plan·체크리스트 |
| stats 새 16 후보 | 14/12/10/17.5 뒤 집계 한 명령; 15 전이면 설치 검증에 함께 포함, 뒤면 통계 별도 확인. 또는 E5에 유지하고 entry after로 이동(E5:73) | 새 stats port/PG/fake/계약·Core metric 함수·CLI stats/registry/SDK·guide/output fixture, 양 에픽 범위 문서 |

순서 안 A는 `1·2 → 4 → 5/6 → 7 → 8 → 9 → 14 → 10/11`, 별도 `3 → 12`, 마지막 `stats 후보 → 15`다. 공용 조립 파일 충돌을 줄이려면 같은 순서를 한 줄로 펴는 안 B가 있다. 새 작업 runtime 통합 자체가 tracer 크기를 넘으면 별도 미사용 id로 metadata/읽기 경로 준비를 앞에 둘 수 있으나, 4의 '한 줄이 다음 시작에 보임' 관통과 기존 4/6 유지 Decision은 지킨다(E3:96; §8 근거 표). 자동 sweep 13을 복구하거나 이 조사만으로 새 id/after/hitl을 확정하지 않는다(E3:99, E3:103).
