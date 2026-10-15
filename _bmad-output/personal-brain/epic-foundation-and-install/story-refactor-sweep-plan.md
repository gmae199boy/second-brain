---
title: 'Refactor sweep: 에픽 1 동안 미룬 정리'
type: 'refactor'
ticket: '9'
created: '2026-10-15'
status: done
baseline_revision: 'cc732119e2c21cb1682eabebaa5ce3d0d23e369c'
route: 'full'
route_source: 'auto'
risk: 'low'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 에픽 1 빌드 리뷰가 "story 9 후보"로 남긴 정리가 쌓였다: 테스트 파일이 타입 검사되지 않고(sqlite 테스트에 TS 오류 2개가 이미 숨어 있다), 디스패처의 hook/command busy 예산 분기를 검사하는 테스트가 없고, `closedPort()`가 postgres 테스트 두 파일에 복사돼 있고, 스키마 불일치 메시지가 없는 명령 `brain setup upgrade`를 안내한다.

**Approach:** 동작을 바꾸지 않는 정리만 한다: 테스트까지 타입 검사하는 단계를 `pnpm test`에 넣고, 디스패처에 store 생성 주입 seam을 더해 예산 분기를 테스트하고, 중복 헬퍼를 한 파일로 모으고, 안내 문구를 실제 있는 `brain setup run`으로 바꾼다.

## Boundaries & Constraints

**Always:** 기존 테스트는 모두 그대로 통과한다(문구 단정만 새 문구로). 새 seam은 선택 필드이고 기본값이 지금 동작(`sqliteStore`)과 같다. core는 런타임 의존성 0을 유지한다. 패키지 의존 경계(`packages/second_brain/test/boundaries.test.ts`)를 건드리지 않는다.

**Never:** 티켓 파일(`tickets.toml`) 수정. Postgres 복제본 trigger·`index_configs`·`redactions` 스키마 변경(epic 7·2). 다른 불변 테이블 trigger 추가. 설치기 설정 부분 읽기·모르는 키 보존(Decision 2026-10-15: 행동 변경이라 제외, epic 2 첫 스토리나 별도 버그 티켓 몫). 공개 표면(`second_brain` export) 추가. 빌드 산출물(`dist/`) 구성 변경.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| hook 명령 | `hook: true` spec을 설정 있는 home에서 dispatch | 주입된 store 생성기가 `busyTimeoutMs = BUSY_TIMEOUT_MS.turn`으로 불린다 | 없음 |
| 일반 명령 | `hook` 없는 DB 명령 | 같은 생성기가 `BUSY_TIMEOUT_MS.command`로 불린다 | 없음 |
| 스키마 불일치 | DB가 기대와 다른 버전 | 메시지가 `brain setup run`을 안내하고 `setup upgrade`는 없다 | `SCHEMA_MISMATCH` 코드 그대로 |
| 테스트 타입 오류 | 테스트 파일에 TS 오류 | `pnpm test`가 vitest 전에 실패한다 | tsc 오류 출력 |

</frozen-after-approval>

## Code Map

- `tsconfig.base.json`, 각 패키지 `tsconfig.json` -- 모두 `include: ["src"]`; build 설정은 바꾸지 않는다. core는 `types: []`(node 타입 금지)이므로 테스트 검사가 core src에 node 타입을 섞지 않게 한다.
- `package.json` -- `"test": "pnpm build && vitest run"`. 타입 검사 단계를 build와 vitest 사이에 넣는다. 테스트가 있는 곳: `packages/{core,sqlite,postgres,second_brain}/test`, `apps/cli/test`, `tooling/bootstrap/test`(test-db는 없음).
- `packages/sqlite/test/schema-files.test.ts:893`, `packages/sqlite/test/schema.test.ts:876` -- 현재 유일한 테스트 TS 오류 2개(TS2345: 사례 배열의 `row` 합집합이 `Readonly<Record<string, string | number | null>>`에 안 맞음). 사례 배열 타입을 명시해 고친다.
- `apps/cli/src/dispatch.ts:161` `DispatchRuntime`, `:287-291` -- store 생성 지점(`sqliteStore({ path, busyTimeoutMs })`). seam은 `DispatchRuntime`의 선택 필드로 둔다.
- `apps/cli/test/dispatch.test.ts` -- 지금은 빌드된 CLI를 subprocess로 돈다. 새 예산 테스트는 `../src/dispatch.js`를 in-process로 import하고 테스트 전용 registry를 넘긴다.
- `packages/postgres/test/store.test.ts:9`, `packages/postgres/test/migrate.test.ts:73` -- 같은 `closedPort()`. `packages/postgres/test/` 안 공용 파일 하나로 옮긴다(test-db export 추가 아님).
- `packages/core/src/schema.ts:46` -- `Run \`brain setup upgrade\`.` 문구. 단정: `packages/core/test/schema.test.ts:27`, `apps/cli/test/admin-doctor.test.ts:294`. `schema.ts:24`·`sqlite/src/migrate.ts:90`·`postgres/src/migrate.ts:77`·`domain/schema-version.ts:3`의 "setup upgrade" 주석은 미래 epic 5 계획을 말하므로 그대로 둔다.
- 이미 해결돼 범위 밖: node minor 하한은 story 1.8 doctor `NODE_FLOOR = '24.16.0'`이 강제한다.

## Tasks & Acceptance

**Execution:**
- [x] `tsconfig.test.json`(루트, 신규) + `package.json` -- 모든 `*/test`를 `noEmit`으로 검사하는 설정과 `typecheck` 스크립트, `test`를 `pnpm build && pnpm typecheck && vitest run`으로 -- 숨은 테스트 TS 오류를 막는다.
- [x] `packages/sqlite/test/schema-files.test.ts`, `packages/sqlite/test/schema.test.ts` -- 사례 배열 타입 명시로 TS2345 2건 해소 -- 단정 내용은 그대로.
- [x] `apps/cli/src/dispatch.ts` -- `DispatchRuntime`에 선택 store 생성기, 기본 `sqliteStore` -- 예산 분기 관찰 지점.
- [x] `apps/cli/test/dispatch.test.ts` -- I/O 표 hook/일반 두 행 테스트.
- [x] `packages/postgres/test/closed-port.ts`(신규), `store.test.ts`, `migrate.test.ts` -- 중복 제거.
- [x] `packages/core/src/schema.ts`, `packages/core/test/schema.test.ts`, `apps/cli/test/admin-doctor.test.ts` -- 안내를 `brain setup run`으로, 단정에 `setup upgrade` 부재 추가.

**Acceptance Criteria:**
- Given 테스트 파일에 타입 오류를 하나 넣었을 때, when `pnpm test`, then vitest 전에 tsc가 실패한다(확인 뒤 되돌림).
- Given 정리 후 저장소, when compose PG와 함께 `pnpm test`, then 전 프로젝트 통과하고 `boundaries.test.ts`도 통과한다.
- Given 임시 home, when 에픽 Done when 1~5를 다시 실행(npx 테스트, `setup run --yes` 두 번 + `cmp`, `admin doctor --json`과 DB 파일 삭제 시 `DB_UNAVAILABLE`, messages UPDATE 거부, `second_brain` import 부작용 테스트), then 모두 통과한다.

## Implementation Notes

- `tsconfig.test.json`은 `types: ["node"]`로 모든 `*/test`를 검사한다. 테스트가
  `../src/...`를 import하므로 src도 함께 들어오지만, 한 소스가 무엇을 쓸 수 있는지는
  먼저 도는 `pnpm build`의 패키지별 설정이 정한다(core는 여전히 `types: []`).
- TS2345 2건은 `it.each<{ name: string; table: string; row: Row }>([...])`로 해소했다.
  타입이 없으면 TS가 사례들을 합집합으로 만들어 빠진 컬럼을 `undefined`로 채우고,
  그 `undefined`가 `Row`에 안 맞는 것이 원인이었다.
- 디스패처 seam은 `DispatchRuntime.createStore?: CreateStore`이고 기본값은
  `sqliteStore`. `execute()`가 인자로 받아 쓰므로 주입하지 않은 경로는 그대로다.
  예산 테스트는 subprocess 대신 in-process로 `../src/dispatch.js`를 import한다
  (하위 프로세스에서는 예산을 볼 수 없다). 분기를 뒤집어 보니 두 테스트가 실패해
  실제로 분기를 지킨다.
- `packages/postgres/test/setup.test.ts`의 `closedUrl()`은 포트가 아니라 URL을
  돌려주는 다른 함수이고 플랜 작업 목록에 없으므로 손대지 않았다.
- 문구는 방향에 따라 갈린다(리뷰 지적): 마이그레이션은 앞으로만 가고
  `runSqliteMigrations`는 저장된 버전 이하 파일을 건너뛰므로, `found > expected`
  (DB가 빌드보다 새로움)에는 실행할 명령이 없다 -- "This build is older than the
  database: install a newer build."라고만 말한다. `found < expected`와 `null`은
  `brain setup run`을 안내한다. src 주석의
  "setup upgrade"(schema.ts:24, sqlite/postgres migrate, domain/schema-version)는
  플랜대로 epic 5 계획 서술이므로 그대로 둔다.

## Plan Change Log

## Review Triage Log

### Pass 1 (2026-10-15, lens: quick) — high 0 / medium 1 / low 2 / false 0 / maybe-false 0

| # | 발견 | 판정 | 경로 | 증거 |
| --- | --- | --- | --- | --- |
| 1 | DB가 코드보다 새 버전이면(`found > expected`) 새 문구가 `brain setup run`을 안내하지만, `runSqliteMigrations`는 `file.version <= stored`를 모두 건너뛰어 아무것도 하지 않는다 | medium | patch | `packages/sqlite/src/migrate.ts` 133행 확인. 이 변경이 들인 잘못된 안내다. 새 DB 쪽은 "이 빌드가 DB보다 오래됐다, 새 빌드를 설치하라"로 따로 쓰고 테스트 한 건 추가 |
| 2 | "still uses sqliteStore when nothing is injected" 테스트가 exit 0과 파일 미생성만 봐서 이름이 약속하는 것을 증명하지 못한다 | low | patch | 코드 확인. 실제 기본 경로는 subprocess 테스트가 덮는다. 제목을 증명하는 내용대로 바꾸는 직접 수정 |
| 3 | hook 예산 테스트의 `expect(exit).toBe(0)`은 hook이면 늘 0이라(`dispatch.ts:253`) 아무것도 단정하지 않는다 | low | patch | 코드 확인. 한 줄 삭제 |

경로 요약: intent_gap 0, bad_plan 0, patch 3(1·2·3), defer 0, 거절 0.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck` -- expected: 오류 없음
- `docker compose -f compose.test.yaml up -d --wait && BRAIN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres pnpm test; docker compose -f compose.test.yaml down` -- expected: 전 프로젝트 통과
- 임시 `SECOND_BRAIN_HOME`에서 `setup run --yes` 두 번 후 `cmp`로 config·shim 비교, `<home>/bin/brain admin doctor --json` exit 0, `brain.db` 삭제 뒤 exit 1 `DB_UNAVAILABLE` -- expected: Done when 2·4
- `git status --short` -- expected: `dist/`·`*.db`·`tsconfig.scratch` 없음

**Results (2026-10-15):**
- `pnpm build && pnpm typecheck` -- 오류 없음.
- `docker compose -f compose.test.yaml up -d --wait` + `BRAIN_TEST_DATABASE_URL=... pnpm test`
  -- 27 test files / 665 tests 통과(`boundaries.test.ts` 포함). compose는 내렸다.
- 테스트 파일에 일부러 `const deliberate: number = 'not a number'`를 넣고 `pnpm test`
  -- vitest가 돌기 전에 `tsc -p tsconfig.test.json`이 TS2322로 멈췄다. 되돌렸다.
- 임시 `SECOND_BRAIN_HOME`: `setup run --yes` 두 번 -> `cmp`로 `config.toml`·`bin/brain`
  동일, `bin/brain admin doctor --json` exit 0(모든 check ok), `brain.db` 삭제 뒤
  exit 1 + `db:fail DB_UNAVAILABLE` + `warnings: ["DB_UNAVAILABLE"]`이고 파일은
  다시 만들어지지 않았다. `schema_version`을 +1 한 뒤 doctor detail은
  "... Run \`brain setup run\`."로 나온다.
- `git status --short` -- 소스 변경과 새 파일(`tsconfig.test.json`,
  `packages/postgres/test/closed-port.ts`)뿐, `dist/`·`*.db`·scratch 설정 없음.
- 빈 DB에 대고 손으로 해 본 `delete from messages`는 행이 없어 trigger가 안 울린다
  (정상). 행이 있는 상태의 UPDATE·DELETE 거부는 `packages/sqlite/test/schema.test.ts`가
  검사하고 통과한다. Done when 1(npx)과 5(import 부작용)도 자동 테스트
  (`tooling/bootstrap/test/npx.test.ts`, `packages/second_brain/test/import-side-effects.test.ts`)로
  통과했다.
