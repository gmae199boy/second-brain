---
title: '20.2 사용자 키와 self 해석: 설정 scope·채널 대화 user_id·실행 입력 self'
type: 'feature'
ticket: '2'
created: '2026-11-05'
status: 'built'
baseline_revision: '8ca6a4e7ca03c8c3c8387c7ba97d3efdce55d9b7'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '_bmad-output/personal-brain/tickets/epic-extension-platform/epic-extension-platform.md'
  - '_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md'
warnings: ['oversized']
deferred:
  - summary: >-
      core 감독 자식(channel_send, process_probe)의 실행 입력에는 self user_id가 들어가지 않고 시작 전 self 존재만 확인한다.
    evidence: |-
      review pass2 intent-alignment A. "모든 실행 입력"을 core 내부 자식까지 포함해 읽을지 정해야 결론이 난다. 현재 core 자식은 사용자 값을 쓰지 않고 channel_conversations 행이 user_id를 갖는다. 다중 사용자 에픽 또는 사용자 판단으로 정한다.
    location: >-
      apps/cli/src/daemon/supervisor.ts
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** `brain.settings`는 key 하나가 기본키라 사용자·공통 값을 구분하지 못하고, `channel_conversations`에는 사용자 키가 없으며, self 조회가 경로마다 흩어져 설정 snapshot·일감 입력에는 사용자가 들어가지 않는다(E20-2, AD-18·40·12).

**Approach:** 새 forward migration 0032로 settings를 `UNIQUE NULLS NOT DISTINCT (user_id, key)`(user_id nullable, 공통 값 NULL)로, channel_conversations에 `user_id NOT NULL`을 더하고 기존 행을 기존 self로 채운다. core에 유일한 self 해석기와 키별 scope(user|global)를 가진 설정 코덱(사용자 → 공통 → 기본값 읽기, scope 불일치 쓰기 거부, manifest 기본값 부재 시 삽입)을 두고, 설정 snapshot·일감 실행·명령 봉투·설치 확인이 모두 그 해석기로 user_id를 받아 self가 없으면 `USER_MISSING`으로 멈춘다.

## Boundaries & Constraints

**Always:**
- 공통/global 설정은 `user_id` NULL이고 유일성은 `UNIQUE NULLS NOT DISTINCT (user_id, key)`다. settings.user_id는 NOT NULL로 만들지 않는다. channel_conversations.user_id만 NOT NULL(공통 값이 허용되지 않는 표)이다.
- 이행 순서 의미를 지킨다: nullable 추가 → self 보장 → backfill → 기본값 → 필요한 NOT NULL. 업그레이드 DB는 이전 setup이 만든 self가 있으므로 0032 한 파일이 nullable 추가 → 기존 self로 backfill → NOT NULL 확정을 순서대로 한다. 새 DB는 행이 없고 setup이 migration 직후 self를 만든 뒤 설정·대화가 쓰인다. 채울 행이 있는데 self가 없으면 migration은 `USER_MISSING`을 담은 오류로 전체를 rollback한다(값을 만들지 않는다, AD-22).
- backfill 제외: `doctor.writable`(쓰기 확인 probe, 기계 공통)은 NULL로 둔다. 그 밖의 기존 설정 행은 self로 채운다.
- settings의 key·user_id 불변, value·updated_at만 바뀐다(Table Contract). 기존 trigger를 새 migration에서 대체해 user_id 변경도 거부한다(backfill은 대체 전에 수행).
- 읽기 순서는 사용자 행 → 공통 행 → 코덱/manifest 기본값이다. 쓰기 대상은 키의 scope가 정한다(user → self, global → NULL). 다른 scope 대상 쓰기는 코덱이 거부한다.
- manifest settings 선언에 선택 `scope: "user" | "global"`(기본 `user`)를 더한다. 공유 schema·Python fixture 판정과 일치시킨다. 확장 설치/재설치는 기본값이 있고 machine이 아닌 키에 대해 해당 scope 대상 행이 없을 때만 삽입하고 기존 값을 덮지 않는다. 기존의 snapshot 읽기 시 기본값 fallback도 유지한다.
- core에 유일한 self 해석기(`readSelfUser` 래핑, 결과 `{ok:true,userId}` 또는 `USER_MISSING`/DB 실패)를 두고 설정 코덱·설치 확인·감독 일감 준비·확장 명령·세션 수집이 이것만 쓴다. 사용자를 인자로 바꾸는 공개 표면은 만들지 않는다.
- 설정 snapshot JSON에 `user_id`를 넣는다(`{version:1, extension, user_id, values}`). core decoder는 UUID 문자열 user_id를 요구한다. 명령 봉투는 20.1의 `{abi:1,user_id,settings,input}`을 유지한다.
- 기존 key 단독 읽기·쓰기(`packages/postgres/src/settings.ts`, `store.ts` doctor probe, `tooling/mac-install/run.mjs`, 시험의 `on conflict(key)` 등)를 모두 `(user_id,key)` 계약으로 옮긴다.
- 시험은 합성 자료·격리 홈·소유한 격리 PG·`withoutHarnessFolders`로만 작성한다. 개인 홈 절대 경로·비밀을 쓰지 않는다.
- **시험 실행 유예(2026-11-05 사용자):** 수락조건을 덮는 시험 코드는 작성하지만 직접 시험·`pnpm test:changed`·`pnpm test`·`pnpm test:python`을 실행하지 않는다. `pnpm build`·`pnpm typecheck`만 실행한다. 시험 실행은 21.8로 이관, 미실행이다.

**Never:** 20.3 cron·`schedules`/`schedule_occurrences` user_id·회차 회계, 20.4 패키지 공급원, 다중 사용자 인증·RLS·사용자 선택 표면, Garmin 내용, 과거 migration 원문 수정, 근거 없는 새 보안·보존 정책, 대화 수집 표(sessions·messages·tool_notes·chunks 등)의 행 변경, main 병합·push, 다른 작업의 PG·role·컨테이너 변경. 구현 워커는 커밋·push·티켓 상태 전이·추가 워커 실행을 하지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 새 DB | 0001~0032 적용 → self 생성 → `config set timezone`·대화 생성 | 설정·대화 행 user_id = self | 정상 |
| 업그레이드 | schema 31에 self·설정(timezone, testext.*, doctor.writable)·대화·대화 수집 행 | 0032 뒤 설정·대화 user_id=self(probe만 NULL), 모든 설정의 유효 값 전후 동일, 대화 수집 표 건수·md5 동일 | 정상 |
| self 없는 업그레이드 | schema 31에 설정/대화 행 있고 self 없음 | migration 실패·rollback, schema 31 그대로 | `MIGRATION_FAILED`, 메시지에 `USER_MISSING` |
| 유일성 | 같은 (self,key) 두 번, (NULL,key) 두 번 insert | 각각 두 번째 거부, (self,key)+(NULL,key) 공존 허용 | unique 위반 |
| 우선 읽기 | 같은 key에 공통 값과 사용자 값 | 사용자 값; 사용자 행 없으면 공통 값; 둘 다 없으면 기본값 | 정상 |
| scope 거부 | global 키에 사용자 대상 쓰기, user 키에 공통 대상 쓰기 | 행 변화 없음 | `CONFIG_INVALID`(scope 불일치 메시지) |
| 재설치 | 사용자가 바꾼 확장 설정 값 뒤 재설치/업그레이드 설치 | 값 유지, 새로 선언된 기본값만 삽입 | 정상 |
| self 없음 실행 | self 행 없음에서 감독 일감·확장 명령·설치 확인·사용자 scope 설정 | 자식 프로세스 미시작 | `USER_MISSING` |
| snapshot | 일감·명령·설치 확인 | snapshot에 self user_id, 명령 봉투 user_id=self | 잘못된/없는 user_id snapshot은 `EXTENSION_CONFIG_INVALID` |

</intent-contract>

## Code Map

- `packages/postgres/migrations/0032_user_keys.sql` (신규), `packages/postgres/src/migrate.ts` `CORE_SCHEMA_VERSION` 31→32 — 0001의 `brain.settings`(key PK)·`settings_immutable_update_fn`, 0017의 `channel_conversations`, 0001 `brain.users`(`users_self_idx`, `is_self`)를 참고. 과거 파일은 고치지 않는다. 31을 고정한 시험/빌드 기록도 따라 갱신.
- `packages/postgres/src/settings.ts`, `store.ts`(doctor probe `on conflict(key)`), `channels.ts`(`ensureChannelConversation`), `users.ts` — 저장소 계약. probe는 NULL 대상 `(user_id,key)`로.
- `packages/core/src/ports/store.ts` `SettingsStore`(1468~), `channels/store.ts`, `testing/fakes/store.ts`(`memorySettingsStore` 2000~), `testing/contracts/settings-store.ts`·`channel-store.ts` — 포트·fake·계약에 userId/scope 반영.
- `packages/core/src/settings/index.ts` — `SettingDefinition`에 scope, `getSetting`/`setSetting` 해석 순서·scope 거부·self 해석, `brain.ts` 418·631(`readTimeZone`, `config`)의 연결. `SettingResult` 코드에 `USER_MISSING`.
- self 해석기: core에 새 모듈(예: `packages/core/src/users/self.ts`) 하나, `index.ts` export. 소비자: `sessions/ingest.ts` 466, `extensions/commands.ts` 41, `extensions/install.ts` 240 부근, `apps/cli/src/daemon/supervisor.ts` 45~53 `prepare`.
- `packages/core/src/extensions/snapshot.ts`·`process-abi/codec.ts` `decodeSettingsSnapshot`·`extensions/check.ts`·`queue/supervisor.ts` 201 — snapshot user_id 추가와 검증. `extensionSettingDefinitions`에 scope 전달.
- `packages/core/src/extensions/manifest.ts` 59~71, `packages/core/schemas/extensions/v1/manifest.schema.json`, `packages/core/fixtures/extensions/v1/{manifests.json,check-manifests.py}` — `scope` 선언. 20.1의 공유 fixture 판정 방식을 그대로 사용.
- `apps/cli/src/install/postgres.ts` — migration 뒤 `ensureSelfUser` 순서 유지(새 DB의 self 보장 지점).
- `tooling/mac-install/run.mjs` 36·162·224, `tooling/channels-mac/cleanup.mjs` — key 단독 조회·대화 삽입 계약 확인.
- 시험 참고: `packages/postgres/test/core-garmin-cleanup.test.ts`(이전 schema까지 migrate → seed → 적용 → 건수·md5 snapshot 비교 패턴), `packages/postgres/test/settings.test.ts`, `migrate.test.ts`, `schema.test.ts`, `apps/cli/test/ext-install.test.ts` 353, `apps/cli/test/extension-commands.test.ts`, `apps/cli/test/ext-fixture.ts`, `packages/core/test/{extensions,process-abi,supervisor}.test.ts`.
- `tooling/test-changed/rules.mjs` — 이미 `packages/postgres/`·`core/src/settings/`·extensions 접두 규칙이 있다. 새 core 모듈 경로(self 해석기)가 Python 통합 경로에 쓰이면 규칙을 더한다.

## Tasks & Acceptance

**Execution:**
- [ ] `packages/postgres/migrations/0032_user_keys.sql`, `migrate.ts` -- settings에 nullable `user_id → brain.users(id)` 추가, key PK 제거·`unique nulls not distinct (user_id,key)`, self 있으면 probe 외 행 backfill, channel_conversations nullable 추가→backfill→NOT NULL, self 없는데 채울 행이 있으면 `USER_MISSING` 예외, trigger 대체(key·user_id 불변), 권한 유지 -- AD-18·40 순서와 불변.
- [ ] core self 해석기 모듈·`index.ts` export, 소비자 전환(`ingest.ts`, `commands.ts`, `install.ts`, CLI `daemon/supervisor.ts`) -- 유일한 is_self 해석.
- [ ] `ports/store.ts`, `postgres/src/settings.ts`, fake·contract -- 사용자 → 공통 행 읽기(userId 지정), (userId|null,key) upsert, 부재 시에만 삽입 -- key 단독 계약 제거.
- [ ] `settings/index.ts`, `brain.ts`, `snapshot.ts` `extensionSettingDefinitions`, `apps/cli` config 명령 -- scope 선언(timezone=user), 읽기 순서, scope 불일치 쓰기 거부, `config get/set` 기존 출력 호환 + `scope` 표시 -- 코덱 하나.
- [ ] `manifest.ts`·manifest schema·Python fixture/checker, `install.ts` -- 선택 `scope`, 설치 때 기본값 부재 시 삽입(재설치 보존), self로 설정 읽기 -- 기본값 계약.
- [ ] `snapshot.ts`, `process-abi/codec.ts`, `check.ts`, `queue/supervisor.ts`, CLI `daemon/supervisor.ts`, `commands.ts` -- snapshot user_id, 일감 준비·설치 확인·명령에서 self 없으면 `USER_MISSING`으로 자식 미시작 -- 실행 입력 self.
- [ ] `channels.ts`, `channels/store.ts`, `tooling/*`, `store.ts` probe 등 남은 key 단독 경로 -- user_id 계약으로 옮김.
- [ ] 시험 코드(작성만, 실행 금지): `packages/postgres/test/user-keys.test.ts`(신규) — 새 DB·업그레이드(31→32) self 채움, 업그레이드 전후 모든 설정 유효 값·행 대조, 대화 수집 표 건수·md5 불변, self 없는 업그레이드 실패·rollback, NULLS NOT DISTINCT 유일성, 불변 trigger. core 설정/manifest/snapshot/supervisor/commands 시험 — 우선 읽기·scope 거부·USER_MISSING·snapshot user_id. CLI `ext-install`·`extension-commands` 시험 — 재설치 값 보존·self 없음 USER_MISSING. 기존 시험의 key 단독 SQL 갱신.
- [ ] `tooling/test-changed/rules.mjs` -- 새 비TS 호출 경로 규칙 보강(필요 시).

**Acceptance Criteria:**
- Given 새 DB와 schema 31 업그레이드 DB, when migration·setup 흐름 뒤 설정 쓰기·대화 생성을 하면, then 설정·대화 행 user_id가 self이고 업그레이드 전후 모든 설정 유효 값과 대화 수집 표의 건수·내용 해시가 같다(시험 코드).
- Given 공통 값과 사용자 값이 함께 있는 키, when `brain config get`·확장 snapshot이 읽으면, then 사용자 값이 먼저이고 없으면 공통, 다음 기본값이다.
- Given 사용자가 바꾼 확장 설정, when 같은 확장을 재설치하면, then 값이 유지되고 없던 기본값만 생긴다.
- Given self 행이 없는 DB, when 감독 일감·`brain ext <name> <command>`를 실행하면, then 자식 프로세스 없이 `USER_MISSING`으로 끝난다.
- Given 변경 완료, when `pnpm build`·`pnpm typecheck`를 실행하면, then 둘 다 종료 0이다. 시험 실행은 21.8로 이관, 미실행이다.

## Implementation Notes

- 구현 워커 Codex gpt-6.1-terra/medium, 같은 Dispatch 계열 round1~5(`.brain-automation/implementation-20.2-round{1..5}.md`). round1~3은 범위가 커서 부분 완료(failed)로 보고, round4부터 한 덩어리씩 나눠 succeeded.
- 0032는 nullable 추가 → 기존 self로 backfill(`doctor.writable` 제외) → self 없이 채울 행이 있으면 `USER_MISSING` 예외 → key PK 제거·`unique nulls not distinct (user_id,key)` → channel_conversations NOT NULL → 불변 trigger 대체(key·user_id).
- global scope는 self 없이 공통 행→기본값으로 읽고 쓴다. USER_MISSING은 user scope에만.
- `core-garmin-cleanup.test.ts`는 31까지의 migration 디렉터리로 고정해 0031 자체를 검증하도록 바꿨다.
- 리뷰 pass1 수정(fix1) 뒤 실제 동작: `installPostgres`는 core 31까지 migrate → `ensureSelfUser` → 0032 이후 순서라 self 없는 기존 DB도 setup으로 회복한다. 0032를 setup 밖에서 단독 적용하면 self 없이 채울 행이 있을 때 여전히 `USER_MISSING`으로 rollback한다(I/O 표의 self 없는 업그레이드 행은 단독 migration 경로).
- 읽기 규칙 최종: user scope 키는 사용자 행 → 공통 행 → 기본값, global scope 키는 공통 행 → 기본값(global 키의 사용자 쓰기는 거부되므로 사용자 행이 정상 경로로 생기지 않는다). config·설치 확인·명령·login·데몬이 같은 `readScopedSettings`를 쓴다.
- 지휘자 확인: `pnpm build` 종료 0, `pnpm typecheck` 종료 0, `git diff --check` 종료 0. 시험 실행은 21.8로 이관, 미실행.

## Plan Change Log

## Review Triage Log

### 2026-11-05 — Review pass
- verdicts: 18 findings — high 0, medium 11, low 5, false 2, maybe-false 0
- 리뷰 원문: `.brain-automation/review-20.2-p1-{blind-hunter,edge-case-hunter,verification-gap,intent-alignment}.md` (Codex gpt-6.1-sol/medium, Run run_0741087f84b9)
- findings:
  - `[medium]` `[patch]` (edge-1) global 키를 config는 NULL 행만, 확장 snapshot·명령·설치·login·daemon은 self 우선으로 읽어 같은 키의 유효 값이 갈린다(G1) — `settings/index.ts`의 global 분기와 `getSettings({userId:self})` 일괄 조회를 대조해 확인. 선언 scope별(user→self·공통, global→공통) 조회로 통일하는 수정 지시.
  - `[medium]` `[patch]` (vgap-1) 확장 명령 봉투가 사용자 값(기본값·공통과 다른 값)을 전달하는지 검증 없음 — `extension-commands.test.ts`가 기본값 `fixture`만 확인. CLI/MCP 시험 추가 지시.
  - `[medium]` `[patch]` (vgap-2) global 기본값 설치 대상(NULL 행)·재설치 보존 검증 없음(G2) — 기존 재설치 시험은 user scope뿐. PG 설치 시험 추가 지시.
  - `[medium]` `[patch]` (blind-1) G1과 같은 원인 — 같은 수정과 두 행 공존 CLI·snapshot 비교 시험.
  - `[medium]` `[patch]` (blind-2) auth 선언 확장은 self 확인(`install.ts:239`)보다 앞의 login 단계(`install.ts:200`)에서 인증 일감을 만들고 `EXTENSION_LOGIN_REQUIRED`를 돌려 USER_MISSING을 건너뛴다 — self 해석을 login 단계 앞으로 옮기는 수정 지시.
  - `[medium]` `[patch]` (blind-3) self 조회·기본값 삽입 실패가 설치 journal에 실패 단계로 기록되지 않는다(`install.ts:239–245`는 `mark` 없이 반환) — `configuration` 실패 기록 지시.
  - `[medium]` `[patch]` (blind-4) settings 저장소 계약·PG 시험이 사용자 A·B·NULL 분리를 검증하지 않는다 — 계약 시험 보강 지시.
  - `[medium]` `[patch]` (blind-5) G2와 같은 원인 — 같은 시험.
  - `[low]` `[patch]` (blind-6) `resolveSelfUser`의 DB_LOCKED/DB_UNAVAILABLE 전파 시험 없음 — 시험 한 건 추가(제품 코드 변경 없음).
  - `[medium]` `[patch]` (blind-7) daemon 성공 경로 자식이 snapshot.user_id=self를 확인하지 않는다 — fixture 자식 비교 지시.
  - `[low]` `[patch]` (blind-8) 업그레이드 시험이 대화 기존 필드(id·channel_id·external_ref·비어 있지 않은 thread_ref) 보존을 비교하지 않는다 — 시험 보강.
  - `[low]` `[patch]` (blind-9) channel_conversations.user_id NOT NULL·FK 부정 사례 시험 없음 — 시험 보강.
  - `[low]` `[patch]` (blind-10) process-abi README가 snapshot `user_id` 필수·USER_MISSING을 설명하지 않는다 — 문서 직접 보완.
  - `[medium]` `[patch]` (intent-A) 이행 순서가 setup의 self 보장보다 0032 backfill이 먼저라 self 없는 기존 DB는 setup에서도 회복하지 못한다 — `installPostgres`가 0032 전까지 migrate → `ensureSelfUser` → 나머지 migrate로 원문 순서를 실제 실행 순서로 만들도록 지시.
  - `[medium]` `[patch]` (intent-B) self 부재 USER_MISSING이 확장 보호 일감에만 적용되고 core 감독 일감(channel_send·process_probe)은 그대로 시작된다 — verify "self 행이 없으면 일감·명령이 멈춘다"에 맞춰 모든 감독 일감 시작 전 self 해석 지시.
  - `[medium]` `[patch]` (intent-C) G1과 같은 원인.
  - `[false]` `[reject]` (intent-D) scope 거부가 코덱 수준에만 있다 — 원문이 "설정 코덱에 키별 scope"로 강제 위치를 코덱으로 정하고 DB·RLS 격리는 AD-40 Deferred다.
  - `[false]` `[reject]` (intent-E) 대화 생성자가 userId를 직접 넘긴다 — 운영 생성 경로(`tooling/channels-mac/probe.mjs`)는 `resolveSelfUser` 결과를 넘기고 다른 운영 생성자는 없다. 저장소는 사용자를 고르지 않는다.
- 처리: 수정은 구현 워커(같은 Dispatch 계열)에 2묶음으로 보냄 — 부분 완료 반복을 피하려고 제품 수정 묶음과 시험·문서 묶음을 나눴다.

### 2026-11-05 — Review pass (follow-up pass 2)
- verdicts: 17 findings — high 0, medium 9, low 5, false 2, maybe-false 1
- 리뷰 원문: `.brain-automation/review-20.2-p2-{blind-hunter,edge-case-hunter,verification-gap,intent-alignment}.md`
- findings:
  - `[medium]` `[patch]` (edge-1) 공통 `prepareLaunch` 대기 뒤 core 감독 일감은 취소·보류·토큰·abort 재확인 없이 자식을 시작한다(G3) — `queue/supervisor.ts` 199~216에서 재확인 블록이 protection 분기 안에만 있음을 확인. 재확인을 모든 일감에 적용 지시.
  - `[medium]` `[patch]` (edge-2) `tooling/mac-install/run.mjs` 224의 갱신 전 snapshot이 schema 31 DB에서 없는 `settings.user_id`를 조회해 실패한다 — 열 존재 확인 뒤 구버전은 key 단독 조회 지시.
  - `[medium]` `[patch]` (vgap-1) global 키에 self·NULL 행이 함께 있을 때 실제 명령 봉투가 공통 값을 받는지 검증 없음(G4) — helper 직접 호출 시험뿐. CLI 명령 통합 시험 지시.
  - `[medium]` `[patch]` (vgap-2) self 없는 schema 31 DB를 실제 `installPostgres`로 회복하는 시험 없음(G5) — 순서를 시험 안에서 재현할 뿐. install-orbstack 패턴 통합 시험 지시.
  - `[medium]` `[patch]` (blind-1) G3과 같은 원인.
  - `[low]` `[reject]` (blind-2) user/global 혼합 조회가 두 statement라 동시 갱신 시 키 간 값이 섞일 수 있다 — 실재하나 같은 순간 두 scope 키를 함께 바꾸는 경우는 일상에서 드물고, 해결은 새 저장소 연산 또는 트랜잭션 추가라 거부.
  - `[low]` `[patch]` (blind-3) 공통 준비 실패가 USER_MISSING·DB 오류에도 `확장 설정을 확인하세요`로 저장된다 — 코드별 안내로 직접 대응 지시.
  - `[medium]` `[patch]` (blind-4) 설치의 scope별 설정 조회 실패가 journal에 기록되지 않는다(`install.ts` 252~253) — `configuration` 실패 기록 지시.
  - `[low]` `[patch]` (blind-5) 업그레이드 보존 시험이 일부 표만 seed하고 나머지는 빈 표 해시를 비교한다 — seed한 표의 비어 있지 않음 단언과 의도적 빈 표 구분 지시.
  - `[medium]` `[patch]` (blind-6) G5와 같은 원인.
  - `[medium]` `[patch]` (blind-7) 터미널 `ext login`의 self 해석·scope snapshot 경로 시험 없음 — USER_MISSING·launcher 미호출, 성공 시 snapshot.user_id 시험 지시.
  - `[medium]` `[patch]` (blind-8) G4와 같은 원인(설치 확인·데몬 소비자 포함).
  - `[low]` `[patch]` (blind-9) settings.user_id 불변성이 한 방향(사용자→NULL)만 시험된다 — NULL→사용자, A→B, FK 위반 시험 지시.
  - `[low]` `[reject]` (blind-10) 계획의 Intent·I/O·Design Notes가 fix1 뒤의 setup 순서와 맞지 않는다 — 수정이 이 빌드의 계획 편집이라 규칙상 거부. Implementation Notes에 실제 동작(독립 migration은 rollback, setup은 31→self→0032로 회복)을 덧붙였다.
  - `[maybe-false]` `[defer]` (intent-A) core 감독 자식(`channel_send`, `process_probe`)의 실행 입력에는 self가 들어가지 않는다(시작 전 확인만) — "모든 실행 입력"을 core 내부 자식까지로 읽을지 정해야 결론이 난다. 현재 core 자식은 사용자 값을 쓰지 않고 대화 행이 user_id를 갖는다. deferred 기록.
  - `[false]` `[reject]` (intent-B) global 키가 사용자 행보다 공통 행을 읽는다 — global 키의 사용자 쓰기는 코덱이 거부하므로 정상 경로로는 사용자 행이 생기지 않는다. 사용자 우선 읽기는 user 키에 그대로 적용되고, global에 오래된 사용자 행을 읽으면 `config set`이 효과 없어 보이는 결함이 생긴다(pass1 G1).
  - `[false]` `[reject]` (intent-C) setup이 nullable 추가보다 self를 먼저 보장하고 기본값을 NOT NULL 뒤에 넣는다 — 관찰 가능한 의존(self→backfill→NOT NULL)은 지켜진다. NOT NULL은 channel_conversations에만 걸리고 기본값은 settings에 들어가므로 두 순서는 서로 영향이 없다.

### 2026-11-05 — Review pass (follow-up pass 3)
- verdicts: 17 findings — high 0, medium 0, low 13, false 3, maybe-false 1
- 리뷰 원문: `.brain-automation/review-20.2-p3-{blind-hunter,edge-case-hunter,verification-gap,intent-alignment}.md`
- findings:
  - `[low]` `[reject]` (edge-1) user/global 두 조회 사이 동시 갱신 시 snapshot 값 혼합 — carried: pass2 blind-2와 같은 위치·주장, `settings/index.ts` 두 조회 구조 그대로.
  - `[low]` `[patch]` (vgap-1) 공유 계약 `insert absent A`가 A 삽입 결과를 읽지 않는다 — 단건·일괄 읽기 단언 추가 지시.
  - `[low]` `[reject]` (blind-1) edge-1과 같은 주장 — carried.
  - `[low]` `[reject]` (blind-2) 기본값 삽입 루프에 취소 확인이 없다 — 실재하나 삽입은 부재 시에만 하는 멱등 쓰기라 재개 시 같은 결과가 되고, 해결은 가드 추가라 거부.
  - `[low]` `[patch]` (blind-3) `doctor.writable`만 있는 self 없는 DB의 0032 성공 시험 없음 — 시험 추가 지시.
  - `[low]` `[patch]` (blind-4) backfill이 여러 users 중 `is_self=1`을 고르는지 시험 없음 — non-self 먼저 넣은 v31 시험 지시.
  - `[low]` `[patch]` (blind-5) `installPostgres`의 31→self→32 사이 실패 뒤 재실행 복구 시험 없음 — 두 번째 migration 실패 주입·재실행 시험 지시.
  - `[low]` `[reject]` (blind-6) `coreMaxVersion` 잘못된 값 검증 시험 없음 — 유일한 호출자가 상수 31을 넘기고, runner는 적용 버전보다 큰 파일만 적용하므로 downgrade가 없다. 가드 추가라 거부.
  - `[low]` `[patch]` (blind-7) PG `insertSetting`의 DB_LOCKED/DB_UNAVAILABLE 분류 시험 없음 — 기존 잠금·접근 불가 시험에 insertSetting 추가 지시.
  - `[low]` `[reject]` (blind-8) 여러 기본값 중 일부 삽입 실패 뒤 재설치 사례 — 부재 시 삽입·사용자 값 보존·실패 기록은 각각 시험돼 있어 조합 사례는 추가 가치가 작다.
  - `[low]` `[reject]` (blind-9) 터미널 login의 user 키 fallback 세 경우 시험 — login은 다른 소비자와 같은 `readScopedSettings`를 쓰고 그 helper의 fallback은 core 시험이 덮는다.
  - `[low]` `[reject]` (blind-10) 계획 본문의 global 읽기 서술 불일치 — carried: 계획 편집이라 규칙상 거부. Implementation Notes에 실제 규칙을 적었다.
  - `[maybe-false]` `[defer]` (intent-A) core 감독 자식 실행 입력에 self 미전달 — carried: 기존 deferred 항목.
  - `[false]` `[reject]` (intent-B) global 키가 공통 행을 읽는다 — carried: pass2 intent-B 반증 그대로.
  - `[false]` `[reject]` (intent-C) setup 단계 순서 — carried: pass2 intent-C 반증 그대로.
  - `[low]` `[reject]` (intent-D) 공통 행만 있는 user 키에 manifest 기본값을 설치하면 유효 값이 공통 값에서 기본값으로 바뀐다 — 실재하는 코드 경로지만 user 키의 공통 행은 코덱이 scope 불일치로 거부해 정상 경로로 생기지 않고(0032도 probe 외 행을 self로 옮김) 직접 SQL로만 만들 수 있다.
  - `[false]` `[reject]` (intent-E) scope 거부·대화 소유자의 강제 위치 — carried: pass1 intent-D/E 반증 그대로.
- 처리: low 시험 보강 5건만 patch. 이 후속 pass는 high를 patch하지 않았으므로 후속 리뷰 권고 false(수렴).

## Design Notes

- 이행 순서의 적용: 새 DB에는 0032 시점에 채울 행이 없고 `installPostgres`가 migration 직후 self를 만든다. 업그레이드 DB의 self는 이전 setup이 이미 보장했으므로 0032가 기존 self id를 복사해 채운다(DB가 값을 생성하지 않음). self 없는 비정상 DB는 조용히 NULL(=공통)로 바꾸지 않고 멈춘다 — 설정이 섞이는 위험(에픽 Risk 2)을 피하는 보수적 선택이다.
- probe(`doctor.writable`)는 rollback되는 쓰기 확인용이라 기계 공통 NULL 대상으로 둔다.
- scope 기본 `user`: 기존 manifest·키의 의미를 바꾸지 않고, global이 필요한 확장만 선언한다. timezone은 사용자 설정(AD-13 "사용자 설정 timezone")이므로 user다.

## Verification

**Commands:**
- `pnpm build` -- expected: 종료 0
- `pnpm typecheck` -- expected: 종료 0
- `git diff --check` -- expected: 출력 없음

**시험 실행: 21.8로 이관, 미실행.** 21.8은 전용 시험 DB·합성 자료에서 `pnpm test` → `pnpm test:python`을 순차 실행한다. 이 티켓의 대상 시험(작성만 함, 저장소 루트 vitest): `pnpm vitest run packages/postgres/test/user-keys.test.ts packages/postgres/test/settings.test.ts packages/postgres/test/migrate.test.ts packages/postgres/test/schema.test.ts packages/postgres/test/store.test.ts packages/core/test/extensions.test.ts packages/core/test/process-abi.test.ts packages/core/test/supervisor.test.ts apps/cli/test/ext-install.test.ts apps/cli/test/extension-commands.test.ts`. 준비: 격리 PG(`tooling/test-db`)와 임시 홈, 정리: 시험 fixture의 소유 DB/홈 정리.

## Auto Run Result

- 상태: built(사용자 인수 전). 기준 `8ca6a4e7ca03c8c3c8387c7ba97d3efdce55d9b7`. main 병합·push는 중앙 소관이다.
- 구현 요약: 새 migration 0032가 `brain.settings`에 nullable `user_id`와 `UNIQUE NULLS NOT DISTINCT (user_id,key)`를 두고 `channel_conversations.user_id`를 NOT NULL로 더한다. 기존 행은 기존 self로 채우고 `doctor.writable` probe만 NULL로 둔다. self 없이 채울 행이 있으면 단독 migration은 `USER_MISSING`으로 rollback하고, setup(`installPostgres`)은 core 31까지 migrate → self 보장 → 0032 순서로 회복한다. core 유일 self 해석기(`users/self.ts`)를 설정 코덱·설치 확인·login·확장 명령·모든 감독 일감·세션 수집이 쓴다. 설정 코덱은 키별 scope(user|global, manifest 선택 `scope`, 기본 user)로 쓰기 대상을 정하고 불일치 쓰기를 거부한다. 읽기는 user 키 사용자→공통→기본값, global 키 공통→기본값이다. 설치는 manifest 기본값을 부재 시에만 삽입한다. 설정 snapshot은 `user_id`를 필수로 가진다.
- 변경 파일(제품): migration `0032_user_keys.sql`·`migrate.ts`(버전 32, core 상한 옵션), postgres `settings.ts`·`channels.ts`·`store.ts`(probe), core `users/self.ts`(신규)·`settings/index.ts`·`brain.ts`·`ports/store.ts`·`channels/store.ts`·`extensions/{install,commands,manifest,snapshot}.ts`·`process-abi/codec.ts`·`queue/{supervisor,schedules}.ts`·`sessions/ingest.ts`·`index.ts`, 공유 schema/fixture(manifest scope, settings snapshot user_id)와 ABI README, CLI `install/postgres.ts`·`daemon/supervisor.ts`·`commands/{config-get,config-set,ext-login}.ts`·`doctor/store.ts`, tooling `mac-install/run.mjs`·`channels-mac/{probe,verify,cleanup}.mjs`·`test-changed/rules.mjs`.
- 시험 코드(작성만): 신규 `packages/postgres/test/user-keys.test.ts`, 갱신 settings 계약·PG settings/install-orbstack/migrate/store/channel-store 시험, core settings/extensions/supervisor/process-abi/extension-snapshot 시험, CLI ext-install/extension-commands/ext-login/postgres-setup 시험 등 총 78파일 변경 중 다수.
- 리뷰: 독립 4렌즈(Codex gpt-6.1-sol/medium) × 3 pass. pass1 18건(medium 11·low 5·false 2) → patch 16·reject 2. pass2 17건(medium 9·low 5·false 2·maybe-false 1) → patch 12·reject 4·defer 1. pass3 17건(low 13·false 3·maybe-false 1, carried 7) → patch 5(low 시험)·reject 11·defer 1(carried). 기각 사유와 근거는 Review Triage Log 각 행. deferred 1건: core 감독 자식 실행 입력의 self 전달(판단 필요).
- 후속 리뷰 권고: false. pass3은 후속 pass이고 high patch가 없다(patched low 5, medium 0, high 0). 마지막 patch는 시험 코드만 바꿨다.
- 검증: 최종 `pnpm build` 종료 0, `pnpm typecheck` 종료 0, `git diff --check` 종료 0. **시험 실행은 21.8로 이관, 미실행**이다. 정적 리뷰를 실행 통과로 표현하지 않는다.
- 21.8 인계: 전용 시험 DB·합성 자료에서 `pnpm test` → `pnpm test:python` 순차 실행. 이 티켓 대상 시험은 Verification 절 목록과 `packages/postgres/test/install-orbstack.test.ts`, `apps/cli/test/{ext-login,postgres-setup}.test.ts`, `packages/core/test/{settings,extension-snapshot}.test.ts`. DB 업그레이드(31→32, self 없는 회복·rollback), 권한(app role select/insert/update, delete·불변 trigger 거부), 대화 수집 표 건수·md5 보존 시험이 핵심이다. 준비: `tooling/test-db` 격리 PG와 임시 홈, 정리: fixture 소유 DB/홈.
- 잔여 위험: 시험 미실행이라 새·갱신 시험 자체의 오류 가능성이 있다(21.8). user/global 혼합 조회는 두 statement라 동시 갱신 시 키 간 값이 섞일 수 있다(low, 기각). 공통 행만 있는 user 키에 기본값을 설치하면 유효 값이 바뀐다(직접 SQL로만 생기는 상태, 기각). 20.1의 알려진 경계(명령이 확장 잠금을 보유해 disable이 기다릴 수 있음)는 그대로다.
