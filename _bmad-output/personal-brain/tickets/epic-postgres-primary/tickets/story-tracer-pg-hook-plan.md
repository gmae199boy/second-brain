---
title: 'Tracer: PG 위에서 hook으로 수집한 세션 한 건이 컨테이너를 다시 만들어도 남는다'
type: 'feature'
ticket: '1'
created: '2026-10-28'
status: built
baseline_revision: 25eaf7b7c1e2f68dcb73e1a993f1a794dba49987
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-postgres-primary/epic-postgres-primary.md'
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-postgres-primary/epic-postgres-primary-research-code.md'
  - '{project-root}/_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md'
warnings: ['oversized']
deferred:
  - summary: >-
      `.env` 쓰기가 원자적이지 않아 쓰는 도중 끊기면 PostgreSQL 볼륨 비밀번호를 잃을 수 있다.
    evidence: |-
      `postgresSecrets`(apps/cli/src/config/codec.ts)와 기존 `writeConfig`의 `.env` 쓰기가 모두 `writeFile`로 제자리 truncate 후 쓴다. setup은 매번 두 곳에서 `.env`를 다시 쓰므로 한쪽만 임시 파일+rename으로 바꿔서는 위험이 남는다. 비밀번호를 잃으면 기존 볼륨에 접속할 수 없어 `.env` 복원이나 볼륨 삭제가 필요하다.
    location: >-
      apps/cli/src/config/codec.ts
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Brain의 주 저장소를 PostgreSQL로 옮기는 에픽의 첫 관통이다. 지금 PG 코드는 Store verb 3개(health·schema·close)만 있고, 제품 컨테이너·role·schema·소유자별 마이그레이션 실행기가 없으며, 테스트 Compose는 pgvector 이미지에 기대고 있어 hook 수집이 PG에 닿는 길이 하나도 없다.

**Approach:** 가장 얇은 길로 층을 잇는다. Brain 홈에서 자원 이름을 파생하고, `setup run`이 `[store] url_env`가 기록된 홈에서 제품 Compose(공식 `postgres:18`)·role·`brain` schema·새 실행기·baseline 0001의 수집 부분·"나" 행을 만든다. `brain sessions ingest`는 그 홈에서 수집 capability만 가진 PG Store로 쓴다. Core 수집 use case와 CLI 명령 조립을 그 capability로 좁히며, SQLite는 기본값으로 남는다.

## Boundaries & Constraints

**Always:**
- 자원 이름(compose project·named volume·`127.0.0.1` 포트·LaunchAgent Label)은 Brain 홈을 받는 함수 하나에서만 나온다. 기본 홈(`~/.second_brain`)은 `second-brain`·`second-brain-pg`·`54320`·지금의 `DAEMON_LABEL`이고, 그 밖의 홈은 홈 경로 해시 접미사가 붙은 이름과 54320·54329가 아닌 포트다. launchd 등록·제어도 이 Label을 쓴다.
- `<home>/postgres/compose.yaml`: top-level `name:`이 project, 공식 `postgres:18`, 명시 `name:`을 가진 named volume을 `/var/lib/postgresql`에, `127.0.0.1:<port>:5432`, `restart: unless-stopped`, 슈퍼유저 비밀번호는 `${...:?}` 보간으로만 받는다. 모든 compose 호출은 같은 인자 조립 함수(`--env-file <home>/.env -f <compose>`)와 하나의 비동기 runner를 지난다(8·9가 재사용).
- 비밀번호는 setup이 생성해 `<home>/.env`(0600)에 쓰고, 재실행은 있는 값을 재사용한다. `BRAIN_DATABASE_URL`은 `brain_app` 접속이다.
- role: 마이그레이션 소유자 `brain_owner`(NOLOGIN, setup이 슈퍼유저 연결에서 `SET ROLE`로 씀), `brain_app`(LOGIN, 표 소유자 아님, TRUNCATE·DDL 권한 없음). database `brain`과 schema `brain`은 setup만 만든다. 런타임은 아무것도 만들지 않는다.
- 실행기: `brain.schema_migrations(owner, version, name, checksum, applied_at)`, 소유자별 `0001`부터 연속 번호, 번호 중복·누락·적용된 파일 checksum(sha256) 변경을 `MIGRATION_FAILED`로 거부, 파일마다 자기 트랜잭션에서 advisory lock 아래 적용, `applied_at`은 주입한 Clock 값. core 외 소유자 폴더를 받을 자리가 있다.
- baseline 0001(`brain` schema)은 workspaces·users·projects·worktrees·sessions·messages·tool_notes·transcript_files·failures·work_items·files·file_locations·message_attachments·redactions와 그 키·FK·불변 plpgsql trigger·TRUNCATE 방어를 SQLite 0001~0009 수준으로 담는다. `uuid`·`timestamptz`, DB가 값을 만들지 않는다(`DEFAULT now()`·serial·identity 없음).
- PG 쓰기는 `withWrite` 하나를 지나고, 같은 세션 수집은 세션 토큰 키 `pg_advisory_xact_lock`으로 직렬화한다. 연결 설정(`lock_timeout`·`statement_timeout`·`application_name`·UTC)은 연결 함수 한 곳이며 hook은 `BUSY_TIMEOUT_MS.turn`을 쓴다. 연결 거부·접속 끊김·`brain` schema 없음은 `DB_UNAVAILABLE`, 잠금 초과는 `DB_LOCKED` 값으로 내려가 기존 spool 경로가 돈다.
- 런타임 URL은 `[store] url_env`가 이름 준 변수를 프로세스 환경에서 먼저, 없으면 `<home>/.env`에서 읽는다.

**Never:**
- 전체 `Store`인 척하는 cast, 비운 verb·"미구현"을 돌려주는 verb를 두지 않는다. 수집·setup 경로가 부르지 않는 verb(listStaleSessions·listIdentityCandidates·countUntaggedSessions·fillSessionTags·redactMessage·listTranscriptFiles, Work·Extraction·Schedule 등)는 PG에 만들지 않는다(14 이후).
- SQLite 기본 경로의 동작을 바꾸지 않는다(`url_env` 없는 홈은 지금과 같다). SQLite 코드·테스트를 지우지 않는다.
- 데몬·doctor·`queue drain`·`setup uninstall`·플러그인 bootstrap의 PG 경로, OrbStack 판별(8), 시간대·settings(6), document_extractions·chunks·index_configs 등 나머지 표(2)는 이 스토리 밖이다. `files.current_extraction_id`는 2가 표와 함께 넣는다.
- pgvector·`vector` 확장에 기대지 않는다. `apps/cli/src/install/docker.ts`는 고치지 않는다. `plugin/app-ref`·plugin version을 바꾸지 않는다.
- 테스트·스크립트는 기본 홈의 자원 이름으로 compose·volume·launchd를 건드리지 않는다. 문서·커밋에 절대 홈 경로를 쓰지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 첫 PG setup | 빈 개발 홈, `config.toml`에 `[store] url_env`, OrbStack 켜짐 | compose.yaml·`.env`(0600) 생성, 접미사 project·volume 컨테이너 healthy, roles·schema, `(core,1)` 기록, PG "나" 행, SQLite 단계도 지금처럼 | 없음 |
| setup 재실행 | 같은 홈 | 비밀번호 재사용, 적용 0건, 소유자 그대로 | 없음 |
| compose 실패 | Docker/OrbStack 꺼짐 | exit 1, compose 출력 꼬리와 OrbStack을 켜라는 안내, `installed.json` 안 씀 | 값 실패 |
| `.env` 분실 + 기존 볼륨 | 새 비밀번호로 인증 실패 | exit 1, `.env` 복원 또는 볼륨을 명시적으로 지우라는 안내, 볼륨 안 지움 | 값 실패 |
| hook 수집 | url_env 홈, Stop payload | exit 0, PG에 workspace null 세션·메시지·도구 메모, SQLite에는 안 씀 | 없음 |
| 재전송 | 같은 payload | inserted 0 | 없음 |
| PG 꺼짐 / URL 값 없음 / schema 없음 | hook | exit 0, `SPOOLED`, spool 파일 | `DB_UNAVAILABLE` → spool |
| core 버전 불일치 | `schema_migrations` core ≠ 1 | exit 0, spool | `SCHEMA_MISMATCH` → spool |
| 같은 세션 동시 수집 | 두 프로세스·연결 | 메시지 중복 없음, 둘 다 성공 또는 잠금 초과 spool | `DB_LOCKED` → spool |
| 직접 SQL | `brain_app`의 messages UPDATE·DELETE·TRUNCATE | 거부 | DB 오류 |
| 체크섬·번호 | 적용된 파일 변경, 번호 중복·누락 | `MIGRATION_FAILED`, 적용 없음 | 값 실패 |
| url_env 없음 | 기존 홈 | 지금과 같은 SQLite 동작 | 기존 그대로 |

</intent-contract>

## Code Map

- `packages/core/src/ports/store.ts` -- capability 정의(`SessionStore:272`, `UserStore:396`, `TranscriptFileStore:738`, `AttachmentStore:975`, `Store:762`, `SchemaStore:786`). 수집 capability 타입을 여기에 더한다.
- `packages/core/src/sessions/ingest.ts:133` -- `deps.store`가 부르는 verb는 `findSession`·`ensureSession`·`ingest`·`readSession`·`readSelfUser`·`recordTranscriptFile`·`listMessageAttachments`·`listRedactedContentHashes`뿐(`:297`~`:807`).
- `packages/core/src/brain.ts:67` -- `BrainDependencies.store: Store & SchemaStore`. `createBrain`은 그대로 두고 수집만 하는 조립을 더한다.
- `packages/core/src/testing/contracts/session-store.ts:37` -- subject가 `SessionStore & UserStore & Pick<WorkStore,'listOpenWorkTargets'>`. 수집 verb만 쓰는 case를 떼어낼 대상. `user-store.ts`(3 case), `schema-store.ts`, `contract.ts`.
- `packages/sqlite/src/sessions.ts`·`attachments.ts`(`writeAttachments`)·`users.ts`·`transcript-files.ts`·`write.ts` -- 의미의 기준 구현(수집 SQL·멱등·커서). 고치지 않는다.
- `packages/sqlite/migrations/0001`~`0009` -- 표·키·trigger의 기준. 조사 문서 §3이 건수·위치를 정리했다.
- `packages/postgres/src/{connect,migrate,store,setup,index}.ts`, `migrations/0001_initial.sql` -- 다시 쓴다. `migrate.ts:122`의 파일별 BEGIN→advisory lock 패턴과 `connect.ts`의 `describe`는 재사용 가능. vector 탐침(`store.ts:62`)·`ensureVectorExtension`·`ensureDefaultIndexConfig`는 없앤다.
- `packages/postgres/test/*`, `tooling/test-db/src/{index,global-setup}.ts`(`installVector`, `:47` vector), `tooling/test-db/test/global-setup.test.ts`, `compose.test.yaml` -- `postgres:18`·role·schema 기준으로 바꾼다. global-setup의 소유권 규칙(env URL이면 Docker 안 부름, 자기가 띄운 것만 내림)은 유지.
- `packages/second_brain/src/postgres.ts`, `test/boundaries.test.ts` -- PG 진입점(별도 subpath라 SQLite 경로는 pg를 싣지 않는다).
- `apps/cli/src/dispatch.ts:345,572,603` -- `CreateStore`, store 열기, 쓰기 guard·spool 분기. `sessions ingest`는 hook이라 기회적 drain이 없다.
- `apps/cli/src/commands/sessions-ingest.ts` -- `context.brain.sessions.ingest`만 쓴다.
- `apps/cli/src/assembly.ts:79` -- `SQLITE_SCHEMA_VERSION` 고정. PG 조립은 PG core 버전을 쓴다.
- `apps/cli/src/config/codec.ts:29,206,520,554` -- `KNOWN_KEYS`, read, write, `.env` 쓰기. `store.url_env`와 런타임 `.env` 읽기를 더한다. `config/paths.ts`의 `configHome`.
- `apps/cli/src/install/flow.ts:341`(`runInstall`), `install.ts`(`systemInstallDeps`), `install/store.ts` -- SQLite 단계 뒤(소유자 다음)에 PG 단계를 넣을 자리.
- `apps/cli/src/daemon/launchd.ts:8`, `daemon/control.ts` -- `DAEMON_LABEL` 상수 사용처.
- `apps/cli/src/daemon/launchd.ts:49`(execFile+timeout+값 오류), `tooling/test-db/src/global-setup.ts:62`(주입 runner) -- runner 패턴 참고.
- `tooling/dev/tracer-session.sh` -- 수동 관통 스크립트의 선례.

## Tasks & Acceptance

**Execution:**
- [x] `apps/cli/src/config/resources.ts`(새) + `daemon/launchd.ts`·`daemon/control.ts` -- 홈→{project, volume, port, label} 파생 함수, launchd가 홈의 Label을 쓰게 함 -- E11-1, 개발 홈 setup이 운영 LaunchAgent를 덮지 않게
- [x] `apps/cli/src/runtime/command-runner.ts`(새) -- 비동기 execFile runner(args 배열, env, timeout, 값 결과)와 테스트용 가짜, compose 인자 조립 함수 -- 8·9 공용
- [x] `packages/core/src/ports/store.ts`, `sessions/ingest.ts`, `brain.ts`, `index.ts` -- 수집 capability 타입, use case 의존성 축소, 수집만 하는 Brain 조립(createBrain은 그대로 이를 포함) -- 명령별 조립
- [x] `packages/core/src/testing/contracts/session-store.ts`(+index) -- 수집 verb만 쓰는 case를 `sessionIngestContract()`로 떼고 `sessionStoreContract()`가 그것을 포함(memory·SQLite 실행 수 불변) -- PG가 수집 계약을 돌 수 있게
- [x] `compose.test.yaml`, `tooling/test-db/**` -- `postgres:18`, vector 설정·`installVector`·vector 탐침 제거, 슈퍼유저 URL 외에 `brain_app` 접속을 만들 수 있는 fixture -- 테스트 DB를 제품 role·schema 기준으로
- [x] `packages/postgres/migrations/0001_initial.sql` -- 위 14표 baseline 재작성(`brain` schema, F1의 workspaces FK 포함, `tool_notes.call_id` partial UNIQUE, `pg_trgm`과 `lower(tool_notes.target)` GIN, 불변 trigger·TRUNCATE 방어) -- E11-3 수집 부분
- [x] `packages/postgres/src/migrate.ts`, `setup.ts` -- 새 실행기와 setup용 준비(database·roles·schema·grants·default privileges·`schema_migrations`), `CORE_SCHEMA_VERSION` -- E11-2
- [x] `packages/postgres/src/{connect,write,sessions,users,transcript-files,attachments,store,index}.ts` -- 연결 설정, `withWrite`·오류 분류, 수집·setup verb와 schema·health(vector 없음), 구현한 capability만 가진 Store 팩토리 -- E11-4 수집 부분
- [x] `apps/cli/src/config/codec.ts` -- `store.url_env` 읽기·쓰기·setup 보존, 런타임 URL 해석(env→`.env`), PG 비밀 키 쓰기·재사용 -- AD-10·18
- [x] `apps/cli/src/install/postgres.ts`(새), `install/flow.ts`, `install.ts` -- url_env가 기록된 홈에서 compose 쓰기→`up -d --wait`→준비→실행기→"나"(PG), 실패는 exit 1 값, 보고에 PG 결과 -- E11-8 일부
- [x] `apps/cli/src/dispatch.ts`, `assembly.ts`, `commands/sessions-ingest.ts` -- url_env 홈의 `sessions ingest`만 `second_brain/postgres`를 동적 import해 수집 capability Store·PG 버전 guard·좁힌 brain으로 돌림, 실패는 기존 spool -- 관통
- [x] `packages/postgres/test/*`, `apps/cli/test/*`(+ 필요 시 `apps/cli/test/global-setup.ts`) -- 실행기(연속·중복·누락·checksum·두 번째 소유자·동시 실행), baseline(FK·null workspace·불변·TRUNCATE·`brain_app` 직접 UPDATE/DELETE 거부), PG에서 `sessionIngestContract`·`userStoreContract`·schema 계약, 같은 세션 동시 수집, ID·시각 왕복, 자원 이름, 가짜 runner로 setup PG 단계·실패 문구, CLI PG 수집·spool -- I/O 매트릭스
- [x] `tooling/dev/pg-tracer.sh`(새) -- 임시 홈·임시 LaunchAgents 폴더로 setup→hook 수집→PG 조회→`compose down`(볼륨 유지)→`up --wait`→재조회 비교→기본 홈 자원 부재 확인→정리(uninstall, 볼륨 삭제는 인자로만) -- verify의 실제 관통

**Acceptance Criteria:**
- Given OrbStack이 켜져 있고 `config.toml`에 `[store] url_env = "BRAIN_DATABASE_URL"`만 있는 새 개발 홈, when `brain setup run --yes`, then exit 0이고 `<home>/postgres/compose.yaml`과 0600 `.env`가 있으며 `docker volume ls`에 그 홈의 접미사 볼륨이 보이고 `brain.schema_migrations`에 `core`·`1`·checksum 행이 있다.
- Given 그 홈, when Claude Code Stop payload를 `brain sessions ingest claude-code`에 넣으면, then exit 0이고 PG `brain.sessions`에 `workspace_id`가 null인 세션 한 행과 그 메시지가 있다.
- Given 수집이 끝난 홈, when `docker compose down`(볼륨 유지) 뒤 `up -d --wait`, then 세션·메시지의 ID·시각·본문이 처음 조회와 같다.
- Given 관통 전후, when `docker compose ls -a`·`docker volume ls`를 보면, then 기본 홈의 `second-brain` project·`second-brain-pg` 볼륨이 관통 때문에 생기지 않았고 54320에 새 리스너가 없다.
- Given PostgreSQL 컨테이너가 멈춘 개발 홈, when 같은 hook을 돌리면, then exit 0이고 spool에 파일이 남는다.
- Given 테스트 DB, when `pnpm test`, then PG의 수집 계약 case와 adapter 시험을 포함해 모두 통과한다.

## Implementation Notes

- 재시작 메모(2026-10-28, dev-2): 작업 트리에는 앞선 시도(codex가 `gpt-6.1-sol` 용량 부족으로 끊긴 실행)의 미검증 부분 구현이 있다. 추적 파일 38개 변경은 `refs/attempt-preserve-dirty/20261028-161541-2d13-25eaf7b7-0`에서 되살렸고, 새 파일(`apps/cli/src/config/resources.ts`, `apps/cli/src/install/postgres.ts`, `apps/cli/src/runtime/command-runner.ts`, `packages/postgres/src/{attachments,ingest-work,sessions,transcript-files,users,write}.ts`, `packages/postgres/test/{cli.test,fixture}.ts`, `apps/cli/test/postgres-setup.test.ts`, `tooling/dev/pg-tracer.sh`)은 그 시도가 남긴 그대로다. 이 계획을 기준으로 판단해 맞는 것은 이어 쓰고 틀린 것은 고치거나 버린다. 마지막 기록은 build·typecheck 통과, `pnpm test` 결과 미확인이다.

- 검증 완료(2026-10-28): 보존된 부분 구현을 계획 및 세 context 문서에 대조하고 실제 PostgreSQL 18에서 검증했다. `npx --yes pnpm@12 test`(pnpm 12.15.0)로 build·typecheck와 104개 파일 / 2,882개 테스트가 모두 통과했다(68.10초). 현재 셸에는 pnpm 실행 파일이 없고 캐시된 pnpm 10은 workspace의 `>=12` 요구를 만족하지 않아 npx의 pnpm 12를 사용했다.
- 실제 관통(2026-10-28): `sh tooling/dev/pg-tracer.sh --delete-volume`이 성공했다. 임시 홈에서 setup 2회(비밀번호 재사용·두 번째 적용 0건), hook 수집·재전송, named volume을 유지한 컨테이너 재생성 전후 ID·시각·본문 일치, PG 중단 시 exit 0·SPOOLED·spool 파일을 확인했다. 기본 홈 project·volume·54320 listener는 관통 전후 모두 없었다. uninstall 뒤 컨테이너·임시 LaunchAgent·명시한 볼륨·임시 홈을 정리했다. 테스트 fixture는 `postgres:18`이고 기존 실행 주체의 컨테이너는 유지했다. `git diff --check`도 통과했다.

- 최종 검증(2026-10-28): quick 검토의 3건을 모두 수정했다. 잘못되거나 비밀번호 키와 겹치는 `store.url_env`는 runtime·setup·writer·secret 생성에서 동일하게 거부하고 파일을 보존한다. lock → statement → client timeout 순서를 보장해 기본 연결도 잠금 초과를 `DB_LOCKED`로 돌려준다. 추가 회귀 시험 후 `npx --yes pnpm@12 test`로 build·typecheck 및 105개 파일 / 2,894개 테스트가 모두 통과했다(68.00초). `sh tooling/dev/pg-tracer.sh --delete-volume`도 다시 통과했고, 기본 project·volume·54320 listener는 모두 생성되지 않았다. 임시 자원은 정리했다. 이 스토리 안의 미완료 및 검토 이월은 없다.
- 오케스트레이터 검증(2026-10-28, dev-2): 구현 세션 커밋은 `5ca5da058addd5037cb5006d8198ae6bff409140`(구현)과 `247b28b9b7fbf205152e85ea48943de8129dfbee`(관리용 잠금 대기)다. 첫 재검증에서 전체 `pnpm test` 6회 중 1회 `packages/postgres/test/setup.test.ts`가 실패했다. 원인은 `prepareDatabase`가 런타임 기본 예산(lock_timeout 5000ms)으로 열려 병렬 테스트 파일들의 `pg_advisory_lock` 대기가 그 예산에 걸린 것이고, 관리용 연결 두 곳의 잠금·질의 대기 제한을 풀고(접속 제한은 유지) 실패 메시지를 단언에 넣어 고쳤다. 구현 세션이 그 수정용으로 따로 만든 `_bmad-output/personal-brain/plan-pg-setup-lock-wait.md`는 이 티켓 밖의 부수 계획이라 요지를 여기 옮기고 지웠다. 수정 후 `pnpm test`(corepack pnpm 12.15.0)가 105개 파일·2,896개 테스트 모두 통과했고, `sh tooling/dev/pg-tracer.sh`(볼륨 보존 기본값)도 통과했다: setup 2회(비밀번호 재사용·적용 0건), 수집 후 `workspace_id` null 세션 1행과 메시지·도구 메모, `compose down`→`up -d --wait` 전후 diff 없음, PG 중단 hook exit 0·`SPOOLED`·spool 파일, 기본 홈 자원 `{"project":false,"volume":false,"listener":false}` 전후 동일. 관통이 남긴 임시 홈 볼륨(`second-brain-pg-0fb93a35bbc4`, `second-brain-pg-0699cd92d016`)은 확인 뒤 지웠다. `docker compose ls -a`에는 테스트용 `second-brain-test`만 남았다.

## Plan Change Log

## Review Triage Log

- medium / patch — `apps/cli/src/config/codec.ts`: `readConfigForSetup` drops a present invalid `store.url_env` without warning; `runInstall` then skips PG and rewrites the config without it. Reject an unusable backend selector before writing.
- medium / patch — `apps/cli/src/config/codec.ts`: password-key names pass the selector regex and `postgresSecrets` overwrites the corresponding generated secret with the URL, breaking authentication. Reject reserved password keys consistently before any write.
- medium / patch — `packages/postgres/src/connect.ts`: equal lock, statement, and client timeouts race; the latter two map to `DB_UNAVAILABLE` instead of the required `DB_LOCKED`. Order the deadlines so the server lock error reaches the caller first.

- Resolution — 위 3건은 공통 selector 검증과 timeout 순서 수정으로 해결했으며 설정 파일 보존·실제 잠금 분류 회귀 및 최종 전체 검증이 통과했다.

### 2026-10-28 — Review pass
- verdicts: 25 findings — high 0, medium 7, low 13, false 5, maybe-false 0
- findings:
  - `[low]` `[patch]` blind: `composeArgs`에 `-p`가 없어 상속된 `COMPOSE_PROJECT_NAME`이 compose 파일의 `name:`을 덮는다 — Compose 우선순위상 `-p` > 환경변수 > top-level `name`이고 runner는 프로세스 env를 넘긴다. `apps/cli/src/runtime/command-runner.ts`에 `-p <homeResources(home).project>`를 넣고 argv 테스트를 고쳤다.
  - `[low]` `[reject]` blind: `resolve(home)`이 symlink 별칭을 정규화하지 않아 같은 홈이 다른 자원 이름을 얻는다 — 같은 홈을 서로 다른 symlink 경로로 setup하는 일은 드물고, 고치려면 아직 없는 홈에 대한 realpath 대체 분기가 필요하다.
  - `[low]` `[reject]` blind: 예전 사용자 지정 홈의 접미사 없는 launchd 등록을 옮기지 않는다 — 예전 코드에서 개발 홈 등록은 운영 Label이 이미 올라 있으면 `loaded`로 끝나 실제로 남은 등록이 드물고, 옮기려면 plist의 shim을 읽어 판정하는 새 로직이 든다.
  - `[medium]` `[defer]` blind: `.env`를 제자리에서 잘라 다시 쓰므로 쓰기 도중 끊기면 볼륨 비밀번호를 잃는다 — 실제 위험이지만 기존 `writeConfig`의 `.env` 쓰기도 같은 비원자 방식이고 setup마다 다시 쓰므로 `postgresSecrets`만 고쳐서는 위험이 남는다. `deferred`에 기록했다.
  - `[low]` `[patch]` blind: `??=`가 빈 비밀번호 값을 유지해 `ALTER ROLE ... PASSWORD ''`에 닿는다 — `apps/cli/src/config/codec.ts`를 `||=`로 바꿔 빈 값도 새로 만들게 하고 비밀값 테스트에 넣었다.
  - `[low]` `[reject]` blind: setup이 프로세스 환경의 URL override를 무시하고 로컬 DB만 준비해 hook과 다른 DB를 볼 수 있다 — 런타임의 env→`.env` 우선순위는 계획의 설계이고, override를 export한 것은 운영자의 선택이다. 일상 사용에서 만나기 어렵고 고치려면 분기가 더 든다.
  - `[low]` `[reject]` blind: 이미 있는 `brain_app`·`brain_owner` role의 속성·멤버십을 확인하지 않는다 — 제품 클러스터는 setup이 만든 전용 컨테이너라 다른 정의의 role이 먼저 있을 일이 드물고, 고치려면 검사 단계가 늘어난다.
  - `[low]` `[reject]` blind: 대상 DB의 확장·schema·원장 준비가 advisory lock 밖에서 돌아 같은 DB를 동시에 준비하면 카탈로그 충돌이 날 수 있다 — 같은 홈에서 setup을 동시에 두 번 돌릴 때만 생기고, 고치려면 대상 연결에 잠금을 더 잡아야 한다.
  - `[medium]` `[patch]` blind: `runMigrations`가 `queryTimeoutMs: 0`만 주고 `lock_timeout`은 기본 5000ms로 남아 다른 실행기 뒤에서 5초 넘게 기다리면 `MIGRATION_FAILED`가 된다 — `setup.ts`에서 방금 고친 flaky와 같은 원인이다. `packages/postgres/src/migrate.ts`에 `lockTimeoutMs: 0`을 넣고 5초 넘게 advisory lock을 잡은 동안 기다렸다 성공하는 테스트를 더했다.
  - `[low]` `[patch]` blind: `prepareDatabase`의 `new URL`이 try 밖이라 잘못된 URL이 값이 아닌 예외가 된다 — `packages/postgres/src/setup.ts`에서 파싱을 guard 안으로 옮기고 잘못된 URL 테스트를 더했다.
  - `[low]` `[reject]` edge: 첫 setup 두 개가 동시에 `.env`를 읽으면 볼륨과 다른 비밀번호가 남을 수 있다 — setup의 동시 실행은 SQLite 경로에서도 직렬화되지 않은 기존 성질이고 드물다. 고치려면 홈 잠금이 새로 든다.
  - `[low]` `[reject]` edge: 대상 DB 준비가 cluster advisory lock 해제 뒤에 돈다 — blind의 같은 지적과 같은 원인이며 같은 이유로 기각한다.
  - `[medium]` `[patch]` edge: 마이그레이션 advisory lock 대기가 기본 5초 `lock_timeout`에 걸린다 — blind의 같은 지적과 같은 원인이며 같은 패치(`lockTimeoutMs: 0`과 대기 테스트)로 고쳤다.
  - `[low]` `[reject]` edge: 이미 있는 `brain_app`이 superuser거나 `brain_owner` 멤버면 제한을 우회한다 — blind의 role 속성 지적과 같은 원인이며 같은 이유로 기각한다.
  - `[low]` `[reject]` edge: 외부 테스트 클러스터를 쓰면 fixture가 cluster 전체의 `brain_app` 비밀번호를 바꾼다 — 테스트 URL을 실제 `brain_app`이 있는 클러스터로 돌린 경우에만 생기고, 그 경우에도 다음 setup이 `.env`의 값으로 되돌린다.
  - `[medium]` `[patch]` edge: 기본 core 폴더가 `CORE_SCHEMA_VERSION`에 묶이지 않아 상수를 안 올린 파일이 깨끗한 setup으로 보고되고 모든 hook이 `SCHEMA_MISMATCH`로 spool된다 — SQLite에는 같은 guard가 있다(`packages/sqlite/src/migrate.ts:290`). `packages/postgres/src/migrate.ts`에서 기본 소유자일 때 접속 전에 최고 번호를 상수와 비교해 `MIGRATION_FAILED`로 거부하고 테스트(`packages/postgres/test/migrate-files.test.ts`)를 더했다.
  - `[medium]` `[patch]` verification-gap: PG `listRedactedContentHashes`의 성공 결과가 검증되지 않는다 — `packages/postgres/test/store.test.ts`에 `redacted_at`을 섞어 심고 `brain_app`으로 요청한 가려진 hash만 정확히 돌아오는지 보는 테스트를 더했다.
  - `[medium]` `[patch]` verification-gap: PG `recordTranscriptFile` 이력 저장이 검증되지 않는다 — 같은 파일에 기록·전진·더 오래되고 작은 읽기를 넣고 반환값과 `brain.transcript_files` 행이 새 값을 지키는지 보는 테스트를 더했다.
  - `[medium]` `[patch]` verification-gap: PG `ensureSession`의 `identityWork` 저장이 검증되지 않는다 — 생성 시 그 work가 `brain.work_items`에 정확히 남고 반복 호출이 새 work를 더하지 않는지 보는 테스트를 더했다.
  - `[false]` `[reject]` intent: 자동 테스트는 PG setup→수집 연속 경로를 가짜로 나눠 시험한다 — 연속 경로는 계획의 Verification인 `sh tooling/dev/pg-tracer.sh`가 실제 setup·hook·PG 조회로 돌리고 이번 실행에서 통과했다.
  - `[false]` `[reject]` intent: 컨테이너 재생성 뒤 보존은 관통 스크립트에만 있다 — 감사자 스스로 누락이 아니라고 적었고, 그 스크립트가 named volume을 유지한 `down`→`up -d --wait` 전후 비교를 이번 실행에서 통과했다.
  - `[low]` `[reject]` intent: `url_env` 해석이 setup과 런타임에서 다른 DB를 가리킬 수 있다 — blind의 env override 지적과 같은 원인이며 같은 이유로 기각한다.
  - `[false]` `[reject]` intent: 실제 host 앱이 hook을 쏘지 않고 합성 Stop payload를 넣는다 — 의도는 "hook payload로 `brain sessions ingest`를 돌리면"이고 테스트와 관통은 빌드된 CLI에 그 payload를 넣는다.
  - `[false]` `[reject]` intent: 기본 홈 자원 단언이 "부재"가 아니라 "변화 없음"이다 — 관통 전 상태가 `{"project":false,"volume":false,"listener":false}`였으므로 변화 없음이 곧 부재다.
  - `[false]` `[reject]` intent: 수집 계약을 `sessionIngestContract()`로 떼어 PG에서 돌림 — 감사자가 의도와 일치한다고 적은 행으로, 결함 주장이 없다.

## Design Notes

- setup의 PG 사용 여부는 기록된 `store.url_env`로 정한다. 10이 PG를 유일 경로로 만들 때 기본값이 되는 같은 키라 새 플래그를 만들지 않는다. 이 홈에서도 SQLite 단계·doctor·데몬은 지금처럼 SQLite로 돈다(다른 명령은 아직 PG verb가 없다).
- 0001은 2가 같은 파일을 키운다. 10이 checksum을 고정하기 전까지 checksum 거부를 만난 개발 DB는 다시 만든다.
- 수집 capability 예: `type SessionIngestStore = Pick<SessionStore,'findSession'|'ensureSession'|'ingest'|'readSession'> & Pick<UserStore,'readSelfUser'> & Pick<TranscriptFileStore,'recordTranscriptFile'> & Pick<AttachmentStore,'listMessageAttachments'|'listRedactedContentHashes'>`. setup은 여기에 `ensureSelfUser`를 더한다.
- `brain_owner`는 NOLOGIN이라 비밀이 하나 줄고, 표 소유와 `brain_app` 권한이 갈라져 trigger를 우회할 수 없다. default privileges로 이후 마이그레이션 표도 `brain_app`에 DML만 준다.
- 기존 테스트 컨테이너가 pgvector 이미지로 떠 있으면 global-setup이 그대로 쓰므로 `docker compose -f compose.test.yaml down` 뒤 다시 돌린다.

## Verification

**Commands:**
- `pnpm test` -- expected: 전부 통과(PG 프로젝트 포함, Docker는 global-setup이 띄움)
- `sh tooling/dev/pg-tracer.sh` -- expected: setup 성공, 수집 후 PG 행 출력, 재생성 전후 diff 없음, 기본 홈 자원 없음 확인 줄, 마지막 정리 완료

**Manual checks (if no CLI):**
- 스크립트 출력과 `docker volume ls`를 Implementation Notes에 요약(절대 홈 경로는 `~/…`로)

## Auto Run Result

- 상태: `built` (오케스트레이터 검증 대기, `done` 표시는 하지 않았다)
- 요약: `[store] url_env`가 기록된 Brain 홈에서 `brain setup run`이 홈별 Compose(`postgres:18`, 접미사 project·named volume·`127.0.0.1` 포트)와 0600 `.env` 비밀번호를 만들고, `brain_owner`·`brain_app`·`brain` schema를 준비한 뒤 소유자별 실행기로 baseline 0001(수집 14표·FK·불변 trigger·TRUNCATE 방어)을 적용하고 PG "나" 행을 만든다. `brain sessions ingest`는 그 홈에서 수집 capability만 가진 PG Store(`withWrite`, 세션 토큰 `pg_advisory_xact_lock`)로 쓰고, 연결 거부·schema 없음·버전 불일치·잠금 초과는 기존 spool로 간다. Core 수집 use case·CLI 조립은 `SessionIngestStore`·`createIngestBrain`으로 좁혔고 SQLite 기본 경로는 그대로다. 테스트 Compose·`@second-brain/test-db`는 `postgres:18`·role·schema 기준이 되었고 vector 탐침은 빠졌다. LaunchAgent Label도 홈에서 파생한다.
- 바뀐 파일:
  - `apps/cli/src/config/resources.ts` — 홈→project·volume·port·Label 파생(기본 홈은 기존 이름).
  - `apps/cli/src/runtime/command-runner.ts` — 비동기 execFile runner, 가짜 runner, `-p`·`--env-file`·`-f`를 붙이는 compose 인자 조립.
  - `apps/cli/src/install/postgres.ts`, `install/flow.ts`, `install.ts` — setup의 PG 단계와 실패 안내, 보고의 `postgres` 항목.
  - `apps/cli/src/config/codec.ts` — `store.url_env` 읽기·쓰기·검증, 런타임 URL 해석(env→`.env`), PG 비밀값 생성·재사용.
  - `apps/cli/src/dispatch.ts`, `assembly.ts`, `commands/sessions-ingest.ts` — url_env 홈의 수집만 PG로, 실패는 spool.
  - `apps/cli/src/daemon/launchd.ts`, `daemon/control.ts` — 홈의 Label 사용.
  - `packages/core/src/{ports/store,brain,index,schema}.ts`, `sessions/ingest.ts`, `testing/contracts/{session-store,schema-store}.ts`, `testing/index.ts` — 수집 capability 타입, 수집 전용 Brain, `sessionIngestContract()` 분리, `DB_LOCKED` 전달.
  - `packages/postgres/migrations/0001_initial.sql` — `brain` schema baseline 재작성.
  - `packages/postgres/src/{connect,write,migrate,setup,store,sessions,users,transcript-files,attachments,ingest-work,index}.ts` — 연결 설정, `withWrite`, 실행기, 관리용 준비, 수집 verb.
  - `packages/postgres/test/*`, `apps/cli/test/*`, `tooling/test-db/**`, `compose.test.yaml`, `packages/second_brain/**`, `tooling/bootstrap/test/hook.test.ts` — 새 기준의 테스트와 fixture.
  - `tooling/dev/pg-tracer.sh` — 임시 홈 실제 관통 스크립트.
- 리뷰 결과(thorough, 렌즈 4개, 25건): 패치 8개 항목(medium 5: 마이그레이션 잠금 대기, core 버전 guard, PG 가린 hash·전사 이력·identity work 테스트 3종 / low 3: compose `-p`, 빈 비밀번호 재생성, 잘못된 URL 값 반환). 이월 1건(medium: `.env` 비원자 쓰기). 기각 16건 — low 11건(symlink 홈 별칭, 예전 launchd Label 이전, env override와 setup 대상 불일치 ×2, 기존 role 속성 ×2, 대상 DB 준비 직렬화 ×2, 동시 첫 setup 비밀값, 외부 테스트 클러스터 비밀번호; 모두 일상 사용에서 드물고 고치려면 분기·잠금·검사가 더 든다)과 false 5건(연속 경로·재생성 보존은 관통 스크립트가 통과, 합성 hook payload는 의도와 같음, 자원 "변화 없음"은 사전 부재로 곧 부재, 계약 분리는 일치 보고).
- 재검토 권고: `true` — 첫 패스에서 medium 5건을 패치했다(high 0, medium 5, low 3). 이름 붙인 미검증 위험: 이번 패치로 새로 생긴 PG 성공 경로 테스트 3종과 마이그레이션 잠금 대기 테스트는 이번 실행에서 한 번 통과했을 뿐이고, 잠금 대기 해제(`lockTimeoutMs: 0`)가 실제 setup 재실행·동시 실행에서 무한 대기로 바뀌지 않는지는 독립 렌즈가 다시 보지 않았다.
- 검증: `pnpm test`(corepack pnpm 12.15.0 shim) 106개 파일·2,904개 테스트 통과(build·typecheck 포함). `sh tooling/dev/pg-tracer.sh` 통과 — setup 2회(비밀번호 재사용·적용 0건), 수집·재전송, `compose down`→`up -d --wait` 전후 ID·시각·본문 동일, PG 중단 hook exit 0·`SPOOLED`·spool 파일, 기본 홈 project·volume·54320 listener 관통 전후 없음. 관통이 남긴 임시 볼륨은 지웠다. I/O 매트릭스 12행 모두 실행·통과한 테스트로 덮였다.
- 남은 위험: `.env` 비원자 쓰기(이월). 이 셸에는 `pnpm` 실행 파일이 없어 corepack shim으로 돌렸다. 전체 스위트가 무거운 병렬 부하일 때의 다른 타이밍 flaky는 구현 세션이 SQLite 데몬 시험 시간초과 1회를 보고했으나 이번 두 번의 전체 실행에서는 재현되지 않았다. 앞선 시도의 미검증 구현을 `refs/attempt-preserve-dirty/20261028-161541-2d13-25eaf7b7-0`에서 되살려 이어 썼다.
