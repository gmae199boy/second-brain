---
title: '이 Mac에서 전환: 옛 Garmin 수집 예약을 내리고 공통 예약으로 실계정 수집 한 번이 돈다'
type: 'chore'
ticket: '9'
created: '2026-11-04'
status: blocked
baseline_revision: '03c7b2b50829343b80a22dc6c7923cf070937481'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/personal-brain/automation/runbook.md'
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-garmin-runtime/epic-garmin-runtime-research-code.md'
warnings: ['oversized']
deferred: []
operator_actions:
  - summary: >-
      14.8 반입(이전 Garmin 기록의 규칙 A 반입·verify)을 끝낸다. 16.9 운영 전환과 실수집은 그 뒤에만 재개한다.
    evidence: |-
      2026-11-04 운영 DB 공개 집계: garmin.datasets 0, raw_records 0, import_batches 0. 14.8은 계정 귀속 미확인 후보 때문에 blocked다.
  - summary: >-
      Garmin 봇·채팅 conversation을 채널에 등록한 뒤, 확장 갱신 후 `garmin.notice_conversation_id`에 그 UUID를 설정한다.
    evidence: |-
      설치본 e33a787의 manifest에는 이 키가 없어 `brain config get`이 CONFIG_INVALID다. brain.channel_conversations는 0건이다.
  - summary: >-
      재개 때 app-ref·version commit을 원격에 push해야 공식 bootstrap이 그 ref를 fetch할 수 있다. 원격 marketplace 반영은 중앙 main 병합·push 뒤에만 된다.
    evidence: |-
      `plugin/bootstrap.mjs`는 clone에서 `git fetch origin` 뒤 app-ref로 detach한다. README "릴리스"에 따르면 원격 marketplace는 version별로 캐시한다. 지휘자는 티켓 브랜치만 push하고 main은 중앙 소유다.
blocked_at: "2026-11-04"
blocked_reason: "14.8 반입·verify 완료 대기: 운영 DB 반입 기록 0건에서 실수집하면 core 권위 v2가 반입 dataset 없이 영구 기록됨(중앙 결정 A, msg_ac873b59896a). 운영 상태 무변경"
---

<intent-contract>

## Intent

**Problem:** 16.1~16.7 connector 기능은 main에 있지만 이 Mac의 설치본(e33a787)에는 없다. 옛 `local.garmin-pipeline.collect` LaunchAgent가 아직 수집한다. 그래서 공통 예약으로 실계정 수집이 한 번 돈 증거가 없다.

**Approach:** 원문 순서를 따른다. 무중첩 전환을 한다: 새 쪽 보류 → 보류 중 갱신 → 옛 collect bootout과 종료 확인 → 보류 해제와 공통 예약 → profile 검증 → 실수집 한 번. 각 단계 결과는 공개 투영으로만 plan에 남긴다. 2026-11-04 중앙 결정(msg_ac873b59896a, 선택 A)에 따라 이번 실행은 운영 상태를 바꾸지 않는다. 14.8 반입이 끝날 때까지 blocked로 둔다. 반입이 0건인 상태에서 수집하면 권위 v2가 반입 dataset 없이 영구 기록되기 때문이다.

## Boundaries & Constraints

**Always:** 옛 수집과 새 수집이 같은 계정을 동시에 부르지 않는다. 종료가 불명이면 전환을 멈춘다. 옛 plist는 복구용으로 보존한다. profile 증거로 확인한 계정만 수집 대상으로 쓴다. 공개 plan에는 단계 성공/실패와 건수만 쓴다. MFA·당일 차단(`block.json`)·미실행·실패는 실수집 성공으로 세지 않는다.

**Never:** 14.8 반입 전 실수집. 권위 v2 누락의 수용이나 v3 기능 추가. 옛 collect만 내려서 생기는 수집 공백. 기존 데이터 삭제. 계정 추정. 접근 조건 완화. 건강값·계정 id·토큰·개인 홈 절대 경로를 Git에 쓰는 것. main 병합·push.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 반입 0건 | garmin.datasets 0 | 운영 변경 없이 blocked | 재개 조건: 14.8 반입·verify 완료 |
| 옛 writer 실행 중 | `launchctl list`에 PID, 또는 garmin-pipeline 프로세스 | bootout 뒤 종료를 확인할 때까지 대기. 불명이면 중단 | 새 쪽 보류 유지 |
| 보류 중 예약 시각 경과 | 11:00·11:15 경과, extension:garmin 보류 | garmin 청구 0 | 청구가 있으면 중단·복구 |
| MFA 요구 | 인증이 LOGIN_REQUIRED/MFA | 그 단계만 awaiting-operator | `brain ext login garmin` 재인증을 operator_actions에 남김 |
| 당일 차단 | tokenstore `block.json`이 오늘 날짜 | 호출하지 않고 다음 날 수집 | 성공으로 세지 않음 |
| profile 불일치 | 로그인 profile ≠ 반입 계정 | 수집 중단 | 계정 확인 전 재개 금지 |

</intent-contract>

## Code Map

- `extensions/garmin/src/normalize_store.py:87` `_authority` -- 계정의 첫 발행 때 core `brain.health_authority_rules` revision 2를 INSERT한다. 값은 `[수집 dataset] + v1 provenance`다. 이미 있으면 다시 쓰지 않는다. 반입 뒤 수집이어야 하는 근거다.
- `extensions/garmin/src/collect.py:106-160` -- extension 대상이 처음 돌 때 로그인 profile id로 계정을 정하고 coverage·history_start를 읽는다. 반입 dataset이 없으면 today−30이다.
- `packages/core/src/extensions/install.ts:84-96`, `:170-215`, `:272-292` -- digest가 바뀌면 단계를 처음부터 다시 돈다. `recordExtensionInstall`은 version만 갱신하고 enabled를 바꾸지 않는다(`packages/postgres/src/extensions.ts:102`). 보류 중에는 `garmin.auth` 일감이 hold group에 묶인다. 그래서 설치는 login_required에서 멈추고 Garmin 호출이 없다. 예약은 `ensureDaily`로 기존 행을 재사용한다.
- `packages/postgres/src/extensions.ts:55-66` `setExtensionEnabled` -- `brain ext enable/disable`. disable은 hold group 행을 만들고, enable은 지운다.
- `extensions/garmin/src/garmin_session.py:171` `open_session` -- 옛 tokenstore `.session.lock` 잠금을 쓴다. 당일 `block.json`이 있으면 호출하지 않는다.
- `plugin/app-ref`, `plugin/.claude-plugin/plugin.json`, `plugin/bootstrap.mjs` -- 배포 경로다. 재개 때 앞선 원격 commit과 version 증가를 같은 commit에 넣고, 이 checkout의 plugin root로 공식 bootstrap을 돈다(14.8 선례). 이번에는 바꾸지 않는다. `config.toml [update] auto = true`라서, 바꾸면 세션 시작 때 갱신이 일어날 수 있다.
- 옛 runtime의 설치 패키지 `garmin_pipeline/report.py`, `facts.py` -- garmin·collect를 import하지 않고 수집 완료만 기다린다. 그래서 report LaunchAgent는 epic 18(18.9)까지 남긴다.

## Tasks & Acceptance

**Execution:**
- [x] 이 plan -- 읽기 전용 관찰, 전환·복구 절차, 차단·재개 조건을 기록한다 -- 중앙 결정 A.
- [ ] (재개 후) `plugin/app-ref`, `plugin/.claude-plugin/plugin.json` -- 앞선 원격 commit과 version 증가를 한 commit에 넣는다 -- 설치본 갱신.
- [ ] (재개 후) 설치본 운영 -- 아래 Design Notes 순서대로 한 번 실행하고 공개 투영을 Auto Run Result에 덧붙인다.

**Acceptance Criteria:**
- Given 14.8 반입·verify가 끝난 설치본에서, when 전환 순서를 한 번 돌리면, then `launchctl list`에 `local.garmin-pipeline.collect`가 없고 `brain schedules list`에 garmin.collect 11:00·garmin.collect_retry 11:15가 있으며 보류 구간의 garmin 청구는 0이다.
- Given 해제 전 미완료 garmin 일감을 0으로 만들고 보류 하한 T0와 enable 직전 Ta를 private 증거로 남겼다면, when [T0, Ta] 구간의 garmin 일감 attempt(완료된 것 포함)를 Design Notes의 조회로 세면, then 0건이고, 해제 뒤 attempt는 새로 만든 auth 일감의 것뿐이다. 공개 plan에는 구간 확인 결과와 건수만 남긴다.
- Given 실수집이 성공했다면, when 결과를 읽으면, then 그 일감의 ABI 결과가 성공이고 새 수집 dataset의 raw·건강 행 건수가 0보다 크며 "현재" view 읽기가 성공한다. 옛 수집과 겹친 시간은 없다.
- Given 갱신된 설치본에서, when 원격으로 붙을 수 있는 터미널에서 로그인 스킬로 `brain ext login garmin` 진입을 확인하면, then 비밀 입력이 대화가 아니라 터미널 프롬프트로만 열린다. 결과는 성공/실패만 기록한다. 실제 재인증이 필요하면 운영자 조치로 분리한다.
- Given 이번 실행(반입 0건)에서는, when plan을 읽으면, then 운영 상태 변경 없이 blocked이고 재개 조건과 operator_actions가 있다.

## Design Notes

전환 순서(재개 때 실행):
1. 계정 gate: 14.8 반입이 끝났는지 확인한다. 반입 계정과 tokenstore 로그인 profile이 일치하는지 private로 확인한다. 옛 writer가 돌지 않을 때 한다. plan에는 일치 여부만 쓴다.
2. 보류 하한 시각 T0를 private에 남긴다. 이미 보류 중이면 T0는 `brain.extensions.enabled_changed_at`이다. 그다음 `brain ext disable garmin`(이미 보류면 그대로 둔다). enabled=false를 확인하고, garmin 미완료 일감과 종료되지 않은 attempt가 0인지 확인한다.
3. app-ref·version commit을 push하고 공식 bootstrap으로 설치본을 갱신한다. 그다음 `brain ext install garmin`을 돌린다. 패키지·lock frozen 환경·마이그레이션 단계는 succeeded여야 하고, login_required에서 멈추는 것이 정상이다(보류 중 `garmin.auth`는 청구되지 않음). enabled=false, 예약 행, 청구 0이 그대로인지 확인한다. 이상이 있으면 복구로 간다. 설치 API가 보류 중 갱신을 지원하지 않으면(단계 실패 등) 4를 먼저 하고 3을 다시 한다. 이때부터 옛 collect는 내려간 상태로 본다.
4. `launchctl disable gui/$(id -u)/local.garmin-pipeline.collect`로 다음 로그인·재부팅의 자동 load를 막는다. 이어서 `launchctl bootout gui/$(id -u)/local.garmin-pipeline.collect`를 한다. plist 파일은 그대로 둔다. 다음 넷을 확인한다: `launchctl print-disabled gui/$(id -u)`에서 disabled, `launchctl list`에 label 없음, garmin-pipeline collect 프로세스 없음, tokenstore 잠금 보유자 없음. 하나라도 불명이면 멈추고 복구로 간다. report는 남긴다.
5. 보류 해제와 계정 gate. 시작 조건은 그날 garmin 예약 시각(11:00·11:15, 실제 time_zone 기준)이 모두 지났을 때다. 마감은 다음 예약 시각 30분 전이다. 마감까지 gate를 끝내지 못하면 복구로 간다. 순서는 이렇다. (a) 보류된 기존 garmin 예약 두 건을 `brain schedules remove <id>`로 지운다. 이 예약은 next_run_at이 과거라서 해제 즉시 발화한다. 예약 0을 확인한다. 3에서 보류된 채 대기 중인 `garmin.auth` 일감(status의 `auth_work_id`)을 `brain queue cancel <id>`로 닫는다. 아직 청구되지 않은 일감은 즉시 cancelled로 완료된다. garmin 미완료 일감이 0인지 확인한다. 이렇게 하면 해제 경계에 청구할 수 있는 garmin 일감이 아예 없다. (b) `brain ext enable garmin`을 한 뒤 곧바로 `brain ext install garmin`을 돌린다. cancelled auth를 보고 새 auth 일감을 만든다(`packages/core/src/extensions/install.ts`의 cancelled 분기). (c) `brain ext status garmin`의 `auth_work_id`를 읽는다. 그 일감의 실제 `brain.work_items` 완료·outcome과 latest `brain.work_attempts`의 error_code를 private로 읽어 끝날 때까지 기다린다. status의 login journal은 install을 다시 돌리기 전까지 pending으로 남으므로 판정 근거가 아니다. 진행과 실패(LOGIN_REQUIRED·MFA)를 구별한다. 성공이면 `brain ext install garmin`을 다시 돌려 installed를 확인한다. 예약 두 건이 다시 생겼는지, next_run_at이 마감 뒤 미래인지 확인한다. 실패·부분 예약은 복구로 간다. (d) 곧바로 로그인 profile과 반입 계정이 일치하는지 다시 확인한다. 불일치이거나 MFA를 요구하면 복구로 간다. (e) 경계: 해제 전 T0와, (b)의 enable 직전 Ta를 private에 남긴다. [T0, Ta] 구간에 청구된 garmin attempt는 0이어야 한다. (a)에서 미완료 garmin 일감을 0으로 만들었으므로, 해제 순간에 진행 중이던 청구도 가져갈 일감이 없다. 그래서 started_at이 Ta 근처인 attempt를 시각만으로 예외 처리하지 않는다. 0이 아니면 실패로 보고 복구한다. 해제 뒤의 attempt는 (b)의 install이 새로 만든 auth 일감의 것이다. 그 일감 id가 cancel한 id와 다른지 확인해 구분한다. 공개에는 건수만 쓴다. (f) 채널 conversation이 등록돼 있으면 `garmin.notice_conversation_id`를 설정한다.
6. 당일 `block.json`이 없을 때 `brain ext run garmin collect`를 한 번 돌린다. ABI 결과, raw/건강 행 건수, "현재" view를 확인한다. 로그인 스킬의 원격 터미널 진입은 비밀 프롬프트가 열리는 것까지만 확인하고 자격 증명을 넣지 않는다. 실제 재인증으로 tokenstore가 바뀌면 5의 계정 gate를 다시 한다.

보류 구간 청구 조회(경계는 private 바인딩, 공개에는 건수만):
`select count(*) from brain.work_attempts a join brain.work_items w on w.id = a.work_item_id where starts_with(w.kind, 'garmin.') and a.started_at >= :t0 and a.started_at <= :ta;` 해제 뒤 attempt는 `w.id`로 새 auth 일감인지 확인한다. T0 전에 시작해 아직 끝나지 않은 attempt는 2에서 별도로 0인지 확인한다.

복구(단계 번호가 아니라 실제 상태로 분기): ① `brain ext disable garmin`. 진행 중인 새 attempt의 종료를 확인할 때까지 기다리고, 불명이면 중단 상태로 둔다. ② 옛 collect가 내려간 상태(4를 했거나 3의 fallback을 탔을 때)였으면 garmin 예약을 `brain schedules remove`로 지우고 예약 0을 확인한다. 옛 collect가 아직 등록돼 있으면 예약은 보류된 채 둔다. ③ 계정을 확인한다. 옛 collect도 같은 tokenstore를 쓴다. 그래서 그 tokenstore의 profile이 반입 계정과 일치할 때만 옛 수집을 복원한다. 일치하지 않거나 확인할 수 없으면 두 수집기를 모두 멈춘 안전 정지로 둔다. 운영자 조치(올바른 계정 재로그인)를 기다리고, 그 기간의 수집 공백은 실패로 기록한다. 옛 label이 아직 등록돼 있는데(4 이전 실패) 계정을 확인할 수 없으면 4의 정지 순서(disable → bootout → 확인 넷)를 수행한다. 종료가 확인될 때만 안전 정지 완료로 기록하고, 불명이면 정지 미완료로 보고한다. 이 경우 아래 복원과 ④의 성공 분기로 가지 않는다. 계정이 확인되면 옛 label을 확인한다. `launchctl list`에 있으면 bootstrap하지 않는다(disabled면 `launchctl enable`만). 없고 옛 프로세스 종료가 확인됐을 때만 `launchctl enable gui/$(id -u)/local.garmin-pipeline.collect` → `launchctl bootstrap gui/$(id -u) <옛 collect plist>`를 한다. 옛 프로세스 종료가 불명이면 복원하지 않고 멈춘다. ④ 옛 label 등록, 새 쪽 보류 유지, 수집기 하나만 켜진 상태를 확인한다. 두 수집기를 동시에 켜지 않는다.

## Verification

**Commands:**
- `python3.14 _bmad/method/scripts/tickets.py --project-root . find 16.9` -- expected: plan 상태 blocked, problems 없음
- `git diff --check` -- expected: 출력 없음
- `pnpm test:changed` -- expected: 성공(문서만 바뀌어 선택된 시험 없음)
- `pnpm test` 다음 `pnpm test:python`(순차 1회) -- expected: 성공. 무관한 기존 불안정은 근거와 함께 구별한다

**Manual checks (if no CLI):**
- 공개 plan에 건강값·계정 id·토큰·개인 홈 절대 경로가 없다.

## Implementation Notes

- 2026-11-04 읽기 전용 관찰(공개 투영): 설치본 commit e33a787, daemon alive. garmin 확장 installed, enabled=false, 보류 예약 2건(garmin.collect 11:00, garmin.collect_retry 11:15), interrupted_work 0. hold group `extension:garmin` 1행, garmin 미완료 일감 0, 진행 attempt 0. 옛 LaunchAgent collect(11:00·11:15)·report(11:30) 등록, 조회 시 PID 없음. 운영 DB garmin datasets·raw·import_batches·collect_runs 모두 0. channel_conversations 0. tokenstore 존재(권한 0700/0600), 당일 `block.json` 없음.
- 정적 확인: 옛 report는 수집을 부르지 않는다(위 Code Map).
- 결정: 중앙 msg_ac873b59896a가 선택 A를 정했다. 운영 전환·실수집·옛 collect/report 중지·새 예약 활성화를 하지 않는다. app-ref·version도 바꾸지 않는다.

## Plan Change Log

## Review Triage Log

### 2026-11-04 — Review pass
- 렌즈: blind-hunter·edge-case-hunter·verification-gap·intent-alignment(Codex gpt-6.1-sol medium, Run run_72ce3ca4c741). 원문은 워크트리 `.brain-automation/review/review-*.md`에 있다. 이 diff의 산출물이 곧 절차 문서다. 소스 구현자가 없어서 지휘자가 문서 patch를 직접 적용했다.
- verdicts: 15 findings — high 0, medium 11, low 0, false 0, maybe-false 0, 기술적 차이 기록 2(reject)
- findings:
  - `[medium]` `[patch]` (blind 1) frontmatter `in-review`와 본문 blocked가 어긋나고 구조화된 차단 원인이 없음 — HALT에서 `tickets.py mark ... blocked --blocked`로 status·blocked_at·blocked_reason을 쓴다.
  - `[medium]` `[patch]` (blind 2) plist를 둔 채 bootout만 하면 다음 로그인에 옛 collect가 다시 load됨 — 4단계를 `launchctl disable` → bootout → `print-disabled` 확인으로 바꿨다. 복구 B에 `launchctl enable`을 넣었다.
  - `[medium]` `[patch]` (blind 3) 한 시점의 attempt 0은 보류 구간 청구 0의 증거가 아님 — 보류 시작·해제 시각을 private에 남기고 `brain.work_attempts.started_at` 구간 조회 AC를 더했다(열 존재 확인).
  - `[medium]` `[patch]` (blind 4) 단계와 무관한 단일 복구는 옛 label이 등록된 상태에서 bootstrap이 실패함 — 복구를 A(4 이전, 재등록 안 함)와 B(4 이후)로 나눴다. 복구 뒤 확인 항목도 더했다.
  - `[medium]` `[patch]` (blind 5) 에픽 2026-11-02 Decision의 로그인 스킬 원격 사용 확인이 빠짐 — 6단계와 AC에 원격 터미널 진입 확인(성공/실패만)을 더했다.
  - `[medium]` `[patch]` (edge 1) MFA 재인증으로 다른 계정이 로그인되면 첫 수집이 다른 profile에 v2를 발행함 — 5단계에 재인증·tokenstore 교체 뒤 profile 재확인을 더했다. 불일치면 disable 후 중단한다.
  - `[medium]` `[patch]` (edge 2) 재로그인 시 옛 LaunchAgent 재등록 — blind 2와 같은 원인이다. 같은 patch.
  - `[medium]` `[patch]` (edge 3) blocked 선언과 frontmatter 상태 불일치 — blind 1과 같은 원인이다. 같은 patch.
  - `[reject]` (intent 최종 결과 표면) 실제 설치·예약·수집 결과가 없음 — 중앙 결정 A(msg_ac873b59896a)로 실행을 연기했다. 해당 AC는 미충족으로 남기고 blocked이며, built로 올리지 않는다. 숨긴 것이 아니다.
  - `[medium]` `[patch]` (intent 안전 전환) 보류 구간 무청구가 한 시점 관찰뿐임 — blind 3과 같은 원인이다. 같은 patch.
  - `[medium]` `[patch]` (intent 설치 호환성) lock frozen·마이그레이션과 설치 API 미지원 분기가 명시되지 않음 — 3단계에 패키지·frozen 환경(`uv sync --frozen`, `apps/cli/src/runtime/extension-python.ts:54`)·마이그레이션 succeeded 확인과 미지원 시 4를 먼저 하는 분기를 더했다.
  - `[medium]` `[patch]` (intent 복구) 원문 복구의 "예약 제거"가 빠짐 — 복구 B에 `brain schedules remove` 두 건과 예약 0 확인을 더했다.
  - `[medium]` `[patch]` (intent 원격 push) push 의존 단계가 operator_actions에 없음 — operator_actions에 app-ref commit push와 중앙 main·marketplace 반영 항목을 더했다.
  - `[medium]` `[patch]` (intent 차단 상태) status 표면 차이 — blind 1과 같은 patch.
  - `[reject]` (intent 검증 표면) Verification 명령이 저장소 검증일 뿐 실운영 관찰이 아님 — 이번 회차 산출물은 문서다. 실운영 관찰은 재개 AC로 남겼다. 추가 작업 지시가 아닌 기술적 차이 기록이다.
- verification-gap: "No verification gaps found."(문서 전용 diff, 렌즈의 제외 규칙).
- 후속 리뷰 판단: patch가 안전 관련 절차(launchctl disable/enable, 복구 분기, 계정 재확인)를 새로 넣었다. 그래서 patch 범위만 보는 후속 독립 리뷰 1회(Sol)를 수행한다. 결과는 다음 항목에 적는다.

### 2026-11-04 — Review pass (후속 1, patch 확인)
- 렌즈: 후속 독립 리뷰(Codex gpt-6.1-sol medium, ctx_42f490568f90). 원문은 `.brain-automation/review/review-followup.md`에 있다. 1차 patch 13항목 판정: 해결 6, 부분 4, 미해결 3. 미해결 3은 모두 frontmatter blocked이며, HALT의 `mark`로 해결하고 그 뒤 재확인한다. 1차 집계 "medium 11"은 patch 13행·reject 2행의 오기다. 1차 finding 수는 15로 유지한다.
- verdicts: 4 findings — high 0, medium 4, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` F1 enable이 계정 재확인보다 먼저라서, next_run_at이 과거인 보류 예약이 해제 즉시 발화해 미확인 profile로 첫 수집이 될 수 있음 — 확인했다: 해제 시 hold 행 삭제(`packages/postgres/src/extensions.ts:64`), 재등록은 `nextDailyOccurrence`의 미래 시각(`packages/core/src/queue/schedules.ts`). 5단계를 바꿨다: 11:00~11:30 밖에서만, 보류 예약을 먼저 remove, enable/install이 미래 시각으로 다시 등록, 곧바로 profile 재확인, 불일치·MFA면 다음 예약 전 disable. 6단계 원격 로그인은 프롬프트 진입까지만 하고, tokenstore가 바뀌면 gate를 다시 한다.
  - `[medium]` `[patch]` F2 bootout 실패·종료 불명을 B로 보내지만 B가 label 잔존을 처리하지 않음 — 복구를 실제 상태 기반 단일 절차 ①~④로 바꿨다. label이 있으면 bootstrap하지 않고, 종료 불명이면 복원하지 않고 멈춘다.
  - `[medium]` `[patch]` F3 3의 fallback(4 먼저) 뒤 실패가 복구 A 전제와 어긋남 — 3에 "fallback 뒤에는 옛 collect가 내려간 상태"를 명시했다. 복구 ②가 그 상태를 분기한다.
  - `[medium]` `[patch]` F4 보류 구간 경계의 채취 순서 결함 — 2에서 T0를 disable 전에 채취하고(이미 보류면 `brain.extensions.enabled_changed_at`), 5에서 T1을 enable 직전에 채취한다. 조회 SQL을 고정했다(work_items join, garmin 전체 kind). T0 이전부터 진행 중인 attempt는 별도로 확인한다.
- 후속 리뷰 판단: 절차를 다시 썼으므로 이 범위에 후속 리뷰 2를 한 번 더 한다.

### 2026-11-04 — Review pass (후속 2, 재작성 절차 확인)
- 렌즈: 후속 독립 리뷰 2(Codex gpt-6.1-sol medium, ctx_1fcb6247d573). 원문은 `.brain-automation/review/review-followup2.md`에 있다. F1~F4 판정: F2·F3 해결, F1·F4 부분.
- verdicts: 4 findings — high 0, medium 4, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` R1 "11:00~11:30 밖"에는 완료 여유와 마감이 없다. 예약 직전에 install하면 같은 날 11:00이 다음 발화가 된다(`packages/core/src/local-time.ts:57-63`) — 5의 시작 조건을 "그날 예약 시각이 모두 지난 뒤"로, 마감을 "다음 예약 30분 전, 넘기면 복구"로 바꿨다. 재생성 예약의 next_run_at이 마감 뒤인지 확인을 더했다.
  - `[medium]` `[patch]` R2 계정 gate 실패가 disable 후 중단으로 끝나 두 수집기가 모두 멈추고, 같은 tokenstore 탓에 옛 수집 복원도 안전하지 않다 — gate 실패를 복구로 연결했다. 복구 ③에 tokenstore profile 일치 확인을 더했다. 확인할 수 없으면 안전 정지로 두고, 운영자 재로그인을 기다리며, 수집 공백은 실패로 기록한다.
  - `[medium]` `[patch]` R3 T1 채취와 실제 해제 사이의 꼬리 구간이 집계에서 빠진다 — T1을 enable 뒤 `brain.extensions.enabled_changed_at`(실제 hold 삭제와 같은 트랜잭션, `packages/postgres/src/extensions.ts:57-65`)으로 바꿨다. 조회는 해제 뒤에 한다. AC 문구도 맞췄다.
  - `[medium]` `[patch]` R4 enable 직후 install은 auth 완료를 기다리지 않고 LOGIN_REQUIRED로 돌아온다(`packages/core/src/extensions/install.ts:180-213`) — 5(c)를 바꿨다: auth 종료를 기다리고, pending과 실패를 구별하고, 성공 뒤 install을 다시 돌려 installed·예약 2건을 확인한다. 실패·부분 예약은 복구로 간다.
- 후속 리뷰 판단: R1~R4 반영이 해결됐는지 확인하는 후속 리뷰 3을 한 번 더 한다. 이 절차는 재개 때 실제 실행 전 다시 독립 리뷰한다(재개 조건에 포함).

### 2026-11-04 — Review pass (후속 3, R1~R4 반영 확인)
- 렌즈: 후속 독립 리뷰 3(Codex gpt-6.1-sol medium, ctx_bd4cbca5a590). 원문은 `.brain-automation/review/review-followup3.md`에 있다. 판정: R1·R2 해결, R3·R4 부분, 새 결함 1.
- verdicts: 3 findings — high 0, medium 3, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` 잔여 R3: `enabled_changed_at`과 `started_at`은 호출 쪽 시각이라 실제 해제 경계가 아니다(`packages/core/src/extensions/status.ts:22-23`, `packages/postgres/src/work.ts:359-378`) — enable 직전·직후 wall-clock Ta·Tb로 바꿨다. [T0, Ta)는 0이어야 하고, 꼬리 [Ta, Tb]에는 auth만 허용한다. 수집 예약을 먼저 지우므로 해제 직후 청구될 수 있는 것은 auth뿐이다. AC와 SQL을 맞췄다.
  - `[medium]` `[patch]` 잔여 R4: `brain ext status`는 auth work outcome을 읽지 않는다. login journal은 install을 다시 돌려야 바뀐다(`packages/core/src/extensions/install.ts:180-213`) — 5(c)를 `auth_work_id`의 work·latest attempt private 조회로 바꿨다.
  - `[medium]` `[patch]` N1: 4 이전 실패 복구에서 계정을 확인할 수 없을 때, 살아 있는 옛 label을 멈추는 지시가 없다 — 복구 ③에 4의 정지 순서를 더했다. 종료가 확인될 때만 안전 정지 완료다. 복원과 ④ 성공 분기로 가는 것을 금지했다.
- 후속 리뷰 판단: 세 차례 후속 리뷰마다 더 미세한 운영 경계가 나왔다. 이번 patch는 확인하는 후속 리뷰를 거치지 않았다. 그래서 `followup_review_recommended: false`로 둔다. 이 절차는 미실행 재개 계획이므로, 재개 조건에 "실행 전 현재 코드 기준 독립 리뷰"를 둔다. 운영 전환은 이번 회차에 하지 않으므로 사용자 데이터·계정에 미치는 영향은 없다.

### 2026-11-04 — Review pass (후속 4, 후속 3 patch 확인 — 중앙 요청 msg_cf3f0c40f6b1)
- 렌즈: 후속 독립 리뷰 4(Codex gpt-6.1-sol medium, ctx_62e9f3995734). 원문은 `.brain-automation/review/review-followup4.md`에 있다. 판정: R4·N1 해결, R3 부분. 세 patch가 만든 새 결함은 없다.
- verdicts: 1 finding — high 0, medium 1, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` 잔여 R3: supervisor는 `clock.now()`를 먼저 잡고 청구 SELECT를 나중에 한다(`packages/core/src/queue/supervisor.ts:435-436`, `packages/postgres/src/work.ts:355-378`). 그래서 해제 직후의 정상 auth도 started_at이 Ta 이전일 수 있고, 시각 경계로는 구분할 수 없다 — 경계 방식을 바꿨다. 5(a)에서 보류된 auth 일감을 `brain queue cancel`로 닫는다(미청구 일감은 즉시 cancelled 완료, `packages/postgres/src/work.ts:299-305`). 미완료 garmin 일감 0을 확인한 뒤 enable한다. 이후 해제 경계에는 청구할 일감이 없으므로 [T0, Ta]는 예외 없이 0이어야 한다. 해제 뒤 attempt는 새 auth 일감의 id로 구분한다. 5(b)에서 install이 cancelled auth를 보고 새 일감을 만든다(`packages/core/src/extensions/install.ts` cancelled 분기). AC와 SQL을 맞췄다.
- 후속 리뷰 판단: 이 R3 patch만 확인하는 후속 리뷰 5를 한다.

### 2026-11-04 — Review pass (후속 5, 잔여 R3 patch 확인)
- 렌즈: 후속 독립 리뷰 5(Codex gpt-6.1-sol medium, ctx_c0b93ff5cced). 원문은 `.brain-automation/review/review-followup5.md`에 있다.
- verdicts: 0 findings — 잔여 R3 해결, patch가 만든 새 결함 없음. 근거: 미청구 auth cancel(`packages/postgres/src/work.ts:296-308`). 새 auth의 `next_attempt_at`은 enable 뒤 시각이고, 청구는 `next_attempt_at <= now`를 요구한다(`work.ts:360,371`). 그래서 Ta 이전 시각을 가진 지연 claim이 새 auth를 가져갈 수 없다.
- 후속 리뷰 판단: 이번 회차 patch의 확인은 모두 닫혔다. `followup_review_recommended: false`. 재개 조건 3(실행 직전 현재 코드 기준 독립 리뷰)은 미래 실행을 위해 유지한다.

## Auto Run Result

- 상태: **blocked**. 운영 전환·실수집을 하지 않았다. built가 아니다.
- 차단 원인: 운영 DB에 반입된 Garmin 기록이 0건이다(14.8 blocked). 지금 수집하면 core 권위 v2(INSERT 전용)가 반입 dataset 없이 영구 기록되어, 16.4 전제("반입 뒤 수집")와 에픽 Outcome에 어긋난다. 중앙 결정 msg_ac873b59896a(선택 A)가 이 판단을 정했다.
- 재개 조건: (1) 14.8 반입·verify 완료. (2) 반입 계정과 tokenstore 로그인 profile의 private 일치 확인. (3) 실행 직전 현재 코드 기준으로 이 전환 절차를 독립 리뷰. (4) 원격 push 가능 상태에서 app-ref·version commit. 그 뒤 Design Notes 1~6을 한 번 실행하고 공개 투영을 덧붙인다.
- 미충족 수락 기준: 옛 collect label 부재, 공통 예약 2건 활성, 보류 구간 청구 0, 실수집 ABI 성공·raw/건강 행 >0·"현재" view, 로그인 스킬 원격 진입. 모두 미실행이며 성공으로 세지 않는다.
- 이번 회차 운영 영향: 없음. 읽기 전용 조회만 했다. 옛 LaunchAgent, 새 쪽 보류·예약, DB, tokenstore, app-ref/version 모두 변경하지 않았다.
- 운영자·후속: frontmatter `operator_actions` 3건(14.8 반입, notice conversation 등록·설정, 재개 때 원격 push·중앙 main 반영). `deferred` 없음.
- 리뷰: thorough 1차(4렌즈, 15건) → 후속 1(4건) → 후속 2(4건) → 후속 3(3건). 모두 문서 patch로 반영했다. 마지막 patch는 확인 리뷰를 거치지 않아 `followup_review_recommended: false`(재개 조건 3).
- 검증(이 회차, 문서 전용 diff):
  - `pnpm test:changed`: 성공. 선택된 시험 없음(문서 1개).
  - `pnpm test`: 성공. 173 files, 3933 passed, 1 skipped.
  - `pnpm test:python`: 전체 실행은 성공으로 끝나지 않았다. 1·2회차: 51건 실패, 모두 설치 `role` 단계 DB_UNAVAILABLE. 원인은 공유 54329 클러스터에 남은 전역 `brain_ext_garmin` role이다(다른 시험 DB에 표식됨, 1회차는 중앙 checkout의 Python 시험과 동시 실행). 소유자를 확정할 수 없어 role은 지우지 않았다. 3회차(전용 임시 PG): 9건 실패. 새 워크트리에 `extensions/garmin/.venv`가 없어서 8건, import-verify EXTENSION_INVALID 1건이다. 4회차(전용 PG와 `uv sync --frozen` venv): 59/61 통과. 실패는 batch-import EXTENSION_INVALID 1건, normalize의 COLLECT_STOPPED/INVALID_ATTEMPT 경합 1건이다. 실패한 세 파일(batch-import, normalize, import-verify)은 단독 재실행에서 모두 통과했다(5/5, 1/1, 10/10). 회차마다 실패 시험이 다르고 16.7에 기록된 기존 불안정과 같다. 이 diff는 소스를 바꾸지 않으므로 이 티켓과 무관하다. 다만 전체 test:python을 한 번에 성공시킨 기록은 없다. 원문 로그는 워크트리 `.brain-automation/verify/`에 있다.
  - 시험이 다시 쓴 추적 파일 `extensions/garmin/tests/__pycache__/fixtures.cpython-314.pyc`는 원래대로 되돌렸다. 전용 PG 컨테이너는 정지·제거했다.
