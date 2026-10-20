- source_plan: `_bmad-output/personal-brain/epic-foundation-and-install/story-trigger-plan.md`
  summary: runMigrations가 도달 가능한 DB의 마이그레이션 실패(SQL 오류 등)를 DB_UNAVAILABLE과 구분해 돌려주도록 한다(story 5 setup run에서 사람에게 보일 때).
  evidence: 리뷰 재현 — 충돌 테이블이 있는 DB에서 `relation "workspaces" already exists`가 `DB_UNAVAILABLE`로 보고됨. story 1.3의 frozen Boundaries가 그렇게 정해 이번엔 바꾸지 않음.
- source_plan: `_bmad-output/personal-brain/epic-foundation-and-install/story-trigger-plan.md`
  summary: redactions(및 log_entry_edits·context_injections·index_configs)처럼 Table Contract상 불변인 테이블에도 변경 거부 trigger를 둘지 결정한다.
  evidence: 마이그레이션된 DB에서 `update/delete/truncate redactions`가 성공함. AD-11은 trigger 대상을 messages·tool_notes로만 명시.
- source_plan: `_bmad-output/personal-brain/epic-foundation-and-install/story-trigger-plan.md`
  summary: transcript_files.size_bytes(bigint)를 node-pg가 문자열로 돌려주므로 adapter에서 number로 변환하거나 컬럼을 integer로 줄인다.
  evidence: TranscriptFile.sizeBytes는 number인데 pg는 int8을 string으로 파싱. 아직 이 컬럼을 읽는 코드가 없음.
- source_plan: `_bmad-output/personal-brain/epic-foundation-and-install/story-untitled-plan.md`
  summary: tickets.toml의 story 5 설명("pnpm@12.10.1이 없으면 설치를 묻고")을 고정 해제 결정(12 이상, 없으면 최신 설치)에 맞게 고친다.
  evidence: 2026-10-13 사용자 결정으로 packageManager 고정을 풀었고 architecture·epic Notes는 고쳤으나, 빌드는 티켓 파일에 쓰지 않으므로 tickets.toml이 남음.
- source_plan: `_bmad-output/personal-brain/epic-foundation-and-install/story-sqlite-store-plan.md`
  summary: 루트 `engines.node: >=24.16.0` 하한을 실제로 강제한다(진입점 gate 또는 doctor의 실행 중 node minor 점검).
  evidence: 진입점 `MIN_NODE_MAJOR = 24`는 major만 보고, pnpm 12.11.2는 루트 engines를 강제하지 않음을 실측했다(>=24.99.0 프로젝트가 exit 0). Node 24.0~24.15에서는 node:sqlite가 RC가 아니고 randomUUIDv7이 없다. story 8 doctor의 node 하한 항목이 자연스러운 자리.
- source_plan: `_bmad-output/personal-brain/epic-foundation-and-install/story-sqlite-trigger-plan.md`
  summary: Postgres 복제 대상의 `brain_reject_mutation`이 `tool_notes` UPDATE를 모두 거부하므로, 원본(SQLite)에서 가린 `tool_notes.target`을 복제할 수 있게 Postgres trigger·가리기 함수를 맞춘다(epic 7).
  evidence: `packages/postgres/migrations/0001_initial.sql`의 trigger는 `tg_table_name = 'messages'`일 때만 우회를 허용한다. AD-11은 `messages.redact`가 tool_notes.target도 함께 가린다고 정한다. story 1.11 리뷰에서 발견.
- source_plan: `_bmad-output/personal-brain/epic-foundation-and-install/story-untitled-12-plan.md`
  summary: `files.redact`가 남길 `redactions` 기록 자리를 만든다(`message_id` nullable + `file_id`, 파일 가리기는 `start`/`end` 없음) — `files.redact`를 만드는 epic 2가 다음 마이그레이션으로.
  evidence: AD-23은 파일 가리기가 `redactions`에 기록을 남긴다고 하지만 0001(SQLite·Postgres 모두)의 `redactions.message_id`는 not null이고 `start`/`end`가 필수다. story 1.12 티켓 범위에 없어 사용자 결정(2026-10-14)으로 미뤘다.
- source_plan: `_bmad-output/personal-brain/epic-foundation-and-install/story-untitled-12-plan.md`
  summary: Postgres 복제본의 `index_configs`를 원본(SQLite 0002)에 맞춘다 — `kind`에 `document_chunk`, kind별 `chunk_params` 모양, 기본 `document_chunk` 행(epic 7).
  evidence: `packages/postgres/migrations/0001_initial.sql`의 `index_configs_kind_check`는 `('chunk','embedding')`뿐이고 세 키 CHECK도 없다. story 1.12 리뷰에서 지적 — 8개 새 테이블 외에 기존 테이블 하나도 갈라졌다는 기록이 없었다.
- source_plan: `_bmad-output/personal-brain/epic-foundation-and-install/story-untitled-12-plan.md`
  summary: `message_attachments`(자리·출처 불변, `file_id`·상태 한 번 채움), `document_extractions`(상태만 진행), `document_chunks`, `file_names`, `file_metadata`의 Table Contract 변경 규칙을 trigger로 강제할지 — story 11이 미룬 `redactions` 등과 같은 결정으로 함께 정한다.
  evidence: 0002는 플랜의 의도적 결정(AD-11의 범위)으로 `files`·`file_locations`에만 변경 거부 trigger를 둔다. story 1.12 리뷰에서 그 결정이 기록되지 않았음을 지적.
- source_plan: `_bmad-output/personal-brain/epic-foundation-and-install/story-untitled-12-plan.md`
  summary: 문서 조각 세대가 어떤 `index_configs` 행(`document_chunk`)으로 만들어졌는지 가리키는 칸(`document_extractions.index_config_id`가 자연스러움)을 epic 4가 문서 조각을 만들 때 `alter table add column`으로 더한다.
  evidence: 0002의 `document_chunks`·`document_extractions`에는 `index_config_id`가 없어 기본 `document_chunk` 행을 가리키는 것이 없고, params를 바꾼 두 세대를 구별할 수 없다(`chunks`는 `index_config_id`를 키에 넣는다). story 1.12 리뷰 발견. 지금은 읽는 코드가 없어 칸 추가를 미뤘다.
- source_plan: `_bmad-output/personal-brain/epic-foundation-and-install/story-untitled-13-plan.md`
  summary: `setup run`이 읽을 수 없는 값이 하나 있는 config를 만나면 묻지 않는 값(timezone, `files.path`, `mirror.path`)까지 기본값으로 되돌린다.
  evidence: `install.ts`의 config.read가 `readConfig` 실패를 모두 `undefined`로 바꾼다. 리뷰어가 상대 `store.path` + 사용자 지정 files/mirror로 재현했다. `files.path`는 질문도 플래그도 없어 되돌릴 수 없다. epic 2가 블롭을 쓰기 전에 부분 읽기 결과가 필요하다.
- source_plan: `_bmad-output/personal-brain/epic-foundation-and-install/story-untitled-13-plan.md`
  summary: 디스패처의 hook→`BUSY_TIMEOUT_MS.turn` / 그 밖→`.command` 분기를 검사하는 테스트가 없다.
  evidence: `apps/cli/test`에 BUSY_TIMEOUT 단정이 없어, 두 값을 바꿔도 테스트가 통과한다. store 팩토리 주입 seam이 필요하다(story 9 refactor sweep 후보).
- source_plan: `_bmad-output/personal-brain/epic-foundation-and-install/story-untitled-13-plan.md`
  summary: 설치기가 `CONFIG_UNKNOWN_KEY` 경고를 보이지 않고, config를 다시 쓰면서 모르는 키를 조용히 지운다.
  evidence: `setup run --yes`를 `[database] url_env`가 있는 config 위에서 돌리면 경고 없이 키가 사라진다(리뷰어 재현). AD-18은 모르는 설정이 조용히 사라지는 것을 막으라고 한다.
- source_plan: `_bmad-output/personal-brain/epic-foundation-and-install/story-doctor-plan.md`
  summary: Core `checkSchema`의 불일치 메시지가 아직 없는 명령 `brain setup upgrade`(epic 5)를 안내한다.
  evidence: story 3부터 있던 문구다. 이번 변경으로 doctor의 `schema-version` 항목이 이 문구를 사용자에게 보여 준다. 등록된 명령은 admin doctor·setup run·setup connect뿐이다. epic 5가 upgrade를 만들 때까지는 `brain setup run`으로 안내하거나, 그때 함께 맞춘다.

- source_plan: `_bmad-output/personal-brain/epic-capture/story-untitled-plan.md`
  summary: 쓰기 가드의 `DB_UNAVAILABLE` 실패가 exit 1로 남아 있다 — Conventions 표는 이 코드를 2로 적는다. 둘 중 하나를 맞춘다.
  evidence: `apps/cli/src/dispatch.ts`의 쓰기 가드가 `exit: 1`을 명시해 `ERROR_CODES.DB_UNAVAILABLE.exit = 2`를 덮는다. story 2.1의 frozen Boundaries가 "기존 실패의 exit는 지금과 같다"로 정해 이번엔 바꾸지 않았다. epic 2가 이 거부를 spool로 바꾸면 실패 자체가 사라질 수 있어 그때 함께 정한다.
  resolution: 해결됨(2.10, 2026-10-19). 쓰기 가드에서 `exit: 1`과 그 주석을 지웠으므로 거부는 코드 표를 따른다 — `DB_UNAVAILABLE`은 2, `SCHEMA_MISMATCH`는 1이다. `spool` 갈래를 선언한 명령은 애초에 거부되지 않고 표시를 남기며 성공한다.

- source_plan: `_bmad-output/personal-brain/epic-capture/story-tracer-stop-hook-brain-db-plan.md`
  summary: `TRANSCRIPT_UNREADABLE`·`SESSION_NOT_FOUND`를 Core `ERROR_CODES`(exit·retryable·hint)와 spine Conventions 오류 코드 목록에 넣을지 정한다.
  evidence: 두 코드는 epic 1부터 parser·store port의 실패 코드였지만 표에 없다. story 2.2의 `sessions ingest`가 처음으로 둘을 명령 실패로 내보내고, `errorEnvelope`가 표에 없는 코드를 `exit_code: 1`·hint 없음으로 만든다. hook 경로는 엔벨로프를 버리므로 지금은 보이지 않는다. SDK와 `guide exit-codes`(문서 대조 테스트)가 생길 때 드러난다. 2.3(명령 메타) 또는 guide 스토리가 자연스러운 자리다.

## Triage (2026-10-16, epic 2 인셉션)

위 항목은 빌드가 append-only로 쓴다. 이 표는 각 항목의 현재 처분이다(epic 1 회고 Action 4). "story"는 epic-capture `tickets.toml`의 entry id다.

| 항목 | 처분 |
| --- | --- |
| runMigrations 실패를 `DB_UNAVAILABLE`과 구분(Postgres) | epic 7(복제 대상의 Postgres 마이그레이션) |
| `redactions` 등 불변 테이블의 변경 거부 trigger | `redactions`: 해결됨(2.6, 0004 `redactions_immutable_update`·`_delete`). `log_entry_edits`·`context_injections`: epic 3. `index_configs`: 두지 않음(setup만 쓴다) |
| `transcript_files.size_bytes` bigint(Postgres) | epic 7 |
| `tickets.toml` story 5의 pnpm 문구 | 해결됨(epic 1 마무리) |
| 루트 `engines.node` 하한 강제 | doctor 하한은 해결됨(1.8). 진입점 하한은 epic 2 story 5(회고 F7) |
| Postgres의 `tool_notes` 가리기 | epic 7 |
| `files.redact`의 `redactions` 자리 | 해결됨(2.6, 0004의 `redactions.file_id`, 위치 없음). 동작은 epic-attachments |
| Postgres `index_configs` 맞춤 | epic 7 |
| 0002 새 테이블 5개의 변경 규칙 trigger | epic-attachments 인셉션 |
| `document_extractions.index_config_id` | 해결됨(2.6, 0004, nullable). 문서 조각은 epic-attachments가 만든다 |
| `setup run` 부분 읽기 리셋 | epic 2 story 4 |
| busy 예산 분기 테스트 | 해결됨(1.9) |
| 설치기가 모르는 키를 지움 | epic 2 story 4 |
| `checkSchema`의 `setup upgrade` 문구 | 해결됨(1.9) |
| 쓰기 가드의 `DB_UNAVAILABLE` exit 1 vs 표 2 (2.1) | 해결됨(2.10, 2026-10-19). 거부는 코드 표의 종료 코드를 따르고(`DB_UNAVAILABLE` 2, `SCHEMA_MISMATCH` 1), `spool` 갈래가 있는 명령은 거부되지 않는다 |
| Postgres가 0004만큼 더 갈라짐(`messages.git_branch`·`is_subagent_report`와 불변 trigger, `files.source_unreachable_at`, `document_chunks.chunk_locator`와 trigger, `redactions` 재생성·불변 trigger, `document_extractions`의 `attempt`·`failed_stage`·`index_config_id`·키, `failures` 대상 키, `work_items_due_idx`) | epic 7(2.6 리뷰, 2026-10-18). 0005(`redactions.tool_note_id`와 세 대상 check·`redactions` 재생성, `document_extractions`의 `failed_stage` trigger 둘, `projects` 재생성과 `identity_key`, `failures.first_occurred_at`·`occurrences`, `tool_notes.call_id`와 `tool_notes_call_id_idx`·불변 trigger 교체)도 epic 7(2026-10-19, 자리는 2026-10-20에 생김) |
| Core `Failure` 타입이 0004에서 없어진 `harness_session_id`를 키로 적음(`packages/core/src/domain/failure.ts`). `Redaction`·`Message`도 새 칸이 없음 | `Failure`: 해결됨(2.11, 대상 키 `targetKind`·`targetId`와 nullable `harness`). `Redaction`: `patternVersion`만 해결됨(2.9). 아직 `messageId: string`·non-null `start`/`end`라 0004의 파일 가리기(`file_id`, 위치 없음)를 표현하지 못한다 — `fileId` 추가와 `messageId`·`start`·`end` nullable화는 `files.redact`를 만드는 epic-attachments. `toolNoteId`는 story 13(18의 칸을 처음 쓸 때, 2026-10-19). `Message`: story 7(2.6 Decision, 2026-10-18) |
| 도구 메모 대상을 가린 기록 자리가 없음 | 자리는 해결됨(18, 2026-10-20, 0005의 `redactions.tool_note_id`: 대상 셋 중 정확히 하나이고 위치는 그 `target` 위의 반열림 구간). 쓰는 쪽은 story 13(`messages redact`)이다 — Core `Redaction`에 `toolNoteId`가 없고 아무도 이 칸에 넣지 않는다. 2026-10-19: 마스킹 B로 수집은 도구 메모 대상을 가리지 않는다(원문 저장). 기록이 필요한 것은 2.13의 저장본 가리기뿐이다. (이전 처분: epic-attachments 또는 epic 7과 함께(다음 마이그레이션). 0004의 `redactions` 행은 대상이 `message_id`·`file_id` 둘뿐이고 위치는 **본문** 위의 구간이라, 가려진 `tool_notes.target`을 가리킬 칸이 없다. 2.9는 대상의 값을 가리되 기록은 남기지 않는다(Decision 2026-10-18). 넣으려면 0005에 `redactions.tool_note_id`를 더하고 위치를 그 대상 위의 구간으로 정의해야 한다) |
| `messages redact`(2.13)가 같은 문제를 만난다 | 2026-10-19: story 18(자리)과 story 13(쓰기). 이전 처분: epic 2 story 13. AD-11은 `messages.redact`가 `tool_notes.target`도 함께 가린다고 정하는데, 그 가리기 역시 남길 행이 없다. 위 항목과 한 번에 결정한다(2.9, 2026-10-18) |
| 2.9 deferred: 영어 키워드 과잉 가림, 한국어 표현 놓침 (`story-untitled-9-plan.md` frontmatter) | 해결됨(2.17, 2026-10-20, `SECRET_PATTERN_VERSION = '2'`). 과잉 가림: 영어 키워드의 **따옴표 없는** 값에 모양 규칙 셋 — 호출(`parse(input)`), 숫자만(`{"token": 123}`), 영문자 단어 뒤에 또 영문자 단어(`see the README`)는 가리지 않는다. 놓침: 한국어 구분자에 조사(`은는이가을를도`)와 공백을 더해 `비밀번호 X`·`비밀번호가 X`를 잡는다. 값 끊김: 값 문자 집합이 `!`·`?`·`.`·`:`·괄호를 품고 공백·따옴표·`,`·`;`·전각 구두점·한글에서만 멈추며, 끝의 짝 없는 닫는 괄호는 뗀다. (이전 처분: epic 2 story 17(마스킹 B에서 패턴 버전 2로, 값 끊김 포함, 2026-10-19)) |
| auto-build 커밋을 이력에서 빼기 (2026-10-18) | push 전, 사용자(티켓 밖). 끝나면 `app-ref`·`version`·`baseline_revision`·커밋 번호를 다시 맞춘다 |
| 무인 루프 v2가 커밋을 기다리지 않음 (2026-10-18) | 저장소 밖 도구. 2.10~를 무인으로 돌리기 전에 고친다 |
| 2.7 follow-up 리뷰 (2026-10-18) | 리뷰 끝남(2026-10-20, `epic-capture/story-transcript-parser-follow-up-review.md`, 지적 21건). 수정은 epic 2 story 21(수집 경로 보강)·22(보고 판정·출처, "has not reported yet" 포함)·23(parser v4)과 17·18 보강이 맡는다 |
| 2.7 follow-up 리뷰 #21: 500자로 자른 도구 메모 대상 끝에 걸친 키 조각 | 해결됨(2.17, 2026-10-20). 상한이 Core 상수 `TOOL_NOTE_TARGET_LIMIT`가 되고(`TOOL_TARGET_LIMIT`가 그 값을 쓴다), 출력의 `maskToolNoteTarget`이 상한에 닿은 대상의 마지막 토큰을 `[REDACTED:truncated]`로 가린다(토큰의 시작은 마지막 공백 뒤와 마지막 가린 표시의 끝 중 더 뒤쪽, 길이 0이면 가리지 않음). 저장본은 그대로다 |
| 출력 가리기의 남은 위험 (2.17, 2026-10-20) | 셋 다 받아들인 대가다. (1) 출력 가리기는 패턴이 아는 것만 가리고, 저장소 파일(`brain.db`·`-wal`·`-shm`)에는 비밀이 원문으로 남는다 — 지키는 것은 AD-10(권한 0600, 동기화 폴더 금지)이고, 저장본에서도 지우려면 `messages redact`(2.13)다. (2) 잘린 꼬리 규칙은 상한에 닿은 대상의 마지막 토큰이 평범한 단어여도 가린다(출력에서만). (3) 영어 키워드의 따옴표 없는 값 중 모양 규칙에 걸리는 것은 가리지 않는다 — 숫자만인 값(`password: 1234`), 영문자만이고 같은 줄에 영문자 단어가 뒤따르는 값(`secret: hunterpass and done`), 그리고 후속 리뷰로 더한 자리 표시·상태 값(`ok`·`null`·`***`·`<...>`·`$NAME` 모양이면 진짜 비밀이어도 가리지 않는다). 한국어도 같은 쪽으로 좁혔다(후속 리뷰, 2026-10-20) — `암호`는 공백 구분자를 더는 받지 않으므로 "암호 Tiger2024"는 가려지지 않고(`암호: `·`암호가 ` 형태는 그대로 가린다), `비밀번호`·`패스워드`의 공백 형태도 영문자만인 값 뒤에 같은 줄의 단어가 이어지면 가리지 않는다("비밀번호 input 필드"가 문장이기 때문이다) |
| 출력에 패턴 버전 도장이 없음 (2.17 후속 리뷰, 2026-10-20) | 오래 남는 출력을 쓰는 에픽이 맡는다 — 미러 파일·복제 payload·내보내기는 가린 결과와 함께 `SECRET_PATTERN_VERSION`을 적어야 한다(AD-11, 기록은 `pattern_version`을 남기는데 출력은 아무것도 남기지 않는다). 지금 출력은 한 번 읽고 사라지는 줄과 엔벨로프뿐이라 어느 버전이 가렸는지 되물을 자리가 없다. epic-recall-and-mirror·epic-replicas·epic-operations |
| 포트 계약에 "`redactions` 행은 있는 메시지를 가리킨다"가 없음 (2.17 후속 리뷰, 2026-10-20) | story 2.13(`messages redact`)이 그 계약 사례를 넣는다. 2.17이 수집의 기록 쓰기를 없애면서 그 사례도 지웠고(쓰는 쪽이 사라졌다), 지금 그 규칙을 지키는지 보는 것은 SQLite의 외래 키 사례 하나뿐이다(`packages/sqlite/test/session-store.test.ts`) — 다른 adapter는 계약만으로는 확인받지 않는다 |
| 잘린 꼬리 규칙이 자름을 길이로 추정함 (2.17 후속 리뷰, 2026-10-20) | `tool_notes`에 잘림 표시 칸이 생기면 그것을 읽는다 — story 18의 0005나 23(parser v4)이 자리다. 지금은 저장된 대상의 UTF-16 길이가 상한과 같으면 잘린 것으로 보므로, 마침 정확히 500자인 멀쩡한 대상도 끝 토큰을 잃는다(출력에서만). 첫 줄 자르기(`split('\n')[0]`)로 둘로 나뉜 비밀은 이 규칙 밖이다 — 뒷부분이 다음 줄에 있어 저장되지 않고, 앞부분은 상한에 닿지 않으므로 그대로 나간다 |
| 도구 메모를 돌려주는 앞으로의 읽기 (2.17 후속 리뷰, 2026-10-20) | 읽기 동사·미러·MCP 읽기는 저장본을 `sessionForOutput`(`packages/core/src/output/mask.ts`)에 먼저 걸어야 한다. 셸 `NAME=value` 규칙과 잘린 꼬리는 `target` 칸에만 거는 규칙이고, 완성된 답을 걷는 코덱은 어느 문자열이 그 칸에서 왔는지 더는 알 수 없다. 지금 그 함수를 부르는 것은 등록된 코덱 셋뿐이고, 그것을 잊은 읽기를 잡아 줄 검사는 없다 — 읽기 동사를 만드는 epic-recall-and-mirror가 자리다 |
| 백업 브랜치 `backup/pre-path-rewrite-2026-10-18` | push 전에 지운다(사용자) |
| 비정상 종료로 남은 `.open` 회수 (2.10) | 해결됨(2.12, 2026-10-19). `claim`이 할 일이다: 이름의 pid가 살아 있지 않고 mtime이 `SPOOL_CLAIM_STALE_MS`보다 오래된 `.open`은 `spool/failed/`로 옮기고 재주입하지 않는다(쓴 쪽이 이미 실패로 답한 쓰기다, Decision 6) |
| 업그레이드 경로 correct-course: 마이그레이션 완료 뒤 전환·실패 시 재시도·마이그레이션 승인 (2.10) | AD-19·20을 바꾸는 입력. bootstrap 2.5·shim·`setup upgrade`(epic 5)에 걸리므로 correct-course로 먼저 본다(2026-10-19 사용자) |
| spool `failure` 레코드 재주입 handler (2.11) | 해결됨(2.12, 2026-10-19). `createBrain`의 spool handler 표에 `failure` 항목: payload 그대로 `recordFailure`, id는 레코드 id, `closeWork` 없음 |
| 데몬 켜짐 예외: 기회적 drain 끄기 (2.11) | epic-daemon(epic 9, 소켓 handshake가 생길 때) |
| 같은 실패 키의 `occurred_at`·`message` 갱신 여부 (2.11) | 해결됨(2.11, 2026-10-19 사용자) |
| 2.14: `SECOND_BRAIN_CAPTURE` 스위치를 없애고 트랜스크립트 폴더를 기본으로 켠다 (2.12) | epic 2 story 2.14(플러그인 hook 등록과 같은 자리) |
| 옛 handback(`handbackReportText` 없음)의 본문 출처 (19) | epic 2 story 22(보고 판정·출처)에 합침(2026-10-20). 넣을지와 규칙은 22가 정한다 |
| 버전이 올라도 크기가 같은 파일은 스캔이 다시 큐에 넣지 않는다 (19) | 미정. 2.14(폴더 스캔을 기본으로 켤 때)가 자연스러운 자리다. 23(parser v4)도 버전을 올리지만 실제 수집 전이라 다시 읽을 저장 세션이 없다(2026-10-20) |
- source_plan: none
  summary: 옛 무인 루프 스크립트(`tooling/dev/auto-build.sh`)를 넣은 커밋(`10a09d2`)을 지우는 커밋이 아니라 그 커밋을 빼고 다시 쌓는 방식으로 이력에서 뺀다(`git rebase --onto 10a09d2^ 10a09d2 main`, 시작 전 백업 브랜치).
  evidence: 2026-10-18 사용자 결정. 그 뒤 해시가 다시 바뀌므로 `plugin/app-ref`(AGENTS.md 규칙대로 version도 함께), plan의 `baseline_revision`, 문서의 커밋 번호를 다시 맞춘다. 원격에는 첫 커밋뿐이라 push 전에 해야 한다. dev-workflow 저장소에서는 같은 일을 이미 끝냈다.
- source_plan: none
  summary: 무인 루프 v2(`~/.local/share/auto-build/auto-build.sh`, 저장소 밖)가 plan이 built가 된 뒤 커밋을 기다리지 않아 "작업 트리 더러움"으로 멈추는 버그를 고친다.
  evidence: 2026-10-18 실행에서 관찰. 루프는 이 저장소의 티켓을 돌리므로 2.10~2.15를 무인으로 돌리기 전에 고친다.
- source_plan: none
  summary: 리뷰 끝남(2026-10-20) — 지적 21건은 `epic-capture/story-transcript-parser-follow-up-review.md`에 있고, 수정은 epic 2 story 21·22·23과 17·18 보강이 맡는다(epic-capture Notes 2026-10-20 Decision). 원래 질문: brain 2.7(parser) follow-up 리뷰를 한 번 더 돌린다. story 19가 알려진 빈틈(`SubagentHandback`으로 끝난 서브에이전트의 보고가 peer user 줄로 와서 parser v2가 버렸다)은 고쳤지만, story 19의 리뷰는 그 diff 하나를 빠른 렌즈로 본 것이고 2.7의 다른 규칙을 다시 본 것이 아니다.
  evidence: 2026-10-18 결정 검토에서 peer handback 누락(보고 약 58%)이 나왔다. 2026-10-19 실측(이 Mac의 메인 transcript 208개, 구조와 건수만)으로 다시 세면 수정 전 누락은 65.8%였고, parser v3가 handback 줄을 보고로 읽고 같은 자리에 남는 안내 문장("Read it there")을 더는 저장하지 않는다. 그 리뷰에서 같은 계열의 두 번째 빈틈이 나왔다 — `<result>`가 "This agent has not reported yet: …will deliver its report through SubagentHandback when that finishes."뿐인 task-notification은 아직 보고로 저장된다(story 19 plan frontmatter의 `deferred`로 미뤘고 고치지 않았다). 그래서 이 항목은 열려 있다: 2.7의 나머지 규칙(안내 문장 계열 전체, 도구 메모, 커서)을 다시 보는 일이 남았다. v3 뒤에도 남는 옛 handback 본문과 폴더 스캔 항목은 아래 새 항목 둘로 떼어 두었다.
- source_plan: `_bmad-output/personal-brain/epic-capture/story-spool-db-plan.md`
  summary: 해결됨(2.12, 2026-10-19) — `claim`이 할 일 앞에서 회수한다: 이름의 pid가 살아 있지 않고 mtime이 `SPOOL_CLAIM_STALE_MS`보다 오래된 `.open`은 `spool/failed/`로 옮기고 다시 넣지 않으며(Decision 6: 반쯤 쓰인 마지막 줄이 있을 수 있고, 쓴 쪽은 이미 실패로 답했다) doctor의 `spool` 줄이 그 건수를 보인다. 원래 질문: 비정상 종료로 남은 `<home>/spool/*.jsonl.open` 파일을 회수한다.
  evidence: 2.10은 `.open`을 절대 claim하지 않는다(쓰는 중인 파일을 반쯤 읽는 것을 막는다). 그래서 append 도중에 죽은 프로세스가 남긴 `.open`은 영원히 남고, doctor의 `spool` 건수에도 들어가지 않는다. 회수 규칙(mtime 기준 유예 뒤 `.jsonl`로 돌릴지, `spool/failed/`로 옮길지, 마지막 줄이 깨졌을 때 어떻게 할지)은 drain과 일부 줄 다시 쓰기가 있는 story 11·12에서 정하는 것이 자연스럽다.
- source_plan: `_bmad-output/personal-brain/epic-capture/story-spool-db-plan.md`
  summary: 업그레이드 경로를 correct-course로 다시 본다 — 마이그레이션이 끝난 뒤에만 새 빌드로 전환하고, 실패하면 마이그레이션부터 다시 하며, 업그레이드 때 사람의 마이그레이션 승인을 받는다.
  evidence: 2026-10-19 사용자 결정. 스키마 불일치는 고칠 대상이고 고치는 길은 업그레이드 경로의 마이그레이션이며, 2.10의 spool은 그 전까지 남는 틈을 받치는 안전망일 뿐이다. 이 셋은 AD-19·20을 바꾸는 일이라 스토리 안에서 하지 않는다. 닿는 곳은 bootstrap(2.5), shim, `setup upgrade`(epic 5)다.
- source_plan: none
  summary: 이력 다시 쓰기 전 백업 브랜치 `backup/pre-path-rewrite-2026-10-18`(로컬)을 push 전에 지운다.
  evidence: 옛 커밋에 실명 경로가 남아 있다. 원격에 올라가면 안 된다. 이력 다시 쓰기는 2026-10-18 `24f0063` 앞에서 끝났다.
- source_plan: `_bmad-output/personal-brain/epic-capture/story-drain-plan.md`
  summary: 해결됨(2.12, 2026-10-19) — `createBrain`이 handler 표에 `failure`를 넣는다: payload 그대로 `recordFailure`, id는 레코드 id, `closeWork` 없음(청구는 이미 만료되었고 다음 drain이 그 일감을 다시 만난다). 원래 질문: spool의 `failure` 레코드를 다시 넣는 재주입 handler를 만든다.
  evidence: story 11이 레코드 종류와 줄 코덱, 그리고 `recordFailure`가 `DB_LOCKED`·`DB_UNAVAILABLE`로 답할 때 그 줄을 쓰는 쪽을 만들었다. 되넣는 쪽은 없다 — `replaySpool`은 handler 없는 kind를 "되돌리고 멈춤"으로 다루므로 줄은 안전하게 남지만 영원히 남는다. handler는 세션 수집 handler와 같은 자리(2.12)가 자연스럽다.
- source_plan: `_bmad-output/personal-brain/epic-capture/story-drain-plan.md`
  summary: 데몬이 살아 있을 때 CLI의 기회적 drain을 끈다(AD-7·27의 예외).
  evidence: AD-7은 "데몬이 살아 있으면(소켓 handshake가 응답하면) 어떤 명령도 기회적 drain을 돌지 않는다"고 정한다. story 11의 `shouldDrain`은 hook·`drain: false`·설정 없음·명령 실패·스키마 불일치만 본다. 소켓도 handshake도 epic-daemon(epic 9)의 것이라 그때 조건을 하나 더한다.
- source_plan: `_bmad-output/personal-brain/epic-capture/story-drain-plan.md`
  summary: 해결됨(2026-10-19 사용자, B; 칸은 18, 2026-10-20) — 같은 실패 키가 다시 나오면 행을 다시 열고 `occurred_at`·`message`를 최신으로 바꾼다(2.11). 처음 난 때와 횟수 칸도 끝났다: 0005의 `failures.first_occurred_at`·`occurrences`(기본값 없음), `recordFailure`가 새 행에 `first = occurred`·`occurrences = 1`을 쓰고 같은 키에는 `occurrences + 1`만 올리며 첫 시각은 건드리지 않는다. Core `Failure`·`listFailures`·`failures list`(`--json`의 두 칸, 텍스트의 `횟수 N`)가 읽는다. 원래 질문: 같은 실패 키가 다시 나올 때 `occurred_at`·`message`를 최신으로 갱신할지 정한다.
  evidence: story 11 Decision 2(2026-10-19, 무인 실행에서 에이전트가 고름). Table Contract의 `failures` 행이 "`resolved_at`만 drain이 채움"이라 그대로 지켰고, 그래서 백 번째 실패를 봐도 보이는 시각과 문장은 첫 번째 것이다. "마지막으로 언제 실패했나"를 알고 싶으면 칸이나 규칙을 바꿔야 한다. `failures list`(2.12)를 쓰면서 판단하는 것이 자연스럽다.
- source_plan: `_bmad-output/personal-brain/epic-capture/story-spool-plan.md`
  summary: `SECOND_BRAIN_CAPTURE` 스위치를 없애고 하네스 트랜스크립트 폴더를 기본으로 켠다(`apps/cli/src/harnesses.ts`의 `transcriptFolders`).
  evidence: 2.12 Decision 1(2026-10-19). 실제 폴더를 읽는 것은 "지금 디스크에 있는 것을 이 빌드의 parser로 수집한다"는 뜻이고, 저장된 메시지는 다시 쓰지 않으므로(AD-11) 19·20 전에 켜면 그 세션은 옛 parser 규칙으로 굳는다. 마스킹은 더 이상 이 이유가 아니다 — 17(마스킹 B, 2026-10-20)로 수집은 원문을 저장하고 패턴은 나갈 때만 돌므로, 패턴이 바뀌어도 저장된 세션은 영향을 받지 않는다. 그래서 에픽 결정("실제 수집은 14에서 켠다")을 지켜 스위치를 두었다. 2.14는 그 스위치를 지우고, 그때 doctor `transcripts`는 `skip`이 아니라 `ok`가 되며, 모든 CLI 테스트는 이미 빈 `CLAUDE_CONFIG_DIR`로 격리되어 있다(`apps/cli/test/environment.ts`).
- source_plan: `_bmad-output/personal-brain/epic-capture/story-parser-v3-peer-handback-plan.md`
  summary: epic 2 story 22(보고 판정·출처)에 합침(2026-10-20). 원래 질문: `handbackReportText`가 없는 옛 handback의 본문을 `origin.body`에서 읽을지 정한다(편집기 앞머리 문장을 떼고 보고의 들여쓰기를 걷어낸다).
  evidence: story 19 Decision(2026-10-19, 무인 실행에서 에이전트가 고름). 티켓이 본문 출처를 `origin.handbackReportText`로 정했고, 2.7 Decision "애매한 user 항목은 빼는 쪽"(넣은 것은 못 고치고 빠진 것은 버전을 올려 더할 수 있다, AD-11)을 따라 그 키가 없는 줄은 뺐다. 실측(2026-10-19)으로 handback 367건 중 244건이 그 키가 없다(Claude Code 2.1.273~2.1.296) — 실제 보고 381건의 64.0%다. 넣으려면 앞머리와 들여쓰기를 걷어내는 규칙을 정해야 하고, 규칙이 틀리면 고칠 수 없는 본문이 남는다. 실제 수집을 켜는 2.14 전에 보면 그 세션이 옛 규칙으로 굳는 것을 막는다.
- source_plan: `_bmad-output/personal-brain/epic-capture/story-parser-v3-peer-handback-plan.md`
  summary: parser 버전이 올라간 뒤 이미 수집된 세션을 다시 읽히는 거리를 만든다 — 지금은 트랜스크립트 폴더 스캔이 크기가 같은 파일을 다시 큐에 넣지 않는다.
  evidence: 2.12의 스캔은 `transcript_files.size_bytes`와 견주어 바뀐 파일만 `session_ingest`로 큐에 넣는다. story 19가 `CLAUDE_CODE_PARSER_VERSION`을 `'3'`으로 올렸지만, 더 자라지 않은 트랜스크립트는 스캔이 집지 않으므로 그 세션의 빠진 handback 보고는 다음 Stop hook이나 손으로 돌린 수집 때까지 들어오지 않는다. 다시 읽는 쪽은 이미 있다 — `sessions.ingest`는 `sessions.parser_version`이 다르면 커서를 넘기지 않고 처음부터 읽는다. 없는 것은 "다시 넣을 거리"뿐이어서, 스캔이 `parser_version`도 함께 보거나 버전 올림 때 한 번 도는 일감 종류를 두는 쪽이 자연스럽다. 폴더 스캔을 기본으로 켜는 2.14가 그 자리다.
- source_plan: `_bmad-output/personal-brain/epic-capture/story-0005-plan.md`
  summary: 프로젝트 비교 키 식을 Core의 함수·호스트 상수로 옮긴다 — 지금은 SQLite 쪽에만 있고, 두 곳에 두 번 적혀 있다.
  evidence: 0005(story 18, 2026-10-20)가 `projects.identity_key`를 놓으면서 식(`github.com/*`·`bitbucket.org/*`면 `lower()`, 그 밖은 그대로)을 `packages/sqlite/migrations/0005_identity_and_records.sql`과 `packages/sqlite/src/project-keys.ts`(`PROJECT_IDENTITY_KEY_SQL`)에 각각 적었다. 마이그레이션 파일은 상수를 import할 수 없어서 두 번이고, 둘이 같은지는 `packages/sqlite/test/schema-0005.test.ts`의 "찾기가 보인 묶음 = 0005가 거부하는 묶음" 사례가 지킨다. 가짜 store(`packages/core/src/testing/fakes/store.ts`)는 아직 `remoteIdentity`로 프로젝트를 키잉하므로 대소문자만 다른 두 remote가 두 프로젝트가 되고, 그래서 "한 프로젝트로 들어간다"를 보는 사례는 SQLite 쪽에만 있다(`session-store.test.ts`). Core 함수·호스트 목록·포트 입력·가짜 store의 키는 story 20이 맡는다.
