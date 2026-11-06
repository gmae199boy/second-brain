---
title: '대량 첨부 반입: 일괄 SQL로 같은 행과 멱등성을 유지한다'
type: 'feature'
ticket: '4'
created: '2026-11-06'
status: 'in-review'
baseline_revision: '9a9c8d60bc8052851220b9869a737b11aa257f1b'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** `writeAttachments`는 첨부마다 SELECT/INSERT/UPDATE를 직렬 실행한다. 조사 후보7은 새 파일·위치2개 첨부1000개의 9002 SQL 왕복을 확인했다. 실제 기준 커밋에서 같은 fixture로 다시 측정해야 한다.

**Approach:** 같은 held transaction 안에서 첨부·파일·위치를 일괄 조회/삽입하고 기존 결과를 유지한다. 기존 query-perf 러너에 실제 writeAttachments 시나리오와 엄격한 비교기를 추가한다.

## Boundaries & Constraints

**Always:** 첫 첨부 승자, 멱등성, 원문 바이트, 동일 content hash의 기존 파일 ID, 기존 위치 ownership, 최초 brain home 위치를 보존한다. 외부 위치를 home으로 승격하지 않는다. 호출자의 session advisory lock과 transaction 경계를 유지한다. 성능은 같은 전용 합성 PG·fixture·러너에서 warmup1회 뒤3표본 중앙값으로 비교한다.

**Never:** schema39/과거 migration, bootstrap, 검색 metadata/순위, 원문 reader, Drive 이동, snapshot, UUID 위치 조회를 변경하지 않는다. 중앙 main/state와 운영/타 티켓 자원을 변경하지 않는다. 개발·리뷰 수정 중 시험/eval 실행 금지, 컴파일 확인만 한다. 시험·성능 임계값을 낮추거나 실패 측정을 지우지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 신규 첨부 | 새 파일과 brain/external 위치2개 | 기준과 같은 첨부·파일·위치·home 행 | transaction 실패는 전체 rollback |
| 재반입/중복 slot | 기존 또는 배치 내 같은 message/ordinal | 첫 승자 유지, linked는 실제 삽입수, 패자 파일/위치 없음 | 기존 오류 분류 유지 |
| 파일 없음 | file:null | missing_at_ingest, 파일/위치 생성 없음 | 없음 |
| 공유 파일/위치 | 같은 hash, 중복 locator, 기존 external/brain 위치 | 기존 ID/ownership/원문/최초 home 유지 | 충돌 규칙 유지 |
| 원문/경쟁 | NUL·대체문자·여러 메시지·동시 ingest/link | 원문 바이트 구분, slot 단일 승자, 잔여 패자 없음 | 없는 메시지의 기존 실패 유지 |

</intent-contract>

## Code Map

- `packages/postgres/src/attachments.ts:24` -- 공유 writeAttachments 직렬 루프. 변경 범위는 이 함수와 필요한 private helper다. 위치 read/mark 등은 유지한다.
- `packages/postgres/src/attachments.ts:225`, `packages/postgres/src/sessions.ts:390` -- linkAttachments와 ingest는 held transaction/session lock 안에서 호출한다. lock을 제거하지 않는다.
- `packages/postgres/src/text.ts` -- pgText 원문 bytea 변환 재사용.
- `packages/postgres/test/attachment-extraction.test.ts` -- 기존 NUL, 다중 메시지, link/link 및 ingest/link 경쟁 계약. `test/fixture.ts` 전용 PG fixture 재사용.
- `tooling/query-perf/{run.mjs,src/core.mjs,src/revision.mjs}` -- CLI/compare·median/hash·checkout/artifact/runner 지문 재사용. `src/session-snapshot.mjs`, `src/import-cleanup.mjs`의 격리 DB 생성/정리·실제 built 코드 로딩 선례.
- `tooling/query-perf/test/`, `tooling/test-changed/rules.mjs` -- 새 시나리오 검증과 SQL/자식프로세스 경로 선정 확인.

## Tasks & Acceptance

**Execution:**
- [x] 1. `packages/postgres/src/attachments.ts` -- held transaction 일괄 조회·삽입을 구현한다. 소수 첨부 비용과 매개변수 한도, 순서 의존 중복을 고려한다.
- [x] 2. `packages/postgres/test/attachment-extraction.test.ts` 또는 새 관련 시험 -- 위 matrix와 대량·동시성·멱등성·원문 불변의 실제 API 회귀를 작성한다. 개발 중 실행하지 않는다.
- [x] 3. `tooling/query-perf/` 및 필요 선정규칙 -- 실제 기준/변경 writeAttachments를 호출하는 1/10/100/1000 × 신규2위치/기존/파일없음 시나리오·엄격한 비교기·오류/계측 시험·README를 작성한다. 결과에는 SQL수, 전체 행/해시 및 재반입 불변, EXPLAIN, 실제 함수/fixture/러너 지문, 시각/부하/프로세스, 정리를 남긴다.

**Acceptance Criteria:**
- Given 같은 합성 fixture와 환경, when 모든12조건을 기준과 변경에서 측정하면, then 전체 결과 행이 같고 재반입이 행을 늘리지 않는다.
- Given 각1000첨부 조건, when warmup뒤3회 측정하면, then SQL수와 중앙값이 각각 기준의0.5이하이다.
- Given 각1/10첨부 조건, when 같은 절차로 측정하면, then 변경 중앙값이 기준의1.10이하이다.
- Given 구현/독립리뷰 및 필요한 수정·후속이 끝나면, when worker2로 최종 `pnpm test` → `pnpm test:python`을 순차 실행하면, then 기존/신규 첨부 시험과 전체 회귀가 통과한다. 최초 실패·처분·관련 재검증을 보존한다.

## Implementation Notes

- T11: 네채널실패의동적UUID전화번호마스킹충돌을고정비민감합성UUID fixture로교정했다(제품마스킹/rawID단언유지). 격리HOME의실제OrbStack vmcontrol/sconrpc socket 연결누락으로orb status가Stopped였고소유HOME링크복구후실제제한PATH에서Running/context/Compose검증. 전역/운영수정0,bootstrap/hook소스수정0. build/typecheck/diff0,시험미실행;독립확인후관련재검증필요. `.brain-automation/reports/fix-11.md`.

- T10최종전체회귀: TS11실패/4470통과/1skip,Python8실패/61통과(별도Python단위244통과),양쪽exit1. 최초hook OrbStack상태오류와연쇄파일부재,channels-retry4건은동적UUID가phone_number로마스킹되는rawID단언실패. 미해결을보존하고시험fixture/격리환경교정후관련재검증한다. 신규첨부/러너시험실패는없다. 로그verify-10,PG2/동적fixture187정리확인.

- T9: baseline/current lock·pg/Kysely/빌드가일치함을정적으로대조했고export함수의무거운batch본문을private helper로분리했다. 큰async함수진입비용은가설이며수치원인으로확정하지않는다. build/typecheck/diff각0,시험/추가측정미실행. `.brain-automation/reports/fix-9.md`.

- T8 승인창08:51:15.632~08:51:31.279UTC의새쌍도1/existing0.105208→0.158417ms(1.50575배)실패. 단일SQL과IndexScan은동일하고DB진단실행시간기준0.004ms/변경0.003ms여서SQL서버비용증가로설명되지않는다. JS함수준비/드라이버/RTT/표본잡음은아직분리되지않았으므로원인확정하지않는다. 전체회귀미실행. `.brain-automation/reports/verify-8.md`, 원시verify-8/유지. 추가반복없이정적분석한다.

- T7: 단일기존slot은기준과동일한SELECT후즉시0반환,새단일첨부는조회결과를재사용해중복조회하지않는다. 새/missing/다른payload패자무쓰기시험추가. build/typecheck/diff각0;실패원인확정/성능통과주장없이후속확인대기. `.brain-automation/reports/fix-7.md`.

- T6 최초실측 실패를 보존: 전체12조건 행/재반입 동등,1000세조건 통과. 1/existing0.174875→0.204958ms(1.1720배)로110%초과. 단일기존첨부도batch VALUES JOIN·배열/키를준비하며기준은단순SELECT후즉시반환한다. 이비용차와sub-ms변동을구별해원인단정은하지않고, singleton의불필요batch준비를제거하는직접교정후다시측정한다. 전체회귀미실행. `.brain-automation/reports/verify-6.md` 및 `.brain-automation/logs/verify-6/` 원문유지.
- 최초 baseline08:41:43.633~08:41:57.953UTC/change08:42:15.860~08:42:17.796UTC는중앙08:43후의창승인보다앞서므로소급승인된성능창으로표시하지않는다. 실제load/process와중앙타티켓heavy종료기록을최종대조한다. 중앙3분창08:46:32UTC만료전이미완료·반납했고새반복은미실행이다.

- T5: r2채택10행을 수정했다. 실제사전상태EXPLAIN·brain_app/origin·필수행/참조 검증·SQL계측/1000조건거부·동일청크ownership/201고유파일 시험, 유한client기한. build/typecheck/diff 각0, 시험/측정미실행. `.brain-automation/reports/fix-5.md`.

- T4: fixture 초기화만 replica/finally origin, 측정Pool 연결/statement timeout, 삭제실패/lock취소/연결실패/111%거부 시험, ANALYZE/BUFFERS 진단을 추가했다. build/typecheck/diff 각0, 시험미실행.`.brain-automation/reports/fix-4.md`。

- T3: UUID slot key의 PG 동치 표기를 정규화했고 실제 신규 ingest의 대문자/brace/4hex표기 및 후반청크 패자 무쓰기 시험, ownership/home/전체rollback을 보강했다. build/typecheck/diff 각0, 시험미실행. `.brain-automation/reports/fix-3.md`.

- Task2: 실제 built 함수의12조건 러너·strict compare·오류/계측 시험·README를 작성했다. build/typecheck/diff 각0. 시험·성능 측정 미실행. `.brain-automation/reports/implementation-2.md`.

- Task1: 200개 chunk의 slot/file/location 일괄화와 대량·중복·원문·rollback 시험을 작성했다. build/typecheck/diff 각0. 시험 미실행. 원문 `.brain-automation/reports/implementation-1.md`.

## Plan Change Log

## Review Triage Log

### 2026-11-06 — T9 helper분리 독립확인
- Sol/medium이T7대비helper분리와실제호출자·회귀를대조해계약보존/신규결함0을확인했다. `.brain-automation/reports/confirm-9.md`. 두실패와원인미확정은그대로이며새창에서한쌍검증이필요하다.

### 2026-11-06 — T7 성능교정 독립확인
- Sol/medium이기준동일단일SELECT/즉시반환·신규중복조회방지·기존계약보존을확인했다. 신규구체결함0, `.brain-automation/reports/confirm-7.md`. 최초성능실패는유지하고재측정으로판정한다.

### 2026-11-06 — T5 채택수정 독립확인
- 독립 Sol/medium이 r2채택10행을 실제스키마/권한/오류정리/시험과 대조해 모두해결·신규구체결함0을 보고했다. `.brain-automation/reports/confirm-5.md`. high0 후속수렴, 추가4렌즈 권고false. 실제성능·회귀는 아직미실행이며 다음단계 필수다.

### 2026-11-06 — r2 독립4렌즈 후속
- verdicts: 12 findings — high 0, medium 8, low 4, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` B1 EXPLAIN 사전상태 불일치 — 신규/missing 측정은 빈 slot인데 진단은 commit/replay 뒤다. 별도 진단에서 같은 사전상태를 복원하고 rowcount/단계를 기록한다.
  - `[low]` `[patch]` B2 관리자 측정역할 한계 — 기존 조사도 superuser 함수 내부 측정이지만 실제 앱역할 비용이라고 일반화하지 않는다. 측정 Pool은 준비한 brain_app으로 직접 교정하고 역할/origin을 기록한다.
  - `[medium]` `[patch]` B3 필수열 없는 양쪽증거 수락 — 현재 합성 성공시험은 빈 객체배열이라 수집오류를 거부하지 못한다. 필수열·참조를 검증하고 실제 fixture형태 및 양쪽열누락 시험을 추가한다.
  - `[low]` `[reject]` B4 클러스터ID/순차 자동검증 미비 — 실제 같은 전용 cluster와 순차실행은 지휘자의 컨테이너 정확ID·명령·시각 증거로 확인한다. 현재 비교기만으로 보장한다고 주장하지 않는다. 별도 클러스터 식별·순차분기 API 추가는 낮은 위험에 비해 복잡성이 커 미채택; 수동증거를 필수로 남긴다.
  - `[medium]` `[patch]` B5 실제 transaction 계측경계 회귀 누락 — Fake는 쿼리복원만 검사한다. 실제 DB sentinel과 BEGIN/lock/COMMIT 제외를 검증한다.
  - `[medium]` `[patch]` B6 1000 existing/missing 초과거부 누락 — new만 runs[9]으로 검사한다. 3조건×시간/SQL 각각 초과거부를 추가한다.
  - `[medium]` `[patch]` B7 같은청크 위치 ownership 충돌 첫입력 시험 누락 — 기존 시험은 앞호출의 저장위치 충돌뿐. 빈상태 external→brain/brain→external 첫 ID/ownership/home을 고정한다.
  - `[medium]` `[patch]` B8 다수 고유파일 두위치의 청크뒤 성공시험 누락 — 기존 대량성공은 공유파일1개. 201이상 고유 hash/위치/home/재반입 전체불변을 검증한다.
  - `[low]` `[reject]` E1 준비API 무한 advisory 대기 — 준비API는 기존 공용코드의 무한 migration 잠금 정책이다. 이 러너는 새 전용 cluster·새 임의DB의 유일 준비자이며 해당 잠금을 다른 연결이 보유하는 조건은 승인한 자원독점 경계 밖이다. 전역 API/취소 wrapper 확장은 일상 경로 이득보다 복잡성이 커 미채택. 환경비정상시 준비중 외부종료 정리가 필요할 수 있는 한계를 보존한다.
  - `[low]` `[patch]` E2 fixture connect 기한 없음 — 관리성공 후 별도 연결은 default0. connectionTimeoutMillis를 직접 추가한다.
  - `[medium]` `[patch]` E3 서버timeout 후 소켓응답 무기한 — 측정Pool의 client query_timeout도 유한하게 추가한다.
  - `[medium]` `[patch]` V1 1000 existing/missing 기준초과 거부 누락 — B6와 같은근본원인이나 행별보존. 3조건×2지표 실패회귀로 해결한다.
- intent-alignment 확정결함0. 실제성능/전체회귀는 미실행 필수검증으로 유지한다. high0 후속이므로 T5 패치뒤 자동4렌즈 반복은 권고하지 않되 패치 정확성에 대한 필요한 독립확인은 수행한다.
- 원문 `.brain-automation/reports/review-r2-{blind-hunter,edge-case-hunter,verification-gap,intent-alignment}.md`. patch10/reject2/defer0.

### 2026-11-06 — r1 독립4렌즈
- verdicts: 9 findings — high 1, medium 8, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` B1 fixture TRUNCATE 차단 — 0001의 no_truncate trigger가 origin에서 무조건 예외. fixture 연결 초기화만 replica로 감싸고 finally origin 복원한다.
  - `[medium]` `[patch]` B2 측정 Pool 무기한 대기 — 별도 관리 Client timeout은 Pool에 적용되지 않는다. 유한 연결·statement timeout과 실패 정리 시험을 추가한다. 양쪽 동일 설정이며 확정 측정에 기한 도달 여부를 기록한다.
  - `[medium]` `[patch]` B3 청크 경계 뒤 패자 무쓰기 검증 누락 — 기존 loser는 첫 청크 안이다. 후반 청크 중복과 파일/위치 부재를 추가한다.
  - `[medium]` `[patch]` B4 저장/입력 ownership 충돌 검증 누락 — 재반입은 winners 공집합이라 해당 분기를 실행하지 않는다. 새 slot의 기존 위치 충돌을 양방향 검증한다.
  - `[medium]` `[patch]` B5 복수 home 후보/기존 home 보존 검증 누락 — 현재 brain 후보가 하나다. 최초 후보와 기존 home 유지 시험을 추가한다.
  - `[medium]` `[patch]` B6 파일·위치 rollback 검증 누락 — 현 시험은 file:null뿐이다. 앞 청크의 세 테이블 쓰기 후 후반 실패와 전체 snapshot 불변을 검증한다.
  - `[medium]` `[patch]` B7 삭제 실패 추적 시험 누락 — beforeDrop 경로의 created:true/deleted:false와 정리 계속/복수 오류를 검증하고 시험 소유자가 정확 DB를 정리한다.
  - `[high]` `[patch]` E1 신규 대문자 message UUID의 청크 뒤 중복 slot 오인 — sessions.ts seen은 신규 message.id 원문, PG SELECT는 canonical 소문자를 반환하므로 key 불일치로 패자 파일/위치가 생길 수 있다. slot 비교를 같은 UUID 의미로 맞추고 실제 ingest 회귀를 추가한다.
  - `[medium]` `[patch]` V1 작은 입력110%초과 거부 시험 누락 — 1/10 ×3조건 각각111%만 주어 비교 결과 실패를 확인한다.
- intent-alignment: 확정 결함0. 함수 내부 시간·12균질조건·전체행 비교 해석은 후보7/재현7과 일치한다. 전체 ingest 지연 절반 또는 모든 혼합조건 성능을 주장하지 않는다. 성능·전체회귀 미실행은 미완료 필수 검증으로 유지한다.
- 원문: `.brain-automation/reports/review-r1-{blind-hunter,edge-case-hunter,verification-gap,intent-alignment}.md`. 모든9항목을 채택하며 defer/reject0. T3 제품/시험, T4 러너/비교기 시험으로 순차 수정하고 독립후속으로 확인한다.

## Verification

- 개발 중: `pnpm build`, `pnpm typecheck`, `git diff --check`만 실행한다. 의존성 다운로드가 필요한 build는 처음부터 권한 확장으로 실행한다.
- 개발 뒤: 전용 PG에서 동일 러너로 baseline archive와 변경 built artifact를 warmup1+3표본 측정하고 compare 종료0/모든 AC를 확인한다. 실패/탐색도 보존한다.
- 마지막 구현·리뷰 수정 뒤 `VITEST_MAX_WORKERS=2 pnpm test` 다음 `VITEST_MAX_WORKERS=2 pnpm test:python`을 순차 각1회 실행한다. 실패 수정 뒤에만 test:changed/관련 시험을 사용한다.
- 격리 HOME·TMPDIR·PG cluster/role·venv·산출물을 쓰며 DOCKER_HOST/전역 Docker 설정을 바꾸지 않는다. 소유 자원만 정확ID로 정리하고 부재를 확인한다. 로그는 gitignored에 저장한다.


### 개발 후 실제 검증 결과

T10의 승인된 세 번째 성능창에서 동일 전용 PG·brain_app/origin·fixture·runner로 baseline→change를 순차 측정했다. warmup1회 뒤3회 중앙값이며 모든12조건의 전체 행 동등성과 재반입 불변을 확인했다. BEGIN/advisory/COMMIT은 SQL수에서 제외하므로 조사 자료의9002와 이 표의9000은 계측 경계가 다르다.

| 첨부수/상태 | 기준 ms | 변경 ms | 기준 SQL | 변경 SQL |
|---|---:|---:|---:|---:|
| 1/new | 1.980583 | 1.366125 | 9 | 7 |
| 1/existing | 0.196125 | 0.097333 | 1 | 1 |
| 1/missing | 0.490209 | 0.308416 | 2 | 2 |
| 10/new | 10.982875 | 2.113792 | 90 | 7 |
| 10/existing | 0.804708 | 0.170458 | 10 | 1 |
| 10/missing | 1.974375 | 0.675333 | 20 | 2 |
| 100/new | 103.180584 | 9.606958 | 900 | 7 |
| 100/existing | 8.498125 | 0.626000 | 100 | 1 |
| 100/missing | 18.570958 | 2.127500 | 200 | 2 |
| 1000/new | 1018.094625 | 78.390667 | 9000 | 35 |
| 1000/existing | 94.423792 | 5.817583 | 1000 | 5 |
| 1000/missing | 213.760667 | 13.940625 | 2000 | 10 |

기준08:59:56.209~09:00:09.541UTC, 변경09:00:09.958~09:00:11.736UTC로 중앙09:04:22UTC 만료 안이다. 1000개 세 조건의 시간/SQL 각각50%이하, 1/10개 여섯 조건110%이하를 모두 충족한다. 최초117.2%와 두 번째150.575% 실패는 삭제하지 않았다. 최초 baseline은 창 승인 전이며 중앙 기록상22.3미시작·17.5/21.11heavy종료·21.7사람입력대기였지만 경합이나 실패 원인은 확정하지 않는다. private helper 분리 뒤 통과했다는 관측과 원인 가설은 구별한다. sub-ms3표본의 변동 한계도 유지한다.

최종 전체 회귀는 T10에서 worker2로 TS→Python 순차 각1회 실행했고 각각11/8건 실패했다. T11의 시험 fixture 및 격리HOME 서비스socket 교정은 Sol 독립확인에서 새 결함0이다(`confirm-11.md`). T12는 같은 worker2로 `pnpm test:changed -- 9a9c8d60bc8052851220b9869a737b11aa257f1b`(기본104파일2127통과1skip,Python16파일69통과), 일반hook(7통과1skip),Pythonhook(8통과)을 순차 실행해 모두 exit0이다. 최초19건은 관련 파일 전체 통과로 해결했다. 전체 명령의 최초 실패를 전체 통과로 덮어쓰지 않는다.

원시/EXPLAIN/행·함수·러너·artifact/lock 지문·load/process/정리는 `.brain-automation/logs/{verify-6,verify-8,verify-10,recheck-12}/`, 한국어 판정은 `.brain-automation/reports/{verify-6,verify-8,verify-10,fix-11,confirm-11,recheck-12}.md`에 보존한다. 성능 함수 SHA256 `b5fd48edd3928f5e132147a722b55160f7e67b040da80e7d2436040c3589e3b2`, runner `dde8916fafe8ee4e086eff1f59fdd2974485fef2602ab769a5011431a9b5cd99`는 T12와 동일하므로 중복 측정하지 않았다. 소유 전용 PG와 동적187개 fixture는 정확ID/label·활성0·잔여DB0 확인 뒤 제거하고 부재를 확인했다. 운영/타티켓 자원은 변경하지 않았다.
