---
title: 'Tracer: workspace 뼈대와 doctor 한 줄'
type: 'feature'
ticket: '1'
created: '2026-10-08'
status: done
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
context: []
baseline_revision: '06c7ac616d001169e4d8970e581b2e1736452c3d'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 저장소에 코드가 없다. 이후 모든 에픽이 얹힐 workspace·패키지 경계·테스트 기반이 없고, Store → SDK → CLI 경로가 하나도 검증되지 않았다.

**Approach:** Structural Seed대로 6개 비공개 패키지를 세우고, Core의 최소 `Store` port(`checkHealth`)를 postgres adapter로 구현해 `brain admin doctor --json`이 DB 연결과 pgvector 확장을 보고하는 tracer를 끝까지 뚫는다. 설정 읽기(`DATABASE_URL` 환경 변수만)와 응답 봉투는 임시이며 story 4가 교체한다.

## Boundaries & Constraints

**Always:**
- AD-1: `core`는 `dependencies` 없음, tsconfig `types: []`(Node API 금지). adapter는 `core`에만 의존. `second_brain`은 재export만. `apps/cli`는 `second_brain`만 import.
- Stack 표의 정확한 버전으로 고정(caret 없음): TS 7.0.2, pnpm 12.10.1(`packageManager`), Kysely 0.29.6, pg 8.23.1, commander 15.0.0, vitest 5.0.3. 모두 `private: true`, ESM.
- 루트 `package.json`에 `dependencies`·`prepare` 없음(epic 결정). devDependencies는 허용.
- AD-3: 연결·환경 변수 읽기는 factory 호출이나 명령 실행 안에서만.
- Postgres 테스트는 실제 DB(테스트 전용 데이터베이스), mock 없음. `BRAIN_TEST_DATABASE_URL`이 없으면 띄우는 방법을 담아 즉시 실패(skip 금지).
- `--json` 봉투는 Conventions의 `{ ok, now, data, warnings[], error? }`.
- 공개 저장소 위생: 회사 이름·실제 대화 없음.
- Decision(2026-10-08): 테스트용 PG는 구현 세션이 `docker compose -f compose.test.yaml up -d`로 띄우고(pg18 이미지 pull 포함) 빌드가 끝나면 `down`으로 내린다. 볼륨 없음.
- Decision(2026-10-08): 플랜 크기(약 2,700 토큰)는 단일 tracer 목표이므로 분할하지 않고 전체를 유지한다.

**Never:**
- 다른 story의 몫: 마이그레이션·trigger(3), 전체 port·도메인 타입(2), config.toml 코덱·디스패처·경고 코드 집합(4), 설치기·shim(5~7), doctor 등록 구조(8).
- Core에 pgvector·`pg`·Kysely 이름이 새는 것. `pgvector` npm 패키지. 코드가 Postgres를 띄우는 것(dev용 `compose.test.yaml`은 예외).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| doctor ok | 살아 있는 PG(vector 설치됨), `brain admin doctor --json` | `ok:true`, `checks`: `db` ok(serverVersion), `pgvector` ok(version). `warnings:[]`. exit 0 | 없음 |
| vector 미설치 | PG 정상, 확장 안 됨 | `db` ok, `pgvector` fail(`available` 보고). exit 1 | warnings 없음 |
| DB 다운 | 닫힌 포트 | `ok:true`, `db` fail `code:"DB_UNAVAILABLE"`+message, `pgvector` skip, `warnings:["DB_UNAVAILABLE"]`. exit 1. 5초 안에 포기 | 예외 밖으로 안 던짐 |
| 설정 없음 | `DATABASE_URL` 미설정 | `ok:false`, `error:{code:"CONFIG_MISSING"}`. exit 2 | 임시 코드 |
| 텍스트 출력 | `--json` 없음 | 항목마다 한 줄, exit 코드는 json과 동일 | 동일 |
| import 부작용 | 테스트가 연 TCP 포트를 `DATABASE_URL`로 두고 자식 프로세스에서 `import("second_brain")` | 연결 0건, exit 0 | — |

</frozen-after-approval>

## Code Map

코드 없음(greenfield). 문서와 환경 사실만.

- `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` -- AD-1·2·3, Conventions·Stack 표, Structural Seed. 필요한 절만 읽는다.
- `.gitignore` -- `node_modules/`·`dist/`·`.env`·`*.tsbuildinfo` 이미 무시. 변경 없음.
- 환경: Node 24.16.0, 전역 pnpm 10.34.4(`packageManager`로 12.10.1 자동 전환, 실패 시 `npx pnpm@12.10.1`), Docker 29(pg18 이미지는 pull 필요), `psql` 없음. 고정 버전은 모두 npm에 있음(2026-10-08 확인). TS 7은 `baseUrl`·`node10` 미지원 → `module: nodenext`, `target: es2024`.
- 패키지 이름: `@second-brain/{core,postgres,claude-code,modelstudio,cli}`, 묶음 `second_brain`(AD-2), dev 전용 `@second-brain/test-db`. 참조는 `workspace:*`.

## Tasks & Acceptance

**Execution:**
- [x] `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts` -- workspace(`packages/*`, `apps/*`, `tooling/*`), `packageManager`, `engines`, devDeps(typescript·vitest·@types/node), scripts `build`(`pnpm -r build`), `test`(`pnpm build && vitest run`), `brain`(`node apps/cli/dist/bin.js`). vitest `projects`로 패키지별 `test/**/*.test.ts` -- 공통 기반
- [x] `compose.test.yaml`, `README.md` -- `pgvector/pgvector:pg18`, 포트 54329, 비밀번호 `postgres`, 볼륨 없음. README에 띄우기·`BRAIN_TEST_DATABASE_URL`·doctor 예시 한 줄씩 -- 사람이 띄우는 테스트 DB
- [x] `tooling/test-db/` -- `createTestDatabase()`: 관리 URL로 `brain_test_<random>` DB 생성 → `CREATE EXTENSION IF NOT EXISTS vector` → `{ url, drop() }`. 환경 변수 없으면 compose 명령을 담은 Error -- 통합 테스트 공통 도구
- [x] `packages/core/` -- `ports/store.ts`(`Store { checkHealth(); close() }`, `StoreHealth` = `{ ok:true, serverVersion, vector:{ available, installed } }` | `{ ok:false, code:'DB_UNAVAILABLE', message }`), `admin/doctor.ts`(`runDoctor(store)` → `{ checks: { id, status:'ok'|'fail'|'skip', detail?, code? }[] }`), `brain.ts`(`createBrain({ store })` → `{ admin:{ doctor }, close }`). 테스트: 가짜 Store로 세 분기 -- port·use case
- [x] `packages/postgres/` -- `postgresStore({ databaseUrl, connectTimeoutMs=5000 })`: Kysely+`pg` Pool을 factory 안에서 생성, `select version()`, `pg_extension`·`pg_available_extensions`의 `vector` 조회, 연결 오류 → `DB_UNAVAILABLE` 값. 테스트: test-db로 ok, 닫힌 포트로 실패(5초 내) -- Store 구현
- [x] `packages/claude-code/`, `packages/modelstudio/` -- `export {}` 뼈대, `core`만 의존 -- 자리 확보
- [x] `packages/second_brain/` -- `export * from` 다섯 줄. 테스트: (a) import 부작용 0건, (b) core `dependencies` 없음, (c) 루트 `dependencies`·`prepare` 없음, (d) adapter의 workspace 의존은 `core`만 -- 경계를 테스트로 고정
- [x] `apps/cli/` -- `bin.ts`(commander `admin doctor [--json]`), `config.ts`(임시: `process.env.DATABASE_URL`), `envelope.ts`, `commands/admin-doctor.ts`(조립→실행→출력→`close()`→exit). `bin.brain`. 테스트: 빌드된 bin을 자식 프로세스로 실행해 I/O 표의 doctor ok·DB 다운·설정 없음 검증 -- Runtime 조립
- [x] 전체 -- `pnpm install && pnpm test` 통과, `git status`에 `dist/`·`node_modules/` 없음 -- 마무리

**Acceptance Criteria:**
- Given 깨끗한 clone, when `pnpm install && pnpm build`, then 7개 패키지의 `dist/`가 생기고 TS 오류가 없다.
- Given `BRAIN_TEST_DATABASE_URL`이 compose의 PG를 가리킬 때, when `pnpm test`, then 전 프로젝트 통과.
- Given 그 변수가 없을 때, when `pnpm test`, then 통합 테스트가 compose 명령을 안내하며 실패한다(skip 아님).
- Given 사람이 띄운 PG, when `DATABASE_URL=... pnpm brain admin doctor --json`, then "doctor ok" 행과 같고, 컨테이너를 멈추면 "DB 다운" 행과 같다.

## Implementation Notes

구현 결과(2026-10-08). 8개 workspace 프로젝트(루트 + 패키지 7개), `dist/` 7개, `pnpm test` 20개 통과.

- 패키지: `packages/{core,postgres,claude-code,modelstudio,second_brain}`, `apps/cli`, `tooling/test-db`.
- Core의 건강 항목 id는 중립 이름 `vector`다. `pgvector`라는 이름은 `apps/cli/src/commands/admin-doctor.ts`의 출력 계층이 `CHECK_IDS` 한 줄로 바꿔 쓴다(JSON·텍스트 모두). Design Notes의 "pgvector는 adapter와 CLI 출력만 안다"를 지킨다.
- `warnings[]`는 체크의 `code`가 경고 코드 집합에 있을 때만 채운다. 그래서 pgvector 미설치는 `fail`이지만 경고가 없다(I/O 표 2행). 전체 집합은 story 4의 몫이라 지금은 `DB_UNAVAILABLE` 하나다.
- `serverVersion`은 `select current_setting('server_version')`을 쓴다(`18.6 (Debian ...)`). `version()` 전체 문자열은 doctor 한 줄을 너무 길게 만든다.
- 시간 예산: adapter는 Pool에 `connectionTimeoutMillis`와 `query_timeout`을 모두 `connectTimeoutMs`(기본 5000)로 건다. 연결은 됐지만 응답이 없는 상대에도 탐침이 끝난다. CLI는 `connectTimeoutMs: 4000`을 넘겨 프로세스 시작 시간까지 합쳐 5초 안에 끝나게 한다(측정: 4,126ms).
- `DB_UNAVAILABLE`의 message는 비지 않는다. Node의 다중 주소 연결 실패는 message가 빈 `AggregateError`라서, 내부 오류 → `code` → `name` 순으로 내려가며 첫 비어 있지 않은 값을 쓴다.
- 각 패키지가 `typescript` 7.0.2를 devDependency로 선언한다. `pnpm -r build`가 루트 `node_modules/.bin` 호이스팅에 기대지 않게 하기 위함이고, AD-1이 금지한 것은 `core`의 `dependencies`다.
- `vitest.config.ts`는 `packages/*`·`apps/*`·`tooling/*`를 훑어 `test/` 폴더가 있는 패키지만 project로 만든다. 테스트가 없는 claude-code·modelstudio·test-db가 "no test files"로 실패하지 않는다.
- 경계 테스트(d)는 `dependencies`만 본다. `@second-brain/test-db`는 postgres·cli의 devDependency다(dev 도구이므로 런타임 경계가 아니다).
- 부작용 테스트는 자식 프로세스를 `apps/cli`에서 띄워 `import("second_brain")`을 bare specifier로 풀게 한다. 묶음을 의존하는 유일한 패키지라서 실제 소비자와 같은 해석 경로가 된다.
- 환경 사실: 전역 pnpm 10.34.4의 자동 전환이 `ENOEXEC`로 실패했다(`~/Library/pnpm/.tools/pnpm/12.10.1/bin`). 플랜의 대안대로 `npx pnpm@12.10.1`로 install·build·test를 모두 돌렸고 README에 적어 두었다.
- DB를 `docker compose stop`으로 멈추면 detail이 `read ECONNRESET`이다(Docker가 포트 포워더를 유지한다). `connect ECONNREFUSED` 경로는 닫힌 포트를 쓰는 postgres·cli 테스트가 덮는다. 둘 다 `DB_UNAVAILABLE`이고 104ms에 끝났다.

- 2026-10-08 (오케스트레이터, Matrix 감사) I/O 표 "vector 미설치" 행에 CLI 통합 테스트가 없어 `tooling/test-db`에 `createTestDatabase({ installVector: false })` 옵션을 더하고 `apps/cli/test/admin-doctor.test.ts`에 그 행의 테스트를 추가했다. 총 21개 테스트 통과.

## Plan Change Log

- 2026-10-08 `packages/second_brain/src/index.ts`는 `export * from` 네 줄이다(플랜은 "다섯 줄"). 묶음이 의존하는 패키지는 core·postgres·claude-code·modelstudio 넷이고, Structural Seed의 다섯 번째 이름은 묶음 자신이다.
- 2026-10-08 `compose.test.yaml`이 inline compose `config`로 `/docker-entrypoint-initdb.d`에 `create extension if not exists vector;`를 넣는다. `pgvector/pgvector:pg18`은 확장을 available로만 두고 어느 데이터베이스에도 설치하지 않아서, 이 없이는 수락 기준의 "doctor ok" 행(사람이 띄운 PG에 대해 exit 0)이 재현되지 않는다. `volumes:`는 쓰지 않았으므로 "볼륨 없음" 제약은 유지된다.
- 2026-10-08 `compose.test.yaml`이 `/var/lib/postgresql`을 `tmpfs`로 가린다. 이미지가 그 경로를 `VOLUME`으로 선언해서, 없으면 `compose down` 뒤에 익명 볼륨이 남는다. 데이터는 컨테이너와 함께 사라지고 명명 볼륨도 없다.
- 2026-10-08 Stack 표에 없는 고정 버전 둘을 더했다: `@types/pg` 8.23.1(dev 전용, `pg` 버전과 일치. `pg`는 타입을 담지 않는다), `@types/node` 24.19.1(dev 전용).

## Review Triage Log

### Pass 1 (2026-10-08, lens: quick) — high 0 / medium 2 / low 9 / false 0 / maybe-false 0 / 1건 intent 밖 거절

| # | 발견 | 판정 | 경로 | 증거 |
| --- | --- | --- | --- | --- |
| 1 | `packages/postgres/src/store.ts` `describe(error)`가 `localhost` 연결 실패(AggregateError, message="")에서 빈 detail을 낸다 | medium | patch | 재현: `DATABASE_URL=...@localhost:54399/...` → `detail:""`. README가 안내하는 URL 형태라 사용자가 만난다. `code`/`errors[0].message`로 대체 |
| 2 | `apps/cli/.../admin-doctor.ts` `formatCheck`가 빈 detail을 출력해 꼬리 공백이 남는다 | low | patch | 1과 같은 재현에서 `db: fail [DB_UNAVAILABLE] `. 빈 문자열을 없는 것으로 취급하는 한 줄 수정 |
| 3 | 응답 없는 리스너에서 doctor가 5초를 넘긴다(연결 timeout 5000ms + 기동, 쿼리 timeout 없음) | medium | patch | 재현: 5081ms, exit 1. I/O 표 "5초 안에 포기" 위반. CLI가 `connectTimeoutMs` 4000을 넘기고 pool에 `query_timeout`을 둔다 |
| 4 | `version() as full_version` 컬럼·필드가 읽히지 않는다 | low | patch | 코드 확인. 삭제만 |
| 5 | README의 `docker compose up -d`에 `--wait`가 없어 첫 기동과 경쟁한다 | low | patch | `createTestDatabase`가 즉시 연결함. README에 `--wait` 추가. 플랜 Verification 수정 요구는 플랜 편집이므로 거절 |
| 6 | test-db가 확장 설치 실패 시 DB를 남기고, `drop()`이 실패해도 dropped로 표시된다 | low | patch(일부) | 코드 확인. `dropped = true`를 성공 뒤로 옮기는 한 줄만 고친다. 실패 시 정리는 일상 사용에서 만나기 어렵고 guard 추가라 거절 |
| 7 | 모든 tsconfig가 `include: ["src"]`라 `test/**`가 타입 검사되지 않는다 | low | 거절 | 사실이나 든 예시(`database?.drop()`)는 TS 오류가 아니다. 수정은 패키지별 tsconfig와 스크립트 추가로 trivial하지 않다. story 9 refactor sweep 후보로 메모 |
| 8 | `readConfig`가 형식이 틀린 `DATABASE_URL`을 `DB_UNAVAILABLE`로 보낸다 | — | 거절(intent 밖) | Intent가 설정 읽기를 "임시, story 4가 교체"로 명시. I/O 표도 미설정만 다룬다 |
| 9 | cli 테스트 `beforeAll`의 `expect(binPath).toBe(join(...))`는 항진이다 | low | patch | 코드 확인. `existsSync(binPath)`로 바꾼다 |
| 10 | `closedPort()`가 cli·postgres 테스트에 중복 | low | 거절 | 개발자만 만나는 중복이고, 수정이 test-db의 export 추가라 trivial하지 않다 |
| 11 | test-db 주석이 second_brain도 쓴다고 하나 쓰지 않는다 | low | patch | `packages/second_brain/package.json`에 devDependency 없음 확인. 주석만 고친다. 플랜 Design Notes 수정은 거절 |
| 12 | `vitest.config.ts`가 cwd 상대 경로로 project를 찾는다 | low | patch | 코드 확인. `import.meta.dirname` 기준으로 바꾼다 |

경로 요약: intent_gap 0, bad_plan 0, patch 9(1·2·3·4·5·6·9·11·12), defer 0, 거절 3(7·8·10).

패치 9건 적용 후 재검증(2026-10-08): `pnpm test` 21개 통과, doctor ok exit 0, `localhost` 닫힌 포트 detail 비어 있지 않음, 컨테이너 stop 시 `DB_UNAVAILABLE` 145ms·exit 1, `compose down` 뒤 볼륨 없음.

## Design Notes

- Core의 건강 정보는 `vector`라는 중립 이름이고, pgvector라는 이름은 adapter와 CLI 출력만 안다. story 2가 `Store`를 넓혀도 `checkHealth`·`close`는 유지.
- 예상된 실패는 값으로: `checkHealth`는 던지지 않는다. 봉투 `ok`는 "명령이 수행됐는가", 항목 실패는 `checks`·`warnings`·exit 1로 드러낸다.
- 패키지 간 import는 `exports → dist`라 테스트 전에 빌드한다. 패키지 내부 테스트는 `../src`를 직접 import.
- test-db가 7번째 패키지인 이유: postgres·second_brain·cli 테스트가 같은 DB 생성 코드를 쓰고, adapter에 두면 cli 테스트가 adapter에 직접 의존한다. 아키텍처 6개 밖의 dev 도구다.
- 봉투 예시(임시):
  ```json
  { "ok": true, "now": "2026-10-08T09:00:00+09:00",
    "data": { "checks": [ { "id": "db", "status": "fail", "code": "DB_UNAVAILABLE", "detail": "connect ECONNREFUSED 127.0.0.1:54329" },
                          { "id": "pgvector", "status": "skip" } ] },
    "warnings": ["DB_UNAVAILABLE"] }
  ```

## Verification

**Commands:**
- `pnpm install && pnpm build` -- expected: pnpm 12.10.1, 7개 `dist/`, exit 0
- `docker compose -f compose.test.yaml up -d && BRAIN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres pnpm test` -- expected: 전 프로젝트 통과
- `DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres pnpm brain admin doctor --json` -- expected: `db`·`pgvector` ok, exit 0
- `docker compose -f compose.test.yaml stop` 후 같은 명령 -- expected: `DB_UNAVAILABLE`, exit 1, 5초 이내
- `git status --short` -- expected: `dist/`·`node_modules/`·`.env` 없음

