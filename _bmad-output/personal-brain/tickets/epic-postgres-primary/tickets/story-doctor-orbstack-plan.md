---
title: '설치·doctor·제거: OrbStack이 없으면 안내하고 멈추고, 있으면 멱등으로 설치된다'
type: 'feature'
ticket: '8'
created: '2026-10-29'
status: done
baseline_revision: '2c3ab8850813824fab60b2021af0aadd991c37a3'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-postgres-primary/epic-postgres-primary.md'
warnings: ['oversized']
deferred:
  - summary: >-
      기존 Core drain이 transcript scan 실패 이유를 보고에서 버려 설치가 성공 안내를 보일 수 있다.
    evidence: |-
      packages/core/src/brain.ts의 drain은 scanTranscripts의 stopped를 읽지 않고 scan.enqueued와 rereadMissing만 반환한다. 폴더 읽기 실패는 scan에서 stopped로 반환하므로 설치의 기존 BrainDrainReport로는 이를 구별할 수 없다. 이 보고 누락은 baseline 이전 Core에도 있으며 이번 변경은 해당 함수를 재사용한다. 보고 계약과 기존 queue 소비자를 함께 보완할 후속 작업이다. 기존 deferred-work ledger는 변경하지 않았다.
    location: >-
      packages/core/src/brain.ts:471
    severity: medium
---

<intent-contract>

## Intent

**Problem:** PG 홈(`config.toml`에 `[store] url_env`가 있는 홈)의 `setup run`은 OrbStack을 확인하지 않고 바로 `docker compose up`을 부르며, SQLite 파일 준비·소유자·doctor까지 그대로 돌린다. doctor는 PG 홈에서도 OrbStack·컨테이너를 보지 않고 DB부터 확인하며, `setup uninstall`은 컨테이너를 내리지 않는다. 그래서 OrbStack이 없거나 꺼진 Mac에서 무엇을 해야 하는지 알 수 없고, 디스크의 transcript도 설치 때 PG로 들어오지 않는다(E11-8, E11-1, AD-19·20·34).

**Approach:** OrbStack 판별 probe 하나(주입 가능한 비동기 runner 위)를 만들어 setup·doctor·uninstall이 함께 쓴다. PG 홈의 `setup run`은 OrbStack 확인 → compose(필요할 때만 up) → role·schema → 마이그레이션 → "나" → 시간대 → transcript 가져오기 drain → … → PG doctor → 완료 기록으로 돌고 SQLite 단계는 건너뛴다. Core doctor는 선행 검사(prerequisites)가 실패하면 DB 항목을 이유와 함께 skip한다.

## Boundaries & Constraints

**Always:**
- PG 홈 판별은 지금처럼 설정의 `storeUrlEnv` 유무다. SQLite 홈(`url_env` 없음)의 setup·doctor·uninstall 동작과 출력은 바꾸지 않는다.
- OrbStack 판별(epic Notes 2026-10-28 probe 결과): `orb status`의 stdout이 `Running`, `docker context show`가 `orbstack`, `DOCKER_HOST`가 비어 있음, `docker version`(서버)과 `docker compose version` 성공. `docker info` 성공만으로 OrbStack이라 보지 않는다. `orb`이 없으면 `/Applications/OrbStack.app` 유무로 "미설치"와 "CLI가 PATH에 없음"을 가른다. 외부 명령을 부를 때 PATH 뒤에 `/usr/local/bin`, `/opt/homebrew/bin`, `<HOME>/.orbstack/bin`을 덧붙인다(앞에 두지 않는다). 각 probe 명령의 시간 한도는 5초다.
- 판별 실패는 새 오류 코드 `ORBSTACK_UNAVAILABLE`(exit 2, retryable false)로 내려가고, 메시지는 원인별 한국어 안내다: 미설치(설치 방법 `brew install --cask orbstack` 또는 https://orbstack.dev), 꺼짐(`orb start` 또는 앱 켜기), context 다름(`docker context use orbstack`, `DOCKER_HOST` 해제), compose 없음.
- PG 홈 `setup run`의 OrbStack 확인은 질문·쓰기보다 먼저 한다. 실패하면 아무 파일도 쓰지 않고(`.env`·compose 파일·`config.toml`·shim·plist·완료 기록 없음) `ORBSTACK_UNAVAILABLE`로 멈춘다. bootstrap 갱신 경로는 같은 설치기를 부르므로 같은 안내가 설치기 로그에 남고 bootstrap은 기존 `failed('설치기')` 경로로 끝난다.
- 멱등: compose 파일 내용이 그대로이고 그 project의 `postgres` 컨테이너가 running·healthy면 `compose up`을 부르지 않는다. 아니면 `up -d --wait`를 한 번 부른다. role 생성·마이그레이션 적용·"나" 생성은 두 번째 실행에서 0건이다. `.env` 비밀번호는 다시 만들지 않는다.
- 충돌 안내: 이 홈의 볼륨 이름이 이미 있는데 compose project 라벨(`com.docker.compose.project`)이 이 홈의 project가 아니면 up 전에 멈춘다. `compose up`이 포트 사용 중(`port is already allocated`, `address already in use`)으로 실패하면 포트 번호를 넣은 안내로 바꾼다. 둘 다 `DB_UNAVAILABLE`이고 아무것도 지우지 않는다.
- PG 홈 setup은 SQLite 단계(`chooseStorePath` 질문, `storeCollisions`·합치기, `prepareStore`, SQLite `self`, SQLite `doctorAt`)를 돌리지 않는다. `config.toml`의 `store.path`는 기록된 값(없으면 기본값)을 그대로 쓴다(삭제는 티켓 10). PG 홈에서 `--store-path`는 `USAGE`다. 그 경로에 파일이 있으면 지우지 않고 "옛 SQLite 파일 <path>는 지우지 않았고 더 쓰지 않습니다" 한 줄을 보이고 결과 `postgres.legacy_sqlite_path`에 담는다(없으면 null).
- transcript 가져오기: 시간대 다음, 설정 파일 쓰기 뒤·doctor 앞에 PG Store로 조립한 brain의 `queue.drain`을 `DRAIN_BUDGET_MS.command` 예산으로 한 번 돌린다(spool 재생 → 폴더 scan → 일감). 결과를 `postgres.import`(drain 보고의 수치 일부)로 담고 남은 일감은 이후 drain이 잇는다는 한 줄을 보인다. drain 실패는 설치 실패가 아니라 경고 한 줄이다.
- doctor(PG 홈): 순서는 `orbstack` → `container` → `db` → adapter probes(`writable`, `pg_trgm`, `redaction_cleanup`) → `schema-version`(소유자별) → `failures`·`untagged`·`transcripts` → 기존 runtime 검사. `orbstack`이 fail이면 `container`·`db`와 DB 의존 항목이 모두 `skip`이고 detail은 `prereqFailed('orbstack')`; `container`가 fail이면 DB 항목이 `prereqFailed('container')`로 skip. `checkHealth`는 부르지 않는다.
- 조회 명령(doctor 포함)과 hook은 컨테이너를 띄우지 않는다: doctor가 부르는 외부 명령은 읽기(`orb status`, `docker context show`, `docker version`, `docker compose version`, `docker ps`/`volume inspect`)뿐이다.
- `writable` probe는 brain_app으로 트랜잭션 안에서 쓰기를 해 보고 rollback한다. 남는 행이 없고, 잠금 초과면 `warn`, 읽기 전용·권한 없음이면 fail이다.
- `setup uninstall`(PG 홈 또는 `<home>/postgres/compose.yaml`이 있는 홈): 데몬 정리 뒤 OrbStack 확인 → `compose down`(볼륨 유지, `-v` 없음). 볼륨 삭제는 새 플래그 `--delete-volume`과 동의(`--yes`)가 함께 있을 때만이다. 플래그만 있고 동의가 없으면 `CONFIRMATION_REQUIRED`(exit 3)이고 아무것도 내리지 않는다. 볼륨을 남기면 볼륨 이름과 지우는 방법을 한 줄로 보인다. OrbStack이 꺼져 있으면 데몬 정리는 끝내고 `ORBSTACK_UNAVAILABLE`(컨테이너를 남겼다는 말 포함)이다.
- PG 단계의 외부 명령은 모두 `apps/cli/src/runtime/command-runner.ts`의 `CommandRunner`로 부르고, setup·doctor·uninstall 모두 시험이 runner를 주입할 수 있다.
- 모든 사용자 출력 문장은 한국어다(`assertKoreanLine` 규칙).

**Never:**
- OrbStack을 설치하거나 켜지 않는다(`orb start`를 부르지 않는다). 볼륨을 동의 없이 지우지 않는다. 옛 `brain.db`를 지우거나 옮기지 않는다.
- 데몬(`apps/cli/src/daemon/run.ts`)의 Store·재연결은 바꾸지 않는다(티켓 9). SQLite 선택·`store.path`·`packages/sqlite`를 지우지 않는다(티켓 10·11). DW-11(정리 handler·정리 role 접속 조립)은 이 티켓에서 하지 않는다.
- baseline `0001_initial.sql`·`CORE_SCHEMA_VERSION`·마이그레이션 실행기·spool 형식을 바꾸지 않는다. `plugin/app-ref`·plugin version을 바꾸지 않는다.
- `tooling/bootstrap`의 단계 순서·메시지는 바꾸지 않는다(같은 설치기를 공유하는 것으로 충분하다).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| OrbStack 미설치, setup | PG 홈, runner가 `orb` ENOENT, 앱 없음 | exit 2, `ORBSTACK_UNAVAILABLE`, 설치 안내; 홈에 새 파일 없음, runner에 `compose` 호출 없음 | 값으로 반환 |
| OrbStack 꺼짐, setup | `orb status` → `Stopped` | exit 2, `ORBSTACK_UNAVAILABLE`, `orb start` 안내; 새 파일 없음 | 값 |
| context 다름 | `docker context show` → `desktop-linux` | `ORBSTACK_UNAVAILABLE`, `docker context use orbstack` 안내 | 값 |
| OrbStack 꺼짐, doctor | PG 홈 `doctor run --json` | `orbstack` fail(`ORBSTACK_UNAVAILABLE`), `container`·`db`·`writable`·`pg_trgm`·`redaction_cleanup`·`schema-version`·`failures`·`untagged`·`transcripts`가 skip, detail에 `orbstack`; runtime 검사는 그대로 돎; `up`/`start` 호출 없음 | exit는 doctor 기존 규칙 |
| 컨테이너 멈춤, doctor | OrbStack 정상, `docker ps`에 컨테이너 없음/exited | `container` fail, DB 항목 skip(`container`); `up` 호출 없음 | 값 |
| 정상, setup 두 번 | OrbStack 정상, 실제 시험 PG | 1회: up 1회, 적용 N건, owner 생성, transcript 폴더의 세션이 PG에 있음. 2회: up 0회, `applied: []`, `owner_created: false`, `.env` 동일, `schema_migrations` 행 수 동일 | 없음 |
| 볼륨 이름 충돌 | 볼륨이 있고 라벨 project가 다름 | `DB_UNAVAILABLE`, 볼륨 이름·다른 project 안내, up 호출 없음 | 값 |
| 포트 충돌 | `compose up` stderr에 `port is already allocated` | `DB_UNAVAILABLE`, 포트 번호 안내 | 값 |
| 옛 brain.db | PG 홈, 기록된 `store.path`에 파일 있음 | "더 쓰지 않음" 한 줄, 파일 그대로, `legacy_sqlite_path`에 경로 | 없음 |
| uninstall 기본 | PG 홈, OrbStack 정상 | `compose down`(-v 없음) 1회, 볼륨 남김 안내, `data.postgres.down: true`, `volume_removed: false` | 없음 |
| uninstall 볼륨 삭제 | `--delete-volume` 동의 없음 / `--delete-volume --yes` | 앞: exit 3 `CONFIRMATION_REQUIRED`, runner 호출 없음; 뒤: `down -v` 또는 down 뒤 볼륨 삭제, `volume_removed: true` | 값 |
| SQLite 홈 | `url_env` 없음 | setup·doctor·uninstall 지금과 같음, OrbStack probe 호출 없음 | 지금과 같음 |

</intent-contract>

## Code Map

- `apps/cli/src/runtime/command-runner.ts` -- `CommandRunner`·`systemCommandRunner`·`composeArgs`·`fakeCommandRunner`. ENOENT를 구별할 수 있게 실패 값에 `code?`(errno 문자열)를 더한다. PATH 덧붙이기 helper를 여기 둔다.
- `apps/cli/src/runtime/orbstack.ts`(새) -- `probeOrbStack({ runner, env, appExists? })` → `{ ok: true; detail }` | `{ ok: false; reason: 'not-installed'|'cli-missing'|'stopped'|'context'|'engine'|'compose'; message; hint }`. `containerState({ home, runner, env })`: `docker ps -a --filter label=com.docker.compose.project=<project> --format json`로 `postgres` 서비스 상태·health를 읽는다(compose 파일 보간이 필요 없게). `volumeOwner(...)`: `docker volume inspect`의 project 라벨.
- `apps/cli/src/install/postgres.ts` -- `installPostgres`: OrbStack 판별 결과를 받는 쪽은 flow, 여기서는 볼륨 충돌 확인 → compose 파일 비교 쓰기 → 필요할 때만 `up -d --wait` → `prepareDatabase` → `runMigrations` → `ensureSelfUser`. 포트 충돌 stderr 분류. 시험이 실제 시험 PG를 쓰도록 비밀·DB 이름 seam(예: `secrets?`, `databaseName?`)을 둔다(기본은 지금의 `postgresSecrets`와 `brain`). 보고에 `compose_started: boolean`을 더한다.
- `apps/cli/src/install/flow.ts:351`(`runInstall`) -- PG 홈 분기: 설정 읽기 직후 OrbStack 판별, SQLite 단계 생략, `askToProceed` 목록을 PG 자원(compose 파일, project·볼륨·포트)으로, 시간대 뒤 transcript drain, PG doctor, `installed.write`의 `schema_version`은 `build?.schema_version ?? postgres.schema_version`. `InstallDeps`의 PG 관련 의존(`postgres`, `settings`, 새 `orbstack`, `postgresDoctor`, `importTranscripts` 등)을 한 묶음으로 정리해도 된다. 결과 `report.store`는 SQLite 홈에서만, `report.postgres`에 `legacy_sqlite_path`·`import`·`compose_started`.
- `apps/cli/src/install.ts:155`(`systemInstallDeps`) -- runner 주입(`systemInstallDeps({ runner? })`)과 PG doctor·drain 조립. PG doctor는 dispatch의 doctor와 같은 조립(`assembly.ts`)을 쓴다.
- `apps/cli/src/commands/setup-run.ts` -- 출력 설명(`output`)에 바뀐 필드, PG 홈 `--store-path` 거절.
- `packages/core/src/doctor/doctor.ts:150`(`runDoctor`) -- `DoctorOptions.prerequisites?: readonly DoctorCheckSource[]`: DB보다 먼저 돌고, 첫 fail의 id로 `db`와 DB 의존 항목(지금 skip 목록 + adapter probe가 없으므로 probe는 행 없음)을 skip한다. 기존 `db` 실패 skip 규칙은 그대로. `packages/core/src/brain.ts:362`가 옵션을 넘긴다(`BrainDependencies`에 `prerequisites?`).
- `packages/core/src/codes.ts` -- `ORBSTACK_UNAVAILABLE`(오류, exit 2, 의미·hint 한국어). `README.md`의 오류 코드 표(800행 부근)와 설치·doctor·제거 설명에 PG 홈 동작을 더한다(`apps/cli/test/readme-codes.test.ts`가 표를 대조).
- `apps/cli/src/assembly.ts:96` -- PG 홈일 때 `prerequisites: [orbstack, container]`를 runner와 함께 넘긴다. `apps/cli/src/runtime/brain-store.ts`의 `kind`로 판별. `apps/cli/src/dispatch.ts:349` `DispatchRuntime`에 `runner?: CommandRunner` seam.
- `packages/postgres/src/store.ts:21`(`checkHealth`) -- probes 앞에 `writable`(트랜잭션 안 임시 쓰기 → rollback; `55P03` → warn). vector 탐침은 이미 없다.
- `apps/cli/src/commands/setup-uninstall.ts`, `apps/cli/src/daemon/control.ts`(`uninstallDaemon`은 그대로) -- PG 정리 단계와 `--delete-volume`·`--yes` 옵션, 결과 `postgres: { down, volume, volume_removed } | null`.
- `apps/cli/src/install/docker.ts` -- 어디서도 import하지 않는 옛 pgvector·`docker run` helper. OrbStack probe가 대신하므로 지운다.
- 시험 선례: `apps/cli/test/postgres-setup.test.ts`(`vi.mock('second_brain/postgres')`, `fakeCommandRunner`), `apps/cli/test/install-flow.test.ts`(deps 가짜), `apps/cli/test/setup-uninstall.test.ts`, `apps/cli/test/doctor-checks.test.ts`, `packages/postgres/test/cli.test.ts`·`fixture.ts`(`database()`는 시험 비밀번호 `brain-test-app`·`brain-test-maintenance`로 prepare), `packages/core/test` doctor 시험.
- `tooling/dev/pg-tracer.sh` -- 실제 OrbStack에서 `setup run` 두 번·재생성·spool을 확인하는 기존 스크립트. 바뀐 결과 모양에 맞춰 단언만 고치고, 두 번째 setup의 `compose_started: false`를 더한다.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/codes.ts`, `README.md` -- `ORBSTACK_UNAVAILABLE` 등록과 문서 -- 안내의 공통 어휘
- [x] `packages/core/src/doctor/doctor.ts`, `brain.ts`, 관련 Core 시험 -- `prerequisites` 순서·skip 규칙(첫 fail id, 기존 `db` fail 규칙 유지, 선행 검사 없음이면 지금과 같음) -- 검사 순서·의존성
- [x] `apps/cli/src/runtime/command-runner.ts`, `runtime/orbstack.ts`(새), `apps/cli/test/orbstack.test.ts`(새) -- probe와 원인별 분류를 `fakeCommandRunner`로 표 시험(미설치·CLI 없음·Stopped·context·DOCKER_HOST·engine·compose·정상)
- [x] `packages/postgres/src/store.ts`, `packages/postgres/test/store.test.ts` -- `writable` probe(정상 ok·행 남지 않음, 잠금 warn)
- [x] `apps/cli/src/install/postgres.ts`, `install/flow.ts`, `install.ts`, `commands/setup-run.ts`, `assembly.ts`, `dispatch.ts` -- PG 홈 setup·doctor 흐름과 runner seam
- [x] `apps/cli/src/commands/setup-uninstall.ts` -- compose down·볼륨 동의
- [x] `apps/cli/src/install/docker.ts` -- 삭제
- [x] `packages/postgres/test/install-orbstack.test.ts`(새, PG project: 실제 시험 PG + 가짜 runner) -- 시험 이름: `'stops setup and doctor with guidance and skipped db checks when OrbStack is %s'`(`it.each(['missing','stopped','other-context'])`), `'runs setup twice against one database with compose, roles and migrations once'`, `'imports the transcripts on disk during a PG setup'`, `'leaves the volume after setup uninstall and removes it only with consent'`, `'refuses a volume owned by another project and names a busy port'`. setup·doctor·uninstall은 in-process(`runInstallerWithFlags`/`runInstall`, dispatch `execute`)로 runner를 주입한다. `apps/cli`에는 시험 DB global-setup이 없으므로 이 시험은 PG project에 두고 빌드된 `apps/cli/dist/*.js`를 상대 URL로 import한다(`cli.test.ts`가 `dist/bin.js`를 가리키는 방식과 같다)
- [x] `apps/cli/test/install-flow.test.ts`, `setup-uninstall.test.ts`, `doctor-checks.test.ts`, `postgres-setup.test.ts` -- 매트릭스의 SQLite 홈 무변경·legacy 한 줄·`--store-path` 거절·출력 언어
- [x] `tooling/dev/pg-tracer.sh` -- 바뀐 결과에 맞춘 단언, 두 번째 setup `compose_started: false`, 처음에 `doctor run --json`의 `orbstack`·`container`·`db`·`writable`·`pg_trgm`·`schema-version`이 ok

**Acceptance Criteria:**
- Given OrbStack이 켜진 저장소, when `npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/install-orbstack.test.ts`, then 위 다섯 시험(각 case 포함)이 통과한다: OrbStack 미설치·꺼짐·다른 context에서 setup이 `ORBSTACK_UNAVAILABLE`로 멈추고 홈에 새 파일이 없으며 doctor는 DB 항목을 `orbstack` 이유로 skip한다; 정상 setup 두 번에서 `compose up` 호출 1회, 두 번째 `applied: []`·`owner_created: false`; 디스크 transcript 세션이 PG에 있다; uninstall 뒤 `compose down`만 불리고 볼륨 삭제 명령은 동의가 있을 때만 불린다.
- Given OrbStack이 켜진 이 Mac, when `npx --yes pnpm@12 build && sh tooling/dev/pg-tracer.sh --delete-volume`, then exit 0이고 실제 OrbStack에서 doctor의 `orbstack`·`container`·`db`·`writable` 항목이 ok이며 두 번째 setup이 compose를 다시 올리지 않는다.
- Given 전체 저장소, when `npx --yes pnpm@12 test`, then build·typecheck와 모든 시험이 통과한다.

## Implementation Notes

- PG 설치·doctor·제거, 공통 runner와 OrbStack probe, writable rollback probe, transcript drain과 경고, 문서 및 tracer를 구현했다.
- 리뷰의 spool 재생 실패 안내 누락을 수정했다.
- 사용자 확정: intent-contract의 I/O 매트릭스가 우선이며 Code Map의 "probe는 행 없음"은 계획 작성 실수다. 아래 기존 Review Triage Log와 실행 결과의 "사용자 해석 대기" 기록은 이 결정으로 해소됐다.
- `DoctorOptions`와 `BrainDependencies`에 `adapterProbeIds`를 추가했다. PG 조립은 `second_brain/postgres`가 export하는 `POSTGRES_DOCTOR_PROBE_IDS`를 전달한다. 실제 PG health probe와 skip 행은 동일한 상수를 사용하며 Core는 adapter 이름에 의존하지 않는다.
- OrbStack 또는 container 선행 검사 실패 시 `db` 뒤에 `writable`·`pg_trgm`·`redaction_cleanup`의 skip 행을 표시하고, detail은 첫 실패 ID의 `prereqFailed`다. 선행 검사 통과 뒤 DB 연결 실패 시에는 기존처럼 adapter probe 행을 만들지 않는다.
- 추가 검증: build·typecheck 통과. Core doctor 시험 28개, PG 통합·Store 시험 88개(설치 통합 8개 포함), 영향받는 CLI 6개 파일의 시험 304개 통과. `git diff --check` 통과.
- 실행 명령: `npx --yes pnpm@12 build`, `npx --yes pnpm@12 typecheck`, `npx --yes pnpm@12 exec vitest run --project core packages/core/test/doctor.test.ts`, `npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/install-orbstack.test.ts packages/postgres/test/store.test.ts`, `npx --yes pnpm@12 exec vitest run --project cli apps/cli/test/doctor-checks.test.ts apps/cli/test/dispatch.test.ts apps/cli/test/install-flow.test.ts apps/cli/test/postgres-setup.test.ts apps/cli/test/setup-uninstall.test.ts apps/cli/test/orbstack.test.ts`.
- 이번 후속 수정에서 plan frontmatter를 변경하지 않았고 staging·커밋·push를 하지 않았다. 미해결 요구사항은 없다.


### 오케스트레이터 후속 수정: PG 지연 로딩·SQLite 무호출

- `assembly.ts`의 PostgreSQL 정적 값 import를 제거했다. `openBrainStore`는 PG 분기 안의 기존 동적 import에서 받은 `POSTGRES_DOCTOR_PROBE_IDS`를 반환하고, dispatch·install이 그 목록을 assembly에 전달한다. 기존 `install.ts` 외에는 CLI 소스에 PostgreSQL 정적 값 import가 없다.
- SQLite 홈의 설치에서는 `deps.orbstack`을 호출하지 않음을 단언했다. `url_env`와 compose 파일이 없는 SQLite 홈에서 주입 runner를 쓰는 doctor·uninstall은 runner 호출 0회이며 doctor에 `orbstack`·`container` 행이 없음을 통합 시험으로 검증했다.
- factory 시험 mock을 새 adapter 메타데이터에 맞춰 보완했고, PG 모듈이 제공한 목록을 그대로 반환함을 검증했다.
- 최종 `npx --yes pnpm@12 test` 통과: build·typecheck 및 121개 파일 / 3,188개 시험. `help does not load pg`·`hook does not load pg` 회귀 시험과 신규 SQLite 무호출 시험을 포함한다. `git diff --check` 통과.
- 중간 전체 실행에서 기존 bootstrap hook 시험의 임시 commit SHA 숫자열이 개인정보로 오인돼 마스킹되는 실패가 한 번 있었다. 해당 코드를 변경하지 않았고 최종 전체 재실행은 모두 통과했다.
- 이번 후속 수정에서도 plan frontmatter는 변경하지 않았으며 staging·커밋·push를 하지 않았다.


### 리뷰 후속 수정: 제거·연결 반환·실패 원인 보존

- 제거의 PG 정리는 compose 파일이 있을 때만 실행한다. 파일이 없으면 PG 설정 유무와 관계없이 데몬 정리 결과와 `postgres: null`을 반환하며 runner를 호출하지 않는다.
- compose down 실패 안내에 `(stderr || stdout || message).slice(-2000)`을 붙였다. 각 출력 원천별 시험에서 exit 2·`DB_UNAVAILABLE`·데몬 정리 완료 안내·꼬리 길이 제한을 검증했다.
- writable probe의 rollback 실패 시 `client.release(error)`로 해당 연결을 폐기하고 오류를 전파한다. 정상 rollback 연결만 오류 없이 반환한다.
- 읽기 전용 연결(25006)과 쓰기 권한을 회수한 연결(42501)에서 health 자체는 성공하고 writable만 실패하며 warn은 없고 다른 probe들은 그대로 보고되는지 시험했다.
- transcript 가져오기 예외 경고에 Error 메시지 또는 문자열 값을 붙였고 두 경우 모두 설치는 성공함을 시험했다.
- 관련 패키지 PostgreSQL·CLI 빌드 통과. 관련 시험만 실행: PG `install-orbstack.test.ts`·`store.test.ts`의 95개, CLI `install-flow.test.ts`·`setup-uninstall.test.ts`의 136개 모두 통과. `git diff --check` 통과. 전체 검증은 요청대로 실행하지 않았다.
- 이번 수정에서 plan frontmatter는 변경하지 않았고 staging·커밋·push를 하지 않았다.

### 오케스트레이터 기록

- 구현 세션(codex thread `01a1831e-b2f5-79b3-9090-6e6a871e1c3b`)이 첫 턴에 frontmatter를 `status: in-review`·`review: quick`·`lenses_ran: ['quick']`로 바꾸고 아래 Review Triage Log에 자체 점검 두 줄을 남겼다. 이 점검은 step-04 리뷰가 아니므로 오케스트레이터가 frontmatter를 되돌렸고, 두 줄은 append-only 규칙에 따라 남긴다. 그중 `maybe-false`(adapter probe skip 행)는 오케스트레이터가 "intent-contract 매트릭스 우선"으로 답해 해소됐고 skip 행을 구현했다. Verification 아래 "실행 결과 (2026-10-30 KST)"의 "사용자 답변 대기" 문장도 같은 결정으로 해소됐다.
- 오케스트레이터 검증 중 전체 시험에서 `packages/second_brain/test/import-side-effects.test.ts`의 `help does not load pg`·`hook does not load pg`가 실패했다(`assembly.ts`의 `second_brain/postgres` 정적 import). 구현 세션이 probe id를 `openBrainStore`의 동적 import 결과로 옮겨 고쳤다.

## Plan Change Log

## Review Triage Log

- `maybe-false` / 사용자 해석 대기 — `packages/core/src/doctor/doctor.ts`: 실패 매트릭스는 `writable`·`pg_trgm`·`redaction_cleanup`의 skip 행을 요구하지만 Code Map은 adapter probe를 알 수 없어 행을 만들지 않도록 명시한다. 현재 구현은 Code Map을 따른다. 어느 계약을 적용할지 사용자에게 질문했으며, 답변 전에는 이 부분을 변경하지 않는다.
- `medium` / `patch` / 수정 완료 — `apps/cli/src/install/flow.ts`: `spoolFailed > 0`인데 queue `failed`가 0이면 가져오기 성공 안내가 나왔다. 경고 조건에 `spoolFailed`를 포함하고 replay-only 실패 회귀 시험으로 확인했다(설치 흐름 시험 130개 통과).

### 2026-10-29 — Review pass
- verdicts: 21 findings — high 0, medium 4, low 8, false 9, maybe-false 0
- findings:
  - `[low]` `[reject]` blind: uninstall이 `.env`(`--env-file`, 비밀번호 보간)에 의존해 `.env`를 잃으면 `compose down`이 실패한다 — 실제다. 그러나 `.env` 유실은 setup이 비밀을 만든 뒤 사람이 지운 경우뿐이라 일상 사용에서 드물고, 비밀 없이 내리는 경로는 새 분기·인자가 필요하다. 실패는 아래 patch로 원인 꼬리와 함께 보고된다.
  - `[medium]` `[patch]` blind: PG 설정만 있고 `compose.yaml`이 없는 홈에서도 `compose down`을 시도해 실패한다 — `setup-uninstall.ts`가 `url_env` 홈이면 compose 파일 없이도 OrbStack 확인·down을 불렀다(OrbStack 확인에서 멈춘 설치 뒤 흔한 상태). PG 정리를 compose 파일이 있을 때만 돌게 했고 runner 무호출 시험을 더했다. 라벨로 복구하는 경로 제안은 새 표면이라 넣지 않았다.
  - `[low]` `[reject]` blind: `--delete-volume`이 볼륨 소유자를 확인하지 않는다 — 설치가 다른 project 라벨의 볼륨을 거부하므로 이 홈의 compose 파일이 가리키는 볼륨은 설치 이후 바뀌지 않는 한 이 project 것이다. 바뀌는 경우는 사람이 같은 해시 이름의 볼륨을 다시 만든 때뿐이고, 확인을 넣으려면 새 분기가 필요하다. 명시적 `--delete-volume --yes` 동의도 필요하다.
  - `[low]` `[patch]` blind: `compose down` 실패 시 stderr·stdout·message를 모두 버린다 — 설치의 up 실패처럼 마지막 2000자 꼬리를 메시지에 붙였고 출력 원천별 시험을 더했다.
  - `[false]` `[reject]` blind: `writable` 검사가 `brain.settings`에 의존해 표가 없으면 health 전체가 `DB_UNAVAILABLE`이 된다 — 변경 전에도 `redaction_cleanup` probe가 `brain.work_items`·`brain.failures`를 읽어 같은 결과였고, `brain` schema·표 없음은 티켓 7이 모든 경로에서 `DB_UNAVAILABLE`로 고정한 분류다(AD-10). 새 동작이 아니다.
  - `[low]` `[patch]` blind: rollback이 실패해도 `client.release()`로 연결을 풀에 돌려준다 — rollback 실패 시 `client.release(error)`로 연결을 폐기하게 고쳤다(직접 수정).
  - `[low]` `[reject]` blind: transcript 가져오기 실패가 `deps.log`에만 남아 `--json`의 `warnings`에 없다 — JSON 보고의 `postgres.import`가 drain 보고(`failed`·`spoolFailed`·`stopped`) 또는 `null`을 그대로 담아 기계 소비자가 판별할 수 있다. 구조화 경고를 더하려면 새 경고 코드(공개 표면)가 필요하다.
  - `[low]` `[patch]` blind: 가져오기 예외의 원인을 버린다 — 경고 줄에 예외 메시지를 붙였다.
  - `[medium]` `[patch]` blind: `writable`의 `42501`·`25006` 분기를 시험하지 않는다 — verification-gap의 첫 항목과 같은 원인. 아래 patch로 묶었다.
  - `[low]` `[reject]` blind: README가 옛 SQLite 파일을 "더 쓰지 않습니다"라고 하지만 데몬은 아직 `sqliteStore`를 연다 — 실제다(티켓 7 리뷰의 같은 관찰). "더 쓰지 않음" 한 줄은 의도가 요구한 문장이고, 데몬 전환은 같은 에픽의 티켓 9가 소유한다. 이 빌드는 티켓 10·13 전에 플러그인으로 배포되지 않으므로 사용자가 이 상태를 만나지 않는다.
  - `[low]` `[reject]` edge: `--delete-volume --yes`가 다른 project 볼륨을 지울 수 있다 — blind의 같은 지적과 같은 근거로 거절.
  - `[medium]` `[patch]` edge: compose 파일이 없는 PG 홈의 uninstall 실패 — blind의 같은 지적과 같은 원인·같은 수정.
  - `[medium]` `[patch]` verification-gap: 쓰기 권한 오류의 `writable` 실패가 검증되지 않는다 — `store.test.ts`에 읽기 전용 연결(25006)과 쓰기 권한을 회수한 연결(42501)에서 health는 ok, `writable`은 `ok: false`·warn 없음, 다른 probe는 그대로임을 확인하는 시험을 더했다.
  - `[medium]` `[patch]` verification-gap: uninstall의 compose down 실패 회귀를 시험하지 않는다 — `install-orbstack.test.ts`에 down만 실패시켜 exit 2·`DB_UNAVAILABLE`·"데몬 정리는 끝났지만" 안내·꼬리를 확인하는 시험을 더했다.
  - `[false]` `[reject]` intent: PG 분기가 이미 기록된 `url_env`에 의존하고 bootstrap 실행 시험이 없다 — PG 기본화는 티켓 10이다(에픽 범위). bootstrap 갱신은 `tooling/bootstrap/src/bootstrap.ts:431`에서 같은 `apps/cli/dist/install.js`를 부르고 그 진입점이 `runInstallFlow` → `runInstall`을 돌므로 PG 홈 흐름을 그대로 공유한다.
  - `[false]` `[reject]` intent: OrbStack probe가 실제 probe 결과와 맞는지 확인되지 않는다 — `tooling/dev/pg-tracer.sh`가 이 Mac의 실제 OrbStack에서 setup과 doctor의 `orbstack`·`container`·`db`·`writable` ok를 확인했다(검증 통과). 미설치·CLI 없음 두 분기는 `apps/cli/test/orbstack.test.ts`가 `appExists`를 주입해 고정한다.
  - `[false]` `[reject]` intent: role 생성 한 번을 세지 않는다 — role 이름은 클러스터에서 유일하고 `prepareDatabase`가 `if not exists`로 만들며, 그 멱등성은 `packages/postgres/test/setup.test.ts`의 `prepares role and schema idempotently…`가 확인한다. 통합 시험은 두 번째 실행의 `applied: []`·마이그레이션 행 불변·up 1회를 확인한다.
  - `[false]` `[reject]` intent: uninstall 시험이 실제 컨테이너 부재·볼륨 존속을 조회하지 않는다 — ticket verify가 가짜 runner 통합 시험을 지정했고, 시험은 볼륨을 남기는 `down`(`-v` 없음)과 동의가 있을 때만 `-v`를 단언한다. `down`이 named volume을 남기는 것은 docker compose의 동작이다.
  - `[low]` `[reject]` intent: 기존 PG 데이터가 있을 때 재가져오기와 전체 완료를 검증하지 않는다 — 가져오기는 멱등 키를 쓰는 기존 `session_ingest` drain이고 그 멱등성은 세션 Store 계약이 확인한다. 전체 완료 대기를 시험하려면 큰 fixture와 시간 예산 조정이 필요해 이득이 적다.
  - `[false]` `[reject]` intent: 소유자별 schema 표시·일반 조회 명령의 비기동을 직접 시험하지 않는다 — `schema-version` detail은 Core `schemaCheck`가 소유자별(`` `core`: 1 ``)로 쓰는 기존 동작이다. dispatch에서 runner를 쓰는 곳은 doctor 선행 검사(읽기 명령)뿐이고, 통합 시험이 doctor에서 `up`/`start` 호출이 없음을 단언한다.
  - `[false]` `[reject]` intent: 시험 이름과 실행 명령의 plan 기록이 diff에 없다 — plan은 리뷰 diff에서 뺐을 뿐이며 Tasks & Acceptance와 Verification에 시험 이름과 명령이 있다.


### 2026-10-30 — 후속 Review pass
- verdicts: 22 findings — high 0, medium 5, low 9, false 8, maybe-false 0
- findings:
  - `[false]` `[reject]` intent: role·마이그레이션 단계 호출 자체는 매번 실행됨 — carried: 기존 role 멱등 지적의 false/reject를 유지한다. 요구는 중복 생성·적용 방지이고 setup.test.ts가 role 멱등을 검증한다. 통합 시험은 applied:[]·행 불변·up 1회를 단언한다.
  - `[low]` `[reject]` intent: 전체 transcript 재수집 완료·기존 PG 재수집을 직접 관찰하지 않음 — carried: 기존 같은 주장의 low/reject를 유지한다. 기존 세션 Store 멱등 계약이 중복을 막고 명령 예산 한 번이라는 계약에 맞게 나머지는 이후 drain이 잇는다.
  - `[false]` `[reject]` intent: bootstrap 전체 프로세스 통합 시험 없음 — carried: 기존 같은 주장의 false/reject를 유지한다. bootstrap이 동일 dist/install.js를 호출하며 티켓은 가짜 runner를 주입한 설치 통합 시험을 지정했다.
  - `[false]` `[reject]` intent: 실제 Docker 컨테이너 부재·볼륨 존속을 fake가 모델링하지 않음 — carried: 기존 같은 주장의 false/reject를 유지한다. 지정된 fake 통합 검증은 down과 -v 부재/동의 인자를 관찰하며 실제 tracer도 이번에 통과했다.
  - `[false]` `[reject]` intent: compose 없는 PG 홈은 down 없이 성공함 — 기존 리뷰가 설치 중단 후 자원이 없는 홈의 올바른 제거로 고친 동작이고 직접 회귀 시험이 있다. 정상 설치가 만든 compose가 있는 홈은 down을 실행한다.
  - `[false]` `[reject]` intent: DB만 실패하면 adapter skip 행을 생략함 — 의도와 확정된 매트릭스는 OrbStack·container 선행 실패의 skip 행을 요구한다. 정상 선행 검사 뒤 DB 실패는 기존 doctor 규칙을 보존하므로 요구 위반이 아니다.
  - `[false]` `[reject]` intent: 일반 조회 명령 전체의 비기동 시험 없음 — carried: 기존 같은 주장의 false/reject를 유지한다. runner는 doctor 읽기 선행 검사에만 추가됐고 다른 조회는 compose up 경로가 없다.
  - `[low]` `[reject]` edge: compose EACCES인데 제거 성공 반환 — blind의 같은 실제 문제·같은 근거로 거절한다. ENOENT 외 오류를 나누는 분기가 필요한 드문 수동 권한 변경 경로다.
  - `[false]` `[reject]` edge: settings 표 누락 때문에 DB_UNAVAILABLE로 나머지 점검 생략 — carried: 기존 같은 위치·주장의 false/reject를 유지한다. baseline의 redaction_cleanup도 core 표를 읽고 표 누락은 기존 DB_UNAVAILABLE 계약이다.
  - `[medium]` `[patch]` verification-gap: 같은 project의 기존 볼륨 재사용 시험 없음 — 보고의 검색·시험 증거를 신뢰한다. 기존 정상 runner가 볼륨 없음만 반환해 소유자 비교 회귀를 못 잡는다. fake runner가 up 뒤 볼륨과 현재 project 라벨을 유지하도록 수정했고 두 번째 setup 성공·마이그레이션 보존을 검증했다.
  - `[medium]` `[patch]` verification-gap: 같은 compose 파일과 멈춘 컨테이너 조합의 복구 시험 없음 — 보고의 증거를 신뢰한다. 기존 healthy 재설치만으로 !state.ok 누락을 못 잡는다. 컨테이너만 멈춘 뒤 setup의 compose_started:true·up 누적 2회·파일 동일·마이그레이션 불변·doctor 복구를 검증했다.
  - `[medium]` `[patch]` verification-gap: OrbStack 중지 시 제거의 부분 정리 시험 없음 — 보고의 증거를 신뢰한다. 기존 stopped 제거 사례는 compose가 없어 probe 전에 반환한다. compose와 데몬 흔적이 있는 상태에서 exit 2·ORBSTACK_UNAVAILABLE·컨테이너 보존 안내·흔적 삭제·orb status 외 호출 없음을 검증했다.
  - `[low]` `[reject]` blind: `.env`가 없으면 제거할 수 없음 — carried: 기존 같은 위치·주장의 판정을 유지한다. 비밀 파일을 사람이 지운 상황은 드물고 비밀 없는 정리 경로는 새 분기가 필요하다.
  - `[low]` `[reject]` blind: compose 접근 오류를 파일 없음으로 처리함 — `access(...).then(..., () => false)`가 권한 오류도 삼킨다. 사람이 홈·compose 권한을 바꾼 경우의 잔여 컨테이너 안내 누락이며 일상 경로가 드물고 수정에는 새 오류 분기가 필요하다. 파일 없음의 무호출 성공은 이전 리뷰의 수정된 계약이다.
  - `[low]` `[reject]` blind: 볼륨 삭제 직전 소유자 확인 없음 — carried: 기존 같은 위치·주장의 low/reject를 유지한다. 추가로 이번 보고의 “충돌 거부 직후 compose 생성” 주장은 installPostgres가 volumeOwner 거부 뒤에만 secrets·compose를 쓰므로 성립하지 않는다.
  - `[low]` `[reject]` blind: compose up 실패 뒤 저장된 파일 때문에 재시도 생략 가능 — 파일을 먼저 쓰는 사실은 맞지만 현재 renderer의 내용은 baseline과 같고 정상 설치만으로 다른 컨테이너 구성을 만들지 않는다. 수동으로 다른 구성을 적용하거나 향후 renderer가 변경되는 상황에서만 해가 생긴다. 적용 상태 기록·비교라는 새 상태 관리가 필요한 드문 경로여서 거절한다.
  - `[low]` `[reject]` blind: oneoff postgres 컨테이너를 서비스로 오인 가능 — 서비스 라벨만 보는 find라 수동 compose run으로 같은 라벨의 컨테이너를 추가하면 오인이 가능하다. 제품은 oneoff를 만들지 않으며 새 라벨 분기를 넣을 이득이 낮다.
  - `[false]` `[reject]` blind: transcript drain 전에 schema 확인 없음 — runInstall이 drain 전에 deps.settings.get을 호출하고 withSettings → createSettingsBrain → getSetting의 checkSchema가 같은 env 우선 URL을 검사한다. 불일치면 즉시 설치가 반환되어 drain에 닿지 않는다.
  - `[medium]` `[patch]` blind: 포트·볼륨 DB_UNAVAILABLE의 종료 코드가 1로 덮임 — PG 실패 반환의 명시적 exit를 제거해 코드 표의 기본값 2를 쓰도록 수정했다. installer와 CLI 양쪽에서 포트·볼륨 충돌 exit 2를 검증했고 설치 흐름의 기존 단언도 갱신했다.
  - `[low]` `[reject]` blind: JSON 가져오기 예외 원인 누락 — carried: 기존 같은 위치·주장의 low/reject를 유지한다. import:null로 실패 여부를 알 수 있으며 별도 오류 필드는 공개 보고 계약을 늘린다.
  - `[medium]` `[defer]` blind: scan 실패를 가져오기 성공으로 표시할 수 있음 — 기존 Core drain이 scan.stopped를 버리므로 설치가 이를 알 수 없다. baseline의 동일 drain에도 있는 보고 누락이다. 새 후속 항목을 계획 deferred에만 기록했고 기존 ledger 항목은 변경하지 않았다.
  - `[low]` `[reject]` blind: Docker CLI ENOENT를 context 오류로 안내함 — docker가 PATH에 없으면 context 분기로 가는 것은 맞다. 정상 OrbStack CLI 설치와 PATH 보완 뒤에도 Docker CLI만 없는 드문 환경이며 원인별 새 분류 분기가 필요해 거절한다.

## Design Notes

**PG 홈에서 SQLite 단계를 건너뛰는 이유:** 티켓 7 뒤로 PG 홈의 hook·명령은 PG만 쓰므로 SQLite 파일 준비·doctor는 쓰지 않는 저장소를 만들거나 엉뚱한 점검을 보인다. "옛 brain.db는 더 쓰지 않음" 한 줄은 이 분기의 결과다. SQLite 홈은 티켓 10까지 그대로다.

**up을 건너뛰는 조건:** `up -d --wait`는 docker 쪽에서 멱등이지만, compose 파일이 그대로이고 컨테이너가 healthy일 때 부르지 않아야 "compose 한 번"이 관찰된다. 파일 내용이 바뀌었거나 컨테이너가 없거나 unhealthy면 부른다.

**시험 PG와 설치기의 연결:** 설치기는 홈에서 포트를 파생하므로 시험은 비밀·DB 이름 seam으로 시험 클러스터(`TEST_DATABASE_URL`의 관리 URL, `brain-test-app`/`brain-test-maintenance` 비밀번호, 시험 DB 이름)를 가리키고, 런타임 URL은 `env[urlEnv] = db.appUrl`로 준다(`resolveStoreUrl`은 프로세스 env를 먼저 읽는다). docker·orb 명령만 가짜 runner가 답한다.

```ts
// doctor prerequisites (예)
runDoctor(store, { ..., prerequisites: [orbstackCheck, containerCheck] });
// orbstack fail → [{id:'orbstack',status:'fail',code:'ORBSTACK_UNAVAILABLE'}, {id:'container',status:'skip',detail:prereqFailed('orbstack')}, {id:'db',status:'skip',...}, ...]
```

## Verification

**Commands:**
- `npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/install-orbstack.test.ts` -- expected: 통과
- `npx --yes pnpm@12 exec vitest run --project cli apps/cli/test/orbstack.test.ts apps/cli/test/install-flow.test.ts apps/cli/test/setup-uninstall.test.ts apps/cli/test/doctor-checks.test.ts apps/cli/test/postgres-setup.test.ts apps/cli/test/readme-codes.test.ts` -- expected: 통과
- `npx --yes pnpm@12 build && sh tooling/dev/pg-tracer.sh --delete-volume` -- expected: exit 0
- `npx --yes pnpm@12 test` -- expected: build·typecheck·전체 시험 통과
- `git diff --check` -- expected: 출력 없음

### 실행 결과 (2026-10-30 KST)

- `npx --yes pnpm@12 test`: 최종 재실행에서 build·typecheck, 121개 파일 / 3,182개 시험 통과.
- PG 통합 시험 7개, 대상 PG 시험 97개, 대상 CLI 시험 220개 통과. 리뷰 수정 후 설치 흐름 시험 130개 통과.
- `sh tooling/dev/pg-tracer.sh --delete-volume`: 실제 OrbStack에서 최종 재실행 통과. doctor 항목, 두 번째 setup compose 재사용, 재생성 뒤 데이터·시간대 보존, 장애 spool·복구 drain, 임시 자원 정리 확인.
- `git diff --check`: 통과.
- 리뷰 수정 직후 전체 실행에서 기존 daemon-run의 설정 오류 대기 시험이 한 번 시간 초과됐다. 해당 파일 단독 35개 및 전체 재실행 3,182개는 통과했다. 데몬 코드는 변경하지 않았다.
- 미완료 판단: adapter probe skip 행 표시는 계획의 상충하는 지시 중 어느 쪽을 적용할지 사용자 답변 대기. 커밋·staging·push는 하지 않았다.

## Auto Run Result

### 후속 thorough 리뷰 결과 (2026-10-30 KST)

- 기존 `built` 계획을 재검토했다. 티켓과 계획의 상태는 오케스트레이터 소유로 유지했고 `tickets.py mark`는 실행하지 않았다.
- `blind-hunter`, `edge-case-hunter`, `verification-gap`, `intent-alignment` 네 렌즈가 모두 보고했다. 기존 deferred-work ledger 항목은 읽어 고치거나 다시 열지 않았다.
- 새 Core scan 보고 누락은 기존 문제로 계획의 `deferred`에만 기록했다. 기존 ledger 상태와 해결 판정은 오케스트레이터가 유지한다.

- 구현 요약: PG 설치 실패가 오류 코드 기본 종료값을 따르게 했다. 포트·볼륨 충돌은 installer와 CLI 모두 exit 2다. 정상 반복 설치 시험은 기존 볼륨 소유 라벨을 재현하고, 중지 컨테이너 복구와 OrbStack 중지 시 제거의 부분 정리를 직접 검증한다.
- 변경 파일: `apps/cli/src/install/flow.ts` — PG 실패의 exit:1 덮어쓰기 제거; `apps/cli/test/install-flow.test.ts` — 오류 종료값 단언 갱신; `packages/postgres/test/install-orbstack.test.ts` — 볼륨 상태 fake와 복구·부분 정리·충돌 종료 코드 검증; 이 계획 — 후속 리뷰 판정·새 deferred 항목·실행 결과.
- 리뷰 집계: 22건 중 patch 4 entry(medium 4, high 0, low 0), 새 defer 1건(medium), reject 17건(low 9, false 8)이다. reject 근거는 이번 Review Triage Log에 각 지적별로 남겼다. 반복 지적의 기존 판정은 carried로 유지했다.
- 후속 리뷰 권고: `false`. 이번은 built 계획의 후속 pass이며 high patch가 없다. 기존 권고의 제거 게이트·오류 꼬리를 네 렌즈가 다시 읽었고, 이번 최소 수정은 영향 시험과 전체 검증으로 확인한다.
- 잔여 위험: Core drain의 기존 scan 실패 이유 누락은 계획 deferred 1건으로 남긴다. transcript 가져오기는 명령 예산 한 번으로 제한되며 남은 작업은 다음 drain이 잇는다. 데몬 PG 전환과 정리 handler 조립은 기존 에픽 후속 작업 경계이며 기존 ledger 항목의 상태·해결 여부는 변경하지 않았다.

- 최종 검증: `npx --yes pnpm@12 test` exit 0 — build·typecheck와 121개 파일 / 3,199개 시험 통과. `sh tooling/dev/pg-tracer.sh --delete-volume` exit 0 — 실제 OrbStack 반복 setup·doctor·재생성 보존·장애 spool·복구 drain·기본 홈 무변경·임시 자원 정리 확인.
- 계획 frontmatter YAML을 파싱해 기존 status=built, deferred 단일 목록 1건, followup_review_recommended=false와 22건 판정 집계를 확인했다. `git diff --check` 통과. 기존 deferred-work ledger와 티켓 파일은 변경하지 않았으며 `tickets.py mark`를 실행하지 않았다.
- 최종 반환 상태: `built`. 사람의 결정을 기다리는 차단 조건은 없다. 티켓 완료 처리는 오케스트레이터의 별도 검증 뒤에만 수행한다. 이번 변경은 로컬 커밋으로 기록하며 push하지 않는다.
- 계획의 대상 검증 명령도 수정 후 재실행했다: PostgreSQL install-orbstack 16개, CLI 지정 6개 파일 226개 모두 통과했다.
