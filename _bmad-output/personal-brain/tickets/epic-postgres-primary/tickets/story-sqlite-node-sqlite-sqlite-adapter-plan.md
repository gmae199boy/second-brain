---
title: 'SQLite 삭제: node:sqlite와 SQLite adapter가 저장소에서 없어진다'
type: 'chore'
ticket: '11'
created: '2026-10-29'
status: done
baseline_revision: '3eb6acebab1e144fa006021f30b2db1b2aa31843'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-postgres-primary/epic-postgres-primary.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** 11.10에서 런타임(CLI·데몬·hook·bootstrap)은 PG만 쓰게 됐지만, `packages/sqlite`(adapter·마이그레이션·자체 시험), `second_brain`의 SQLite 재export·의존성, lockfile 항목, README·AGENTS의 "원본은 로컬 SQLite" 설명, pgvector를 전제한 문서·fake probe가 아직 저장소에 남아 있다. 그래서 에픽 Done when 3("SQLite adapter와 `node:sqlite` 경로가 저장소에서 없어졌다")이 아직 참이 아니다.

**Approach:** `packages/sqlite`를 통째로 지우고, `second_brain`의 재export·의존성과 경계 시험의 허용 목록을 맞춘 뒤 `pnpm install`로 lockfile을 갱신한다. 현재 동작을 SQLite·pgvector로 설명하는 문서·주석·fake probe를 PG 기준으로 고친다. 옛 SQLite 파일 안내(11.10의 제품 동작)는 그대로 둔다.

## Boundaries & Constraints

**Always:**
- `packages/sqlite` 디렉터리 전체(추적 파일과 untracked `dist/`·`node_modules/`)를 지운다. 이 패키지를 참조하는 곳은 `packages/second_brain`뿐이다.
- `packages/second_brain/src/index.ts`의 `export * from '@second-brain/sqlite';`와 `package.json`의 의존성을 지운다. `boundaries.test.ts`: adapter 목록에서 `'sqlite'`를, bundle 의존 목록에서 `'@second-brain/sqlite'`를 뺀다. 그 외 경계 규칙(core 무의존, root 무의존, CLI는 bundle만, pg는 `second_brain/postgres`로만 로드)은 그대로다.
- `npx --yes pnpm@12 install`로 `pnpm-lock.yaml`을 갱신한다(손으로 고치지 않는다). 결과 lockfile에 `packages/sqlite` importer와 `@second-brain/sqlite` 항목이 없다. 다른 패키지의 해석된 버전은 바뀌지 않아야 한다(`kysely` 등은 `packages/postgres`가 계속 쓴다).
- 재export가 빠져 typecheck가 깨지는 소비자가 있으면 PG 쪽 동등 기능으로 옮긴다(조사 결과 `apps/`·`tooling/`·다른 패키지에는 SQLite 전용 export 소비자가 없다).
- 문서: `README.md` 3행(원본이 로컬 SQLite 파일), 897–898행(구조 표: `packages/sqlite` 행 삭제, `packages/postgres`를 "the Store port on PostgreSQL -- the primary store"처럼), 954–957행(테스트 DB 절: CLI·`packages/sqlite`는 파일로 돈다는 문장 → CLI·bootstrap·postgres 시험이 PG 시험 DB를 쓴다), 971행("pgvector가 있어야 합니다" 삭제, 필요하면 `pg_trgm`을 만들 수 있는 PostgreSQL 18이면 된다고), 980행(`--project sqlite` → `--project core`)을 현재 동작에 맞춘다. 옛 SQLite 파일을 지우지 않고 더 쓰지 않는다는 안내(143–145, 180, 1068행 근처)와 `legacy_sqlite_path` 설명은 남긴다. `AGENTS.md`의 `## brain` 첫 문장 "whose source of truth is a local SQLite file"을 PostgreSQL(OrbStack Docker 컨테이너) 기준으로 고친다(그 문장만).
- 현재 동작을 SQLite로 설명하거나 지워질 `packages/sqlite` 파일을 가리키는 주석은 PG 기준으로 고치거나 그 언급을 뺀다: `vitest.config.ts:14`(`--project sqlite` → `--project core`), `packages/second_brain/src/postgres.ts:1`, `apps/cli/scripts/write-build-info.mjs:20`, `packages/core/src/ports/store.ts:30-31`(probe 예: SQLite WAL/FTS5·Postgres vector extension → PG의 `writable`·`pg_trgm`), `:150`, `packages/core/src/sessions/ingest.ts:177`·`:209`, `packages/core/src/testing/fakes/store.ts:132`·`:1440`, `packages/core/test/document-extract.test.ts:51`, `apps/cli/test/*.test.ts`의 "real SQLite file"·"one SQLite writer"·`sqlite/src/connect.ts`·`packages/sqlite/test/...` 언급(capture-scan·dispatch·files-redact·output-codecs·queue-drain·sessions-ingest·setup-connect). 주석만 고치고 시험 동작은 바꾸지 않는다.
- pgvector를 전제한 fake: `packages/core/src/testing/fakes/store.ts:80`의 probe `{ id: 'vector', detail: '0.8.7' }`와 `packages/core/test/doctor.test.ts:83-111`·`:402-413`의 `vector` probe를 PG의 실제 probe 이름(`pg_trgm`)과 그에 맞는 detail로 바꾼다. 시험 제목도 맞춘다. Core doctor 로직은 probe id를 해석하지 않으므로 기대값만 바뀐다.
- `tooling/dev/tracer-session.sh`: 끝의 `sqlite3 $home/brain.db …` 안내를 그 홈의 PG를 읽는 같은 질의(`brain.messages`·`brain.users`)로 바꾼다. URL은 `$home/.env`의 `BRAIN_DATABASE_URL`에서 읽게 안내한다(`tooling/dev/pg-tracer.sh`의 `resolveStoreUrl` 사용 선례). 정리 안내는 `SECOND_BRAIN_HOME=$home node $bin setup uninstall --delete-volume --yes` 뒤 `rm -rf $home`이다.
- 사용자에게 보이는 새 문장은 한국어다.

**Never:**
- `packages/postgres/migrations/0001_initial.sql`을 한 바이트도 바꾸지 않는다(11.10이 checksum을 고정했다. 229행의 SQLite 언급 주석도 그대로 둔다). 마이그레이션 실행기·`CORE_SCHEMA_VERSION`·오류 코드·spool 형식을 바꾸지 않는다.
- 옛 SQLite 파일 안내 동작(`legacySqlitePath`·`defaultStorePath`·`postgres.legacy_sqlite_path`·"옛 SQLite 파일 … 더 쓰지 않습니다" 문장과 그 시험)을 지우거나 바꾸지 않는다. 옛 `brain.db`를 지우지 않는다.
- `.gitignore`의 `*.sqlite`·`*.sqlite3`, 시험 언어 검사의 `SQLITE_[A-Z]+` 원문 패턴, Node 하한(`tooling/bootstrap/src/bootstrap.ts:96` 등)과 그 주석, 커밋된 `tooling/bootstrap/bin/second-brain.js`·`plugin/bootstrap.mjs`는 바꾸지 않는다. PG와 같은 정렬을 설명하려고 SQLite를 언급하는 주석(`packages/core/src/instant.ts`, `domain/project-identity.ts:130`, `busy-timeout.ts`, `packages/postgres/src/attachments.ts:122`)은 남긴다.
- `packages/core/src/domain/embedding.ts` 등 수학적 vector 타입과 embedder·reranker 계약은 건드리지 않는다. `_bmad-output/`의 계획·조사·리뷰 기록은 고치지 않는다.
- `plugin/app-ref`·plugin version을 바꾸지 않는다(티켓 13).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 루트 import | `import 'second_brain'` | SQLite 모듈을 로드하지 않고, pg도 로드하지 않음(`boundaries.test.ts`의 기존 단언 유지) | 없음 |
| 경계 시험 | 지운 뒤 `boundaries.test.ts` | bundle 의존이 `claude-code`·`core`·`modelstudio`·`postgres` 넷 | 없음 |
| 깨끗한 설치 | `pnpm install --frozen-lockfile` | lockfile과 manifest가 일치해 성공 | 없음 |
| 옛 SQLite 홈 setup | `config.toml`에 `[store] path=<p>`, `<p>`에 파일 | 지금처럼 안내 한 줄·`legacy_sqlite_path: <p>`, 파일 그대로(기존 시험 통과) | 없음 |

</intent-contract>

## Code Map

- `packages/sqlite/` -- 통째로 삭제. src 14개 모듈·`migrations/`(SQLite 0001~0009)·`test/`(21개 시험 파일, fixtures 포함). DB 공통 계약(store·schema·session·user·work·transcript-file·attachment·extraction·file-redaction·schedule·settings)은 모두 `packages/postgres/test/{store,work-store,attachment-extraction,settings}.test.ts`에서 이미 돈다.
- `packages/second_brain/src/index.ts:3`, `package.json:31` -- 재export·의존성 삭제. `src/postgres.ts:1` 주석.
- `packages/second_brain/test/boundaries.test.ts:38`, `:53` -- 허용 목록. 끝의 "loads pg only through the explicit PostgreSQL entry point" 시험은 유지.
- `pnpm-lock.yaml:123-125`(second_brain의 `@second-brain/sqlite`), `:131~`(`packages/sqlite` importer) -- `pnpm install`이 갱신.
- `vitest.config.ts:14` -- 프로젝트는 `test/` 폴더로 자동 탐지되므로 폴더 삭제만으로 `sqlite` 프로젝트가 사라진다. 주석만 고친다.
- `README.md:3`, `:897-898`, `:954-957`, `:971`, `:980`; `AGENTS.md:6` -- 문서.
- `packages/core/src/ports/store.ts:30-31`, `:150`; `packages/core/src/sessions/ingest.ts:177`, `:209`; `packages/core/src/testing/fakes/store.ts:80`, `:132`, `:1440`; `packages/core/test/doctor.test.ts:83-111`, `:402-413`; `packages/core/test/document-extract.test.ts:51` -- 주석·fake probe. PG probe 이름은 `packages/postgres/src/store.ts:16` `POSTGRES_DOCTOR_PROBE_IDS = ['writable', 'pg_trgm', 'redaction_cleanup']`.
- `apps/cli/scripts/write-build-info.mjs:20`; `apps/cli/test/capture-scan.test.ts:28,628,897,900`, `dispatch.test.ts:29`, `files-redact.test.ts:16`, `output-codecs.test.ts:31`, `queue-drain.test.ts:16,24`, `sessions-ingest.test.ts:42,47,374,957,1421,1570,1696,2167,2411,2478`, `setup-connect.test.ts:31` -- 주석.
- `tooling/dev/tracer-session.sh:79-90` -- 안내 문구. 참고: `tooling/dev/pg-tracer.sh:26-27`, `:85`.
- 바꾸지 않음: `packages/postgres/migrations/0001_initial.sql`, `apps/cli/src/config/codec.ts`·`install/flow.ts`·`install/postgres.ts`의 legacy 안내, `.gitignore`, `apps/cli/test/language.ts`, `tooling/bootstrap/**`, `plugin/**`.

## Tasks & Acceptance

**Execution:**
- [x] `packages/sqlite/` -- 디렉터리 삭제(`git rm -r` 뒤 남은 untracked 산출물도 지움) -- adapter 제거
- [x] `packages/second_brain/src/index.ts`, `src/postgres.ts`, `package.json`, `test/boundaries.test.ts` -- 재export·의존성·허용 목록·주석 -- 묶음 경계 정리
- [x] `pnpm-lock.yaml` -- `npx --yes pnpm@12 install`로 갱신 -- lockfile 정합
- [x] `README.md`, `AGENTS.md`, `vitest.config.ts` -- SQLite·pgvector 현재 설명 교체 -- 문서
- [x] `packages/core/src/ports/store.ts`, `sessions/ingest.ts`, `testing/fakes/store.ts`, `packages/core/test/doctor.test.ts`, `document-extract.test.ts` -- 주석과 `vector` → `pg_trgm` fake probe -- pgvector 전제 제거
- [x] `apps/cli/scripts/write-build-info.mjs`, Code Map의 `apps/cli/test/*` 주석 -- SQLite 현재형 주석 교체 -- 주석 정합
- [x] `tooling/dev/tracer-session.sh` -- PG 질의·uninstall 정리 안내 -- dev 스크립트 정합

**Acceptance Criteria:**
- Given 저장소, when `git grep -nE "from 'node:sqlite'|import\\('node:sqlite'\\)|require\\('node:sqlite'\\)|@second-brain/sqlite|pgvector|create extension[^;]*vector|installVector" -- packages apps tooling plugin package.json pnpm-lock.yaml compose.test.yaml`, then 출력이 없고, `test -e packages/sqlite`가 실패한다.
- Given OrbStack이 켜진 저장소, when `npx --yes pnpm@12 install --frozen-lockfile && npx --yes pnpm@12 test`, then build·typecheck·전체 시험이 exit 0이고, vitest 프로젝트 목록에 `sqlite`가 없다.
- Given 저장소, when `git diff --stat <baseline_revision> -- packages/postgres/migrations plugin tooling/bootstrap .gitignore`, then 출력이 없다.

## Implementation Notes

- 구현 세션(codex thread `01a183c6-6450-7040-9b36-b85c54d2e9b0`)이 `packages/sqlite/` 전체(추적 파일과 untracked `dist/`·`node_modules/`)를 지우고, `second_brain`의 재export·의존성과 `boundaries.test.ts` 허용 목록을 맞췄으며, `npx --yes pnpm@12 install`로 lockfile을 갱신했다(`packages/sqlite` importer와 `@second-brain/sqlite` 항목만 빠짐). README·AGENTS·`vitest.config.ts`·Core 주석·CLI 시험 주석을 PG 기준으로 고치고, fake probe `vector`를 `pg_trgm`으로 바꿨으며, `tooling/dev/tracer-session.sh` 안내를 PG 질의와 `setup uninstall --delete-volume --yes` 정리로 바꿨다. 구현 세션은 커밋하지 않았다.

### 오케스트레이터 기록

- step-03 검증: `npx --yes pnpm@12 install --frozen-lockfile` exit 0, `npx --yes pnpm@12 test` exit 0(build·typecheck, 107개 파일·2,715개 시험; 11.10의 3,070개에서 줄어든 수는 지운 `packages/sqlite` 시험이다), `vitest list`의 프로젝트는 `bootstrap`·`claude-code`·`cli`·`core`·`postgres`·`second_brain`·`test-db`로 `sqlite`가 없다. AC의 `git grep` 출력 없음, `test -e packages/sqlite` 실패, 보호 경로(`packages/postgres/migrations`·`plugin`·`tooling/bootstrap`·`.gitignore`) diff 없음, `sh -n tooling/dev/tracer-session.sh`·`git diff --check` 통과.
- 매트릭스 점검: 루트 import는 `boundaries.test.ts`의 'loads pg only through the explicit PostgreSQL entry point'와 `import-side-effects.test.ts`, 경계 시험은 'the bundle depends on core and every adapter', 깨끗한 설치는 frozen install 명령, 옛 SQLite 홈 setup은 `apps/cli/test/install.test.ts`의 'leaves an old file byte for byte and removes its config key on rewrite'와 `install-flow.test.ts`의 'reports an old file without deleting or moving it'가 덮고, 모두 위 전체 실행에서 통과했다.

## Plan Change Log

## Review Triage Log

### 2026-10-29 — Review pass
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings: 없음. quick 렌즈(codex reviewer thread `01a183cb-2fcc-70d2-bbd1-399dfe3853c5`)가 수용 기준 미충족·규칙 위반·버그를 찾지 못했다고 보고했다. 오케스트레이터가 따로 `tooling/dev/tracer-session.sh` 안내 스니펫의 `resolveStoreUrl(home, name, env)` 서명(`apps/cli/src/config/codec.ts:746`)과 빌드 산출물 `apps/cli/dist/config/codec.js`의 존재를 확인했다.


### 2026-10-29 — 후속 리뷰
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings: 없음. quick 렌즈(codex reviewer thread `01a183cc-c52a-7ba1-96ca-0bfe63288bc6`)가 baseline `3eb6acebab1e144fa006021f30b2db1b2aa31843` 이후 diff와 수용 기준을 확인했으며 지적을 보고하지 않았다. 이번 pass의 patch·defer·reject는 모두 0건이다. 기존 deferred-work ledger와 플랜 `status`는 사용자 지시에 따라 변경하지 않았다.

## Design Notes

**지울 것과 남길 것의 기준:** 지우는 것은 SQLite를 *쓰는* 코드·의존성과 SQLite·pgvector를 *현재 동작으로* 설명하는 문서·주석이다. 남기는 것은 (1) 옛 `brain.db`를 지우지 않고 더 쓰지 않는다는 제품 안내(에픽 결정, 11.10), (2) PG가 SQLite와 같은 정렬·의미를 지킨다는 parity 설명, (3) checksum이 고정된 baseline, (4) 커밋된 bootstrap 번들과 그 Node 하한 근거다. 11.10이 `apps/cli/src`의 SQLite 전용 doctor·설치 단계를 이미 지웠으므로 이 티켓에서 남은 것은 adapter·재export·문서다.

## Verification

**Commands:**
- `npx --yes pnpm@12 install --frozen-lockfile` -- expected: 성공
- `npx --yes pnpm@12 build && npx --yes pnpm@12 typecheck` -- expected: 통과
- `npx --yes pnpm@12 test` -- expected: 전체 통과, 프로젝트 목록에 `sqlite` 없음
- 위 AC의 `git grep` -- expected: 출력 없음
- `sh -n tooling/dev/tracer-session.sh` -- expected: 문법 오류 없음
- `git diff --check` -- expected: 출력 없음

## Auto Run Result

**상태:** `built`(기존 플랜 상태 유지). 후속 리뷰를 마쳤으며 티켓 완료 처리는 오케스트레이터가 검증 뒤 수행한다. `tickets.py mark`는 실행하지 않았고 기존 deferred-work ledger 항목은 변경하지 않았다.

**구현 요약:** 기존 구현이 SQLite adapter·재export·의존성을 제거하고, lockfile·경계 허용 목록·현재 동작 설명·fake probe·개발 스크립트 안내를 PostgreSQL 기준으로 맞춘 것을 후속 리뷰로 확인했다. 이번 pass의 소스·시험 수정은 없다.

**바뀐 파일:**
- `packages/sqlite/` — 기존 구현에서 adapter·마이그레이션·자체 시험 삭제.
- `packages/second_brain/`, `pnpm-lock.yaml` — 기존 구현에서 SQLite 재export·의존성·경계 허용 목록·lockfile 항목 제거.
- `README.md`, `AGENTS.md`, `vitest.config.ts`, Core·CLI 주석과 doctor fake 시험, `tooling/dev/tracer-session.sh` — 기존 구현에서 PG 기준으로 설명·probe·안내 정리.
- 이 플랜 — 이번 후속 리뷰와 검증 결과 추가.

**리뷰 결과:** quick 렌즈 지적 0건. patch 0, defer 0, reject 0. 기각 사유를 기록할 지적은 없다.

**후속 리뷰 권고:** `false`. 이번 pass의 patched entry는 high 0, medium 0, low 0이다.

**검증:**
- `npx --yes pnpm@12 install --frozen-lockfile` exit 0. `npx --yes pnpm@12 test`의 build·typecheck는 통과했다. 첫 전체 시험은 2,714개 통과·1개 시간 초과였다(`packages/postgres/test/redaction.test.ts:263`, MAINTAIN 권한 복구 시험, 40초).
- 해당 파일 단독 실행(`npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/redaction.test.ts`)은 39개 모두 통과했다.
- 전체 시험 재실행(`npx --yes pnpm@12 exec vitest run`)은 107개 파일·2,715개 시험 모두 통과했다.
- 수용 기준의 금지 참조 검색은 출력 없음, `packages/sqlite` 디렉터리 없음. 보호 경로(`packages/postgres/migrations`·`plugin`·`tooling/bootstrap`·`.gitignore`)는 baseline 이후 diff 없음. `sh -n tooling/dev/tracer-session.sh` 통과.

**잔여 위험:** 전체 시험의 첫 실행에서 PG 정리 권한 시험의 시간 초과가 있었으며 단독·전체 재실행에서는 재현되지 않았다. 개발 스크립트 안내는 문법 검사와 리뷰로 확인했으며 실제 Claude 대화를 통한 수동 실행은 하지 않았다. 사람이 결정해야 하는 미해결 사항은 없다.
