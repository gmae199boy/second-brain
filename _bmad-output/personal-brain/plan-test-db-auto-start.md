---
title: 'pnpm test가 Postgres 테스트 DB를 스스로 준비한다'
type: 'chore'
ticket: ''
created: '2026-10-19'
status: 'built'
baseline_revision: '82b2cad310cd8fdf2413920804324dd22b9402c7'
route: 'full'
route_source: 'auto'
risk: 'low'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `BRAIN_TEST_DATABASE_URL`이 없으면 `pnpm test`에서 Postgres 통합 테스트 16개가 각각 같은 안내로 실패한다. 안내가 묻혀 코드가 깨진 것처럼 보이고, 에이전트는 DB를 띄우거나 내리는 법을 매번 다시 찾다가 원래 켜져 있던 컨테이너를 내리기도 했다.

**Approach:** Postgres 프로젝트가 돌 때만 vitest 시작 전에 한 번 확인한다. 변수가 없고 Docker가 켜져 있으면 `compose.test.yaml`로 테스트 DB를 띄우고 변수를 넣는다. 끝나면 자기가 띄운 경우에만 내린다. 준비할 수 없으면 테스트를 돌리기 전에 안내를 한 번만 내고 멈춘다.

## Boundaries & Constraints

**Always:** 변수가 이미 있으면 Docker를 건드리지 않고 그 DB를 쓴다. 이미 떠 있던 컨테이너는 쓰기만 하고 내리지 않는다. Postgres 테스트를 고르지 않은 실행(`--project sqlite` 등)에서는 Docker를 부르지 않는다. 준비 코드는 dev 전용 `tooling/test-db`에 둔다.

**Never:** Postgres 테스트를 목으로 바꾸거나 건너뛰지 않는다(Docker가 없을 때 조용히 통과시키지 않는다). `compose.test.yaml`의 이미지·포트·tmpfs는 바꾸지 않는다. 출시되는 여섯 패키지(`packages/core` 등)의 소스는 건드리지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 변수 있음 | `BRAIN_TEST_DATABASE_URL` 설정됨 | docker 명령 0번, 그 URL로 테스트 | 없음 |
| 이미 떠 있음 | 변수 없음, 테스트 컨테이너 running | 변수에 기본 URL을 넣고 테스트, 끝나도 내리지 않음 | 없음 |
| 새로 띄움 | 변수 없음, Docker 켜짐, 컨테이너 없음 | `up -d --wait` 뒤 변수 넣고 테스트, 끝나면 `down` | 테스트가 실패해도 `down`은 한다 |
| Docker 없음 | `docker info` 실패(명령 없음 포함) | 테스트 0개 실행, 안내 한 번 | 안내: Docker를 켜거나 pgvector가 있는 Postgres를 변수로 가리키라 |
| 띄우기 실패 | `up` 실패(포트 충돌 등) | 테스트 0개 실행, compose 오류 요약 + 같은 안내 한 번 | 반쯤 만든 것은 정리하지 않는다(사람이 볼 수 있게) |

</frozen-after-approval>

## Code Map

- `tooling/test-db/src/index.ts` -- `requireAdminDatabaseUrl`·`MISSING_URL`(안내 문구와 기본 URL `postgres://postgres:postgres@localhost:54329/postgres`), `createTestDatabase`. 기본 URL은 여기서 상수로 내보내 재사용한다. `MISSING_URL`은 준비 단계를 거치지 않은 실행을 위해 남긴다.
- `tooling/test-db/tsconfig.json` -- `rootDir: src`, node types. 새 소스도 여기서 빌드된다.
- `packages/postgres/test/{migrate,setup,store}.test.ts` -- DB를 쓰는 유일한 테스트. 바꾸지 않는다.
- `vitest.config.ts` -- `test/`가 있는 패키지마다 project를 만든다. 여기서 project에 `globalSetup`을 붙인다.
- `compose.test.yaml` -- 서비스 이름 `postgres`, 포트 54329, 볼륨 없음. 바꾸지 않는다.
- `README.md` "테스트 데이터베이스" 절 -- 수동 명령 네 줄. 자동 동작으로 고친다.
- `tsconfig.test.json` -- `tooling/*/test`도 타입 검사한다. 새 테스트 폴더가 자동으로 들어간다.

## Tasks & Acceptance

**Execution:**
- [x] `tooling/test-db/src/global-setup.ts` -- 실행기(명령·인자 → 종료 코드·stdout·stderr)와 env를 주입받는 준비 함수와, vitest가 부를 기본 export(실제 `docker`를 실행하고 teardown을 돌려줌)를 만든다. compose 파일은 저장소 루트 기준으로 찾는다 -- 표의 다섯 경우를 테스트할 수 있게 하려고.
- [x] `tooling/test-db/src/index.ts` -- 기본 URL 상수를 내보내고, 준비 함수를 index에서도 내보낸다 -- 패키지 경계(`exports: "."`)를 유지하려고.
- [x] `packages/postgres/test/global-setup.ts` -- `@second-brain/test-db`의 기본 준비를 다시 내보내는 한 줄 파일 -- project 쪽 진입점.
- [x] `vitest.config.ts` -- 패키지에 `test/global-setup.ts`가 있으면 그 project의 `globalSetup`으로 넣는다 -- 이름을 하드코딩하지 않으려고.
- [x] `tooling/test-db/test/global-setup.test.ts` -- 가짜 실행기로 표의 다섯 경우를 검증한다(부른 명령 순서, env, teardown이 `down`을 부르는지).
- [x] `README.md` -- "테스트 데이터베이스" 절을 자동 동작 기준으로 다시 쓴다(Docker만 켜 두면 됨, 기존 DB를 쓰려면 변수를 넣음, 직접 띄운 컨테이너는 그대로 둠).

**Acceptance Criteria:**
- Given 테스트 컨테이너가 없고 Docker가 켜져 있을 때, when 변수 없이 `pnpm test`, then 전체 통과하고 끝난 뒤 테스트 컨테이너가 없다.
- Given 테스트 컨테이너가 이미 떠 있을 때, when 변수 없이 `pnpm test`, then 전체 통과하고 컨테이너는 그대로 떠 있다.
- Given 변수 없이, when `vitest run --project sqlite`, then docker를 부르지 않는다.

## Implementation Notes

- 기본 URL 상수(`DEFAULT_TEST_DATABASE_URL`)와 변수 이름 상수(`TEST_DATABASE_URL_ENV`)는
  `global-setup.ts`에 두고 `index.ts`가 다시 내보낸다. Code Map은 index를 가리켰지만
  index가 준비 함수를 다시 내보내므로, 상수를 index에 두면 두 모듈이 서로를 import하게
  된다. 한쪽으로만 흐르게 두고 index의 `MISSING_URL`도 이 상수를 쓴다.
- `prepareTestDatabase`는 순서대로 `docker info` → `compose ps --status running --quiet
  postgres` → `compose up -d --wait`를 부른다. `info`를 먼저 부르는 것은 Docker가 꺼져
  있을 때 compose 오류가 아니라 같은 안내가 나오게 하려는 것이다.
- 준비할 수 없을 때는 안내를 담은 `Error`를 던진다. vitest는 project의 `globalSetup`이
  던지면 테스트 파일을 하나도 돌리지 않고 그 메시지를 한 번 낸다.
- 처음 띄울 때 이미지를 끌어오면 조용히 멈춘 것처럼 보이므로, `up` 전에 한 줄(`log`,
  기본은 stderr)을 낸다. 테스트에서는 주입한 `log`로 센다.
- `MISSING_URL`은 남겼다. 준비 단계를 거치지 않은 실행(`createTestDatabase`를 직접 부르는
  경우)만 여기까지 오므로, 문구에 `pnpm test`가 스스로 띄운다는 사실을 더했다.
- 건드리지 않은 것: `tooling/dev/auto-build.sh`는 컨테이너가 떠 있으면 변수를 넣는데,
  이제는 없어도 되지만 동작은 그대로 맞다(변수가 있으면 Docker를 부르지 않고 그 DB를 쓴다).

- 리뷰 패치 뒤 재검증(2026-10-19): 컨테이너 없음 → `pnpm test` 46파일 1546건 통과, 끝난 뒤 `ps -q` 빈칸. 컨테이너 떠 있음 → 1546건 통과, 그대로 running. 실패하는 가짜 `docker`로 `vitest run --project sqlite` 216건 통과, docker 호출 0.

## Plan Change Log

## Review Triage Log

**Pass 1 (quick, 2026-10-19):** high 0 · medium 3 · low 4 · false 0 · maybe-false 0. Patches 4, rejected 3, loopback 0.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | `GUIDANCE` points a Docker-less reader at the compose container URL | medium | patch | `GUIDANCE` interpolates `DEFAULT_TEST_DATABASE_URL` (localhost:54329) right after "Docker is not available"; copying it fails again. Placeholder URL. |
| 2 | README "이미 있는 Postgres" example is the compose container URL | medium | patch | The `up` line that used to precede the export was removed, so the example no longer matches the sentence. Placeholder URL. |
| 3 | Teardown drops a failed `docker compose down` silently | medium | patch | Teardown discards `run(...)`'s result; vitest reports errors thrown during teardown ("error during close"). Throw with a summary and the manual command; one unit test. |
| 4 | `up` failure leaves remnants without saying so | low | patch | Direct text addition to the existing error: what was left and `docker compose -f compose.test.yaml down`. |
| 5 | AC 1 has no recorded run | low | reject | The implementer ran it (46 files / 1545 tests, `info → ps → up → down`, `ps -q` empty afterwards); the fix would edit this plan. |
| 6 | vitest prints "No test files found" above the real error | low | reject | vitest's reporter, not this code; the real message still prints once with exit 1, and working around the reporter adds complexity. |
| 7 | src/dist equal-depth assumption behind `COMPOSE_FILE` is unguarded | low | reject | Holds today (`rootDir: src`, `outDir: dist`); breaks only if the build layout moves, and guarding it adds a build-time test. |

## Design Notes

실측(vitest 5.0.3): project에 붙인 `globalSetup`에서 `process.env`에 넣은 값은 그 project의 테스트에 보인다. 고르지 않은 project의 `globalSetup`은 돌지 않는다. 그래서 `provide`/`inject` 없이 env로 넘기고, Postgres 실행에서만 Docker를 부른다.

이미 떠 있는지는 `docker compose -f <compose> ps --status running --quiet postgres`의 출력이 비어 있지 않은지로 판단한다(실측: 떠 있으면 컨테이너 id, 종료 코드 0). 안내 문구는 기존 `MISSING_URL`처럼 영어로 쓴다(dev 도구 출력).

받아들이는 한계: 두 `pnpm test`가 동시에 돌고 먼저 띄운 쪽이 먼저 끝나면 나중 쪽 DB가 내려간다. 드물고 dev 전용이라 막지 않는다.

## Verification

**Commands:**
- `docker compose -f compose.test.yaml down && pnpm test` -- expected: 전체 통과, 이어서 `docker compose -f compose.test.yaml ps -q`가 비어 있음
- `docker compose -f compose.test.yaml up -d --wait && pnpm test && docker compose -f compose.test.yaml ps -q` -- expected: 전체 통과, 컨테이너 id가 나옴
- `pnpm build && npx vitest run --project sqlite` -- expected: 통과, docker 호출 없음(가짜 PATH나 로그로 확인)
