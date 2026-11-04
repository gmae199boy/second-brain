---
title: '수집 사건 알림: 같은 날 같은 사건은 채널 발신 요청 하나로만 나가고, 확장은 Telegram을 직접 부르지 않는다'
type: 'feature'
ticket: '7'
created: '2026-11-04'
status: 'built'
baseline_revision: '75f8b7d77673c99a6bf07718955fc8feb551afb7'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      DB 진입 전·계정 확인 전 조기 종료(토큰 디렉터리 부재 LOGIN_REQUIRED, BLOCK_FILE_INVALID, 미등록 extension 초기 로그인 실패)는 collect_runs 행을 남기지 않아 수집 사건 알림도 나가지 않는다.
    evidence: |-
      extensions/garmin/src/collect.py run()의 token_path.is_dir 검사와 _run_locked의 blocked_today·초기 open_client가 put_run 이전에 raise한다(16.2/16.3부터 행 없음). 옛 Garmin은 이 경우 auth_failed/error 실행 행과 알림을 남겼다. 실행 행 기록 경계를 앞당기는 별도 작업이 필요하며, 계정 미상 경로는 사건 귀속 방식부터 정해야 한다.
    location: >-
      extensions/garmin/src/collect.py:83
    severity: medium
---

<intent-contract>

## Intent

**Problem:** 새 Garmin collect worker는 옛 `NotifyEvent` 알림(auth_failed·rate_limited·blocked_403·normalize_failed·repeated_partial·error)을 전혀 내지 않는다. 인증 만료·차단·반복 부분 수집을 사람이 알 길이 없다.

**Approach:** collect가 실행 행을 끝낸 뒤 옛 규칙으로 사건을 판정하고, garmin schema의 사건 행(`(source, account, timezone, local_date, event)` 유일)과 core `brain.channel_requests` 행을 확장 role의 짧은 트랜잭션 하나에 넣는다. 실제 발신·재시도는 core `channel_send`(epic 15)가 맡는다.

## Boundaries & Constraints

**Always:**
- 사건 판정은 옛 `collect._notify_end`·`_notify_normalize_failed`·`_abandon_running` 규칙을 따른다. 종료 상태 `auth_failed`·`rate_limited`·`blocked_403`·`error` → 같은 이름 사건(detail = 그 실행 detail). `partial`이면 `collect_coverage.day_status`로 오늘·어제가 모두 `transient=N` 포함 `partial`일 때만 `repeated_partial`(detail = 오늘 detail). `success`·`skipped_blocked`·noop·세션 lock 대기 시간 초과(`SESSION_LOCK_TIMEOUT`, DB 진입 전)는 알리지 않는다.
- `normalize_failed`: 이번 실행 시작(`started`) 이후 `garmin.normalize_items`의 `not ok` 행을 이 계정 dataset에서 endpoint 오름차순 `<endpoint>=<건수>` 공백 토큰으로 묶는다. 이전 실행의 실패만 있으면 내지 않는다. 종료 상태 사건과 별개로 같은 실행에서 함께 판정한다(noop·success·partial·중단 사건 모두).
- 직전 실행 중 attempt가 무효인 `running` 행(snapshot이 `error/abandoned`로 읽는 행)은 그 행 local_date의 `error`(detail `abandoned`) 사건이다.
- 사건 행 INSERT `on conflict do nothing`이 행을 만든 경우에만 같은 트랜잭션에서 요청을 INSERT한다. 의미 키: `producer_result_id`=사건 행 id(text), `conversation_id`=설정 `garmin.notice_conversation_id`, `purpose`=`collection-notice:<event>`, `revision`=`collection-notice-v1`. `producer`='garmin', `source_work_item_id`/`source_attempt_token`=현재 attempt. 트랜잭션은 `collect_store._write` 관례(attempt 확인·짧은 timeout)를 따른다.
- 본문은 옛 `ports.notice_text` 세 줄 형식(`[Garmin] <날짜> <event> <제목>\n<조치>\n사유: <detail or ->`)이다. detail은 상태 토큰·건수만이며 토큰·비밀·응답 본문을 담지 않는다. auth 조치 문구는 `brain ext login garmin`을 가리킨다.

**Never:**
- 확장이 Telegram HTTP·봇 토큰·chat id·`brain.channel_*` SELECT를 쓰지 않는다. core 채널 코드·마이그레이션은 바꾸지 않는다.
- report_failed(epic 18), 다른 work kind(normalize·artifacts·auth)의 알림, 토큰 디렉터리 부재 시 DB 진입 전 `LOGIN_REQUIRED`의 알림은 범위 밖이다.
- 알림 실패를 조용히 삼키지 않는다. 수집 결과(종료 코드·summary)는 알림 유무로 바뀌지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 같은 날 429 두 번 | 같은 계정·날짜에 RATE_LIMITED 실행 2회 | 사건 행 1, 요청 1, 가짜 서버 POST 1 | 두 번째는 conflict로 무요청 |
| 다음 날 같은 사건 | 다음 local_date의 429 | 새 사건 행·새 요청 | — |
| success | 모든 endpoint 성공 | 사건·요청 0 | — |
| 반복 partial | 어제 transient partial + 오늘 transient partial | repeated_partial 1 | 어제가 rejected-only거나 없으면 0 |
| normalize 실패 | 이번 실행에서 정규화 실패 2건(한 endpoint) | `normalize_failed`, detail `<endpoint>=2` | 이전 실행 실패만이면 0 |
| conversation 미설정 | `garmin.notice_conversation_id` 없음 | 사건 행·요청 모두 0, 수집 결과 동일 | 형식 오류 UUID는 `COLLECT_INVALID` |
| commit 전 kill | 사건 INSERT 직후 SIGKILL | 둘 다 rollback, 다음 실행이 한 번 생성, 인계 1 | — |
| commit 후 kill | 사건+요청 commit 직후 SIGKILL | core가 재발견해 인계 1, POST 1 | — |

</intent-contract>

## Code Map

- `extensions/garmin/src/collect.py` -- `_run_locked`의 각 종료 경로(noop `result`, `put_run` 뒤 partial raise·success result, `except GarminError`/`ValueError` 재raise 전)에서 알림 판정을 부른다. `started`(ms)가 실행 시작이다. 알림은 `put_run` 이후, raise/`result` 이전에 둔다.
- `extensions/garmin/src/collect_store.py` -- `_write`(attempt fence·dataset 확인), `coverage_snapshot`(runs의 abandoned 해석), `dataset_for` 재사용. 새 쓰기 함수는 여기 또는 새 모듈에 둔다.
- `extensions/garmin/src/collect_coverage.py:121` -- `day_status` 재사용(옛 규칙과 같다). 바꾸지 않는다. 재발견(아래 Design Notes)도 이 함수의 오늘 상태를 쓴다.
- `extensions/garmin/src/garmin_session.py:246-249` -- 운영 RATE_LIMITED/BLOCKED_403은 raise 전에 당일 `block.json`을 쓴다. 그래서 같은 날 재시도는 `collect.py`의 `blocked_today` 분기(`skipped_blocked`)로 빠진다. 이 분기에서도 계정을 알면 알림(재발견)을 부른다.
- `apps/cli/python-test/garmin-review-boundaries.test.ts` -- 기존 Python checker 실행 목록. 새 `check_collect_notice.py`를 여기에 연결해 `pnpm test:python`이 실행하게 한다.
- `.brain-automation/attempt-1.patch` -- 1차 구현 전체(리뷰 통과 부분 포함). KEEP 항목은 이 patch를 출발점으로 재적용해도 된다.
- `extensions/garmin/src/collect_settings.py` -- 새 키는 manifest 선언으로 자동 허용된다. UUID 형식 검증만 더한다.
- `extensions/garmin/manifest.json` -- `settings`에 `garmin.notice_conversation_id`(string, secret false) 추가. `collect*` work의 required_settings는 바꾸지 않는다.
- `extensions/garmin/migrations/0011_collect_notices.sql`(신규) -- `garmin.collect_notices(id uuid pk, source, account, timezone, local_date date, event check 6종, detail, created_at, work_id, attempt_token, unique(source,account,timezone,local_date,event))`, `brain_ext_garmin`에 select·insert만 grant(0010 관례).
- `packages/postgres/migrations/0017`·`0019`·`0020` -- 요청 표·의미 키 UNIQUE·확장 RLS(`current_user='brain_ext_'||producer`)·열 grant·source attempt fence. 읽기만 한다. 확장은 `on conflict` 없이 사건 gate로만 중복을 막는다.
- 옛 원문: `_bmad-output/personal-brain/prep-garmin-absorption/inputs/garmin-source.tar.gz`의 `src/garmin_pipeline/collect.py:319-395`, `ports.py:149-187`(NOTICE_TEXT). 저장소 밖 임시 디렉터리에 풀어 읽는다.
- `extensions/garmin/tests/collect_fixture.py` -- 감독자 시험용 entry. 모든 `socket.connect` 대상 주소 기록과, marker로 켜는 "사건 INSERT 직후/commit 직후 SIGKILL" 훅을 더한다. 운영 코드의 훅은 기본 무동작 hook 함수 하나로 둔다.
- `apps/cli/python-test/garmin-collect.test.ts`, `apps/cli/test/channel-fixture.ts` -- extHome 설치·daemon·marker 패턴과 가짜 Telegram 서버(`channelTestEndpoint`, `BRAIN_TELEGRAM_*`, ensureChannel/Conversation) 패턴을 재사용한다.

## Tasks & Acceptance

**Execution:**
- [x] `extensions/garmin/migrations/0011_collect_notices.sql`, `manifest.json`, `src/collect_settings.py` -- 사건 표·grant, 설정 키, UUID 검증.
- [x] `src/collect_notice.py`(신규) -- 순수 판정(종료 상태·repeated_partial·normalize 묶음·abandoned), 템플릿 v1 본문, 사건+요청 트랜잭션 쓰기와 테스트 hook.
- [x] `src/collect.py` -- 모든 종료 경로(블록 skipped_blocked 포함, 계정을 아는 경우)에 알림 호출. 알림 쓰기 실패는 `COLLECT_NOTICE_FAILED`(retryable).
- [x] `extensions/garmin/tests/check_collect_notice.py` -- I/O 행렬의 순수 판정·본문 비밀 부재 검사.
- [x] `tests/collect_fixture.py`, `apps/cli/python-test/garmin-collect-notice.test.ts` -- 실제 daemon·PG·`channel_send`·가짜 Telegram 통합 시험. fixture의 429/403은 운영처럼 당일 block 파일을 남길 수 있어야 하고(marker), kill 재시도 시험은 그 상태에서 수행한다. 가짜 서버는 POST `/bot…/sendMessage`만 센다. 추가 사례: blocked_403·auth_failed(401)의 사건·요청 1, skipped_blocked 재시도의 새 요청 0, 무효 attempt의 native running 행 → 원래 날짜 `error/abandoned` 요청 1, 알림 실패 뒤 conversation 정상화 재시도에서 원래 사건 요청 1.
- [x] `apps/cli/python-test/garmin-review-boundaries.test.ts`, `check_collect_notice.py` -- checker를 일반 시험에 연결하고, 운영 `collect.main()`이 `COLLECT_NOTICE_FAILED`를 반환 1·`retryable:true` JSON으로 직렬화하는지 run만 대체해 검사한다.

**Acceptance Criteria:**
- Given garmin 설치·설정된 conversation·가짜 Telegram, When 같은 날 429 수집을 두 번 돌리면, Then `channel_requests` 1행·가짜 서버 POST 1·요청 상태 `sent`.
- Given 위 상태, When 다음 날 429를 돌리면, Then 새 요청 1행이 더 생기고 POST 2.
- Given 운영처럼 당일 block 파일을 남기는 429와 commit 전/후 SIGKILL 훅, When 각각 수집을 죽이고 같은 날 다시 돌리면(재시도는 skipped_blocked), Then 사건 행 1·요청 1·`channel_send` 일감 1·POST 1로 수렴한다.
- Given 모든 endpoint가 성공하는 fixture, When 수집을 돌리면, Then 사건 행·요청이 0이다.
- Given 위 시험들의 연결 기록과 DB, When 시험 끝에 조회하면, Then collect 프로세스의 연결 기록에 가짜 Telegram 포트·외부 주소가 0이고, 모든 요청 body·사건 detail에 `synthetic-token-canary`가 없다.

## Implementation Notes

- 사건 행과 채널 요청은 `collect_store._write`의 같은 트랜잭션에서 삽입하고 사건 충돌 시 요청을 만들지 않는다. 알림 오류는 `COLLECT_NOTICE_FAILED`로 재시도 가능하게 전파하며 무효 attempt는 그대로 전파한다.
- abandoned 사건은 새 `collect_runs`의 무효 running 행만 대상으로 조회해 legacy import 행을 제외했다. `collect_notice.py`, 마이그레이션, 설정 검증, 종료 경로와 시험 fixture를 변경했다.
- 공유 시험 DB의 `brain_ext_garmin` 역할은 다른 시험 DB 소유 표식이 있어 새 DB에서 역할 충돌이 재현됐다. 별도 임시 PostgreSQL에서 검증했으며, 수정 후에는 패키지에 변경이 반영되도록 빌드가 필요했다.
- 리뷰 1차 보완에 따라 noop·skipped_blocked를 포함한 모든 알림 호출에서 오늘의 최신 유효 상태를 재발견한다. 운영형 block 파일 fixture로 커밋 전후 종료와 알림 오류 뒤 복구를 검사하고 checker를 일반 Python 시험에 연결했다.
- (지휘자) 리뷰 2차 patch로 재발견은 "오늘 최신 상태 하나"가 아니라 오늘 native `collect_runs` 종료 행 전체를 순회한다(legacy 보존 run 제외). 리뷰 3차 patch로 같은 날 error·auth_failed 뒤 success의 두 사건 복구 통합 사례를 더했다.

## Plan Change Log

- 2026-11-04 (지휘자, 구현 1차 diff 검토): 첫 구현이 알림 예외를 stderr로 삼켜 "알림 실패를 조용히 삼키지 않는다"를 어겼다. 해석을 고정한다 — 알림 쓰기 실패는 `COLLECT_NOTICE_FAILED`(retryable, manifest error_codes 추가)로 일감을 실패시키고 attempt 무효는 `COLLECT_INVALID_ATTEMPT`로 둔다. collect_runs 행은 이미 기록되어 수집 기록은 보존되며, 재시도는 사건 gate로 중복 요청을 만들지 않는다. 또 abandoned 판정은 legacy `preserved_rows` run을 제외하고 새 `garmin.collect_runs`만 본다(옛 import 행이 옛 날짜 error 알림을 내지 않게). 새 0011 때문에 `garmin-tracer`·`garmin-upgrade` 시험의 마이그레이션 기대값 갱신을 허용했다(0008 복원 검증은 유지). KEEP: 사건 gate `on conflict do nothing returning id` 뒤에만 요청 INSERT, 같은 `_write` 트랜잭션.
- 2026-11-04 (지휘자, 리뷰 1차 bad_plan, review_loop_iteration 1): 트리거 — 운영 429/403은 raise 전에 당일 block 파일을 쓰므로 사건 INSERT 뒤 commit 전 kill 또는 알림 쓰기 실패 뒤 같은 날 재시도가 skipped_blocked/noop으로 끝나 사건을 영구히 잃는다(intent-alignment A, blind-hunter 2, edge-case 1). 시험 fixture는 block 파일을 남기지 않아 이를 가렸다. 수정 — Design Notes에 오늘 상태 재발견, Code Map에 block 파일·checker 연결 근거, Tasks에 skipped_blocked 분기 알림·운영형 fixture·추가 통합 사례·checker 연결·main 직렬화 시험, AC의 kill 사례를 운영형으로 고쳤다. 피한 상태: 시험은 통과하나 운영에서 알림이 사라지는 상태. KEEP: 0011 표·grant, 설정 키·UUID 검증, `collect_notice.write`의 gate→요청 단일 `_write` 트랜잭션·hook 위치, `_notify_checked`의 COLLECT_NOTICE_FAILED/INVALID_ATTEMPT 처리, legacy 제외 abandoned 조회, normalize_items endpoint 묶음, 기존 통합 시험 사례 전부, tracer·upgrade 시험의 0011 갱신. 본문 문구 고침 — auth 조치는 사유 토큰 구별 없이 "`brain ext login garmin`으로 다시 로그인하거나 Garmin Connect 프로필 공개 범위를 확인한다", repeated_partial·error의 `collect.log` 안내는 실제 명령 `brain failures list`로 바꾼다. 템플릿이 바뀌었으나 아직 배포 전이므로 revision은 `collection-notice-v1` 유지.

## Review Triage Log

### 2026-11-04 — Review pass
- verdicts: 20 findings — high 3, medium 7, low 5, false 5, maybe-false 0 (blind 7, edge 4, verification-gap 3, intent 6)
- findings:
  - `[medium]` `[defer]` (blind 1) 토큰 디렉터리 부재 `LOGIN_REQUIRED`·`BLOCK_FILE_INVALID`·미등록 extension 초기 로그인 실패가 알림 경계 밖 — 이 경로들은 16.2/16.3부터 collect_runs 행 자체를 남기지 않는 기존 결손이고 사건은 실행 행에서 파생된다. 계정 미상 경로는 귀속 불가. deferred에 기록.
  - `[high]` `[bad_plan]` (blind 2) 알림 실패 뒤 재시도가 noop/skipped_blocked로 빠져 원래 사건 손실 — 운영 `garmin_session.py:246-249`의 block 파일과 `coverage.entry`의 auth_failed→noop으로 재현 경로 확인. 오늘 상태 재발견으로 계획 보완.
  - `[low]` `[reject]` (blind 3) normalize_days 날짜 집계 실패 미포함 — 옛 `normalize_result`는 항목(endpoint) 단위뿐이고 원문 의도도 "endpoint 건수"다. 날짜 digest 실패는 드물고 별도 토큰 설계가 필요해 거부, 잔여 위험으로 남김.
  - `[low]` `[bad_plan]` (blind 4) auth 조치가 도달 불가능한 token_invalid/privacy_protected 사유를 구별 — 실제 detail은 `login_required`뿐. 문구를 사유 무관 조치로 바꾸도록 계획에 반영.
  - `[low]` `[bad_plan]` (blind 5) 존재하지 않는 `collect.log` 안내 — 저장소에 해당 로그 없음 확인. `brain failures list`로 교체하도록 반영.
  - `[medium]` `[bad_plan]` (blind 6) checker가 일반 시험에 미연결 — `garmin-review-boundaries.test.ts` 목록에 없음 확인. 연결 task 추가.
  - `[low]` `[reject]` (blind 7) 만료 attempt 통합 시험 부재 — 알림 쓰기는 기존 `_write`의 attempt 확인과 0019 source fence를 그대로 쓰며 그 fence는 15.3·16.3 시험이 실제 role로 검증한다. 결함 미관찰, 새 시험만 늘어 거부.
  - `[high]` `[bad_plan]` (edge 1) auth_failed 알림 트랜잭션 실패/kill 뒤 재시도 noop으로 영구 누락 — blind 2와 같은 근본 원인.
  - `[low]` `[reject]` (edge 2) 날짜 집계 실패 미알림 — blind 3과 같음, 같은 사유로 거부.
  - `[medium]` `[defer]` (edge 3) 조기 종료 경로 무알림 — blind 1과 같은 근본 원인, defer.
  - `[false]` `[reject]` (edge 4) "결과·종료 코드 불변" 주장 위반 — Plan Change Log 1차 항목이 알림 실패 시 retryable `COLLECT_NOTICE_FAILED`를 의도된 해석으로 고정했다. 알림 "유무"는 결과를 바꾸지 않으며, 수정은 계획 문구 편집뿐이라 거부.
  - `[medium]` `[bad_plan]` (vgap 1) repeated_partial checker 미실행 — blind 6과 같은 근본 원인.
  - `[medium]` `[bad_plan]` (vgap 2) native abandoned 양성 DB 검증 부재 — mock만 있음 확인. 통합 사례 task 추가.
  - `[medium]` `[bad_plan]` (vgap 3) 운영 `collect.main()`의 COLLECT_NOTICE_FAILED 직렬화 미검증 — fixture가 자체 직렬화함 확인. main 직렬화 검사 task 추가.
  - `[high]` `[bad_plan]` (intent A) INSERT 직후 kill 복구가 block 파일 없는 가짜 재발생에 의존 — blind 2와 같은 근본 원인. fixture를 운영형으로 바꾸는 task 추가.
  - `[false]` `[reject]` (intent B) success 실행의 normalize_failed/abandoned 요청 — 옛 `collect.run`이 종료 판정 뒤 별도로 `_notify_normalize_failed`·`_abandon_running`을 부른다(아카이브 `collect.py:245,262`). 원문 "success 실행은 요청을 만들지 않는다"는 종료 사건 분류이며 의도와 일치.
  - `[false]` `[reject]` (intent C) conversation 동일성은 설정 전제 — 확장은 conversation 표를 읽을 권한이 없다(0019). 운영 조치로 기록된 채택 가정이며 결함 아님.
  - `[medium]` `[bad_plan]` (intent D) auth_failed·blocked_403·skipped_blocked 통합 경로 미실행 — 새 통합 사례 task 추가.
  - `[false]` `[reject]` (intent E) 네트워크 관찰 범위가 합성 client 경로 — 원문 검증 문장은 시험 경로의 연결 기록을 요구하고 새 알림 코드는 PG INSERT만 한다. 설명적 지적이며 결함 아님.
  - `[false]` `[reject]` (intent F) 15.1 fixture를 import하지 않음 — 같은 core `channelTestEndpoint`·daemon·`channel_send` 경로를 재사용한다. 다만 POST/경로 구분 없이 세는 점은 task에 반영(POST sendMessage만 계수).

### 2026-11-04 — Review pass (2차, 재도출 후)
- verdicts: 18 findings — high 0, medium 5, low 4, false 7, maybe-false 0 (blind 7, edge 2, verification-gap 2, intent 7) — carried 행은 1차 판정 유지
- findings:
  - `[medium]` `[defer]` (blind 1) tokenstore 부재·미등록 extension 초기 로그인 실패 무알림 — carried: 1차 deferred 항목과 같은 위치·주장, 코드도 그대로다.
  - `[medium]` `[defer]` (blind 2) 손상 block.json(`BLOCK_FILE_INVALID`) 무알림 — carried: 같은 deferred 항목(실행 행 이전 조기 종료)에 포함.
  - `[medium]` `[patch]` (blind 3) 재발견이 오늘 최신 상태만 봐 error 알림 실패 뒤 success 재시도가 앞선 사건을 덮음 — `notify`가 `coverage.day_status(오늘)` 하나만 쓰는 것 확인. 수정: 오늘 native `collect_runs`의 모든 종료 행을 순회해 종료 사건(과 transient partial의 repeated_partial)을 gate에 넣는다(옛 규칙은 실행마다 판정).
  - `[low]` `[reject]` (blind 4) normalize_days 날짜 실패 미집계 — carried: 1차 거부 사유(옛 규칙·원문이 endpoint 건수) 유지.
  - `[medium]` `[patch]` (blind 5) 재발견 상태에 legacy 보존 run이 섞임 — `coverage_snapshot`이 preserved_rows run을 합침 확인. blind 3과 같은 근본 원인, native 행 순회로 함께 해결.
  - `[low]` `[reject]` (blind 6) 병행 normalize 워커 실패가 started 이후 집계에 섞일 수 있음 — 섞여도 같은 dataset의 실제 실패를 알리는 것이고, 귀속하려면 실행 식별자 배관이 필요해 복잡도 대비 이득이 없다.
  - `[medium]` `[patch]` (blind 7) repeated_partial 실제 수집 경로 통합 시험 부재 — 수정: 이틀 연속 GARMIN_TRANSIENT 통합 사례 추가.
  - `[low]` `[reject]` (edge 1) 정규화 실패+알림 실패+차단 재시도 시 normalize_failed 유실 — Design Notes에 잔여 위험으로 명시한 범위(이번 실행 한정 사건은 재발견하지 않음). 두 장애가 겹쳐야 하고 해결에 미인계 사건 영속 저장이 필요해 거부.
  - `[medium]` `[defer]` (edge 2) 알려진 계정의 조기 종료 경로 무알림 — carried: 1차 deferred와 같음.
  - `[medium]` `[patch]` (vgap 1) noop 재진입의 auth_failed 복구 통합 검증 부재 — 수정: 401 실행+잘못된 conversation으로 COLLECT_NOTICE_FAILED 뒤 정상 conversation으로 같은 날 재시도(noop) 시 원래 auth_failed 요청 1 통합 사례 추가.
  - `[medium]` `[patch]` (vgap 2) repeated_partial 저장 결과 연결 검증 부재 — blind 7과 같은 근본 원인.
  - `[false]` `[reject]` (intent A) 무알림 종료에서 미인계 사건 인계 — carried(1차 intent B): 옛 규칙과 재발견 설계에 따른 의도된 해석.
  - `[false]` `[reject]` (intent B) 같은 날 429 두 번이 429→SESSION_BLOCKED로 시험됨 — 운영은 429 뒤 block 파일로 같은 날 재시도가 차단되므로 그것이 실제 "같은 날 두 번"이다. gate 충돌은 SQL UNIQUE+조건부 INSERT로 보장.
  - `[false]` `[reject]` (intent C) 인증 실패 발생 위치 범위 — carried: deferred 항목으로 기록됨, 새 결함 아님.
  - `[false]` `[reject]` (intent D) conversation 동일성은 설정 전제 — carried(1차 intent C).
  - `[false]` `[reject]` (intent E) 네트워크 관찰 범위 — carried(1차 intent E).
  - `[false]` `[reject]` (intent F) crash 복구가 재실행과 core 전달을 함께 사용 — 원문 최종 상태(한 번 인계)와 일치함을 리뷰어도 확인.
  - `[low]` `[reject]` (intent G) 세션 lock timeout 무요청·RLS 위반 독립 시험 부재 — lock timeout은 DB 연결 전에 raise해 알림 코드에 도달할 수 없고, RLS·fence는 15.3 시험이 검증한다. 시험만 늘어 거부.

### 2026-11-04 — Review pass (3차 후속, patch 범위)
- verdicts: 1 findings — high 0, medium 1, low 0, false 0, maybe-false 0 (edge-case-hunter 0, verification-gap 1)
- findings:
  - `[medium]` `[patch]` (vgap 1) 같은 날 여러 종류의 미인계 native 종료 사건(error·auth_failed 뒤 success) 전체 복구의 실제 SQL·인계 통합 검증 부재 — verification-gap 사전 검증 항목. 수정: 실제 DB에 해당 행을 구성하고 noop 재진입에서 두 사건·요청 각 1·POST 2를 확인하는 통합 사례 추가.

## Design Notes

채택 가정(근거 기록, 사람 판단 불필요):
- conversation은 새 설정 `garmin.notice_conversation_id`로 받는다. 확장은 `brain.channel_conversations`를 읽을 권한이 없고(0019), 옛 import 전용 `garmin.legacy_conversation_id`와 이름을 섞지 않는다. 운영 조치: 두 키에 같은 Garmin 봇·채팅 conversation UUID를 넣는다.
- 미설정이면 사건 행도 쓰지 않는다. 사건 행만 남기면 그날 gate가 소비돼 설정 뒤에도 그날 알림이 영영 나가지 않는다.
- 새 구조의 "쓰기 lock"은 `run()`의 세션 lock(DB·네트워크 전)이므로 그 timeout은 옛 write lock timeout처럼 무알림이다.
- 재발견(2026-11-04 리뷰 1차): 매 알림 호출은 현재 실행의 종료 사건과 함께 `day_status(오늘)`(skipped_blocked 제외 최신 실행)로 판정한 사건도 gate에 넣는다. 오늘의 최신 실행이 auth_failed·rate_limited·blocked_403·error면 그 사건(detail=그 실행 detail), transient partial이고 어제도 그렇다면 repeated_partial이다. gate가 중복을 막으므로 이미 나간 사건은 다시 나가지 않는다. 이로써 commit 전 kill·알림 쓰기 실패 뒤 같은 날 재시도(skipped_blocked·noop 진입 포함)가 잃은 사건을 한 번 인계한다. 범위는 오늘뿐이다(배포 직후 과거 날짜 실행이 알림을 쏟지 않게). 이번 실행 한정인 normalize_failed는 kill 뒤 재발견하지 않는다(잔여 위험).
- 날짜 사건 중복 억제는 사건 gate가, 실제 attempt 재시도(unknown·일시 실패)는 epic 15 결정이 맡는다(옛 "전송 실패 후 그날 재발신 없음"과 다르다).

## Verification

**Commands (반복 중):**
- `pnpm test:changed` -- expected: 통과(바뀐 `extensions/` 경로가 Python 통합 전체를 고른다).
- `uv run --project extensions/garmin python extensions/garmin/tests/check_collect_notice.py` -- expected: 0 종료(실제 실행 방법은 기존 check_*.py 관례를 확인해 맞춘다).
- `pnpm build && pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts garmin-collect-notice garmin-collect` -- expected: 통과.

**시험 DB 주의:** 공유 54329 컨테이너는 다른 시험 DB가 표식한 클러스터 전역 `brain_ext_garmin` role 때문에 `DB_UNAVAILABLE`이 난다. 이 티켓은 전용 컨테이너(`BRAIN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54367/postgres`)로 모든 명령을 돌렸다.

**Commands (built·커밋 직전 1회, 순차):**
- `pnpm test` -- expected: 통과.
- `pnpm test:python` -- expected: 통과.

## Auto Run Result

**요약:** Garmin collect worker가 옛 `NotifyEvent` 규칙으로 여섯 수집 사건을 판정하고, `garmin.collect_notices`(`(source, account, timezone, local_date, event)` UNIQUE) 사건 행과 `brain.channel_requests` 요청을 확장 role의 attempt-fenced 짧은 트랜잭션 하나에 넣는다. 의미 키는 (사건 행 id, `garmin.notice_conversation_id`, `collection-notice:<event>`, `collection-notice-v1`)이다. 사건 gate가 새로 생긴 경우에만 요청을 넣는다. 매 알림 호출은 오늘 native 종료 행 전체와 무효 running(abandoned)을 재발견하므로 commit 전 kill·알림 실패 뒤 같은 날 재시도(skipped_blocked·noop 포함)도 사건을 한 번 인계한다. 실제 발신·재시도는 core `channel_send`가 맡고, 확장은 Telegram을 부르거나 봇 설정을 읽지 않는다.

**변경 파일:**
- `extensions/garmin/migrations/0011_collect_notices.sql` -- 사건 표·6종 CHECK·UNIQUE gate, `brain_ext_garmin` select·insert.
- `extensions/garmin/manifest.json` -- `garmin.notice_conversation_id` 설정, `COLLECT_NOTICE_FAILED` 오류 코드.
- `extensions/garmin/src/collect_settings.py` -- conversation 설정 UUID 검증.
- `extensions/garmin/src/collect_notice.py` -- 판정·재발견·본문 템플릿 v1·사건+요청 트랜잭션·시험 hook.
- `extensions/garmin/src/collect.py` -- 모든 계정 확인 이후 종료 경로(skipped_blocked 포함)에 알림, 실패 시 retryable `COLLECT_NOTICE_FAILED`.
- `extensions/garmin/tests/check_collect_notice.py` -- 순수 판정·재발견·본문·main 직렬화 checker.
- `extensions/garmin/tests/collect_fixture.py` -- 연결 주소 기록, 운영형 block 파일, kill hook, 오류 코드 직렬화.
- `apps/cli/python-test/garmin-collect-notice.test.ts` -- 실제 daemon·PG·`channel_send`·가짜 Telegram 통합 시험.
- `apps/cli/python-test/garmin-review-boundaries.test.ts` -- checker를 일반 Python 시험에 연결.
- `apps/cli/python-test/garmin-tracer.test.ts`, `garmin-upgrade.test.ts` -- 0011 마이그레이션 기대값(0008 복원 검증 유지).

**리뷰:** thorough 4 lens 2회와 후속 2 lens 1회. 1차 20건 → bad_plan(재발견 부재, high 3)으로 코드 되돌림·계획 보완·재도출(review_loop_iteration 1). 2차 18건 → patch 3건(medium: 전체 native 행 순회·legacy 제외, repeated_partial 실제 경로 시험, noop auth_failed 복구 시험), deferred 1(조기 종료 경로, carried), 거부 low 4·false 7(사유는 Review Triage Log). 후속 3차 2건 lens → patch 1건(medium, 다중 사건 복구 통합 시험), 새 결함 0. 리뷰 원문: `.brain-automation/review-{1,2,3}-*.md`(gitignored, 중앙 보관 대상).

**후속 리뷰 권고:** `false` -- 마지막(후속) 패스는 시험만 추가한 medium 1건이며 high patch가 없다. 2차의 medium 3건 patch는 이미 후속 리뷰(3차)로 확인했다. patched 집계: 2차 medium 3, 3차 medium 1.

**검증:**
- `uv run --project extensions/garmin python extensions/garmin/tests/check_collect_notice.py` -- 통과.
- `pnpm build && pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts garmin-collect-notice garmin-collect garmin-review-boundaries garmin-tracer garmin-upgrade` -- 6파일·18시험 통과(마지막 patch 뒤 notice 파일 단독 재통과는 구현자 보고, 전체 회귀에서 재확인).
- 최종 `pnpm test` -- 172/173 파일, 3932 통과·1 실패·1 skip. 실패는 `apps/cli/test/queue-drain.test.ts`의 PG 연결 시간 초과(`Connection terminated due to connection timeout`)이며 단독 재실행 12/12 통과. 직전 회차의 `packages/postgres/test/commit-unknown.test.ts` 30초 시간 초과도 단독 3/3 통과. 이번 diff는 `packages/`·`apps/cli/test`를 바꾸지 않는다.
- 최종 `pnpm test:python` -- 17/18 파일, 60 통과·1 실패. 실패는 `garmin-import-verify.test.ts`의 기존 불안정(무작위 UUID가 출력 가리기에서 `[REDACTED:card_number]`로 바뀐 사례, 및 `EXTENSION_INVALID`로 report 없는 사례). 기준 커밋 `75f8b7d77673c99a6bf07718955fc8feb551afb7`의 임시 worktree에서 같은 사례가 6회 중 2회 같은 `EXTENSION_INVALID`로 실패해 기존 결함임을 확인했다. 새 `garmin-collect-notice` 등 이 티켓의 시험은 전체 회귀에서 통과했다.

**채택 가정:** Design Notes의 네 항목(설정 키 conversation, 미설정 시 사건도 미기록, 세션 lock timeout 무알림, 날짜 gate와 epic 15 재시도 분리)과 재발견 범위(오늘 native 행만).

**운영 조치(operator_actions):**
- `garmin.notice_conversation_id`에 기존 Garmin 봇·채팅 conversation UUID(`garmin.legacy_conversation_id`와 같은 값)를 설정해야 알림이 나간다. 미설정이면 알림은 꺼진 상태다.

**잔여 위험:**
- 이번 실행 한정 사건(normalize_failed)은 kill·알림 실패 뒤 재발견하지 않는다.
- DB 진입 전 조기 종료(토큰 디렉터리 부재, 손상 block.json, 미등록 extension 초기 로그인 실패)는 실행 행이 없어 알림도 없다(deferred).
- normalize_days(날짜 digest) 실패는 endpoint 토큰이 없어 normalize_failed에 들어가지 않는다(옛 규칙과 같음, 거부 사유 기록).
- 공유 시험 PG 54329의 교차 DB `brain_ext_garmin` role 표식과 import-verify·queue-drain·commit-unknown의 기존 불안정은 이 티켓 밖의 시험 환경 문제다.
