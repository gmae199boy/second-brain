---
title: 'Tracer: brain ext install testext 뒤 ext status가 connected를 보인다'
type: 'feature'
ticket: '1'
created: '2026-10-29'
status: done
baseline_revision: '6db2f007321c8c3d7dbc356aa9a9912dafd16e7e'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      재설치 마이그레이션이 일부 파일을 커밋한 뒤 실패하면 이전 패키지를 되돌려, 설치 폴더에 이미 ledger에 기록된 마이그레이션 파일이 없게 된다.
    evidence: |-
      `runMigrations`는 파일마다 커밋한다. `apps/cli/src/runtime/extensions.ts`의 migrator는 실패 결과면 무조건 backup을 되돌리므로, 0002 성공·0003 실패 때 ledger에는 0002가 있고 설치본에는 없다. 설치된 확장 마이그레이션을 setup이 다시 돌리게 되면(AD-31, setup run의 "설치된 확장" 마이그레이션) checksum·파일 검증이 실패한다. 실패·재개 정책은 13.5(단계 보고와 재개) 소관이다.
    location: >-
      apps/cli/src/runtime/extensions.ts:76
    severity: medium
  - summary: >-
      마이그레이션 커밋 뒤 `recordExtensionInstall`이 실패하면 패키지와 DDL은 남고 registry에는 설치 사실이 없다.
    evidence: |-
      `packages/core/src/extensions/install.ts`는 place → migrate → registry 기록 순서이고, migrator가 성공하면 backup을 지운다. 그 뒤 DB 쓰기가 실패하면 `ext status`는 미설치로 보이지만 `<home>/extensions/<name>/`와 확장 schema는 있다. 다시 돌리면 이어 가지만 단계별 결과 기록과 재개는 13.5 소관이다.
    location: >-
      packages/core/src/extensions/install.ts:36
    severity: medium
  - summary: >-
      연결 확인 중 CLI가 SIGINT 등으로 끝나면 detached로 뜬 자식 프로세스 그룹이 정리되지 않고 남을 수 있다.
    evidence: |-
      `runExtensionCheck`에는 취소 신호가 없고 실제 launcher는 `detached: true`로 띄운다. 큐 행이 없으므로 감독자 reconcile도 회수하지 않는다. testext는 즉시 끝나 영향이 없지만, 오래 걸리는 실제 확장 확인에서는 고아 그룹이 생긴다. 취소 보고는 13.5 소관이다.
    location: >-
      packages/core/src/extensions/check.ts:5
    severity: medium
  - summary: >-
      연결 확인 실패 때 자식의 stderr 진단(마스킹·길이 제한된 값)이 버려져 registry에는 ABI 코드와 일반 메시지만 남는다.
    evidence: |-
      `packages/core/src/extensions/check.ts`는 `createAbiStderr()`로 모은 값을 `stderr.value()`로 읽고 버린다. Node 구문 오류처럼 원인이 stderr에만 있는 실패는 `ABI_EXIT_FAILED`만 보인다. 마지막 실패 보고는 13.5, 공개 상태 view는 13.6 소관이다.
    location: >-
      packages/core/src/extensions/check.ts:41
    severity: low
---

<intent-contract>

## Intent

**Problem:** 선택 확장을 설치할 길이 없다. `ext` 명령·확장 registry·확장 마이그레이션 연결·확장 명령 자식 실행이 모두 없어서, 뒤 스토리(manifest 전체, Python, role, 단계 보고, 켜기/끄기, 스킬)가 얹힐 바닥이 없다.

**Approach:** 가장 얇은 수직 경로 하나를 놓는다. 최소 manifest 코덱 → 패키지를 `<home>/extensions/<name>/`에 복사 → core 실행기로 소유자 `<name>`의 마이그레이션 적용 → core 마이그레이션 0011의 registry 표에 설치·활성 기록 → 감독자 부품으로 연결 확인 명령을 자식 프로세스로 한 번 돌려 ABI v1 판정을 registry에 기록 → `brain ext install|list|status`(CommandSpec·SDK 1:1)가 registry를 다시 읽어 보인다. 시험 fixture `testext`는 기본 홈이 아닐 때만 환경 변수로 켜지는 시험용 resolver로 설치한다.

## Boundaries & Constraints

**Always:**
- core는 확장 코드를 import하지 않는다. manifest가 선언한 연결 확인 명령을 자식 프로세스로 부르는 것만 한다(AD-29).
- 확장 이름은 `^[a-z][a-z0-9_]{0,30}$`이고 `core`·`brain`·`public`·`pg_`로 시작하는 이름은 거부한다. manifest의 `name`은 요청한 이름·패키지 폴더 이름과 같아야 한다.
- 확장 마이그레이션은 기존 `runMigrations`(`packages/postgres/src/migrate.ts`)에 `owners: [{ owner: <name>, directory }]`로 넘긴다. 실행기 복제·직접 DDL 실행 금지. 확장 번호는 core 번호와 따로 간다.
- 새 core 마이그레이션은 `0011_extension_registry.sql`이고 `CORE_SCHEMA_VERSION`을 11로 올린다. 0001~0010은 고치지 않는다.
- 설치·활성·연결 확인은 registry 표의 서로 다른 칼럼(사실)이다. 하나의 "설치됨" 상태로 뭉치지 않는다. registry 작성은 core use case만 한다.
- `ext install`·`ext status`의 응답은 registry를 다시 읽은 값이다. 출력은 기존 envelope·코드 표(`packages/core/src/codes.ts`)를 거친다.
- 연결 확인 자식의 ABI env는 `packages/core/schemas/process-abi/v1/env.schema.json`을 통과한다. DB URL은 env로만, argv에 넣지 않는다.
- 시험용 resolver는 `SECOND_BRAIN_TEST_EXTENSIONS`(패키지들이 든 폴더)가 있고 해석된 Brain 홈이 기본 홈(`~/.second_brain`)과 다를 때만 켜진다. 기본 홈에서는 무시한다.
- 확장을 설치하지 않은 Brain은 `<home>/extensions/`를 만들지 않는다(조립은 아무것도 열거나 만들지 않는다, AD-3).

**Never:**
- 사용자용 `--from <경로>` 옵션, testext의 일반 출하(`extensions/` 아래 두기), 임의 경로 설치.
- 연결 확인을 `work_items`에 넣거나 CLI 프로세스에서 두 번째 `runSupervisor`를 돌리기(Design Notes). `runSupervisor`·`execute` 리팩터링.
- ABI v1 schema·codec·fixture 변경, 0001 baseline 수정.
- 범위 밖: manifest 전체 JSON Schema·설정 snapshot(13.2), Python·`uv`(13.3), `brain_ext_<name>` role·확장 schema 권한(13.4), 단계 보고·재개·로그인(13.5), `enable|disable`·공개 상태 view·doctor(13.6), 스킬(13.7). 데몬이 resolver 환경 변수를 받는 일은 13.10.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 정상 설치 | 빈 홈, resolver 켬, `brain ext install testext --json` | `<home>/extensions/testext/` 생김, ledger에 `(testext, 1)`, registry 설치·활성·`connected`, 응답은 재조회 값 | 없음 |
| 다시 설치 | 같은 홈에서 다시 `ext install testext` | ledger 행 늘지 않음, registry 행 하나, 다시 `connected` | 없음 |
| 모르는 이름 | `ext install nope` 또는 resolver 꺼짐(기본 홈 포함) | 아무것도 쓰지 않음 | `EXTENSION_NOT_FOUND` |
| 잘못된 이름 | `ext install Core` / `ext install ../x` | 아무것도 쓰지 않음 | `EXTENSION_NOT_FOUND`(이름 규칙 위반도 같은 코드, 메시지로 구분) |
| manifest 불량 | 필드 누락·모르는 키·`core`/`abi` 불일치·`entry`가 패키지 밖 | 복사·마이그레이션 전 거부 | `EXTENSION_INVALID` |
| 연결 확인 실패 | 자식이 ABI `error`·비정상 종료·시간 초과 | registry에 설치·활성 사실은 남고 연결 `failed`+코드 | `EXTENSION_CHECK_FAILED`(exit 1) |
| 미설치 조회 | `ext status testext` 설치 전 | `ok` + `installed: false`, 나머지 사실 null/false | 없음 |
| 마이그레이션 실패 | 확장 SQL 오류 | registry에 설치 기록 없음 | 실행기의 `MIGRATION_FAILED`/`DB_UNAVAILABLE` 그대로 |

</intent-contract>

## Code Map

- `packages/postgres/src/migrate.ts` -- `runMigrations({ databaseUrl, clock, owners })`, `MigrationOwner`, `CORE_SCHEMA_VERSION`(10→11). 실행기는 `set role brain_owner`라 관리(admin) 연결이 필요하다. 확장만 넘기면 `from/to`는 0이고 `applied`는 파일명.
- `packages/postgres/migrations/0010_work_hold_groups.sql` -- 최근 마이그레이션 모양. `brain` 표는 `setup.ts:44-52`의 default privileges로 `brain_app`이 SELECT/INSERT/UPDATE/DELETE를 받는다.
- `packages/postgres/test/migrate.test.ts:20,22,34,77,123`, `migrate-files.test.ts:12` -- core 파일 목록·최종 버전을 고정. 0011 추가 때 갱신. `baseline-checksum.test.ts`는 0001만 본다.
- `apps/cli/src/install/postgres.ts:58-61` -- setup의 `prepareDatabase`→`runMigrations` 전례. `apps/cli/src/config/codec.ts:742`(`resolveStoreUrl`), `:747`(`postgresSecrets`: `.env`의 `BRAIN_POSTGRES_PASSWORD`, 관리 사용자 `postgres`).
- `packages/core/src/queue/supervisor.ts` -- 읽기 전용 참고. `execute`의 자식 실행·`createAbiRun`/`createAbiStderr`·`cleanProcessGroup`(`queue/process-cleanup.ts`) 사용법. 고치지 않는다.
- `packages/core/src/process-abi/codec.ts` -- `PROCESS_ABI_ENV`, `createAbiRun()`(feed/end/fail/verdict), `AbiRunVerdict`. 결과 summary는 판정에 없다: `connected`는 판정 `succeeded`에서 매핑한다.
- `packages/core/src/ports/process.ts`, `apps/cli/src/runtime/process-group.ts`, `runtime/process-inspector.ts`, `runtime/clock.ts`(`systemTimer`) -- 자식 실행 port와 실제 adapter. spawn env는 `spec.env`뿐(부모 env 병합 없음), stdin 없음.
- `apps/cli/src/workers/process-probe.ts` -- testext 연결 확인 스크립트의 바탕(ABI env 검증 → progress → result).
- `packages/core/src/ports/store.ts:838`(`Store` 교집합), `:1424`(`ScheduleStore` 전례) -- 새 `ExtensionStore`를 더한다.
- `packages/core/src/testing/fakes/store.ts:170`(`memoryStore`), `testing/contracts/schedule-store.ts`, `testing/contract.ts`, `packages/core/test/contracts.test.ts:1527`, `packages/postgres/test/work-store.test.ts:17`, `packages/postgres/test/fixture.ts:15` -- fake·계약·PG 계약 실행 전례.
- `packages/postgres/src/store.ts:18`, `schedules.ts:29` -- PG capability factory 조립 전례(`withWrite`, `databaseFailure`).
- `packages/core/src/brain.ts:74,229,251` -- `BrainDependencies`, `BrainSchedules`, `createBrain`. `packages/core/src/index.ts` export. `packages/second_brain/src/index.ts`는 재수출만.
- `apps/cli/src/assembly.ts:74` -- `brainDependencies`. 여기서 확장 runtime(패키지 source·migrator·launcher·inspector·timer)을 조립한다. 아무것도 열지 않는다.
- `apps/cli/src/commands/index.ts:44`, `schedules-add.ts`, `schedules-list.ts`, `apps/cli/src/dispatch.ts:222,253,342` -- CommandSpec·meta 전례. `guide-schema.ts`는 등록부를 그대로 보여 준다.
- `packages/core/src/codes.ts` -- `CODES`(예: `SCHEDULE_NOT_FOUND`, `CONFIG_MISSING`). 새 코드 셋을 더한다.
- `apps/cli/src/config/paths.ts:9,98`(`HOME_ENV`, `configHome`) -- 기본 홈 비교.
- `apps/cli/test/pg-home.ts:9`(`pgHome`), `temp-home.ts:7`(`tempHomes`), `environment.ts:37`(`withoutHarnessFolders`), `packages/postgres/test/cli.test.ts:18`(빌드된 CLI를 자식으로 부르는 `run`) -- 시험 기반 재사용. test-db 관리 URL은 `postgres://postgres:postgres@localhost:54329/...`.
- `apps/cli/test/command-meta.test.ts`, `guide.test.ts`, `output-language.test.ts` -- 새 명령이 자동으로 검사받는다(한국어 meta).

## Tasks & Acceptance

**Execution:**
- [x] `packages/postgres/migrations/0011_extension_registry.sql`, `packages/postgres/src/migrate.ts`, `packages/postgres/test/migrate*.test.ts` -- `brain.extensions(name pk + 이름 check, version, installed_at, enabled, enabled_changed_at, connection_status in ('connected','failed') null, connection_checked_at, connection_code, connection_message, status와 checked_at의 null 일치 check)`를 만들고 `CORE_SCHEMA_VERSION=11`, 고정 목록 시험을 갱신 -- registry의 유일한 저장 자리.
- [x] `packages/core/src/ports/store.ts`, `testing/fakes/store.ts`, `testing/contracts/extension-store.ts`(+index export), `packages/postgres/src/extensions.ts`, `packages/postgres/src/store.ts` -- `ExtensionStore`: `recordExtensionInstall({name, version, now})`(upsert: 처음이면 enabled=true·installed_at=now, 다시면 version만 갱신), `recordExtensionConnection({name, status, code, message, checkedAt})`, `getExtension(name)`, `listExtensions()`(이름순). `Store`에 포함. 계약을 fake와 PG에서 같이 돌린다 -- 사실을 따로 기록하는 port.
- [x] `packages/core/src/extensions/manifest.ts` -- 최소 코덱 `decodeExtensionManifest(text)`: 정확히 `name`·`version`(비지 않은 문자열)·`core`(=`EXTENSION_CORE_VERSION`=1)·`abi`(=1)·`migrations`(패키지 안 상대 경로)·`connection_check: { runtime: 'node', entry }`(패키지 안 상대 경로, `..`·절대 경로 금지). 모르는 키 거부. 이름 규칙 함수도 여기 -- 13.2가 넓힐 코덱의 씨앗.
- [x] `packages/core/src/extensions/check.ts` -- `runExtensionCheck({ launcher, inspector, clock, timer, spec, timeoutMs })`: 자식 하나를 띄워 stdout을 `createAbiRun`에, stderr를 `createAbiStderr`에 먹이고, 종료 또는 시간 초과(기본 60초) 뒤 `cleanProcessGroup`으로 그룹을 정리하고 `AbiRunVerdict`를 돌려준다. 시작 실패·시간 초과도 failed 판정으로 -- 감독자 부품의 일회성 사용.
- [x] `packages/core/src/extensions/install.ts`, `status.ts`, `packages/core/src/brain.ts`, `packages/core/src/index.ts`, `packages/core/src/codes.ts` -- port `ExtensionPackages { resolve(name) → {ok, dir, manifestText} | not found; place(name, dir) → installedDir }`, `ExtensionMigrator { apply(owner, directory) → MigrationResult 모양 }`, `ExtensionRuntime { packages, migrator, launcher, inspector, timer, databaseUrl() }`를 `BrainDependencies.extensions?`로 받는다. `brain.ext.install({name})`: 이름 검사 → resolve → manifest 검사 → place → migrate → `recordExtensionInstall` → 연결 확인(env: ABI env, kind `<name>.connection_check`, target `extension`/`<name>`, run generation `1`, work id·attempt token은 `idGen`) → `recordExtensionConnection` → 재조회. `brain.ext.status({name})`, `brain.ext.list()`. 코드 `EXTENSION_NOT_FOUND`(exit 2), `EXTENSION_INVALID`(exit 2), `EXTENSION_CHECK_FAILED`(exit 1). `extensions` 미조립이면 기존 설정 오류 코드로 실패 -- core use case와 SDK.
- [x] `apps/cli/src/runtime/extensions.ts`, `apps/cli/src/config/codec.ts`, `apps/cli/src/assembly.ts` -- 패키지 source: 앱의 `extensions/<name>/`(CLI dist 기준 앱 루트), 그리고 시험 resolver(`SECOND_BRAIN_TEST_EXTENSIONS`, 기본 홈 아닐 때만, 순수 함수 `testExtensionsFolder(home, env, defaultHome)`). place는 임시 폴더에 복사한 뒤 rename으로 `<home>/extensions/<name>/`를 바꾼다(`extensions/`는 0700). migrator는 런타임 URL의 host·port·db에 관리 사용자 `postgres`와 `BRAIN_POSTGRES_PASSWORD`(env 우선, 없으면 `.env`)를 끼운 관리 URL로 `runMigrations`. 자식 `node`는 `process.execPath`, entry는 설치 폴더 안 절대 경로 -- Runtime adapter.
- [x] `apps/cli/src/commands/ext-install.ts`, `ext-list.ts`, `ext-status.ts`, `apps/cli/src/commands/index.ts` -- `ns: 'ext'`, 한국어 meta, `install`(write)·`list`(read, `meta: {count}`)·`status`(read). data 모양 `{ name, installed, version, installed_at, enabled, connection: { status, checked_at, code, message } }`(snake_case, 시각은 `isoWithOffset`) -- CLI 1:1.
- [x] `apps/cli/test/fixtures/extensions/testext/` -- `manifest.json`, `migrations/0001_testext.sql`(`create schema testext; create table testext.checks(...)`), `bin/check.mjs`(의존 없는 ESM, ABI env를 검증하고 progress·result `{"abi":1,"type":"result","summary":"connected"}`를 내고 exit 0) -- 시험 전용 fixture.
- [x] `apps/cli/test/ext-fixture.ts` -- 재사용 시험 기반 `extHome()`: `tempHomes`로 홈, `pgHome`으로 격리 DB, `.env`에 `BRAIN_POSTGRES_PASSWORD`(test-db 관리 비밀번호) 추가, env(`SECOND_BRAIN_HOME`, `SECOND_BRAIN_TEST_EXTENSIONS`, `BRAIN_DATABASE_URL`, `withoutHarnessFolders`), 빌드된 CLI를 실제 자식으로 부르는 `run(args)`, `ledger(owner)` 조회, `cleanup()`(DB drop·홈 삭제) -- 13.2 이후가 다시 쓴다.
- [x] `packages/core/test/extensions.test.ts` -- fake로 matrix의 모르는 이름·잘못된 이름·manifest 불량·연결 실패·미설치 조회, manifest 코덱 단위, `runExtensionCheck`의 시간 초과(가짜 launcher/timer).
- [x] `apps/cli/test/ext-install.test.ts` -- PG 통합: 정상 설치·다시 설치·list·status·`guide schema ext`, 그리고 `testExtensionsFolder`가 기본 홈에서 꺼짐.

**Acceptance Criteria:**
- Given 빈 격리 홈과 시험 DB, when 실제 CLI 자식으로 `brain ext install testext --json`을 돌리면, then exit 0이고 `<home>/extensions/testext/manifest.json`이 있으며 `brain.schema_migrations`에 `owner='testext', version=1` 행이 하나 있다.
- Given 설치가 끝난 홈, when `brain ext status testext --json`을 부르면, then `data.installed=true`, `data.enabled=true`, `data.connection.status='connected'`이고 `checked_at`이 있다.
- Given 같은 홈, when `brain ext list --json`을 부르면, then `data`에 `name='testext'` 항목이 있다.
- Given 빌드된 CLI, when `brain guide schema ext --json`을 부르면, then `install`·`list`·`status` 세 verb가 보인다.
- Given 확장을 설치하지 않은 격리 홈, when `brain ext list --json`을 부르면, then 빈 목록이고 `<home>/extensions/`가 생기지 않는다.
- Given `pnpm test`, when 전체를 돌리면, then 기존 시험과 새 시험이 모두 통과한다(Python 요구 없음).

## Implementation Notes

- 구현 커밋 `1a65b1f`(codex 구현 세션). registry 작성과 재조회는 core use case가 하고, SDK는 `ext.install`·`ext.list`·`ext.status`를 낸다. CLI data는 snake_case이고 기존 envelope·코드 표를 쓴다.
- Runtime adapter는 manifest의 `node` 실행기를 `process.execPath`로 바꾸고, ABI 값은 자식 env로만 넘긴다. 패키지 배치는 임시 폴더에 복사한 뒤 rename하며, 패키지 루트와 하위의 심볼릭 링크를 거부한다.
- `extHome`은 운영 setup처럼 시험 DB의 owner를 `brain_owner`로 바꾼다(공용 test-db helper는 `postgres` owner로 DB를 만든다). 운영 setup 권한은 바꾸지 않았다.
- core 마이그레이션 0011과 새 코드 셋에 맞춰 schema 버전 기대값과 README 오류 코드 표를 갱신했다. baseline 마이그레이션과 ABI v1 schema·codec·fixture는 바꾸지 않았다.
- 구현 세션이 스스로 한 점검에서 두 가지를 고쳤다: (1) 재설치의 마이그레이션이 실패하면 이전 패키지를 되돌린다(배치 백업을 마이그레이션 결과까지 유지). (2) 자식의 오류 메시지를 NUL 정규화와 `failureText()`를 거쳐 저장한다. 둘 다 실제 CLI·PG 회귀 시험이 있다.
- 구현 세션이 plan frontmatter를 `status: done`·`review: quick`으로 바꾸고 Review Triage Log에 자체 점검을 적었으나, 상태는 orchestrator 소유이므로 되돌리고 그 내용을 위 항목으로 옮겼다.
- 검증(step-03): `pnpm test` — build·typecheck 통과, 128개 파일 3418개 시험 통과. Matrix 8행 모두 `packages/core/test/extensions.test.ts`·`apps/cli/test/ext-install.test.ts`의 실행된 시험이 덮는다.

## Plan Change Log

## Review Triage Log

### 2026-10-29 — Review pass
- verdicts: 22 findings — high 0, medium 6, low 12, false 4, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind) 같은 확장을 두 CLI가 동시에 설치하면 `pending`이 프로세스마다 따로라 서로의 패키지를 바꾸거나 지울 수 있다 — 실제 경합이지만 같은 확장을 동시에 설치하는 일은 일상에서 드물고, 고치려면 확장별 잠금이라는 새 상태가 필요하다. 중복 설치 방지는 13.5.
  - `[medium]` `[defer]` (blind) 일부 커밋된 재설치 마이그레이션 실패 뒤 이전 패키지 복원이 ledger와 설치본을 어긋나게 한다 — 확인함(migrator가 실패면 무조건 backup 복원). 실패·재개 정책은 의도가 13.5로 뺐으므로 frontmatter `deferred`에 기록.
  - `[medium]` `[defer]` (blind) 마이그레이션 뒤 `recordExtensionInstall` 실패 때 파일·DDL은 있고 registry는 미설치 — 확인함. 단계 결과·재개는 13.5 소관, `deferred`에 기록.
  - `[medium]` `[defer]` (blind) 연결 확인에 취소 경로가 없어 CLI 종료 때 detached 자식이 남는다 — 확인함(`detached: true`, signal 없음). 취소 보고는 13.5, `deferred`에 기록.
  - `[low]` `[patch]` (blind) manifest `version`의 NUL이 검증을 통과해 복사·DDL 뒤 PG 저장에서 실패한다 — `decodeExtensionManifest`가 제어 문자를 거부하고 core 시험 추가(`8176a1e`).
  - `[low]` `[patch]` (blind) `testExtensionsFolder`가 문자열 경로만 비교해 기본 홈을 가리키는 링크 홈에서 resolver가 켜진다 — `realpath` 비교(없으면 `resolve`)로 바꾸고 링크 홈 시험 추가(`8176a1e`).
  - `[low]` `[reject]` (blind) `connection_check.entry`의 존재를 마이그레이션 전에 확인하지 않는다 — 앱이 함께 내는 패키지만 설치하므로 드물고, 그 경우에도 설치·활성 뒤 연결 `failed`로 정확히 보고된다. 검사 단계를 더하는 것은 직접 수정이 아니다.
  - `[low]` `[patch]` (blind) `packages.resolve()`의 예외(`EACCES`·`EISDIR`)가 use case를 빠져나가 JSON envelope 없이 crash한다 — 확인함(dispatch는 예외를 crash 줄로 낸다). `installExtension`이 `EXTENSION_INVALID`로 바꾸고 아무것도 쓰지 않음, core 시험 추가(`8176a1e`).
  - `[low]` `[reject]` (blind) ABI 위반이나 출력 읽기 실패가 종료 대기를 깨우지 않아 최대 60초 기다린다 — 판정은 여전히 failed이고 시간 상한이 있다. 지연만 있고 드물며, 대기 경로를 더 바꾸는 것은 직접 수정이 아니다.
  - `[low]` `[defer]` (blind) stderr 진단을 버려 실패 원인이 registry에 남지 않는다 — 확인함. 저장하려면 registry 칼럼(공개 표면)이 필요하고 마지막 실패 보고는 의도상 13.5·13.6이므로 `deferred`에 기록.
  - `[low]` `[reject]` (edge) 동시 설치 경합 — 위 blind 첫 항목과 같은 원인, 같은 판단.
  - `[medium]` `[defer]` (edge) 일부 커밋 뒤 실패한 재설치의 패키지 복원 — 위 blind 항목과 같은 원인, 같은 `deferred` 항목.
  - `[low]` `[patch]` (edge) `version`의 NUL — 위 blind 항목과 같은 원인, 같은 수정.
  - `[low]` `[patch]` (edge) 링크 홈으로 기본 홈 보호 우회 — 위 blind 항목과 같은 원인, 같은 수정.
  - `[low]` `[patch]` (edge) 상대 `SECOND_BRAIN_HOME`이면 entry가 절대 경로가 아니고 `-`로 시작하면 node 옵션으로 읽힌다 — 확인함(`configHome`은 override를 그대로 돌려준다). `place()`가 `resolve()`한 절대 경로를 돌려주도록 수정(`8176a1e`).
  - `[medium]` `[patch]` (verification-gap) 패키지 안쪽 심볼릭 링크 거부가 시험되지 않는다 — 실제 폴더 안 `bin/check.mjs` 링크를 거부하고 `<home>/extensions`를 만들지 않는 시험 추가(`8176a1e`).
  - `[medium]` `[patch]` (verification-gap) 그룹 정리 `unknown`이 정상 ABI 결과를 실패로 바꾸는 판정이 시험되지 않는다 — inspector 그룹 `unknown`에서 `EXTENSION_CHECK_FAILED`와 재조회 `failed`/`PROCESS_DIED`를 확인하는 core 시험 추가(`8176a1e`).
  - `[false]` `[reject]` (intent) 연결 확인이 `runSupervisor`·실행 분류 등록부를 거치지 않는다 — 12.1 감독자의 launcher·inspector·ABI 수집·그룹 정리를 그대로 쓰고, 큐 경로는 AD-33(확장 일감은 데몬만 청구)과 두 번째 `runSupervisor`의 `reconcile()`이 데몬 시도를 정리하는 위험 때문에 plan이 막았다. 관찰 결과(실제 Node 자식의 ABI v1 결과가 registry에 남음)는 의도와 같다.
  - `[false]` `[reject]` (intent) `connected`가 실제 DB 연결이 아니라 ABI 성공이다 — 의도가 "정상 ABI 결과 한 건"을 요구하고, ABI v1 result에는 상태 칸이 없다. 판정 `succeeded` → `connected`가 의도한 매핑이다.
  - `[false]` `[reject]` (intent) 데몬·에이전트 세션의 환경 전달을 시험하지 않는다 — 의도가 "(10이 받는다)"로 13.10에 넘겼다.
  - `[low]` `[patch]` (intent) 기본 홈 resolver 꺼짐이 순수 함수로만 시험된다 — `HOME`을 임시 폴더로 둔 실제 CLI 자식에서 `EXTENSION_NOT_FOUND`와 `extensions/` 미생성을 확인하는 시험 추가(`8176a1e`).
  - `[false]` `[reject]` (intent) 운영 자원 이름 파생을 통한 격리를 시험하지 않는다 — 시험 격리는 `tempHomes`·`pgHome`의 임의 홈·임의 DB로 이미 운영과 분리된다. 의도의 요구는 격리된 PG와 Brain 홈이지 자원 이름 파생 경로의 시험이 아니다.


### 2026-10-29 — Review pass (후속)
- verdicts: 26 findings — high 0, medium 7, low 12, false 6, maybe-false 1
- findings:
  - `[low]` `[reject]` (blind 1) 동시 설치 경합 — carried: 기존 같은 위치·주장의 low/reject를 유지한다. 프로세스별 pending과 첫 await 전 예약 부재 모두 같은 잠금 부재이며, 드문 동시 설치를 위한 새 잠금 상태는 이번 직접 수정이 아니다.
  - `[medium]` `[defer]` (blind 2) 일부 마이그레이션 커밋 뒤 이전 패키지 복원 — carried: 기존 medium/defer를 유지한다. 실패 시 무조건 복원하는 코드가 그대로다. DW-22와 기존 frontmatter 항목을 수정하거나 다시 등록하지 않았다.
  - `[medium]` `[defer]` (blind 3) 마이그레이션 뒤 registry 쓰기 실패 — carried: 기존 medium/defer를 유지한다. migrate → recordExtensionInstall 순서가 그대로다. DW-23과 기존 frontmatter 항목을 수정하거나 다시 등록하지 않았다.
  - `[medium]` `[defer]` (blind 4) CLI 종료 뒤 detached 자식 잔류 — carried: 기존 medium/defer를 유지한다. 취소 신호가 없는 실행 경로가 그대로다. DW-24와 기존 frontmatter 항목을 수정하거나 다시 등록하지 않았다.
  - `[low]` `[defer]` (blind 5) stderr 진단 버림 — carried: 기존 low/defer를 유지한다. stderr.value()를 버리는 코드가 그대로다. DW-25와 기존 frontmatter 항목을 수정하거나 다시 등록하지 않았다.
  - `[low]` `[reject]` (blind 6) entry 존재 사전 확인 부재 — carried: 기존 low/reject를 유지한다. 앱 동봉 패키지의 없는 entry는 설치 뒤 연결 failed로 보고되며, 드문 패키지 불량에 새 사전 검사 단계를 더하지 않는다.
  - `[low]` `[reject]` (blind 7) 직접 SDK 호출의 schema guard 부재 — createBrain은 기존 다른 쓰기 SDK와 같이 조립된 port를 호출하고, CLI는 dispatch의 writes guard로 설치 전 checkSchema를 실행한다. 직접 SDK를 조립하면서 불일치 DB를 넘기는 경우는 드물며, 별도 SDK guard 정책과 분기를 이번 tracer에 추가하지 않는다.
  - `[low]` `[reject]` (blind 8) 설치 대상 extensions 링크를 따라감 — place의 mkdir/chmod/mkdtemp는 기존 대상 링크를 따른다. 사용자가 Brain 홈 안 설치 대상 폴더를 외부 링크로 미리 바꾼 경우에만 생기며, 링크 홈을 허용하는 기존 경로 정책에 새 대상 검사 분기를 더하는 수정은 일상 경로의 직접 수정이 아니다.
  - `[low]` `[reject]` (blind 9) 두 번째 databaseUrl 해석 예외 — migrator의 첫 URL 해석 후 .env가 사라지거나 권한이 바뀌면 설치 기록 뒤 두 번째 해석이 던질 수 있다. 짧은 설치 도중 외부 설정 변경이 필요한 드문 상황이며, 새 실패 저장·예외 분기를 추가하지 않는다.
  - `[false]` `[reject]` (blind 10) inspector 예외로 자식 정리 누락 — 실제 createProcessInspector.run은 execFile 실패를 resolve 값으로 반환하고 parseBootTime/parseStartedAt도 unknown으로 바꾼다. 지정된 기본 명령·인자에서 OS 조회 실패가 throw되는 경로는 없다. 예외를 던지는 별도 주입 adapter만으로 실제 런타임 결함은 입증되지 않는다.
  - `[low]` `[reject]` (edge 1) 동시 설치 경합 — carried: 기존 같은 위치·주장의 low/reject를 유지한다. blind 1과 같은 잠금 부재다.
  - `[low]` `[reject]` (edge 2) 원본 검증과 복사 사이 파일 교체 — checkTree와 cp 사이 원본을 별도 프로세스가 바꾸면 검증한 내용과 달라질 수 있다. 신뢰하는 앱 동봉 패키지 또는 격리 시험 fixture를 설치 중 동시에 변경해야 하므로 드물며, 복사 후 재검증·manifest 비교라는 새 분기를 더하지 않는다.
  - `[medium]` `[defer]` (edge 3) 일부 커밋 뒤 실패한 재설치 복원 — carried: 기존 medium/defer를 유지한다. blind 2와 같은 원인이다. DW-22를 수정하거나 다시 등록하지 않았다.
  - `[medium]` `[defer]` (edge 4) DDL 성공 뒤 registry 기록 실패 — carried: 기존 medium/defer를 유지한다. blind 3과 같은 원인이다. DW-23을 수정하거나 다시 등록하지 않았다.
  - `[low]` `[reject]` (edge 5) databaseUrl 예외 뒤 이전 연결 결과 잔류 — blind 9와 같은 두 번째 URL 해석 실패다. 첫 해석과 다음 해석 사이 .env 삭제·권한 변경이 필요하다. 드문 외부 변경에 새 실패 기록 분기를 추가하지 않는다.
  - `[medium]` `[defer]` (edge 6) SIGINT/SIGTERM 때 자식 그룹 잔류 — carried: 기존 medium/defer를 유지한다. blind 4와 같은 취소 경로 부재다. DW-24를 수정하거나 다시 등록하지 않았다.
  - `[low]` `[reject]` (edge 7) 없는 기본 홈의 부모 링크 별칭 비교 — realpath의 ENOENT fallback은 부모 링크까지 풀지 않아 순수 helper에서 별칭을 다르게 볼 수 있다. 다만 실제 ext install은 readConfig와 schema guard를 먼저 통과해야 하므로 존재하지 않는 기본 홈으로 설치하는 결과는 입증되지 않는다. 미설정 홈의 별칭 비교를 위한 새 경로 탐색 분기는 추가하지 않는다.
  - `[medium]` `[patch]` (verification-gap 1) 재설치에서 연결 결과가 바뀌는 경로의 검증 부재 — 정상 설치 후 source의 check.mjs를 ABI error로 바꾼 실제 CLI/PG 시험을 추가했다. 재설치 EXTENSION_CHECK_FAILED, 재조회 failed/REINSTALL_REFUSED와 최초 installed_at 보존을 확인한다.
  - `[low]` `[patch]` (verification-gap 2) 최초 마이그레이션 실패의 디스크 정리 검증 부재 — 첫 SQL이 실패하는 실제 CLI/PG 시험을 추가했다. MIGRATION_FAILED, registry·확장 ledger 행 부재, 설치 대상과 임시 폴더 부재를 확인한다. 일부 성공 뒤 실패하는 DW-22의 상태나 정책은 바꾸지 않았다.
  - `[false]` `[reject]` (intent 1) 감독자·실행 분류 등록부를 직접 경유하지 않음 — carried: 기존 감독자 경로 지적의 false/reject를 유지한다. 감독자 launcher·inspector·ABI·그룹 정리 부품 재사용이라는 기존 결정과 실제 Node 자식의 ABI v1 결과 기록 경로가 그대로다.
  - `[false]` `[reject]` (intent 2) 홈 기반 자원 이름 파생 미검증 — carried: 기존 격리 지적의 false/reject를 유지한다. tempHomes·pgHome이 운영과 분리된 홈·DB를 만들고 뒤 스토리에 재사용된다.
  - `[false]` `[reject]` (intent 3) connected가 실제 DB 접속을 증명하지 않음 — carried: 기존 false/reject를 유지한다. 티켓의 정상 ABI 결과 한 건 요구에 맞춰 succeeded를 connected로 기록한다.
  - `[false]` `[reject]` (intent 4) 데몬·에이전트 환경 전달 미검증 — carried: 기존 false/reject를 유지한다. 티켓이 10이 받는다고 명시했고, 현재 시험은 새 CLI 자식에서 같은 홈·resolver 환경을 사용한다.
  - `[false]` `[reject]` (intent 5) 완전히 미설정인 빈 홈부터 setup하지 않음 — 티켓은 확장 설치의 tracer이고 기본 Brain setup 구현을 요구하지 않는다. extHome이 준비한 확장 없는 홈에서 설치 전 status/list와 extensions 폴더 부재를 관찰하므로 기대한 설치 전 상태를 확인한다.
  - `[low]` `[reject]` (intent 6) plan에 개별 it 제목 부재 — plan에는 시험 파일과 실행 명령이 있고 개별 it 제목은 없다. 해결이 이번 build plan 편집뿐인 지적이므로 워크플로 규칙에 따라 거절한다.
  - `[maybe-false]` `[reject]` (intent 7) 한 세션 제한 준수 불확실 — diff만으로 한 세션의 경계나 초과 시점을 확인할 수 없으며, 확인하려면 이전 실행 시간과 작업 범위 기록이 필요하다. 관찰 가능한 tracer 동작의 실패가 제시되지 않아 if-true 영향은 low이며, 불확실한 low 항목은 거절한다.

## Design Notes

- **연결 확인을 큐에 넣지 않는 이유.** AD-33은 확장 *일감*을 데몬 감독자만 청구하게 한다. 연결 확인은 설치 흐름 안에서 즉시 결과가 필요한 단계이고, CLI가 두 번째 `runSupervisor`를 돌리면 그 `reconcile()`이 살아 있는 데몬의 시도를 다른 incarnation으로 보고 정리해 버린다. 그래서 감독자의 부품(ProcessLauncher/Inspector port, ABI 코덱, 그룹 정리)을 그대로 쓰는 일회성 실행 함수를 둔다. work id·attempt token 자리에는 이 확인 실행의 새 UUID를 넣는다(행이 없으므로 자식은 DB 시도 대조를 쓰지 않는다). 확장 일감을 데몬이 manifest로 띄우는 일은 13.5·13.6에서 붙는다.
- **관리 URL.** 확장 DDL은 `brain_owner`로 돌아야 하므로 `runMigrations`에 관리 연결을 준다. setup이 이미 `.env`에 `BRAIN_POSTGRES_PASSWORD`를 두므로 새 비밀은 없다. 런타임 URL의 host·port·database를 그대로 써서 시험 DB(임의 이름·54329)와 실제 홈(`brain`·홈 파생 포트)이 같은 코드로 풀린다.
- **자식 DB URL.** 13.1은 `brain_app` 런타임 URL을 넘긴다. `brain_ext_<name>` role URL로 바꾸는 일은 13.4다.
- **manifest 예**:
  ```json
  { "name": "testext", "version": "0.1.0", "core": 1, "abi": 1, "migrations": "migrations",
    "connection_check": { "runtime": "node", "entry": "bin/check.mjs" } }
  ```

## Verification

**Commands:**
- `pnpm build && pnpm typecheck` -- expected: 오류 없음
- `pnpm exec vitest run --project core test/extensions.test.ts test/contracts.test.ts` -- expected: 통과
- `pnpm exec vitest run --project postgres` -- expected: 통과(registry 계약, 0011 목록 포함)
- `pnpm exec vitest run --project cli test/ext-install.test.ts test/command-meta.test.ts test/guide.test.ts test/output-language.test.ts` -- expected: 통과(시험 DB는 global setup이 Docker로 띄우거나 `BRAIN_TEST_DATABASE_URL`)
- `pnpm test` -- expected: 전체 통과

## Auto Run Result

Status: built

**구현 요약:** 최소 manifest → `<home>/extensions/testext/` 배치 → core 실행기의 확장별 DDL → 설치·활성·연결 확인을 분리한 registry → 실제 Node 자식의 ABI v1 판정 → `brain ext install|list|status` 재조회 경로를 후속 thorough 리뷰했다. 기존 구현 커밋은 `1a65b1f067cf0fbe88920af81e22a5245be1973f`, 이전 리뷰 패치 커밋은 `8176a1e6c7a69be644392c79854341f41274cde2`다. 이번 실행은 제품 코드를 바꾸지 않고 두 실제 CLI/PG 회귀 시험을 보강했다.

**이번 변경 파일:**
- `apps/cli/test/ext-install.test.ts` — 재설치 때 연결 결과 갱신과 최초 DDL 실패 뒤 설치·임시 폴더 정리를 검증하는 시험 두 개를 추가했다.
- 이 plan — 후속 리뷰 26건의 개별 판정, 검증 결과와 후속 리뷰 권고를 기록했다. 티켓 상태 `built`와 기존 deferred 목록은 그대로다.
- `_bmad-output/personal-brain/deferred-work.md` — 실행 시작 때 이미 있던 오케스트레이터의 DW-22~25 추가 내용을 그대로 보존했다. 이번 실행에서 기존 항목의 본문·status·resolution을 쓰거나 다시 열거나 재등록하지 않았다.

**기존 구현 파일 묶음:**
- `packages/postgres/migrations/0011_extension_registry.sql`, `packages/postgres/src/migrate.ts` — registry 표와 core schema 버전 11.
- `packages/postgres/src/extensions.ts`, `store.ts` — PG ExtensionStore와 조립.
- `packages/core/src/extensions/` — 최소 manifest, 설치·조회 use case, 감독자 부품을 재사용하는 연결 확인.
- `packages/core/src/ports/store.ts`, `brain.ts`, `index.ts`, `codes.ts` — 저장 port, SDK와 오류 코드.
- `packages/core/src/testing/` — 메모리 fake와 PG에서도 실행하는 공통 계약.
- `apps/cli/src/runtime/extensions.ts`, `config/codec.ts`, `assembly.ts`, `doctor/store.ts` — 패키지 resolver·배치·관리 URL·런타임 조립.
- `apps/cli/src/commands/ext-install.ts`, `ext-list.ts`, `ext-status.ts`, `commands/index.ts` — 세 CLI 명령과 메타데이터.
- `apps/cli/test/ext-fixture.ts`, `fixtures/extensions/testext/` — 격리 홈·DB·실제 Node fixture와 정리 도구.
- core·PG·CLI 시험과 `README.md` — schema 버전·port·명령·오류 코드와 설치 동작 검증.

**후속 리뷰 결과:** 네 렌즈가 26건을 보고했다. 판정은 high 0, medium 7, low 12, false 6, maybe-false 1이다. 상세 근거는 바로 위 `## Review Triage Log` 후속 항목의 각 행에 있다.
- 패치 2묶음: medium 1(재설치 연결 재확인 시험), low 1(최초 DDL 실패 정리 시험). 제품 동작 변경은 없다.
- 기존 defer 판정 7행을 carried로 이어받았다. 같은 4개 원인의 기존 항목만 유지했고 새 deferred 항목은 없다.
- 거절 17행: 동시 설치 2행은 드문 경합과 새 잠금 필요, entry 사전 확인은 이미 연결 failed로 보고, SDK schema guard는 CLI의 기존 보호와 직접 조립 호출의 드문 전제, 대상 링크는 사용자의 사전 외부 링크 구성, URL 재해석 2행은 설치 중 외부 설정 변경, 원본 교체는 설치 중 동시 변경, 없는 홈 별칭은 실제 설치 전 config/schema 검사라는 이유로 새 분기를 추가하지 않았다. inspector 예외는 실제 adapter의 값 반환이 반증한다. 감독자·격리·connected·환경 전달 4행은 기존 false 판정을 유지했다. 빈 홈은 준비된 Brain의 확장 없는 홈으로 검증하며 setup 자체는 범위가 아니다. 개별 시험 제목은 plan만 편집하는 지적이어서 거절했고, 한 세션 제한은 diff로 확인할 수 없는 low 영향 주장이라 거절했다.

**후속 리뷰 권고:** `false`. 이번 실행은 built plan의 후속 리뷰이며 패치한 high 항목이 없다. 패치한 묶음은 high 0, medium 1, low 1이다.

**검증:**
- 패치 전 `pnpm test`: build·typecheck 성공, 128개 파일 3433개 시험 통과.
- 구현 세션의 `pnpm exec vitest run --project cli test/ext-install.test.ts`: 실제 CLI·PG 시험 11개 통과.
- 패치 후 `pnpm test`: build·typecheck 성공, 128개 파일 3435개 시험 통과. plan의 개별 core·PG·CLI 검증 명령이 지정한 시험도 이 전체 실행에 포함된다.
- 기본 Node/PG suite만 사용했으며 Python·Garmin·실계정은 사용하지 않았다.
- 원장 전체 바이트와 plan의 기존 deferred 블록을 실행 전 사본과 비교해 동일함을 확인했다. `tickets.py mark`는 실행하지 않았고 티켓과 plan을 done으로 바꾸지 않았다.

**남은 위험:** 기존 DW-22~25(부분 커밋 실패 복원, registry 기록 실패, CLI 취소 시 자식 정리, stderr 진단)는 오케스트레이터가 관리한다. 자식의 확장 전용 role은 13.4, 단계 보고·재개는 13.5, 공개 상태 view는 13.6, 데몬·에이전트 환경 전달은 13.10 범위다. 사람의 결정이 필요한 새 차단 조건은 없다. 최종 완료 판정은 오케스트레이터 검증에 맡긴다.
