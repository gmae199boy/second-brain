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
| Postgres가 0004만큼 더 갈라짐(`messages.git_branch`·`is_subagent_report`와 불변 trigger, `files.source_unreachable_at`, `document_chunks.chunk_locator`와 trigger, `redactions` 재생성·불변 trigger, `document_extractions`의 `attempt`·`failed_stage`·`index_config_id`·키, `failures` 대상 키, `work_items_due_idx`) | epic 7(2.6 리뷰, 2026-10-18). 0005(`redactions.tool_note_id`, `failed_stage` trigger, `projects.identity_key`)도 epic 7(2026-10-19) |
| Core `Failure` 타입이 0004에서 없어진 `harness_session_id`를 키로 적음(`packages/core/src/domain/failure.ts`). `Redaction`·`Message`도 새 칸이 없음 | `Failure`: epic 2 story 11(실패 기록 함수가 타입을 대상 키로 바꿈). `Redaction`: `patternVersion`만 해결됨(2.9). 아직 `messageId: string`·non-null `start`/`end`라 0004의 파일 가리기(`file_id`, 위치 없음)를 표현하지 못한다 — `fileId` 추가와 `messageId`·`start`·`end` nullable화는 `files.redact`를 만드는 epic-attachments. `toolNoteId`는 story 13(18의 칸을 처음 쓸 때, 2026-10-19). `Message`: story 7(2.6 Decision, 2026-10-18) |
| 도구 메모 대상을 가린 기록 자리가 없음 | 2026-10-19: 마스킹 B로 수집은 도구 메모 대상을 가리지 않는다(원문 저장). 기록이 필요한 것은 2.13의 저장본 가리기뿐이고, 0005(story 18)의 `redactions.tool_note_id`가 맡는다. (이전 처분: epic-attachments 또는 epic 7과 함께(다음 마이그레이션). 0004의 `redactions` 행은 대상이 `message_id`·`file_id` 둘뿐이고 위치는 **본문** 위의 구간이라, 가려진 `tool_notes.target`을 가리킬 칸이 없다. 2.9는 대상의 값을 가리되 기록은 남기지 않는다(Decision 2026-10-18). 넣으려면 0005에 `redactions.tool_note_id`를 더하고 위치를 그 대상 위의 구간으로 정의해야 한다) |
| `messages redact`(2.13)가 같은 문제를 만난다 | 2026-10-19: story 18(자리)과 story 13(쓰기). 이전 처분: epic 2 story 13. AD-11은 `messages.redact`가 `tool_notes.target`도 함께 가린다고 정하는데, 그 가리기 역시 남길 행이 없다. 위 항목과 한 번에 결정한다(2.9, 2026-10-18) |
| 2.9 deferred: 영어 키워드 과잉 가림, 한국어 표현 놓침 (`story-untitled-9-plan.md` frontmatter) | epic 2 story 17(마스킹 B에서 패턴 버전 2로, 값 끊김 포함, 2026-10-19) |
| auto-build 커밋을 이력에서 빼기 (2026-10-18) | push 전, 사용자(티켓 밖). 끝나면 `app-ref`·`version`·`baseline_revision`·커밋 번호를 다시 맞춘다 |
| 무인 루프 v2가 커밋을 기다리지 않음 (2026-10-18) | 저장소 밖 도구. 2.10~를 무인으로 돌리기 전에 고친다 |
| 2.7 follow-up 리뷰 (2026-10-18) | epic 2 story 19의 리뷰로 한다(change-masking-b-and-review-fixes D10) |
| 백업 브랜치 `backup/pre-path-rewrite-2026-10-18` | push 전에 지운다(사용자) |
| 비정상 종료로 남은 `.open` 회수 (2.10) | epic 2 story 11·12(drain과 일부 줄 다시 쓰기와 함께, 2026-10-19) |
| 업그레이드 경로 correct-course: 마이그레이션 완료 뒤 전환·실패 시 재시도·마이그레이션 승인 (2.10) | AD-19·20을 바꾸는 입력. bootstrap 2.5·shim·`setup upgrade`(epic 5)에 걸리므로 correct-course로 먼저 본다(2026-10-19 사용자) |
- source_plan: none
  summary: 옛 무인 루프 스크립트(`tooling/dev/auto-build.sh`)를 넣은 커밋(`10a09d2`)을 지우는 커밋이 아니라 그 커밋을 빼고 다시 쌓는 방식으로 이력에서 뺀다(`git rebase --onto 10a09d2^ 10a09d2 main`, 시작 전 백업 브랜치).
  evidence: 2026-10-18 사용자 결정. 그 뒤 해시가 다시 바뀌므로 `plugin/app-ref`(AGENTS.md 규칙대로 version도 함께), plan의 `baseline_revision`, 문서의 커밋 번호를 다시 맞춘다. 원격에는 첫 커밋뿐이라 push 전에 해야 한다. dev-workflow 저장소에서는 같은 일을 이미 끝냈다.
- source_plan: none
  summary: 무인 루프 v2(`~/.local/share/auto-build/auto-build.sh`, 저장소 밖)가 plan이 built가 된 뒤 커밋을 기다리지 않아 "작업 트리 더러움"으로 멈추는 버그를 고친다.
  evidence: 2026-10-18 실행에서 관찰. 루프는 이 저장소의 티켓을 돌리므로 2.10~2.15를 무인으로 돌리기 전에 고친다.
- source_plan: none
  summary: brain 2.7(parser) follow-up 리뷰를 한 번 더 돌린다.
  evidence: 2026-10-18 결정 검토에서 peer handback 누락(보고 약 58%)이 나왔다. 수정은 `inputs/masking-b-and-review-fixes.md` §2에 있고, 다른 빈틈이 없는지 리뷰로 확인하자는 권장이다.
- source_plan: `_bmad-output/personal-brain/epic-capture/story-spool-db-plan.md`
  summary: 비정상 종료로 남은 `<home>/spool/*.jsonl.open` 파일을 회수한다.
  evidence: 2.10은 `.open`을 절대 claim하지 않는다(쓰는 중인 파일을 반쯤 읽는 것을 막는다). 그래서 append 도중에 죽은 프로세스가 남긴 `.open`은 영원히 남고, doctor의 `spool` 건수에도 들어가지 않는다. 회수 규칙(mtime 기준 유예 뒤 `.jsonl`로 돌릴지, `spool/failed/`로 옮길지, 마지막 줄이 깨졌을 때 어떻게 할지)은 drain과 일부 줄 다시 쓰기가 있는 story 11·12에서 정하는 것이 자연스럽다.
- source_plan: `_bmad-output/personal-brain/epic-capture/story-spool-db-plan.md`
  summary: 업그레이드 경로를 correct-course로 다시 본다 — 마이그레이션이 끝난 뒤에만 새 빌드로 전환하고, 실패하면 마이그레이션부터 다시 하며, 업그레이드 때 사람의 마이그레이션 승인을 받는다.
  evidence: 2026-10-19 사용자 결정. 스키마 불일치는 고칠 대상이고 고치는 길은 업그레이드 경로의 마이그레이션이며, 2.10의 spool은 그 전까지 남는 틈을 받치는 안전망일 뿐이다. 이 셋은 AD-19·20을 바꾸는 일이라 스토리 안에서 하지 않는다. 닿는 곳은 bootstrap(2.5), shim, `setup upgrade`(epic 5)다.
- source_plan: none
  summary: 이력 다시 쓰기 전 백업 브랜치 `backup/pre-path-rewrite-2026-10-18`(로컬)을 push 전에 지운다.
  evidence: 옛 커밋에 실명 경로가 남아 있다. 원격에 올라가면 안 된다. 이력 다시 쓰기는 2026-10-18 `24f0063` 앞에서 끝났다.
