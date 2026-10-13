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
