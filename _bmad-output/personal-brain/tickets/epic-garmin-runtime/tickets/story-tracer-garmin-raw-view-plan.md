---
title: '16.1 합성 Garmin 수집 수직 경로'
type: 'feature'
ticket: 1
created: '2026-11-01'
status: done
baseline_revision: '2f5829f9beef076bb134e322f88c98e7e3c0dcbc'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**문제:** 기존 Garmin 확장은 반입만 지원한다. 실제 감독자와 Python worker로 새 raw와 정규화 건강 행을 함께 저장하는 길을 먼저 검증해야 후속 수집을 안전하게 확장할 수 있다.

**접근:** 날짜 endpoint `user_summary` 하나, 지표 `daily_metric.steps` 하나, 합성 정상 응답 하나로 coverage → client port → raw → 기존 v8 순수 계산 → 건강 INSERT → 현재 view를 잇는다. route는 워크플로에 고정된 `full`이며 첫 저장 경로의 영향 때문에 risk는 `high`다.

## Boundaries & Constraints

**항상:** `garmin.collect`를 manifest의 supervised/manual `collect`로 선언한다. worker는 ABI v1의 target·계정·시간 범위·세대·attempt와 설정 snapshot을 검증한다. 현재 감독자는 `BRAIN_ACCOUNT`를 채우지 않으므로 계정은 명시적인 account target id로 받고, optional 계정 입력이 있으면 일치시킨다. 범위는 하루로 제한하고 시간대는 선언된 snapshot 설정으로 받는다. raw는 라이브러리 객체를 `json.dumps(ensure_ascii=False)`한 문자열이며 JSONB로 재직렬화하지 않는다. 같은 계정의 모든 dataset을 보는 coverage reader와 새 수집 dataset writer를 분리한다. 외부 호출과 순수 계산은 DB 트랜잭션 밖, 현재 attempt 검사와 raw·건강·수집 상태 쓰기는 같은 2초 이하 트랜잭션이다. 기존 role 최소권한과 core 계약 INSERT만 사용한다. 원문 해시 revision·안정 dataset/보관 키는 attempt와 독립이다.

**금지:** 기존 반입 행·권위 v1·core 계약 행 UPDATE/DELETE, 확장의 일감 청구, 실계정·tokenstore·Garmin 네트워크 호출, 모델 호출, 배포·예약 전환은 하지 않는다. fake를 영속 설정만으로 열지 않는다. 인증/라이브러리 adapter는 16.2, 전수 coverage·응답 변경/NoData 전이는 16.3, 전수 정규화·권위 v2는 16.4, 실설치는 16.9 몫이다. 이번 현재 view 시험은 단일 새 dataset으로 고정하고 다중 dataset 권위 완성을 주장하지 않는다.

## I/O & Edge-Case Matrix

| 상황 | 입력·상태 | 기대 관찰 | 오류 처리 |
|---|---|---|---|
| 정상 | 격리 홈·PG, 누락된 하루, 합성 user_summary | fake 1회, raw 원문 동일, v8 steps 현재 행, progress/result와 성공 | 오류 없음 |
| 재실행 | 같은 계정·날짜의 완료 raw | coverage가 재호출을 피하고 raw·건강·수집 상태의 행 수 불변 | 새 work/attempt 이력만 증가 허용 |
| 회수 | 실제로 청구된 token을 fetch 뒤 commit 전에 회수 | worker 오류, raw·건강·수집 상태 모두 무변경 | 허용된 비재시도 오류, fallback 없음 |
| 격리 실패 | 운영 기본 홈/그 alias 또는 fixture가 아닌 DB | fake fetch·쓰기·외부 호출 모두 0 | 닫힌 실패, 비밀과 계정·응답 비노출 |

</intent-contract>

## Code Map

- `extensions/garmin/manifest.json` — 현재 import 계열만 있다. collect/manual·필요한 snapshot 키·오류를 추가하고 importer 설정은 유지한다.
- `extensions/garmin/src/tracer_import.py`, `role_probe.py` — ABI 출력·role 검사·PG timeout 예시. `batch_import.py:check`의 `garmin.attempt_valid()`를 같은 쓰기 트랜잭션에서 재사용한다.
- `extensions/garmin/migrations/0001_tracer.sql`, `0002_batch_import.sql`, `0003_raw_v2.sql` — datasets/import_batches/raw_payloads와 raw view. dataset 간 같은 계정 키는 허용되며 기존 원문 codec과 NULL identity를 존중한다. 새 DDL은 0006부터다.
- `extensions/garmin/src/health.py` — catalog mapping과 타입/factor 재사용. `import_candidates()`는 반입 전용이므로 collector로 쓰지 않는다.
- `packages/postgres/migrations/0023_health_contract.sql`~`0026_health_json_comparison.sql` — 지원 v8·저장 identity·current 최종 계약. `brain_ext_garmin`에 health SELECT를 주지 않는다.
- `apps/cli/src/daemon/supervisor.ts`, `packages/core/src/process-abi/codec.ts`, `packages/core/src/extensions/snapshot.ts` — generic supervised launch·ABI·declared snapshot. Garmin 전용 core 분기는 추가하지 않는다.
- `apps/cli/python-test/garmin-tracer.test.ts`, `apps/cli/test/ext-fixture.ts`, `pg-home.ts`, `tooling/test-db/src/index.ts` — 실제 설치·감독자·격리 홈/brain_test DB·정리 기반이다. 마이그레이션 ledger 기대가 바뀌면 기존 시험도 갱신한다.
- `_bmad-output/personal-brain/prep-garmin-absorption/inputs/garmin-source.tar.gz` — `garmin-source/src/garmin_pipeline/normalize/daily.py:user_summary`와 그 순수 helper를 재사용한다. `totalSteps` 외 여섯 필드가 필요하고 null 허용이다. SQLite coordinator는 가져오지 않는다. 버전 근거는 archive `store/__init__.py:NORMALIZE_VERSION=8`이다.

## Tasks & Acceptance

**실행:**

- [x] 1단계 — `extensions/garmin/src/collect_client.py`, `collect_normalize.py`, `collect_store.py`, 필요 시 `migrations/0006_collect.sql` — client/read/write port, archive 순수 계산, 단일 endpoint coverage와 원자적 publisher를 만든다. 새 dataset·원문 해시·안정 fetched 시각·v8 저장 identity를 지킨다. `extensions/garmin/tests/check_collect.py`로 순수 계산과 port 동작을 확인한다.
- [x] 2단계 — `extensions/garmin/src/collect.py`, `manifest.json` — snapshot·ABI 입력, progress/result/error, endpoint 경계 종료 반응을 연결한다. 운영 client가 아직 없으면 명시 오류로 닫고 합성 데이터를 기본으로 만들지 않는다. lock은 필요한 의존만 추가하며 현재 frozen Python 3.14.10/psycopg를 보존한다.
- [x] 3단계 — `extensions/garmin/tests/collect_fixture.py`, 합성 기대 fixture, `apps/cli/python-test/garmin-collect.test.ts` — 시험 전용 wrapper에서만 fake를 주입하고 동일 collect.run/store를 실제 Python worker로 실행한다. fixture가 만든 임시 home의 realpath·별도 marker와 실제 current_database 일치를 함께 검증하며 운영 기본 홈과 alias를 거부한다. 이 wrapper는 배송 manifest/운영 src에서 활성화할 수 없어야 한다. fetch 후 commit 전 barrier는 시험 fake port에서 제공한다. 기존 설치/반입 회귀도 확인한다.

**수락 기준:**

- Given 격리 fixture와 누락된 합성 하루가 있고, When 실제 daemon supervisor가 manifest collect를 실행하면, Then 새 수집 dataset의 raw UTF-8 바이트가 기대 문자열과 같고 `garmin.raw_records.key=day/<날짜>`이며 v8의 고정 기대 steps가 `brain.health_current_v1`에 보이고 진행·결과 후 성공하며 외부 네트워크 호출은 0이다.
- Given 같은 입력이 이미 성공했고, When 다른 work/attempt로 같은 collect를 실행하면, Then fake 호출 누계는 1이고 raw·건강·수집 상태의 행 수와 기존 값이 같다. 별도 계정의 legacy 완료 raw로 coverage가 동작하는 관찰도 추가한다.
- Given token A로 실제 worker가 fetch를 마쳐 barrier에 있고, When 감독자/시험의 관리 연결이 A를 회수한 후 writer를 진행시키면, Then 원자적 쓰기가 거부되고 모든 대상 저장 표가 이전 상태를 유지한다. 완료된 A의 재실행도 쓰지 못한다.
- Given 기본 운영 홈/그 symlink alias와 시험 DB 조합 또는 임시 홈과 fixture 아닌 DB 조합이고, When 시험 fake 진입을 시도하면, Then fake fetch·DB 쓰기·외부 호출이 0이고 오류 출력에 비밀·원문·계정 식별자가 없다.

## Implementation Notes

- 3단계를 같은 Orca 구현 Dispatch에서 수행했다. 별도 수집 port·v8 순수 계산·ABI worker·0006 수집 상태와 시험 전용 wrapper를 추가했다. 잠긴 Python 의존과 core 코드는 유지했다. 건강 관측 ID는 UUIDv7이다.
- 계정은 ABI account target, 하루는 range from/to, 시간대는 선언된 `garmin.timezone` snapshot으로 공급한다. 새 수집 dataset과 batch는 attempt와 독립인 안정 해시다. 시험 응답과 고정 기대값은 새 통합 시험에 함께 고정했다.
- 지휘자가 전체 diff를 확인하고 build/typecheck·Python 7건·PG 15건과 순수/ABI 검사를 직접 재실행해 모두 통과했다. 행렬 네 행은 새 통합 시험에서 모두 실행됐고 skip은 없다. 상세 로그는 로컬 임시 파일에 보관했다.

## Plan Change Log

계획과 intent-contract 변경 없이 검증 경계 두 곳을 직접 보정했다.

## Review Triage Log

### 2026-11-01 — Review pass

- verdicts: 2 findings — high 0, medium 2, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` `extensions/garmin/tests/collect_fixture.py`의 DB 검증 전 원격 접속 — 원래 `checked_fixture`는 검증되지 않은 URL로 먼저 연결했고 Python socket hook은 libpq를 막지 못했다. libpq 파라미터를 연결 전에 해석해 marker의 로컬 host·port·DB로 제한하고 query·service·hostaddr·PG 환경 우회를 거부한다. 실제 DB 재검사를 유지하고 거부 사례의 연결 시도 카운터 불변을 추가했다.
  - `[medium]` `[patch]` `apps/cli/python-test/garmin-collect.test.ts`의 실제 회수 worker 오류 관찰 누락 — 기존 시험은 관리 연결이 쓴 failed·종료·무변경만 확인했고 replay 초기 검사만 오류를 보았다. 이제 barrier에 있던 worker의 실제 emit 오류를 따로 기록해 replay 전에 `COLLECT_INVALID_ATTEMPT`와 `retryable:false`를 확인한다. 소스 수정 없이 시험 경계만 보정했다.

## Design Notes

시험 주입은 배송 설정과 분리된 wrapper를 사용한다. 운영 collector 기본 경로는 실제 adapter가 추가될 16.2까지 닫힌 실패다. 단일 dataset에서의 현재 선택은 14.2의 공개 계약으로 검증하고 권위 v2를 서둘러 구현하지 않는다. “모든 표의 행 수 불변”은 수집 소유 데이터 표에 적용하며 실행 이력은 증가한다. 작은 명세 공백에 가정이 필요하면 코드와 계획에 `[ASSUMPTION]` 및 deferred를 남기되 보안·비밀·이전 안전성 결정은 임의 가정하지 않는다.

## Verification

전제는 Node >=24.16.0, pnpm >=12, uv와 잠긴 Python 3.14.10, 시험용 PostgreSQL이다. Python suite globalSetup이 `compose.test.yaml`의 격리 PG를 준비하며 운영 DB URL을 쓰지 않는다.

**명령:**

- `pnpm build` — 전체 빌드 성공.
- `pnpm typecheck` — 시험 포함 타입 검사 성공.
- `pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-collect.test.ts apps/cli/python-test/garmin-tracer.test.ts` — 새 수직 경로·행렬 전부와 기존 설치/반입 성공, skip 없음. 새 시험 이름은 정상·재실행·회수·격리 관찰을 명시한다.
- `pnpm exec vitest run --project postgres packages/postgres/test/attempt-fence.test.ts packages/postgres/test/health-contract.test.ts` — attempt/건강 계약 회귀 성공.

시험은 `finally`에서 barrier 해제·worker reap·daemon abort/대기·store close·fixture.cleanup 순으로 정리한다. 수동 중단 때도 해당 fixture 소유 프로세스/DB만 정리하며 운영 컨테이너·홈은 만지지 않는다. 필요 시 시험 전용 서버 정리는 `docker compose -f compose.test.yaml down`이다. 공개 증거는 성공 여부·개수만 남기고 실건강값·계정·비밀은 기록하지 않는다. 지휘자가 계획 상태·검증을 소유하고 구현자는 소스/시험만 수정하며 commit·ticket done·tickets.py mark를 실행하지 않는다.


## Auto Run Result

- Status: built
- 합성 날짜 endpoint 한 건이 실제 daemon supervisor와 Python collect worker를 거쳐 새 수집 raw·v8 건강 행·현재 view로 이어졌다. 원문·재실행 멱등·회수 token 거부·fake 격리를 검증했다.
- 변경 파일:
  - `extensions/garmin/src/collect_client.py` — 네트워크 없는 기본 client와 주입 port.
  - `extensions/garmin/src/collect_normalize.py` — archive v8의 순수 user_summary 계산.
  - `extensions/garmin/src/collect_store.py` — 계정 전체 coverage와 attempt를 검사하는 원자적 raw/건강 publisher.
  - `extensions/garmin/src/collect.py` — ABI·snapshot·종료 경계와 진행/결과/오류 worker.
  - `extensions/garmin/migrations/0006_collect.sql` — 수집 성공 상태의 별도 저장.
  - `extensions/garmin/manifest.json` — supervised/manual collect와 설정·오류 선언.
  - `extensions/garmin/tests/check_collect.py` — 순수 계산·port·ABI 경계 검사.
  - `extensions/garmin/tests/collect_fixture.py` — 격리 fake·barrier·접속 경계와 오류 관찰.
  - `apps/cli/python-test/garmin-collect.test.ts` — 실제 감독자·PG의 네 행렬 및 legacy coverage 통합 시험.
  - `apps/cli/python-test/garmin-tracer.test.ts` — 새 migration ledger까지 기존 배송·반입 회귀.
  - 이 계획 — 구현·검증·리뷰·실행 결과.
- 리뷰: quick 렌즈 findings 2건, medium patch 2건 반영; high/low/false/maybe-false 0건. deferred 0건, reject 0건이다. 각 근거와 보정은 Review Triage Log에 있다.
- 후속 리뷰 권고: `true`. 첫 pass의 medium patch 두 묶음 때문에 권고한다. libpq URL·환경 파라미터 제한과 실제 오류 기록 wrapper의 추가 변경은 지휘자가 검사·재검증했으나 독립 리뷰어가 수정본을 다시 검사하지 않은 경계다.
- 검증: 지휘자가 패치 전후 `pnpm build`, `pnpm typecheck`, 계획의 Python 통합 7건과 PG 계약 15건을 모두 통과시켰다. `check_collect.py` 순수·port·ABI 검사도 통과했다. 전체 staged diff 공백 검사는 `collect_normalize.py` 말미의 추가 빈 줄 1건을 경고했으며 실행 동작에는 영향이 없다. skip은 없으며 네 행렬을 모두 실제 통합 시험에서 확인했다.
- 로그: `/tmp/brain16-final-build.log`, `/tmp/brain16-final-typecheck.log`, `/tmp/brain16-final-python.log`, `/tmp/brain16-final-pg.log`. 최종 검토 diff는 `/tmp/brain16-1-final.diff`다.
- 남는 범위: 이번 경로는 단일 endpoint·지표·정상 응답이다. 운영 client는 명시 오류로 닫혀 있고 실제 인증·전수 수집·변경 응답 전이·권위 v2·실설치는 후속 16.x가 맡는다. 이 티켓의 외부 사람 전용 작업은 없다.
- 티켓 done과 원격 push는 수행하지 않았다. 최종 완료 판정은 오케스트레이터에 남긴다.
- Orca 정리: 조사·리뷰·구현 Dispatch의 정식 성공 보고를 각각 수락하고 모두 release했다. 자기 Run의 최종 worker-list는 released 3건뿐이며 미처리 mail은 0이다. 취소할 과업·미확인 워커는 없다. 마지막 checkpoint 뒤 전용 제어 셸을 닫는다.
