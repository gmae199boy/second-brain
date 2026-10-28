---
title: '사용자 설정: brain config set으로 바꾼 시간대가 컨테이너를 다시 만들어도 남는다'
type: 'feature'
ticket: '6'
created: '2026-10-28'
status: done
baseline_revision: '4037ff5ee4b49401683463fe71e54dd9aae9f408'
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

**Problem:** 사용자 선택값(첫 키 `timezone`)이 아직 기계 파일 `config.toml`에 있어 DB와 함께 옮겨지지 않고, 그것을 읽고 쓰는 `brain config get/set`·SDK·설정 port가 없다(E11-7, AD-18).

**Approach:** Core에 `SettingsStore` port·메모리 fake·공통 계약과 설정 코덱(키 정의 표, `timezone`, 확장 키 `<ext>.*` 등록 자리)·get/set use case를 두고, PG가 `brain.settings`로 port를 구현한다. CLI는 PG 홈(`[store] url_env`가 있는 홈)에서 `config get`·`config set`을 PG로 보내고, setup은 시간대를 물어 DB에 쓰고 `config.toml`에서는 뺀다. 그 키가 PG 홈의 파일에 남아 있으면 doctor가 `warn`이다.

## Boundaries & Constraints

**Always:**
- 키 정의·검증·기본값은 설정 코덱 하나에서 나온다. CLI·SDK·setup이 모두 그것을 거친다.
- `timezone` 기본값은 `Asia/Seoul`이고, 유효한 IANA 이름만 받는다. `+09:00` 같은 offset이나 빈 문자열은 거부한다. 저장값은 `Intl`이 돌려주는 정규형 이름이다(예: `america/new_york` → `America/New_York`).
- 시각은 Clock에서 한 번 읽는다(`updated_at`). DB는 값을 만들지 않는다(`DEFAULT now()` 없음).
- 모르는 키와 잘못된 값은 `CONFIG_INVALID`(exit 2)로 거부하고 DB를 바꾸지 않는다. DB에 닿지 않으면 `DB_UNAVAILABLE`, 잠금 초과는 `DB_LOCKED`, 버전 불일치는 `SCHEMA_MISMATCH`다. 새 오류 코드는 만들지 않는다.
- 확장 키는 `<ext>.<name>` 꼴이고 확장 정의가 주어질 때만 받는다. core 키와 겹치는 확장 정의는 거부한다. 지금은 등록된 확장이 없으므로 `garmin.x` 같은 키는 모르는 키다.
- 비밀은 `.env`, 기계 값은 `config.toml`에 그대로 남는다.

**Never:**
- `drive.keep_local_days` 키를 등록하지 않는다(epic-drive). 예약·현지 날짜 질의처럼 시간대를 쓰는 기능을 만들지 않는다(epic 12·17).
- `SettingsStore`를 Core `Store` 교집합에 넣지 않는다. SQLite adapter에 설정 표나 마이그레이션을 더하지 않는다(티켓 10에서 SQLite가 없어진다).
- 전체 PG 런타임 조립을 하지 않는다(티켓 7). `sessions ingest`의 PG 분기처럼 config 명령만 좁은 capability로 PG에 보낸다.
- 플러그인 `app-ref`·version을 바꾸지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 값 없음 | PG 홈, 행 없음, `config get timezone` | `value: Asia/Seoul`, `source: default`, `updated_at: null` | 없음 |
| 쓰기·읽기 | `config set timezone America/New_York` 뒤 새 프로세스에서 `config get timezone` | 같은 값, `source: db`, 쓴 시각 | 없음 |
| 정규화 | `config set timezone america/new_york` | 저장·출력이 `America/New_York` | 없음 |
| 잘못된 값 | `config set timezone Mars/Base`, `+09:00`, `""` | 실패, 기존 값 그대로 | `CONFIG_INVALID`, exit 2 |
| 모르는 키 | `config get nope`, `config set garmin.x 1` | 실패, DB 변화 없음 | `CONFIG_INVALID`, exit 2 |
| DB 꺼짐 | URL이 닿지 않는 포트 | 실패, spool 없음 | `DB_UNAVAILABLE` |
| SQLite 홈 | `store.url_env` 없음 | 실패, 메시지가 사용자 설정은 PostgreSQL 저장소에 둔다고 말함 | `CONFIG_INVALID`, exit 2 |
| setup 첫 실행 | PG 홈, DB 행 없음, `config.toml`에 `timezone = "Europe/Paris"` | 기본값으로 `Europe/Paris`를 보이고(비TTY는 그대로 채택) DB에 쓰며, 다시 쓴 `config.toml`에 `timezone`이 없음 | 없음 |
| setup 재실행 | DB에 `America/New_York` | 기본값이 DB 값. 같은 값이면 다시 쓰지 않음 | 없음 |
| doctor 남은 키 | PG 홈 `config.toml`에 `timezone` | 새 check가 `warn`, 값은 DB에 있다는 안내 | readConfig는 그 키를 검증하지 않음 |
| doctor SQLite 홈 | `store.url_env` 없음, `timezone` 있음 | 그 check는 `ok`(지금 동작 유지) | 없음 |

</intent-contract>

## Code Map

- `packages/postgres/migrations/0001_initial.sql:364` -- `brain.settings(key text pk, value text not null, updated_at timestamptz not null)`는 이미 있다. 표 계약("`value`·`updated_at`만 바뀜")대로 key 변경·DELETE를 거부하는 plpgsql trigger를 기존 `*_immutable_*` 함수 모양으로 더한다(baseline은 티켓 10 전까지 고칠 수 있다). `brain_app` 권한은 기본 grant를 따른다.
- `packages/core/src/ports/store.ts` -- `SettingsStore { getSetting({key}); setSetting({key, value, updatedAt}) }`를 별도 capability로 추가(`Store` 교집합에는 넣지 않는다). 실패는 `DB_UNAVAILABLE`·`DB_LOCKED` 값. `ports/index.ts`·`core/src/index.ts` export.
- `packages/core/src/settings/`(새) -- 설정 코덱: `SettingDefinition`(key, 기본값, raw 문자열 → 정규값|오류 메시지), `TIMEZONE_SETTING`, core 정의 표, 확장 정의를 받아 `<ext>.*` 규칙·core 키 충돌을 검사하는 함수, `isTimeZone`/정규화 helper. use case `getSetting`·`setSetting`(입력 검증 → store → `{ key, value, source, updatedAt }`). `apps/cli/src/config/codec.ts:749`의 `isTimeZone`은 이 helper를 쓰게 바꾼다.
- `packages/core/src/brain.ts:520` -- `createIngestBrain` 선례대로 `createSettingsBrain({ store: SettingsStore & SchemaStore, clock, settingDefinitions? })` → `{ config: { get, set } }`와 `SettingsBrain` 타입. `core/src/index.ts:239` 근처 export. `second_brain`은 `export *`라 따라온다.
- `packages/core/src/testing/fakes/store.ts` -- 메모리 fake가 `SettingsStore`를 구현(같은 파일에 더하거나 `memorySettingsStore`). `packages/core/src/testing/contracts/settings-store.ts`(새) -- `settingsStoreContract()`: 없는 키는 null, 쓴 값·시각 되읽기, 덮어쓰기는 value·updated_at만 바뀜, 키 독립, 한글·긴 값 왕복. `contracts/index.ts` export. 선례: `contracts/schedule-store.ts`.
- `packages/postgres/src/settings.ts`(새) -- `postgresSettingsStore(connect)`: `insert … on conflict (key) do update`, 오류는 `databaseFailure`(`connect.ts`). `store.ts`의 `postgresStore` 반환과 `PostgresStore` 타입에 합치고 `index.ts` export.
- `apps/cli/src/dispatch.ts:283,571` -- `runIngest`처럼 `runSettings?: (ctx & { brain: SettingsBrain }) => …`를 `CommandSpecBase`에 더하고, `storeUrlEnv`가 있으면 `resolveStoreUrl` → `postgresStore` → `checkSchema` → `runSettings`로 보낸다. 없으면 위 SQLite 홈 행의 `CONFIG_INVALID`. spool 분기는 없다.
- `apps/cli/src/commands/config-get.ts`·`config-set.ts`(새), `commands/index.ts` -- `ns: 'config'`, 인자 `<key>`·`<key> <value>`, usedFor/required/examples/output, `get`은 `risk: 'read'`·`writes: false`, `set`은 `risk: 'write'`·`writes: true`, `hook: false`, `dryRun: false`, `drain: false`. 데이터 `{ key, value, source, updated_at }`. 선례 `messages-redact.ts`.
- `apps/cli/src/config/codec.ts:192,399,534` -- PG 홈(`store.url_env` 있음)에서 `readConfig`는 `timezone`을 검증·노출하지 않고(`BrainConfig.timezone` 선택 필드, 파일에 키가 있었는지는 doctor가 알 수 있게 표시), `readForSetup`은 유효한 값을 seed로 계속 돌려주며, writer는 `timezone`을 쓰지 않는다. SQLite 홈 동작은 그대로다.
- `apps/cli/src/install/flow.ts:530,762` -- PG 단계 뒤 시간대 단계: 기본값 = DB 값 → `config.toml` seed → `Asia/Seoul`. TTY면 `deps.prompts.text`로 묻고(잘못된 답 처리는 같은 파일 `choosePath`(853행 부근) 방식), 비TTY는 기본값 채택. 코덱으로 검증해 DB와 다르면 쓴다. `InstallDeps`에 설정 읽기·쓰기 의존(예: `settings?`)을 더하고 `apps/cli/src/install.ts`가 PG URL로 조립한다. setup `--json` 데이터에 `timezone`.
- `apps/cli/src/doctor/checks.ts:134` -- `config` 다음에 새 check(예: `config-timezone`): PG 홈 파일에 `timezone`이 있으면 `warn`, 아니면 `ok`.
- `README.md` -- 명령 목록·설정 위치 설명에 `config get/set`과 시간대가 DB로 옮겨 갔다는 한 줄. `apps/cli/test/readme-codes.test.ts`·`command-meta.test.ts`·`guide.test.ts`가 새 명령 메타를 검사하면 맞춘다.
- `tooling/dev/pg-tracer.sh` -- 실제 compose 시험에 설정 단계 추가: setup 뒤 `config set timezone America/New_York`, `config get` 일치, `compose down`/`up -d --wait` 뒤 일치, setup 재실행 데이터의 `timezone`이 DB 값이고 `config.toml`에 `timezone` 없음.
- 시험 선례: `packages/postgres/test/cli.test.ts`의 `world()`(빌드한 CLI + 시험 DB + `url_env`), `packages/postgres/test/store.test.ts`의 계약 실행, `apps/cli/test/config.test.ts`·`install-flow.test.ts`·`doctor-checks.test.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/ports/store.ts`, `packages/core/src/settings/**`, `packages/core/src/brain.ts`, `packages/core/src/index.ts` -- port, 설정 코덱, use case, `createSettingsBrain`
- [x] `packages/core/src/testing/fakes/store.ts`, `packages/core/src/testing/contracts/settings-store.ts`, `contracts/index.ts`, `packages/core/test/settings.test.ts`(새) -- fake·계약을 메모리에서 실행, 코덱 시험(정규화·offset 거부·모르는 키·확장 정의 규칙)
- [x] `packages/postgres/migrations/0001_initial.sql`, `packages/postgres/src/settings.ts`, `store.ts`, `index.ts`, `packages/postgres/test/settings.test.ts`(새) -- PG 구현, 계약 실행, 직접 SQL로 key UPDATE·DELETE 거부 확인
- [x] `apps/cli/src/dispatch.ts`, `apps/cli/src/commands/config-get.ts`, `config-set.ts`, `commands/index.ts` -- 명령과 PG 분기
- [x] `apps/cli/src/config/codec.ts`, `apps/cli/src/install/flow.ts`, `apps/cli/src/install.ts`, `apps/cli/src/doctor/checks.ts` -- seed·기본값·파일에서 빼기·doctor `warn`
- [x] `apps/cli/test/**`(config·install-flow·doctor-checks·command-meta 등) -- I/O 매트릭스의 setup·doctor·SQLite 홈 행
- [x] `packages/postgres/test/cli.test.ts` -- 빌드한 CLI로 매트릭스의 get/set 행(값 없음·쓰기·읽기·정규화·잘못된 값·모르는 키·DB 꺼짐) 시험
- [x] `tooling/dev/pg-tracer.sh`, `README.md` -- 컨테이너 재생성 시험과 문서

**Acceptance Criteria:**
- Given OrbStack이 켜진 저장소, when `npx --yes pnpm@12 build && sh tooling/dev/pg-tracer.sh --delete-volume`, then 스크립트가 0으로 끝나고 `config set timezone America/New_York` 뒤의 `config get timezone`이 컨테이너 재생성 전후 모두 `America/New_York`이며, 재실행한 setup의 `timezone`이 같은 값이고 `config.toml`에 `timezone`이 없다.
- Given 같은 빌드, when `npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/settings.test.ts packages/postgres/test/cli.test.ts`, then 설정 계약과 CLI get/set 시험이 모두 통과한다.
- Given 전체 저장소, when `npx --yes pnpm@12 test`, then build·typecheck와 memory·SQLite·PG의 모든 시험이 통과한다.

## Implementation Notes

- 계획 범위를 모두 구현했다. SQLite Store와 플러그인 app-ref·version은 변경하지 않았다.
- baseline 0001 변경으로 이전 checksum의 개발 DB는 재생성이 필요하다.

## Plan Change Log

## Review Triage Log

- quick: 독립 검토에서 지적 사항 없음. 보류 항목 없음.

### 2026-10-28 — Review pass
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings:
  - (quick lens 보고 없음: "수용 기준 미충족, 저장소 규칙 위반, 버그를 발견하지 못했습니다.")
- 조정자 diff 확인(lens 밖, 1건):
  - `[medium]` `[patch]` `packages/core/src/settings/index.ts`의 `getSetting`·`setSetting`가 `checkSchema(deps.store, 1)`로 스키마 버전을 하드코딩했다. PG core 마이그레이션이 2로 오르면 dispatch 검사는 통과하고 설정 verb만 `SCHEMA_MISMATCH`를 낸다(`BrainDependencies.schemaVersion` 주석: 현재 버전은 adapter의 사실). — 구현 세션이 `SettingsDependencies.schemaVersion`을 필수로 더하고 `dispatch.ts`·`install.ts`가 `CORE_SCHEMA_VERSION`을 넘기게 고쳤으며 버전 2 회귀 시험을 더했다(`1256785`). 전체 Verification 재실행 통과.

### 2026-10-28 — 후속 리뷰
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings:
  - quick 독립 검토에서 수용 기준 미충족·규칙 위반·버그를 발견하지 못했다.
- 이번 후속 검토의 patch·defer·reject는 모두 0건이다. 기존 deferred-work 항목은 변경하지 않았다.

## Design Notes

**왜 Core에 코덱인가:** spine은 "읽기·쓰기는 Runtime의 설정 코덱 하나"라고 하지만 SDK도 같은 검증을 해야 한다. 그래서 DB 설정의 키 정의는 Core `settings/`에 하나만 두고 CLI·setup·SDK가 모두 그것을 부른다. `config.toml`·`.env` 코덱은 지금처럼 CLI에 남는다.

**왜 좁은 capability인가:** 런타임은 티켓 7 전까지 SQLite가 기본이다. `SettingsStore`를 `Store`에 넣으면 SQLite에 새 표가 필요하다. `sessions ingest`의 PG 분기(`dispatch.ts:571`)와 같은 모양으로 config 명령만 PG로 보낸다. 티켓 7이 전체 조립 때 `Brain`에 합친다.

**setup이 파일에서 키를 빼는 이유:** writer는 파일을 통째로 다시 쓰므로, PG 홈에서 `timezone`을 쓰지 않으면 setup 한 번으로 값이 DB로 옮겨지고 파일에서 사라진다. doctor `warn`은 그 뒤에 손으로 되돌린 키나 옛 파일을 잡는다.

## Verification

**Commands:**
- `npx --yes pnpm@12 build && sh tooling/dev/pg-tracer.sh --delete-volume` -- expected: exit 0, 설정 값이 재생성 뒤에도 같음
- `npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/settings.test.ts packages/postgres/test/cli.test.ts` -- expected: 통과
- `npx --yes pnpm@12 test` -- expected: build·typecheck·전체 시험 통과(OrbStack 켜짐)
- `git diff --check` -- expected: 출력 없음

**Results (2026-10-28):**
- `npx --yes pnpm@12 test`: exit 0; build·typecheck, 115 files / 3101 tests 통과.
- `npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/settings.test.ts packages/postgres/test/cli.test.ts`: exit 0; 2 files / 13 tests 통과.
- `npx --yes pnpm@12 build` 및 `sh tooling/dev/pg-tracer.sh --delete-volume`: exit 0; 시간대 값·수정 시각이 컨테이너 재생성 및 setup 재실행 뒤 유지됨. 파일에서 timezone 제거 확인, 임시 홈·볼륨 정리 완료.
- `git diff --check`, `git diff --cached --check`: 통과.
- 입출력 매트릭스 전체 행의 테스트가 실행되어 통과했다.

## Auto Run Result

Status: built

**요약:** 기존 구현의 후속 리뷰와 수용 기준 검증을 완료했다. Core 설정 port·코덱·SDK, PG 설정 저장소, CLI `config get/set`, setup 시간대 이전과 doctor 경고가 티켓 의도에 부합한다. 이번 실행에서는 소스·시험 파일을 변경하지 않았으며 계획 파일에 후속 검토 결과를 기록했다. 계획의 `status`는 기존 `built`를 유지했고 `tickets.py mark`는 실행하지 않았다. 티켓 완료 판정은 오케스트레이터가 수행한다.

**구현에 포함된 파일:**
- `packages/core/src/settings/index.ts` — 설정 코덱·get/set use case(스키마 버전은 adapter가 넘김)
- `packages/core/src/ports/store.ts`, `ports/index.ts`, `index.ts`, `brain.ts` — `SettingsStore` port, `createSettingsBrain`·`SettingsBrain` export
- `packages/core/src/testing/contracts/settings-store.ts`, `contracts/index.ts`, `testing/index.ts`, `testing/fakes/store.ts` — 공통 계약과 `memorySettingsStore`
- `packages/core/test/settings.test.ts` — 코덱·use case·확장 정의 규칙·오류 전파 시험
- `packages/postgres/migrations/0001_initial.sql` — `brain.settings` key 변경·DELETE 거부 trigger
- `packages/postgres/src/settings.ts`, `store.ts`, `index.ts` — PG 구현과 Store 조립
- `packages/postgres/test/settings.test.ts`, `cli.test.ts` — PG 계약·직접 SQL 거부·잠금/연결 실패, 빌드한 CLI get/set
- `apps/cli/src/commands/config-get.ts`, `config-set.ts`, `commands/index.ts` — 명령과 메타
- `apps/cli/src/dispatch.ts` — `runSettings` PG 분기, SQLite 홈은 `CONFIG_INVALID`
- `apps/cli/src/config/codec.ts` — PG 홈에서 `timezone`을 검증·노출하지 않고(`fileHasTimezone`만), writer가 쓰지 않음. `isTimeZone`은 Core helper 사용
- `apps/cli/src/install/flow.ts`, `install.ts` — 시간대 단계와 설정 의존 조립, setup 데이터 `timezone`
- `apps/cli/src/doctor/checks.ts` — `config-timezone` check
- `apps/cli/test/*` — config·install-flow·doctor 시험과 check 목록 갱신
- `tooling/dev/pg-tracer.sh` — 실제 compose 재생성 전후 설정 값 확인
- `README.md` — 명령과 설정 위치 문서

**이번 실행에서 변경한 파일:**
- `_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/story-brain-config-set-plan.md` — 후속 리뷰 판정과 재검증 결과 기록.

**리뷰:** quick 독립 검토 지적 0건. 이번 pass에서 patch·defer·reject 모두 0건이다. 기존 deferred-work ledger 항목과 상태는 변경하지 않았다.

**후속 리뷰 권고:** `false` — 이번 후속 pass의 patch는 high 0, medium 0, low 0이며 추가로 검증할 위험을 발견하지 못했다.

**이번 실행의 검증:**
- `npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/settings.test.ts packages/postgres/test/cli.test.ts` — exit 0, 2 files / 13 tests 통과.
- `npx --yes pnpm@12 build && sh tooling/dev/pg-tracer.sh --delete-volume` — exit 0. 컨테이너 재생성·setup 재실행 뒤 시간대 값과 수정 시각이 유지됐고 `config.toml`의 시간대가 제거됨을 확인했다. PG 중단 시 hook spool과 기본 홈 자원 무변경도 확인했다. 임시 홈·컨테이너·볼륨 정리를 완료했다.
- `npx --yes pnpm@12 test` — exit 0, build·typecheck와 115 files / 3102 tests 통과.
- `git diff --check` — 통과.

**남은 위험:** baseline 0001 변경 이전 checksum의 개발 DB는 재생성이 필요하다. 전체 런타임 전환은 티켓 7의 범위이므로 config 명령은 `store.url_env`가 있는 PG 홈에서 동작한다. `drive.keep_local_days` 등록은 epic-drive 범위다.
