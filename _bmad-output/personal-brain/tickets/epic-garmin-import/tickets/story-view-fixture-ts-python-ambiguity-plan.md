---
title: '건강 의미·현재 값의 TS/Python/PG 공유 계약'
type: 'feature'
ticket: '2'
created: '2026-10-31'
status: done
baseline_revision: '77753a82c8f656d94b98057ee1ce7a83c30f1c11'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context:
  - _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md
  - _bmad-output/personal-brain/tickets/epic-garmin-import/epic-garmin-import-research-code.md
warnings: [oversized]
deferred:
  - summary: '검토 필요: [ASSUMPTION] 원본 SQL에서 단위 근거가 없는 지표는 legacy_unspecified로 보존하고 숫자 집계를 금지한다.'
---

<intent-contract>

## Intent

**Problem:** 14.1의 수치 최소형은 지표 의미·운동 구분·dataset 권위 선택이 없어 epic 16·17·18의 건강 조회 계약으로 부족하다.

**Approach:** core 마이그레이션의 버전 catalog·불변 보관 키·권위 기록·현재/ambiguity view를 완성하고, TS 순수 판정과 Garmin Python publisher 및 PG가 동일한 합성 fixture를 통과하게 한다. 공개 계약은 `packages/core/schemas/health/v1/README.md`에 고정한다.

## Boundaries & Constraints

**Always:** 출처 중립 core, 원문 해시 revision, dataset 안 fetched_at 순서, 정수 정규화 버전, 계정·시간대 provenance를 지킨다. 논리 키는 source/account/metric/운동 및 하위 identity/date XOR instant/timezone이고 보관 키에는 dataset/원래 표·키/버전/revision이 더해진다. NULL 안전 UNIQUE, 불변 행, 자기 source INSERT만의 RLS와 현재 attempt 검사를 유지한다. UUID·시각·해시·값은 작성자가 공급한다. 시험은 합성 자료와 격리 PG/홈만 쓴다.

**Never:** 적용된 0022·Garmin 0001 수정, 원본 DB migration/normalize, 실반입·수집·모델·발신·배포·push·티켓 done을 하지 않는다. 전수 reader/반입·raw 다중 dataset 보관 확장은 14.3/14.4에 남긴다.

## I/O & Edge-Case Matrix

| 상황 | 입력/상태 | 기대 동작 | 오류 처리 |
|---|---|---|---|
| 권위 | 같은 논리 키의 다른 dataset 값 | 명시 순서 우선 값만 현재, 미선택 provenance 보존 | 순서 없는 복수 후보는 ambiguity |
| 관측 | 같은 dataset의 다른 fetched_at | 최신 원문 revision 우선 후 지원 버전 선택 | 같은 시각 다른 해시는 값이 같아도 ambiguity |
| 버전·동률 | 같은 revision의 버전 1·2·10, 동일 값 중복 | 지원 목록 안 최대 정수 버전, 동일 값 한 행 | 같은 순위 다른 값은 ambiguity |
| identity | 운동·세트·시간대가 다르거나 NULL 키 재입력 | 다른 논리 측정 분리, 같은 보관 키 재입력 행 수 불변 | 같은 보관 키 다른 payload는 충돌 |
| 결측·타입 | 미확인 계정/날짜 시간대, NULL·0·음수·문자열·JSON | 미확인은 ambiguity, NULL 보존, 유효 0·음수 유지, 비수치는 숫자 집계 제외 | 날짜/순간 배타·타입·단위 위반 거부 |
| 집계·변환 | 허용 sum/mean, 분→초·kg→g, 분류 평균 | 비모호 현재 숫자만 집계, 명시 배율 | 금지 집계는 HEALTH_AGGREGATION_NOT_ALLOWED |
| 권한·업그레이드 | 0022 기존 행/role, 새 role, 다른 source·회수 token | 0023 적용 후 기존 값·최소 권한 유지 | 금지 쓰기·UPDATE/DELETE 거부 |

</intent-contract>

## Code Map

- `packages/postgres/migrations/0022_import_contracts.sql`: 기존 건강 표·health_current_v1·guard_import_attempt·reject_import_mutation. 수정하지 않고 신규 `0023_health_contract.sql`로 확장한다. 현재 CORE_SCHEMA_VERSION=22.
- `packages/postgres/src/{migrate,extension-provision,imports}.ts`: 버전 23, 기존/신규 role의 허용 열 감사 및 GRANT 양쪽, readHealth view 조회 재사용. 공개 view의 기존 열 순서·타입을 보존한다.
- `packages/core/src/ports/import-store.ts`, `src/index.ts`: 기존 readHealth 호출 유지, 출처 중립 타입·집계 판정을 공개한다. `ports/store.ts` HealthStore는 DB 상태 검사이며 다른 계약이다.
- `extensions/garmin/src/import.py`: 첫 daily steps tracer, profile id 확인·원문 UTF-8 hash·원래 fetched_at·meta 버전·2초 트랜잭션·파일/분석 인계 유지. 부작용 없는 `health.py` publisher를 연결한다. cross-dataset raw는 아직 명시 충돌이다.
- `packages/core/{schemas,fixtures}/extensions/v1/`: 공유 자료 배포 선례. 건강 자료는 같은 package의 `health/v1/`에 둔다.
- `packages/postgres/test/{import-contracts,migrate,schema,store,extension-permissions}.test.ts`: 현재 권한·불변성·시간대·버전 검증 선례. 열 목록 없는 INSERT SELECT는 새 열 추가 시 명시 열로 보완한다.
- `apps/cli/python-test/garmin-tracer.test.ts`, `extensions/garmin/tests/fixtures.py`: exact Python 3.14.10 frozen 설치·실제 감독자·schema10/15 합성 회귀. 기존 raw·비발신·staging 보호를 유지한다.
- 옛 지표 근거는 고정 archive와 연구 §1·4, `~/github/garmin/src/garmin_pipeline/store/migrations/0006~0016`의 SQL 주석이다. 개인 DB를 읽지 않는다.

## Tasks & Acceptance

**Execution:**
- [x] 단계 1 — `packages/core/src/domain/health.ts`, `src/index.ts`, `schemas/health/v1/{catalog.json,README.md}`, `fixtures/health/v1/current.json`, `test/health.test.ts` — 타입·단위·NULL·집계·선택 계약과 독립 기대표를 만든다. daily·sample·activity·set·legacy recovery·schema16 지표를 원래 열별 mapping과 명시 배율로 포함한다.
- [x] 단계 2 — `packages/postgres/migrations/0023_health_contract.sql`, `src/{migrate,extension-provision,imports}.ts`, `test/health-contract.test.ts` 및 위 Code Map의 버전/권한 회귀 — catalog seed·typed 값·운동/하위 identity·보관키, 권위 기록·resolution/current view 및 허용 집계 경로를 구현한다. 동일 fixture를 PG로 재현하고 SQL catalog와 JSON을 대조한다.
- [x] 단계 3 — `extensions/garmin/src/{health,import}.py`, `tests/check_health_contract.py`, 필요시 `apps/cli/python-test/garmin-tracer.test.ts` — 공유 fixture의 Python 판정·publisher 변환과 실제 tracer 연결을 구현하고 전체 회귀를 검증한다. 외부 의존은 더하지 않는다.

**Acceptance Criteria:**
- Given 동일 합성 fixture와 손으로 만든 기대표가 있을 때, When TS·Python·PG 시험을 실행하면, Then 현재 값·ambiguity 사유·허용 집계 및 고정 오류가 모두 같은 기대와 일치한다.
- Given NULL 키·운동/하위 identity와 여러 dataset/revision/버전이 있을 때, When PG에 재입력하고 권위 규칙으로 조회하면, Then 행 수는 늘지 않고 우선 dataset·최신 revision·최대 지원 정수 버전이 현재이며 이전 값은 보관된다.
- Given 같은 dataset·fetched_at의 다른 원문 해시 또는 같은 최종 순위 다른 값이 있을 때, When current와 resolution 및 기본 합계/평균을 읽으면, Then ambiguity와 관련 provenance가 보이고 해당 값은 집계에서 빠진다.
- Given 미확인 계정·문자열·JSON·분류 지표가 있을 때, When 현재 조회·수치 집계·금지 평균을 요청하면, Then 미확인은 현재가 아니며 비수치는 숫자 집계에서 빠지고 금지 요청은 HEALTH_AGGREGATION_NOT_ALLOWED다.
- Given 0022의 행과 기존 role 및 나중에 설치한 role이 있을 때, When 0023 업그레이드·재실행·실제 Python tracer를 실행하면, Then 원문·NULL·버전·시간대·멱등성·RLS·attempt·비발신 회귀가 유지된다.

## Implementation Notes

- 최종 리뷰 전 독립 검증: build/typecheck, core 24개·공유 Python 선택 18건/집계 4건·PG 123개가 성공했다. 기본 전체 재실행 중 기존 설치 취소 PID 대기 시험 1개가 10초 timeout으로 실패했다. 해당 파일 12개와 전체를 무변경 재실행해 기본 3885개(선택 Python 1개 skip), 전체 Python 14개가 성공했다. 최초 실패 로그는 보존하며 근본 원인은 미확정이다. SQL seed와 JSON catalog 108개 정의의 완전 동등성도 직접 확인했다.

- 단계 3과 독립 검증: 설치된 Python publisher가 읽기 전용 SQL catalog를 사용한다. 계획의 7개 명령을 지휘자가 독립 실행해 모두 성공했다(기본 3882개·선택 Python skip 1개, 전체 Python 14개·PG 123개·core 21개). 추가 반례에서 Python의 1/1.0 동등성 불일치를 발견해 숫자·JSON 내부 동등 및 boolean 구별 3개 공유 사례를 추가했다. 수정 후 보고는 core 24개·Python 14개·PG 건강 계약 성공이며 재독립 검증을 수행한다.

- 단계 2: 0023의 catalog 정본·typed 값·운동/하위 키·권위 scope·resolution/current·집계와 기존/신규 role 권한을 구현했다. 지휘자가 migration·회귀 diff를 직접 확인하고 초기 지원 버전 누락을 찾아 1·2·8로 보완했다. JSON scalar 거부·미확인 계정 flag·원문/값 ambiguity의 실제 current 및 sum/mean 제외를 추가했다. core 21개·PG 123개·타입 검사 성공 보고를 받았다. 전체 독립 검증은 단계3 뒤 수행한다.

- 단계 1: 공개 타입·108개 지표 catalog·14개 선택 및 4개 집계 공유 기대를 만들었다. 최초 14시험 성공 뒤 지휘자 대조에서 시각 문자열 순서·다른 지표 혼입·NULL 의미와 알려진 단위 누락을 찾아 보완했다. 보완 후 core 20시험·전체 타입 검사가 성공 보고되었고 시간/지표 필터·catalog 원문을 직접 확인했다. PG·Python 동등성은 다음 단계에서 검증한다.

## Plan Change Log

## Review Triage Log

### 2026-10-31 — Review pass
- verdicts: 3 findings — high 0, medium 3, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` SQL NULL 연산이 허용 검사를 우회해 평균을 반환했다 — NULL IF의 3값 논리와 ELSE avg 도달을 확인했다. operation IS NULL 직접 거부와 허용/금지 지표의 NULL 오류 회귀로 교정했다.
  - `[medium]` `[patch]` 같은 보관키 동시 입력이 동일 payload에도 UNIQUE 오류가 났다 — 기존 조회/INSERT 사이 직렬화가 없고 attempt fence는 공유 잠금뿐임을 확인했다. 해당 보관키의 advisory 트랜잭션 잠금 한 줄을 추가하고 두 연결의 실제 대기를 동기화해 동일 payload 양쪽 성공·1행, 다른 payload 충돌·1행을 검증했다.
  - `[medium]` `[patch]` 공유 집계 fixture의 논리 키·metric·unit이 시험마다 달랐다 — 원래 평균 사례는 같은 논리 키인데 TS가 단건 resolve하고 PG가 sub_identity와 타입을 바꿨다. fixture 자체의 독립 identity·정당한 타입을 명시하고 세 시험을 동일 입력의 키별 현재 판정→집계로 교정했다. 원문/값 ambiguity의 합계·평균 기대는 모두 4로 손 계산했다.
- 세 수정은 새 공개면 없이 기존 조건·기존 키 조회·합성 입력/시험을 직접 교정하므로 patch로 처리했다. 새 상태나 미관찰 경로를 추가하지 않았다. 그룹화 없이 세 근본 원인을 각각 기록했으며 defer/reject는 없다.


## Design Notes

- catalog의 정본은 core migration 데이터다. JSON은 배포 가능한 공개 투영이며 PG 시험이 완전 동등성을 확인한다. 원래 열 mapping·NULL의 손실된 원인과 legacy 삭제 이력을 문서화한다.
- `health_current_v1`은 기존 호출을 유지하고 `health_resolution_v1`은 ambiguity·규칙 버전·선택/미선택 provenance를 제공한다. 기존 숫자 value를 유지하고 typed 열·catalog version·activity/sub identity를 추가한다.
- 권위 기록은 core가 소유한 불변 규칙 revision으로 source/account 및 선택 metric/운동/날짜 범위를 명시한다. dataset 순서는 호출자가 명시하며 v1의 D2→D1→D4→D5→D3 의미를 문서화한다. 확장이 권위를 임의 UPDATE하지 못한다. 승인 기록 없는 단일 dataset은 tracer 호환으로 허용하고 복수는 ambiguity다. 규칙 밖 dataset은 자동 보완하지 않는다.
- 지원 정규화 버전은 명시 목록으로 소비자가 전달하고 SQL 계약에도 저장한다. 미지원 버전은 현재 후보에서 제외한다. 원문 revision 동률 ambiguity를 버전 선택으로 가리지 않는다.
- 같은 관측·같은 typed 값의 동률만 하나로 축약한다. 대표 ID의 안정 정렬은 최신성 의미가 없다. NULL은 0이 아니며 빈 수치 집합의 sum/mean은 null이다.
- [ASSUMPTION] SQL에서 단위를 확인하지 못한 지표는 `legacy_unspecified`로 보존하고 집계를 금지한다. 임의 의학 단위로 바꾸지 않는다. 같은 설명을 코드 주석과 catalog 근거에 남긴다.

## Verification

**Commands:**
- `pnpm build` — 전체 빌드 성공.
- `pnpm typecheck` — 전체 타입 검사 성공.
- `pnpm exec vitest run --project core test/health.test.ts` — 공유 fixture·독립 기대표·변환 행렬 실행 성공.
- `uv run --project extensions/garmin --frozen --python 3.14.10 python extensions/garmin/tests/check_health_contract.py` — 동일 fixture Python 판정·publisher 변환 성공.
- `pnpm exec vitest run --project postgres test/health-contract.test.ts test/import-contracts.test.ts test/migrate.test.ts test/schema.test.ts test/store.test.ts test/extension-permissions.test.ts` — 동일 fixture PG·NULL 멱등·권한·0022 업그레이드 성공.
- `pnpm test` — 기본 suite 회귀 성공.
- `pnpm test:python` — 실제 설치·감독자·tracer와 전체 Python suite 성공, 신규 계약 시험 skip 없음.

PG18은 기존 globalSetup·격리 DB helper를 쓰고 매 시험의 finally에서 client/store/DB/자기 marker role·임시 홈을 정리한다. 운영 DB/홈·private capture를 쓰지 않는다. Python 3.14.10은 사전 설치본을 frozen으로 사용한다. 공개 계획에는 개인 값·원문·해시·절대 홈 경로 없이 시험 건수·성공 여부만 남긴다.

## Auto Run Result

Status: built

- 구현: core migration 0023의 108개 지표 catalog와 typed 관측·운동/하위 identity·NULL 안전 보관키, 불변 권위 기록, 현재/ambiguity view 및 허용 집계를 완성했다. TS·Python·PG는 공유 선택 18건·집계 6건을 같은 입력과 독립 기대값으로 대조한다. 설치된 Python publisher가 읽기 전용 정본 catalog를 사용한다.
- 리뷰: quick 렌즈 1개를 실행했다. medium 3건을 각각 patch했으며 high 0·low 0, 새 defer 0·reject 0이다. SQL NULL 연산 거부, 동일 키 동시 입력 직렬화, 공유 집계 입력의 의미 보존을 교정했다. 기각한 finding은 없다. 기존 단위 미확인 ASSUMPTION 한 항목은 frontmatter에 보존한다.
- 후속 검토: `followup_review_recommended: true`. 이번 pass의 patch는 high 0·medium 3·low 0이다. 동일 보관키의 두 연결 경쟁은 시험했으나, 여러 키를 반대 순서로 반입하는 경우의 advisory 잠금 경합은 별도 확인하지 않았다. 수정된 동시 입력과 공통 집계 파이프라인의 추가 독립 검토를 권장한다.
- 최종 검증: Verification의 7개 명령을 지휘자가 모두 실행해 성공했다. build/typecheck, core 26개, 공유 Python 선택 18건·집계 6건 및 변환, PG 123개, 기본 suite 3887개(기존 선택 Python 1개 skip), 전체 Python suite 14개(skip 없음)가 통과했다. 최종 명령·상태·로그 인덱스는 `/tmp/brain142-final-results.json`이며 로그는 `/tmp/brain142-final-*.log`다.
- 행렬 감사: 권위·관측·정수 지원 버전·보관키·운동/세트/날짜/시간대 분리·미확인 계정·typed NULL·허용/금지 집계·명시 변환·기존/신규 role·attempt·0022 업그레이드를 core/공유 Python/PG/설치 tracer 시험에서 실행했다. 추가로 원문·값 ambiguity의 실제 sum/mean 제외와 동일/다른 payload 동시 입력을 관찰했다. SQL seed와 JSON catalog의 108개 정의도 완전히 같다.
- 검증 중 관측: 리뷰 전 전체 실행에서 변경하지 않은 설치 취소 시험의 자식 PID 대기 10초 timeout 1건이 있었다. 소스 무변경 단독 12개와 전체 재실행이 통과했고, 리뷰 보완 뒤 마지막 전체 실행도 통과했다. 최초 로그 `/tmp/brain142-before-review-default.log`와 재실행 로그를 보존한다. 비결정성의 근본 원인은 미확정이다.
- 잔여 범위: 단위 근거 없는 지표는 `legacy_unspecified`로 보존하며 집계를 금지한다. 전수 reader·반입·다중 dataset raw 보관·실데이터 확인은 원래 후속 티켓의 범위다. 저장소 밖 운영자 작업은 없다.
- 티켓 done 표시·`tickets.py mark`·push는 실행하지 않았다. 오케스트레이터가 별도 검증 후 티켓 완료를 결정한다.

변경 파일과 역할:

- `_bmad-output/personal-brain/tickets/epic-garmin-import/tickets/story-view-fixture-ts-python-ambiguity-plan.md` — 계획·단계 검증·독립 리뷰 triage·종료 근거를 기록한다.
- `packages/core/src/domain/health.ts` — typed 관측·선택·ambiguity·허용 집계의 출처 중립 타입과 순수 함수를 공개한다.
- `packages/core/src/index.ts` — 건강 계약 export를 추가한다.
- `packages/core/schemas/health/v1/catalog.json` — 정본 SQL catalog의 지표별 단위·NULL·원본 열·배율·집계 투영을 배송한다.
- `packages/core/schemas/health/v1/README.md` — 후속 에픽이 소비하는 SQL·TS·Python 공개 이름과 의미를 고정한다.
- `packages/core/fixtures/health/v1/current.json` — 독립 선택·집계 기대값과 경계 입력을 공유한다.
- `packages/core/test/health.test.ts` — TS 판정·검증과 논리 키별 현재 값의 집계를 대조한다.
- `packages/postgres/migrations/0023_health_contract.sql` — catalog·typed 값·보관키·지원 버전·권위·view·집계·동시 멱등성을 확장한다.
- `packages/postgres/src/migrate.ts` — core 스키마 버전을 23으로 올린다.
- `packages/postgres/src/extension-provision.ts` — 기존/신규 role의 typed INSERT·정본 catalog SELECT와 초과권한 감사를 맞춘다.
- `packages/postgres/test/health-contract.test.ts` — 동일 fixture·실제 집계·키 분리·동시 입력을 PG로 검증한다.
- `packages/postgres/test/import-contracts.test.ts` — 새 typed 열과 기존 출처·attempt·불변 권한을 확인한다.
- `packages/postgres/test/migrate.test.ts` — 0022 기존 행·role과 checksum을 보존하는 0023 업그레이드·재실행을 확인한다.
- `packages/postgres/test/schema.test.ts` — 새 계약 표와 명시적 기본값을 확인한다.
- `packages/postgres/test/store.test.ts` — 최신 core 스키마 기대값을 갱신한다.
- `packages/postgres/test/work-store.test.ts` — 최신 스키마에서 기존 감독 복구를 검증한다.
- `extensions/garmin/src/health.py` — 독립 Python 선택·동등성·검증·집계·publisher 변환을 구현한다.
- `extensions/garmin/src/import.py` — 실제 tracer의 steps 게시에 정본 catalog와 변환을 연결한다.
- `extensions/garmin/tests/check_health_contract.py` — 동일 입력의 Python 현재 판정·집계·변환을 검사한다.
- `apps/cli/python-test/garmin-tracer.test.ts` — 설치된 모듈의 공유 fixture와 실제 publisher 경로를 확인한다.
- `apps/cli/test/install.test.ts` — 실제 설치의 스키마 23을 확인한다.
- `apps/cli/test/setup.test.ts` — setup·doctor의 최신 스키마 기대값을 갱신한다.

정리 결과: 자기 Orca Run의 조사·구현·quick 리뷰 워커 3개의 정식 succeeded 보고 전문을 수락하고 모두 release했다. 전체 목록은 completed/released 3개이고 다음 페이지·reclaimable·미처리 mail은 없다. 과업 취소·강제 종료·중복 구현자는 없었다. 제어 셸의 다중행 입력 미제출은 명령 파일 전달로 복구하고 동일 요청의 등록을 확인했다. 전용 제어 셸은 최종 체크포인트 뒤 마지막에 닫는다.
