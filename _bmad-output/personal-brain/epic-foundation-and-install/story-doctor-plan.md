---
title: 'doctor 틀 완성 — 점검 등록 구조와 store·스키마·shim·node·설정 항목'
type: 'feature'
ticket: '8'
created: '2026-10-14'
status: done
baseline_revision: '276415a06bc92e04c4b798458ae5bfe45f7daf2a'
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

**Problem:** `brain admin doctor`는 지금 store 탐침(`db`·`wal`·`fts5-trigram`·`foreign-keys`)만 보인다. DB 파일이 읽기 전용이어도 모두 ok로 나오고(실측: `mode=rw`가 조용히 읽기 전용으로 열림), 스키마 버전·shim·node·설정은 보지 않는다. 이후 에픽(spool·주입·내보내기·복제 지연)이 항목을 더할 자리도 없다.

**Approach:** Core `runDoctor`가 store 항목 뒤에 스키마 버전 항목과, 주입받은 점검 목록(`DoctorCheckSource`)을 차례로 돌리게 한다. SQLite adapter에 `writable` 탐침을 더하고, CLI 런타임은 `config`·`shim`·`node-path`·`node-version` 점검을 등록부 하나에 모아 디스패처와 설치기가 같은 목록을 쓰게 한다.

## Boundaries & Constraints

**Always:**
- doctor는 던지지 않는다. 점검 하나가 던지면 그 id의 `fail`(detail = 한 줄 사유)이 되고 나머지는 계속 돈다. 실패가 하나라도 있으면 exit 1, 봉투는 ok.
- 읽기는 읽기로 남는다: `writable` 탐침은 `begin immediate; create table main.brain_probe_writable(x); rollback`이고 아무것도 남기지 않는다. doctor는 DB 파일을 만들지 않는다.
- 스키마 버전 항목은 Core `checkSchema(store, expected)`를 쓰고, 불일치는 `fail` + code `SCHEMA_MISMATCH`(경고 코드라 `warnings[]`에도 실림). `db`가 실패하면 스키마 항목은 내지 않는다(아는 것이 없으므로, 기존 원칙과 같음).
- node 하한은 상수 하나(`24.16.0`)이고, 테스트가 루트 `package.json`의 `engines.node`와 같은지 확인한다.
- `shim` 항목: `<home>/bin/brain`이 있고, 실행 가능하고, 서명 줄이 있고, 담긴 CLI 진입 파일이 있다. 없으면 `fail`이고 `node-path`는 `skip`.
- `node-path` 항목: shim에 적힌 node가 있고 실행되며 `--version`이 하한 이상(2초 타임아웃). `node-version` 항목: 지금 도는 node가 하한 이상.
- 설치기의 마지막 doctor도 같은 점검 목록을 쓴다(설치 대상 home·store 경로 기준).
- Decision(2026-10-14): 설정이 없거나 깨져도 doctor만은 돈다(스펙 플래그 `diagnostic: true`, 다른 명령은 지금처럼 exit 2). 그때 `config`는 fail + `CONFIG_MISSING`/`CONFIG_INVALID`, `db`는 fail `DB_UNAVAILABLE`("설정이 없어 DB 위치를 모름"), shim·node 항목은 그대로 돌고 exit 1. 설정이 정상이면 `config`는 ok + 설정 파일 경로.
- Decision(2026-10-14): 플랜 크기(약 2,900 토큰)는 단일 목표(doctor 틀)이고 Core·adapter·CLI가 따로 낼 수 없게 묶여 있으므로 분할하지 않는다.

**Never:**
- pgvector·임베딩 항목(epic 6·7), spool·주입·내보내기·hook 수신 시각(epic 2·3·5), 복제 지연(epic 7).
- 점검이 무언가를 고치는 것(권한 변경, 파일 생성, 마이그레이션).
- Harness별 connector 점검(등록부가 비어 있음, epic 2).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 정상 | 설치 직후 home | 모든 항목 ok, exit 0 | — |
| DB 없음 | `brain.db` 삭제 | `db` fail `DB_UNAVAILABLE`, 스키마·탐침 항목 없음, 파일 재생성 없음 | exit 1 |
| 읽기 전용 | `chmod 444 brain.db` | `writable` fail(사유 한 줄), 다른 탐침 ok | exit 1 |
| 스키마 불일치 | `schema_version.version`을 1로 | `schema-version` fail `SCHEMA_MISMATCH` | exit 1, warnings에 코드 |
| shim 없음 | `bin/brain` 삭제 | `shim` fail, `node-path` skip | exit 1 |
| node 경로 틀림 | shim의 node를 `/nonexistent/node`로 | `node-path` fail | exit 1 |
| 설정 없음·깨짐 | `config.toml` 삭제 또는 상대 경로 | `config` fail `CONFIG_*`, `db` fail `DB_UNAVAILABLE`, shim·node 항목은 평소대로 | exit 1 (exit 2 아님) |
| 다른 명령 + 깨진 설정 | 같은 상태에서 doctor 외 명령 | 지금처럼 `CONFIG_*` | exit 2 |
| 점검이 던짐 | 등록된 점검이 예외 | 그 id fail, 나머지 계속 | exit 1 |

</frozen-after-approval>

## Code Map

- `packages/core/src/admin/doctor.ts` -- `runDoctor(store, options)`로 넓힌다: `options = { schemaVersion: number; checks?: readonly DoctorCheckSource[] }`. 순서: `db` → adapter 탐침 → `schema-version`(`checkSchema` 재사용, `../schema.js`) → 등록 점검. `DoctorCheckSource = { id: string; run(): Promise<DoctorCheck> }`를 여기 정의·export. store 타입은 `HealthStore & SchemaStore`.
- `packages/core/src/brain.ts` -- `BrainDependencies`에 `schemaVersion`·`checks?`, store 타입 `HealthStore & SchemaStore`. `packages/core/src/index.ts`에 `DoctorCheckSource` export.
- `packages/core/test/doctor.test.ts` -- fake store에 `readSchemaVersion` 추가, 스키마 일치·불일치·db 실패 시 생략, 점검이 던질 때 fail로 바뀌는 사례. 기존 fakes(`src/testing/fakes/schema-store.ts`) 재사용 가능.
- `packages/sqlite/src/store.ts` -- `writableProbe`를 `walProbe` 앞에 더한다(기존 `probe()` 헬퍼). `packages/sqlite/test/`의 store 테스트에 읽기 전용 파일 사례(파일을 0444로, 끝에 되돌림).
- `packages/postgres/src/store.ts` -- 이미 `HealthStore & SchemaStore`라 변경 없음. 손대지 않는다.
- `apps/cli/src/install/shim.ts` -- `parseShim(text): { node; bin; home } | undefined`를 `renderShim` 옆에 더한다(`'\''` 이스케이프의 역). round-trip 테스트를 `test/shim.test.ts`에.
- `apps/cli/src/doctor/checks.ts` (새) -- 런타임 점검 등록부 `runtimeChecks({ home })`: `config`, `shim`, `node-path`, `node-version`. 머리 주석에 "이후 에픽은 여기에 더한다"(connectors/index.ts 문체). `NODE_FLOOR = '24.16.0'`과 작은 버전 비교 함수. node 실행은 `execFile` 주입 가능하게(테스트 seam).
- `apps/cli/src/dispatch.ts` L265 -- `createBrain({ store, schemaVersion: SQLITE_SCHEMA_VERSION, checks: runtimeChecks({ home }) })`. `DatabaseCommandSpec`에 `diagnostic?: boolean`을 더하고, 설정 읽기가 실패하면 그 스펙에 한해 `failedConfigStore(message)`(항상 `DB_UNAVAILABLE`을 답하는 `HealthStore & SchemaStore`, `apps/cli/src/doctor/`)와 실패 결과를 담은 `runtimeChecks`로 진행한다. `admin-doctor.ts`가 `diagnostic: true`. `runtimeChecks({ home, config })`는 `readConfig` 결과를 받아 `config` 항목을 만든다.
- `apps/cli/src/commands/admin-doctor.ts` -- 머리 주석의 "story 8 adds…"만 고친다. 형식·경고 변환은 그대로.
- `apps/cli/src/install/store.ts` `doctorAt(path)` → `doctorAt(home, path)`가 같은 `runtimeChecks`와 `SQLITE_SCHEMA_VERSION`을 쓴다. `install/flow.ts` L245와 `InstallDeps.store.doctor` 시그니처, `install.ts` L125, `test/install-flow.test.ts` L335 fake를 함께 고친다.
- `apps/cli/test/admin-doctor.test.ts` -- `CHECKS` 순서 갱신, I/O 표의 행을 빌드된 `dist/bin.js`로(기존 `configuredHome`·`runBrain` 본보기). shim이 필요한 행은 `writeShim(home)`으로 만든다.
- `README.md` "Check the install" 절 -- 새 항목 목록.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/admin/doctor.ts`, `brain.ts`, `index.ts` (+`test/doctor.test.ts`) -- 스키마 항목과 점검 등록 구조
- [x] `packages/sqlite/src/store.ts` (+store 테스트) -- `writable` 탐침
- [x] `apps/cli/src/install/shim.ts` (+`test/shim.test.ts`) -- `parseShim`
- [x] `apps/cli/src/doctor/checks.ts` (새, +`test/doctor-checks.test.ts`) -- 런타임 점검 4개, 하한 상수와 `package.json` 일치 테스트
- [x] `apps/cli/src/dispatch.ts`, `commands/admin-doctor.ts`, `install/store.ts`, `install/flow.ts`, `install.ts` -- 같은 목록 연결
- [x] `apps/cli/test/admin-doctor.test.ts`, `test/install-flow.test.ts` -- I/O 표 행
- [x] `README.md` -- 점검 항목 설명

**Acceptance Criteria:**
- Given 빈 home에 `setup run --yes`, when `env -u SECOND_BRAIN_HOME <home>/bin/brain admin doctor --json`, then exit 0이고 `db`·`writable`·`wal`·`fts5-trigram`·`foreign-keys`·`schema-version`·`config`·`shim`·`node-path`·`node-version`이 모두 ok다.
- Given `apps/cli/src`, when 새 점검을 하나 더하려 하면, then `doctor/checks.ts`의 목록 한 곳만 고치면 디스패처와 설치기 둘 다에 나타난다(테스트가 두 경로의 id 목록이 같음을 확인).
- Given compose PG, when `pnpm build && pnpm test`, then 전부 통과한다.

## Implementation Notes

- `runDoctor(store, options)`의 등록 점검은 `db`가 실패해도 돈다. 플랜의 "설정 없음" 행이 요구하는 동작이고, DB가 안 잡힐 때야말로 shim·node 사실이 필요하다. 스키마 항목만 생략된다.
- `writable` 탐침은 Kysely가 아니라 `connection.database`(raw `DatabaseSync`)로 `begin immediate`/`create table`/`rollback`을 돌린다. 트랜잭션 제어는 한 커넥션의 일이고, `sql`.execute(db)로 쪼개면 Kysely의 커넥션 획득과 섞인다. `rollback`은 `finally`에서, 트랜잭션이 없을 때의 예외는 삼킨다(`begin immediate` 자체가 실패한 경우).
- `writable` 탐침은 기다리지 않는다: `pragma busy_timeout = 0`으로 낮추고 `finally`에서 호출자 budget으로 되돌린다. 다른 프로세스가 쓰기 락을 쥐고 있으면(`isBusy`) `fail`이 아니라 `ok` + "writability was not tested"다 — 쓰는 중인 브레인은 못 쓰는 브레인이 아니고, 권한 질문 하나가 명령 lock budget(10s)을 다 쓰면 안 된다. 실측: hold 2000ms에 `checkHealth` 1ms(`store.test.ts`, lock-holder 서브프로세스).
- sidecar 경로는 detail에 넣지 않았다. detail은 SQLite의 한 줄 사유(`attempt to write a readonly database`)만 담고, sidecar 함정은 `writableProbe` 머리 주석과 README("Check the install" 절 끝)에 적었다.
- `parseShim`은 서명 줄을 요구하지 않는다(순수 구조 파싱). `shim` 점검이 서명을 따로 보므로, "서명이 없다"와 "읽을 수 없다"가 서로 다른 한 줄로 나온다. 다만 exec 줄 끝은 정확히 ` "$@"`여야 한다 — 인자를 넘기지 않는 shim은 모든 hook을 명령 없는 맨 `brain`으로 돌린다.
- `shim` 점검은 shim이 담은 home이 지금 보는 home과 다르면 fail하고 두 폴더를 모두 적는다. 남의 설치본 shim이 이 자리에 있으면 hook이 조용히 다른 브레인에 쓴다.
- `ShimState`는 `{ path; shim?; message? }`로 둘이 독립이다. 파싱은 됐지만 못 쓰는 경우(실행 불가·서명 없음·home 불일치·진입 파일 없음)엔 node 이름을 알고 있으므로 `node-path`를 그대로 돌린다. `skip`은 읽기 실패와 파싱 실패 둘뿐이다.
- `DatabaseCommandSpec.diagnostic`을 더하면서 `CommandContext.config`가 `BrainConfig | undefined`가 됐다. 설정 없이 도는 명령에 `BrainConfig`를 줄 수는 없고, 스펙별 context 타입 분기는 레지스트리를 둘로 쪼갠다. 주석에 "diagnostic 명령만 undefined를 본다"를 명시.
- `runtimeChecks({ home, config? })`: `config`를 안 주면 점검이 스스로 `readConfig(home)`을 한다. 디스패처는 이미 읽은 결과를 넘기고(두 번 읽으면 서로 다른 말을 할 수 있다), 설치기는 생략한다 — 그래서 두 경로의 id 목록이 같다.
- 설정을 못 읽을 때 `db` detail은 "the configuration could not be read, so the database location is unknown"뿐이고 `config.message`를 끼워 넣지 않는다 — 같은 문장이 한 리포트에 두 번 나오면 문제가 두 개로 읽힌다. 사유는 `config` 항목이 담는다.
- `shim`과 `node-path`는 `once()`로 memoize한 한 번의 shim 읽기를 공유한다. 한 리포트가 한 파일에 대해 두 말을 하지 않도록. 테스트는 `shim.run()` 뒤 파일을 지우고 `node-path.run()`이 그대로 ok인지로 확인한다.
- node 실행 seam은 `RunNode = (path) => Promise<NodeRun>` (기본값은 `execFile` + 2초 타임아웃). `--version`이 버전이 아닌 답을 줄 때도 fail로 처리.
- 기존 shim 테스트 3개(`the shim, run as a hook would run it`)는 "설정 없는 home에서 doctor가 exit 2 + CONFIG_MISSING 봉투"를 shim 도달 증거로 쓰고 있었다. doctor가 diagnostic이 되면서 exit 1 + `config` 점검 detail로 바꿨다 — 증명하는 사실(shim이 CLI에 닿고 이 home을 가리킨다)은 같다.
- `apps/cli/src/doctor/store.ts`의 `failedConfigStore`는 `HealthStore & SchemaStore` 둘 다에 `DB_UNAVAILABLE`로 답한다. 아무것도 열지 않고 아무것도 만들지 않는다(디스패처 테스트가 폴더가 비어 있음을 확인).

## Plan Change Log

## Review Triage Log

### Pass 1 (2026-10-14, lens: quick) — high 0 / medium 3 / low 11 / false 0 / maybe-false 0

| # | 발견 | 판정 | 경로 | 증거 |
| --- | --- | --- | --- | --- |
| 1 | 다른 프로세스가 쓰기 잠금을 쥐면 `writable`이 10초 기다린 뒤 "database is locked"로 fail(쓰는 중인 정상 brain을 고장으로 보고), doctor가 잠금을 쥐어 hook 쓰기를 밀어낼 수 있음 | medium | patch | 리뷰어가 두 번째 프로세스로 재현(12초, exit 1). 탐침만 busy_timeout 0, busy면 "검사 못 함" ok로 |
| 2 | shim을 읽고 파싱했는데 실행 권한·서명·진입 파일 실패일 때 `node-path`가 "the shim could not be read" skip | medium | patch | `chmod 644` 재현. 파싱된 node가 있으면 node-path를 돌린다 |
| 3 | 다른 설치의 home을 담은 shim이 `shim: ok` | medium | patch | 설치 A의 shim을 B에 복사해 재현. `ParsedShim.home` 비교 |
| 4 | `parseShim`이 `"$@"` 없는 exec 줄도 받아들임 | low | patch | 재현(USAGE). 나머지가 정확히 ` "$@"`인지 확인하는 직접 수정 |
| 5 | shim이 진입 파일 대신 폴더를 가리켜도 통과 | low | 거절 | 손으로 고친 shim에서만 생기고, 고치려면 stat 분기가 더 든다 |
| 6 | README `schema-version` 행이 없는 명령 `brain setup upgrade`를 안내 | low | patch(README) + defer(core 메시지) | README는 이번 변경. `checkSchema` 메시지 자체는 story 3부터 있던 것 |
| 7 | README에 sidecar 함정이 없음(Implementation Notes와 불일치) | low | patch | grep으로 확인, 한 줄 추가 |
| 8 | `failedConfigStore`가 port 계약 테스트를 돌지 않음 | low | 거절 | 피해가 생기는 호출자가 없다. `readSchemaVersion`은 `health.ok`일 때만 불려 도달하지 않는다 |
| 9 | doctor-checks·install-store 테스트가 dist 가드 없이 `dist/bin.js`에 의존 | low | patch | 다른 파일과 같은 `beforeAll` 가드 |
| 10 | DB 없음 시간 예산이 이유 없이 5000→10000 | low | patch | 실제 ~115ms. 되돌리거나 이유를 적는다 |
| 11 | 설정이 없을 때 `db` detail이 `config` detail을 그대로 반복 | low | patch | 출력으로 확인. 메시지 인라인 제거 |
| 12 | `diagnostic`과 `writes`를 함께 켜는 것을 막지 않음 | low | 거절 | 그런 명령이 없고, 막으려면 타입·분기가 는다 |
| 13 | 등록부 머리 주석이 어떤 심볼에도 붙어 있지 않음 | low | patch | `runtimeChecks` 문서로 옮기는 직접 수정 |
| 14 | sqlite 테스트가 0444 뒤 sidecar 권한을 되돌리지 않음 | low | patch | admin-doctor 테스트와 같게 |

경로 요약: intent_gap 0, bad_plan 0, patch 11(1·2·3·4·6·7·9·10·11·13·14), defer 1(6의 core 메시지), 거절 3(5·8·12).

## Design Notes

- 왜 Core가 등록부를 받는가: 어떤 점검이 있는지는 Core의 일이고(admin-doctor.ts 주석, AD-5), Core는 파일 시스템을 모른다. 그래서 store로 답할 수 있는 것(스키마, 이후 spool 건수)은 Core가, 기계 사실(shim·node·설정 파일)은 런타임이 `DoctorCheckSource`로 넘긴다.
- 읽기 전용 실측(Node 24.16.0): 0444 파일은 `mode=rw`로 열리고 `journal_mode`·select·`begin immediate`까지 성공, 첫 쓰기에서 `SQLITE_READONLY`(8). 폴더가 쓰기 불가면 `journal_mode`부터 1544(`READONLY_CANTINIT`). 그래서 기존 `wal` 탐침이 폴더 경우는 잡지만 파일 경우는 못 잡는다.
- 주의: 읽기 전용 파일을 연 SQLite는 `-wal`·`-shm`을 0444로 남긴다. 사용자가 DB 권한을 고쳐도 sidecar 때문에 `writable`이 계속 실패할 수 있다 — detail에 sidecar 경로를 언급할지는 구현 판단.

## Verification

**Commands:**
- `pnpm build` -- expected: TS 오류 없음
- `pnpm vitest run --project cli` (PG 없이) -- expected: 전부 통과
- `docker compose -f compose.test.yaml up -d --wait && BRAIN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres pnpm test; docker compose -f compose.test.yaml down` -- expected: 전 프로젝트 통과
- 임시 `SECOND_BRAIN_HOME`에서 `setup run --yes` 뒤 I/O 표의 각 손상(DB 삭제, 0444, 스키마 1, shim 삭제, shim node 경로 변경)을 하나씩 걸고 `<home>/bin/brain admin doctor --json` -- expected: 해당 항목만 fail, exit 1

**증거(2026-10-14, 리뷰 패치 적용 뒤):**
- `pnpm build` 정상. compose PG + `pnpm vitest run` — 27개 파일 662개 테스트 통과
- 임시 home에서 `setup run --yes` 실행 뒤 shim으로 doctor: 정상이면 10개 항목 모두 ok·exit 0, 0444이면 `writable`만 fail, `schema_version=1`이면 `schema-version` fail `SCHEMA_MISMATCH`(warnings 포함), `config.toml`이 없으면 `config`·`db` fail·exit 1, DB가 없으면 `db` fail이고 파일을 다시 만들지 않음. node 경로가 틀린 경우(빌드된 CLI로 실행)는 `node-path` fail, shim이 없으면 `shim` fail·`node-path` skip
