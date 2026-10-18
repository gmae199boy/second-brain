---
title: '설정 코덱, CLI 응답 형식, 스키마 확인'
type: 'feature'
ticket: '4'
created: '2026-10-13'
status: done
baseline_revision: '971ffef61ba4de78830b6c23a3af1fcd6f8ed3a6'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** tracer의 CLI는 `DATABASE_URL` 환경 변수만 읽고, 봉투·경고 코드·종료 코드를 `admin doctor` 안에서 손으로 조립한다. 이후 명령 30여 개가 같은 설정 원천(AD-18), 같은 `--json` 봉투(Conventions), hook 경로 exit 0, 스키마 버전 불일치 시 쓰기 거부(AD-20)를 공유할 자리가 없다.

**Approach:** `apps/cli`에 설정 코덱(`config.toml` + `.env` 읽기·쓰기), 명령 등록부 기반 `brain <ns> <verb>` 디스패처, 봉투·경고 코드 모듈을 두고, 디스패처가 명령의 `writes`·`hook` 표시를 보고 스키마 확인과 exit 0 래핑을 한 곳에서 한다. Core에는 스키마 버전을 읽는 작은 port와 확인 함수를, postgres에는 그 구현을 더한다. `admin doctor`를 이 틀로 옮긴다.

## Boundaries & Constraints

**Always:**
- 설정 읽기·쓰기는 `apps/cli/src/config/` 코덱 하나뿐(AD-18). 위치는 `~/.second_brain/`, 환경 변수 `SECOND_BRAIN_HOME`이 있으면 그 폴더(테스트·재설치용). 읽기는 명령 실행 중에만(AD-3).
- `config.toml`에는 키 값이 아니라 환경 변수 이름만 적는다. TOML은 `smol-toml` 1.9.0(정확한 버전), `.env`는 Node 내장 `util.parseEnv`. 코덱이 쓰는 `.env`는 권한 0600.
- 봉투는 `{ ok, now, data?, warnings[], error? }`, `now`는 Clock에서 오프셋 포함 ISO-8601. 경고 코드는 Conventions의 9개 + `CONFIG_UNKNOWN_KEY`를 한 상수 집합으로 두고 타입으로 강제한다.
- 종료 코드: 0 성공, 1 실행했으나 실패·저하(점검 실패, `DB_UNAVAILABLE`, `SCHEMA_MISMATCH`), 2 실행 불가(설정·사용법). `hook: true` 명령은 예외·잘못된 인자를 포함해 무엇이 일어나도 exit 0이고, 실패는 stderr 한 줄로만 남긴다(failures·spool 기록은 epic 2).
- `writes: true` 명령은 실행 전에 DB의 `schema_version`을 코드의 `SCHEMA_VERSION`과 비교하고, 다르거나 행이 없으면 run을 부르지 않고 `error.code = SCHEMA_MISMATCH`로 끝낸다. 읽기 명령은 확인하지 않는다.
- CLI 명령은 인자 해석과 출력 변환만 한다(AD-5). `apps/cli`는 `second_brain`만 import(AD-1).
- 기존 테스트(153개)의 동작 계약은 유지하되, `DATABASE_URL` 전제 테스트는 새 설정 원천으로 옮긴다.

- Decision(2026-10-13): 플랜 크기(약 3,500 토큰)는 단일 목표(디스패처 하나로 묶임)이므로 분할하지 않고 전체를 유지한다.
- Decision(2026-10-13): `config.toml`이 없으면 `CONFIG_MISSING`, exit 2(설치기 안내). 기본값으로 실행하지 않는다.
- Decision(2026-10-13): 모르는 설정 키는 새 경고 코드 `CONFIG_UNKNOWN_KEY`로 `warnings[]`에 넣는다(경고 코드는 10개). 아키텍처 Conventions 표의 경고 코드 목록도 함께 갱신한다.
- Decision(2026-10-13): DB URL 환경 변수 기본 이름은 `SECOND_BRAIN_DATABASE_URL`이고, `.env` 값이 프로세스 환경보다 우선한다(프로세스 환경은 `.env`에 없을 때만).
- Decision(2026-10-13): v1 설정 키는 `schema_version`(=1), `timezone`(기본 `Asia/Seoul`), `[database] url_env`(기본 `SECOND_BRAIN_DATABASE_URL`)뿐이다. 다른 키는 그 키를 쓰는 스토리가 코덱에 더한다.

**Never:**
- spool·`failures` 기록(epic 2), doctor 점검 항목 추가(story 8), 설치기·`setup run`·마이그레이션 호출(story 6·7), 실제 쓰기 명령 구현.
- 설정 파일에 비밀 값 기록, 모르는 키를 조용히 무시, import 시점의 파일 읽기.
- 명령마다 봉투·종료 코드를 직접 조립하는 것.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 정상 설정 | `config.toml` + `.env`에 URL | 명령이 그 URL로 실행 | — |
| 모르는 키 | `config.toml`에 `colour = "x"` | 명령은 실행되고 `warnings`에 `CONFIG_UNKNOWN_KEY`, 텍스트 모드는 stderr에 키 이름 | — |
| 설정 없음 | `config.toml` 없음 | exit 2, `CONFIG_MISSING` | run 안 부름 |
| 설정 형식 오류 | 깨진 TOML, 타입 틀림, 지원 안 하는 `schema_version` | exit 2, `error.code = CONFIG_INVALID` | run 안 부름 |
| URL 없음 | 지정된 환경 변수가 `.env`·프로세스 모두에 없음 | exit 2, `CONFIG_MISSING` | — |
| 코덱 왕복 | `writeConfig` → `readConfig` | 같은 값, `.env` 모드 0600 | — |
| 봉투 스냅샷 | 고정 Clock, ok/에러 각각 | 스냅샷과 동일 | — |
| 스키마 일치 | `writes` 명령, DB 버전 = 코드 | run 실행 | — |
| 스키마 불일치 | `writes` 명령, DB 버전 ≠ 코드 또는 행 없음 | exit 1, `SCHEMA_MISMATCH`, DB 변화 없음 | run 안 부름 |
| DB 다운 + 쓰기 | `writes` 명령, 닫힌 포트 | exit 1, `DB_UNAVAILABLE`, 5초 안 | run 안 부름 |
| hook 실패 | `hook` 명령이 던짐 / 설정 없음 / 잘못된 인자 | exit 0, stderr 한 줄 | 삼킴 |
| 모르는 명령 | `brain nope verb --json` | exit 2, `error.code = USAGE` 봉투 | — |

</frozen-after-approval>

## Code Map

- `apps/cli/src/bin.ts` -- commander 손 조립. 등록부 + 디스패처 호출로 교체.
- `apps/cli/src/config.ts` -- 임시 `readConfig`(DATABASE_URL만). 코덱으로 교체 후 삭제.
- `apps/cli/src/envelope.ts` -- `okEnvelope`·`errorEnvelope`·`isoWithOffset` 재사용. `new Date()` 기본값을 Clock 주입으로 바꾸고 경고 코드 타입을 붙인다.
- `apps/cli/src/commands/admin-doctor.ts` -- 로컬 `WARNING_CODES`·`CHECK_IDS`·`formatCheck`. 명령 spec으로 옮기되 `CHECK_IDS`(vector→pgvector)와 텍스트 형식은 유지.
- `apps/cli/src/runtime/clock.ts` -- `systemClock` 재사용.
- `apps/cli/test/admin-doctor.test.ts` -- `runBrain` spawn 헬퍼·`closedPort` 패턴. env 대신 임시 `SECOND_BRAIN_HOME`에 설정을 쓰도록 바꾼다. 체크 id·exit 코드 기대값은 유지.
- `packages/core/src/ports/store.ts` -- `HealthStore` 옆에 `SchemaStore { readSchemaVersion() }` port 추가, `Store` 합성에는 넣지 않음(별 capability).
- `packages/core/src/domain/schema-version.ts` -- `SchemaVersion` 타입 재사용.
- `packages/core/src/testing/contracts/` -- 새 port에 계약 케이스 + 메모리 가짜(story 2 패턴: vitest 없는 케이스 목록).
- `packages/postgres/src/store.ts`, `src/connect.ts` -- `createPool`·`describe` 재사용. `postgresStore` 반환 타입을 `HealthStore & SchemaStore`로 넓힌다. 테이블 없음(`42P01`)은 version `null`, 연결 실패는 `DB_UNAVAILABLE`.
- `packages/postgres/src/migrate.ts` -- `SCHEMA_VERSION` 재사용, 변경 없음.
- `tooling/test-db` -- `createTestDatabase`로 마이그레이션된 DB·버전 조작.
- 새 의존: `apps/cli`의 `smol-toml` 1.9.0.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/ports/store.ts`, `packages/core/src/schema.ts`, `packages/core/src/warnings.ts`, `packages/core/src/index.ts` -- `SchemaStore` port, `checkSchema(store, expected)` → ok 또는 `SCHEMA_MISMATCH`/`DB_UNAVAILABLE` 값, Conventions 경고 코드 상수·`WarningCode` 타입 -- Core가 소유하는 공통 언어
- [x] `packages/core/src/testing/{contracts,fakes}/*` -- `schemaStoreContract`와 메모리 가짜, `packages/core/test/contracts.test.ts`에 연결 -- 계약 틀
- [x] `packages/postgres/src/store.ts`, `packages/postgres/test/store.test.ts` -- `readSchemaVersion` 구현, 실제 DB에서 계약 + 미마이그레이션 DB(null) + 닫힌 포트 -- adapter
- [x] `apps/cli/src/config/{codec,paths}.ts`, `apps/cli/test/config.test.ts` -- `readConfig(home)`·`writeConfig(home, …)`, 알려진 키 표, 모르는 키 경고 목록, 매트릭스의 설정 행 -- 단일 코덱
- [x] `apps/cli/src/envelope.ts`, `apps/cli/test/envelope.test.ts` -- Clock 주입, `WarningCode[]`, 고정 시각 스냅샷 -- 봉투
- [x] `apps/cli/src/dispatch.ts`, `apps/cli/src/commands/index.ts`, `apps/cli/src/bin.ts` -- `CommandSpec { ns, verb, description, options, writes?, hook?, run(ctx) }`, 등록부에서 commander 트리 생성, 설정 로드 → (writes면) 스키마 확인 → run → 봉투/텍스트 출력 → 종료 코드, hook 래핑, 사용법 오류 봉투 -- 디스패처
- [x] `apps/cli/src/commands/admin-doctor.ts`, 기존 `config.ts` 삭제 -- doctor를 spec으로 이전 -- tracer 교체
- [x] `apps/cli/test/dispatch.test.ts` -- 테스트 전용 등록부(가짜 writes·hook 명령)로 스키마 일치·불일치·DB 다운·hook 실패·모르는 명령 행을 실제 DB로 검증 -- 매트릭스
- [x] `apps/cli/test/admin-doctor.test.ts` -- 임시 `SECOND_BRAIN_HOME`으로 이전, 모르는 키 경고 케이스 추가 -- 회귀
- [x] `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` -- Conventions 경고 코드 목록에 `CONFIG_UNKNOWN_KEY` 추가 -- 결정 반영
- [x] 전체 -- `pnpm test` 통과 -- 마무리

**Acceptance Criteria:**
- Given 설치된 설정 폴더, when `brain admin doctor --json`, then 봉투 형태·체크 id·종료 코드가 story 1과 같다.
- Given 새 명령을 더하는 개발자, when 등록부에 spec 하나를 추가하면, then 설정·봉투·종료 코드·스키마 확인·hook 래핑을 직접 쓰지 않아도 된다.
- Given `second_brain` import, when 아무 명령도 실행하지 않으면, then 설정 파일을 읽지 않는다(기존 부작용 테스트 통과).

## Implementation Notes

- `SchemaStore`에는 `readSchemaVersion`과 함께 `close`를 두었다. `HealthStore`와 같은 모양이라 `withSubject`가 계약 케이스마다 자원을 닫을 수 있고, postgres는 `HealthStore & SchemaStore`로 한 번만 닫는다.
- `checkSchema`는 행이 없는 경우(`found: null`)도 `SCHEMA_MISMATCH`로 본다. 메시지만 갈라져 `setup run`/`setup upgrade`를 각각 안내한다.
- `util.parseEnv`는 큰따옴표 안의 역슬래시 escape를 모른다. 그래서 코덱은 값에 없는 쪽 따옴표로 감싸고, 양쪽 따옴표를 모두 가진 값은 조용히 다르게 적는 대신 던진다.
- `writeConfig`는 기존 `.env` 항목을 보존한다(story 6·7의 재설정이 다른 키를 지우지 않도록). 모드는 `writeFile` 뒤에 `chmod`로 따로 준다 — `writeFile`의 `mode`는 새로 만드는 파일에만 걸린다.
- `config.toml`에 `schema_version`이 없으면 `CONFIG_INVALID`다. AD-18이 이 키를 요구하므로 기본값으로 떨어지지 않는다.
- `timezone`은 `Intl.DateTimeFormat`으로 실제 존재하는 지역인지까지 본다. `writeConfig`도 같은 두 검사(시간대·변수 이름)를 해서, 코덱이 쓴 폴더는 코덱이 반드시 읽을 수 있다.
- 디스패처는 commander 액션에서 명령을 실행하지 않고 선택만 기록한다. 설정·스키마 확인이 파싱 안에 들어가면 실패가 갈 곳이 없다.
- `hook` 여부는 commander보다 먼저 raw argv에서 찾는다(`findSpec`). 잘못된 인자야말로 hook이 exit 0을 지켜야 하는 경우다.
- 텍스트 모드에서 경고는 stderr로 간다(story 1의 doctor는 stdout이었다). 매트릭스가 모르는 키를 stderr로 요구하므로 한쪽으로 모았다.
- `--help`는 exit 0으로 commander의 출력을 그대로 내보낸다. 명령 없이 부른 `brain`·`brain admin`은 `USAGE` exit 2다.
- `apps/cli/test/dispatch.test.ts`는 가짜 등록부가 자식 프로세스 안에 있어야 하므로 `node --input-type=module -e`로 `dist/dispatch.js`를 불러 쓴다. `-e`에서는 사용자 인자가 `process.argv[1]`부터다.
- `envelope.test.ts`는 첫 `Date` 전에 `process.env.TZ`를 `Asia/Seoul`로 고정해 오프셋 스냅샷을 기계와 무관하게 만든다(`TZ=America/New_York`으로 돌려 확인).
- `second_brain`의 import 부작용 테스트는 `DATABASE_URL` 대신 임시 `SECOND_BRAIN_HOME` + `SECOND_BRAIN_DATABASE_URL`을 쓴다.
- 2026-10-13 (오케스트레이터, Matrix 감사) 스키마 불일치 행의 "DB 버전 ≠ 코드" 절반이 빈 DB로만 검증돼, 마이그레이션 뒤 버전을 올린 DB로 거부를 확인하는 테스트를 `apps/cli/test/dispatch.test.ts`에 더했다. 이를 위해 개발 전용 `tooling/test-db`의 `TestDatabase`에 `query()`를 추가했다.
- 리뷰 패치 뒤: `.env`는 `writeFile`의 `mode: 0o600`으로 생성되고 기존 파일만 `chmod`로 조인다. 암묵 `help` 하위 명령은 꺼서 `-h/--help`만 도움말이다. `CommandSpec.queryTimeoutMs`(기본 = 연결 예산)를 더했고 이를 넘기려 `PostgresStoreOptions`가 `CreatePoolOptions`로 넓어졌다.

## Plan Change Log

## Review Triage Log

**2026-10-13 — 코디네이터 리뷰 8건, 전부 수정:**
- `codec.ts` URL 조회: `url_env = "constructor"` 등이 `Object.prototype` 멤버를 읽어 TypeError로 죽었다 → `Object.hasOwn`으로 자기 속성만 본다(`own()`). `.env`와 프로세스 환경 둘 다.
- `codec.ts` `unknownKeyWarnings`: 비어 있는 `[database]`가 모르는 키로 보고됐다 → 알려진 키의 접두사인 테이블 경로는 아는 것으로 본다.
- `codec.ts` `writeConfig`: `.env`가 0644로 만들어진 뒤 chmod됐다 → `writeFile`에 `mode: 0o600`을 준다(기존 파일용 chmod는 유지).
- `codec.ts` `writeConfig` 순서: `quote()`가 `config.toml`을 쓴 뒤에 던져 반쪽 폴더가 남았다 → 두 파일 내용을 모두 만든 뒤에 쓴다.
- `dispatch.ts` `quiet()`: commander의 암묵적 `help` 하위 명령이 help를 찍고 USAGE로 실패해 `--json` stdout을 둘로 만들었다 → `helpCommand(false)`. `-h/--help`가 유일한 help 경로, `brain help`는 모르는 명령이다.
- `dispatch.ts` hook 분기: `ok: true, failed: true`인 hook 결과의 data·text·경고를 삼키고 "the command failed"만 찍었다 → 오류 봉투가 있을 때만 삼킨다. 저하된 성공은 정상 출력 + exit 0.
- `dispatch.ts` 질의 예산: `connectTimeoutMs`가 `queryTimeoutMs` 기본값이라 앞으로의 모든 명령 질의가 4초로 묶였다 → `CommandSpec.queryTimeoutMs?`를 더해 넘긴다(`postgresStore` 옵션도 `CreatePoolOptions`로 넓힘). doctor는 기존 기본값 유지.
- `README.md`, 아키텍처 AD-10·다이어그램: `DATABASE_URL`을 아직 설정 원천으로 설명했다 → 설정 폴더 안내와 `SECOND_BRAIN_DATABASE_URL`로 교체.

### Pass 1 (2026-10-13, lens: quick) — high 0 / medium 4 / low 4 / false 2 / maybe-false 0

| # | 발견 | 판정 | 경로 | 증거 |
| --- | --- | --- | --- | --- |
| 1 | `url_env = "constructor"`가 `parseEnv` 결과의 prototype 멤버를 읽어 TypeError로 죽는다(봉투 없음, exit 1) | low | patch | 리뷰어 재현. `ENV_NAME`이 `constructor`를 통과시킴. own property 조회로 바로잡는 직접 수정 |
| 2 | `brain help [cmd]`가 도움말을 찍은 뒤 `USAGE` exit 2를 내고 `--json` stdout이 JSON이 아니게 된다 | medium | patch | 리뷰어 재현. `commander.help` 코드가 usage로 감. 암묵 help 하위 명령을 끄면 `-h/--help` 하나로 통일 |
| 3 | 비어 있는 알려진 `[database]` 표가 모르는 키로 경고된다 | low | patch | `flatten`이 빈 표 경로를 기록하고 `KNOWN_KEYS`는 leaf만 가짐. 알려진 키의 접두 경로를 알려진 것으로 보는 직접 수정 |
| 4 | hook 명령의 `ok:true, failed:true` 결과가 data·text·경고 코드를 잃고 "the command failed"만 남는다 | medium | patch | 코드 확인: `exit !== 0`이면 무조건 삼킴. 지금은 hook 명령이 없지만 epic 2 첫 hook이 NFR-2(조용한 실패 금지)를 어긴다 |
| 5 | `.env`가 0644로 생성된 뒤 chmod되어 비밀이 잠깐 누구나 읽을 수 있다 | medium | patch | `writeFile`에 mode 없음, 같은 함수의 `config.toml`이 644로 생성됨. `mode: 0o600` 추가 |
| 6 | `quote()`가 `config.toml`을 쓴 뒤 던져, 코덱이 다시 읽지 못하는 폴더가 남는다 | low | patch | 리뷰어 재현(빈 폴더 → toml만 남고 CONFIG_MISSING). `.env` 줄 조립을 첫 쓰기 앞으로 옮기는 순서 변경 |
| 7 | 디스패처의 4초 예산이 모든 명령의 쿼리 timeout이 된다 | medium | patch | `connect.ts`가 `queryTimeoutMs`를 `connectTimeoutMs`로 기본 설정. epic 2 `sessions ingest`·epic 5 `admin export`가 4초에 잘림. spec에 선택 필드 `queryTimeoutMs`(apps/cli 내부 타입) |
| 8 | README와 아키텍처 AD-10·배포 그림이 아직 `DATABASE_URL`을 설정 원천으로 적는다 | medium | patch | README 설치 확인 명령이 이제 `CONFIG_MISSING`(리뷰어 재현). frozen Decision으로 이름이 바뀜 |
| 9 | 리뷰 diff에 `pnpm-lock.yaml`이 없다 | false | 거절 | diff를 만들 때 lockfile을 일부러 뺐다. 작업 트리에 `smol-toml@1.9.0` 항목이 있고 커밋에 함께 들어간다 |
| 10 | AC 3(import 시 설정 파일을 읽지 않음)이 테스트로 단언되지 않는다 | false | 거절 | 코덱은 `apps/cli`에만 있고 `second_brain`(재export만)은 그것을 import하지 않는다. 설정을 읽을 경로가 import 그래프에 없으므로 AC가 말하는 나쁜 결과가 일어날 수 없다 |

경로 요약: intent_gap 0, bad_plan 0, patch 8(1~8), defer 0, 거절 2(9·10).

패치 8건 적용 후 재검증(2026-10-13): `pnpm test` 12개 파일 245개 통과(실제 DB), `compose down -v` 뒤 볼륨 없음, `dist/`·`node_modules/` 미추적.


## Design Notes

- `SchemaStore`를 `HealthStore`에 넣지 않는 이유: doctor(story 8)와 쓰기 가드가 같은 port를 쓰되, 건강 probe의 모양(story 1 계약)을 바꾸지 않는다. capability별 port는 story 2의 방식이다.
- 쓰기 가드를 디스패처에 두는 이유: 명령마다 확인을 넣으면 하나를 빠뜨렸을 때 조용히 옛 스키마에 쓴다. spec의 `writes` 표시 한 곳이 규칙을 강제한다. epic 2는 이 자리에서 거부 대신 spool로 보낸다.
  ```ts
  export const logAppend: CommandSpec = { ns: 'log', verb: 'append', writes: true, run: async (ctx) => … };
  ```
- `SECOND_BRAIN_HOME`은 설정 키가 아니라 설정 폴더 자체의 위치라 코덱 밖 환경 변수로 둔다.

## Verification

**Result (2026-10-13):** 세 명령 모두 통과. `pnpm test` = 12개 파일 237개 테스트 통과(이전 153개), `compose down` 뒤 `brain` 볼륨 없음, `git status --short`에 `dist/`·`node_modules/` 없음.


**Commands:**
- `docker compose -f compose.test.yaml up -d --wait && BRAIN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres npx -y pnpm@12.10.1 test` -- expected: 전 프로젝트 통과
- `docker compose -f compose.test.yaml down` -- expected: 볼륨 없음
- `git status --short` -- expected: `dist/`·`node_modules/` 없음
