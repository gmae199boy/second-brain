# 테스트·조회 성능 조사 — 목적, 결과, TODO, 재개 지점

기록 시각: 2026-11-04 14:08 KST / 05:08 UTC. 이 문서는 이 시점의 조사 인계 기록이며 이후 구현 상태의 원천은 티켓·Git·실제 Orca 상태다.

## 다음 세션에서 먼저 읽을 것

1. 저장소 `AGENTS.md`와 [티켓 자동화 런북](../automation/runbook.md)을 먼저 읽는다. 자동화를 다루면 최신 런북을 다시 읽는다.
2. 이 문서의 **현재 상태와 승인 범위**, **TODO**, **재개 순서**를 읽는다. 조사 결과와 최적화 구현 완료를 혼동하지 않는다.
3. 필요한 영역의 아래 상세 보고서만 읽는다. 원시 실행 계획과 반복 결과가 필요할 때 로컬 `.brain-automation/` 증거를 연다. 이 경로는 gitignored라 다른 checkout에 없을 수 있다.

**현재 결론:** 큰 원인은 하나가 아니다. 건강 판정 뷰의 불필요한 계산, 시험마다 새 DB·마이그레이션 반복, 새 폰트 캐시, 그래프 직렬 대기와 규모가 큰 세션·정리·검색에서 각각 다른 비용을 확인했다. 개선 구현은 아직 하지 않았다.

## 조사 목적과 대화에서 정한 방향

사용자는 테스트가 여전히 약 10분 걸리는 이유를 물었고, “DB를 쓴다”거나 “Python이라 그렇다”는 추상 설명이 아니라 실제 느린 구간을 확인하도록 요청했다. 이후 건강 SQL의 설계 이유·소비자, 다른 SQL·프로그램 로직·인덱스까지 Orca 워커로 조사하도록 요청했다.

처음에는 느린 정규화 시험 한 파일을 임시 계측했고, 그 뒤 설계·사용처 조사, 전반 정적 조사, SQL/테스트/Garmin의 독립 실측으로 범위를 넓혔다. 초반의 “DB 연결/프로세스 시작 때문에 느릴 수 있다”는 추정은 실측과 구분하며 최종 원인으로 채택하지 않는다.

사용자가 승인한 결정:

- 18.2(건강 분석 입력 snapshot)를 마친 뒤, 18.3 전에 별도 **18.10**으로 건강 현재값 조회 성능을 개선한다.
- 18.10은 기존 판정·snapshot 의미를 유지한다. SQL 최적화와 후보·규칙 일괄 조회 후 프로그램 판정을 비교하며 Python 전체 이식을 전제로 하지 않는다.
- 18.10에 **인덱스 사용 여부 검토·쿼리/인덱스 변경 비교·조회 효과와 쓰기 비용 검증·미변경 근거 기록**을 명시한다. 다른 기능 인덱스 전수 정비는 넣지 않는다.
- 나머지 병목도 조사한다. 이 조사 결과의 별도 티켓 등록·구현 순서는 아직 승인·확정하지 않았다. 아래 추천 순위를 실행 승인으로 해석하지 않는다.
- 최신 요청은 조사 목적·결과·TODO·진행 상황을 문서로 보존하는 것이다. 이 문서를 쓰는 일이 추가 최적화 구현이나 티켓 자동화 소유권 이전은 아니다.

## 현재 상태와 승인 범위

| 항목 | 기록 시점 상태 |
| --- | --- |
| 건강 SQL 설계·소비자 조사 | 완료, 결과 수신 |
| SQL·런타임 정적 후보 조사 | 완료, 결과 수신 |
| SQL·테스트·Garmin 추가 실측 3건 | 모두 `worker_done outcome=succeeded` 수신; 조사 Task 완료 |
| 18.10 | `planned` entry 등록, 아직 이 조사에서 구현 시작하지 않음 |
| 실행 순서 | `18.2 → 18.10 → 18.3`; 18.3의 after에 2·10·12.6 명시 |
| 그 밖의 개선 티켓 | 2026-11-04 epic 19 `epic-test-time`로 등록(아래 TODO의 등록 결과) |
| 최적화 소스 변경 | 없음. 테스트 임시 계측 6파일 원복 확인, 조사 자원 정리 보고 수신 |
| 전체 suite 전수 프로파일 | 미실시. 측정 구간을 합쳐 전체 10분을 다 설명할 수 없음 |
| 별도 티켓 자동화 | 디스크 체크포인트는 `running / building / current_ticket:18.2`, 다음 행동은 `await-ticket-result:18.2; accept and integrate then launch18.10 before18.3` |

마지막 행은 **디스크 체크포인트 관찰값**이다. 정상 실행 중인 별도 18.2 워커를 이 조사에서 live 점검·중단·재배정하지 않았다. 이 문서로 18.2 완료·중단·소유권을 단정하지 말고, 중앙 감독자는 런북 복구 절차로 실제 상태를 대조한다. 해당 `.brain-automation/state.json`은 이 조사에서 수정하지 않았다.

티켓 변경 커밋:

- `40e72f3`: 18.10 생성과 실행 순서·측정 근거 문서 등록.
- `51018bb`: 18.10의 인덱스 평가 요구 추가.
- 위 커밋은 이 채팅에서 로컬 main에 작성했다. 원격 반영 여부는 확인하지 않았으므로 push됐다고 가정하지 않는다.

티켓 원천: [epic 18 tickets.toml](../tickets/epic-health-analysis/tickets/tickets.toml), [에픽 결정](../tickets/epic-health-analysis/epic-health-analysis.md), [18.10 최초 측정 근거](../tickets/epic-health-analysis/epic-health-analysis-health-query-performance-evidence.md).

18.10의 성능 수락 기준은 동일 fixture·환경·기준 커밋을 고정하고 warm-up 뒤 3회 중앙값으로 비교하는 것이다. 좁은 현재값 조회와 기존 정규화 시험은 각각 기준 시간의 절반 이하, 전체 조회·반입 검증·18.2 snapshot은 10% 초과 회귀 없음이다. 이는 티켓 작성 시 추천으로 정해 기록한 기준이며 과거 9초/148초를 절대 상한으로 쓰지 않는다. 구현 반복은 `pnpm test:changed`, 구현 완료 커밋 직전 전체 `pnpm test`와 `pnpm test:python` 각 한 번을 순차 실행한다.

## 확정 결과 1 — 건강 현재값 판정, 18.10 범위

정규화 시험 상세 실행 147.96초에서 시험의 DB 결과 읽기 367회가 131.03초, 1초 초과 17회가 129.49초였다. 정규화 Python 프로세스 14회 합계는 약 6.57초였다. Python 계산이나 일반 연결 왕복보다 `health_current_v1`/`health_resolution_v1`의 반복 판정이 이 파일의 주요 병목이었다.

현재값 하나를 요청해도 관계없는 논리 키들까지 판정하는 실행 계획을 관찰했다. 한 표본은 관측 2,608행·판정 약 1,133행·하위 계획 93개·약 560만 shared buffer hit였다. JIT만 끄는 것은 해결이 아니었다. 관측과 판정 양쪽에 동일 논리 키 조건을 준 한 비교는 약 9초에서 0.32초로 줄고 결과가 같았다. 단, 당시 시험과 동시 실행했고 입력도 변했으므로 엄격한 고정 비교가 아니다. 일반 동등성·안정된 성능은 18.10에서 다시 검증한다.

뷰의 복잡한 **정책 자체는 필요**하다. 승인 dataset 순위 → 최신 수집 시각 → revision 충돌 → 최고 지원 정규화 버전 → 논리 값 충돌을 판정하고, 계정·시간대 미확인도 제외한다. 같은 키의 다른 원본이 경쟁하므로 dataset/revision/version을 먼저 제외해 충돌을 숨기면 안 된다. 원형 바이트 identity·NULL·날짜 없는 instant·cutoff·권위 provenance를 보존해야 한다. 정확히 현재의 CTE/상관 서브쿼리 형태를 택한 성능 이유는 기록에서 확인되지 않았다.

이 뷰는 하루치 전용이 아니다. D1/D2는 날짜가 아니라 과거 개발/운영 원본 구분이다. 설계 조사 기준에서 생산 소비자는 반입 검증 snapshot→독립 Python 기대 판정→검증 보고서·CLI였고, readHealth/SQL 집계 호출은 시험에서 확인됐다. 18.2가 추가하는 소비 경로는 병합된 코드를 새로 확인해야 한다. 그래프·일반 보고서가 모두 이 뷰를 쓴다고 일반화하지 않는다.

근거: [설계·사용처 상세](health-query-design-report.md), [최초 계측 JSON](health-query-profile-summary.json), [18.10 근거 문서](../tickets/epic-health-analysis/epic-health-analysis-health-query-performance-evidence.md).

## 확정 결과 2 — 테스트 기반

별도 PostgreSQL 18에서 실제 4파일·353 case를 warm-up 1회 뒤 3회 반복했다. 모두 통과했고 명령 wall 중앙값은 **128.785초**, DB 준비·정리 합계 중앙값은 **75.512초(약 58.6%)**였다.

| 파일 | 매 반복 DB 수 | 파일 시간 | 준비·정리 비중 |
| --- | ---: | ---: | ---: |
| sessions-ingest | 73 | 51.087초 | 30.9% |
| work-store | 167 | 40.435초 | 84.6% |
| store | 83 | 19.620초 | 87.3% |
| redaction | 39 | 14.228초 | 56.8% |

핵심은 fixture 하나가 극단적으로 느린 것이 아니라 362개의 새 DB에 전체 migration을 반복하는 누적 비용이다. 초기 migration 약 150ms/176 SQL, 이미 최신인 migration 약 22ms/118 SQL을 확인했다. no-op migration 단독의 생산 우선순위는 낮다. 안전한 fixture template·초기화 재사용 가능성은 아직 구현·비교하지 않았다.

실제 시험용 25ms daemon은 약 2.2초에 SQL 1,156회·연결 65회, 생산 기본 supervisor5초/drain10초 구성은 약 11.2초에 SQL44회·연결3회였다. 기간·구성이 달라 절대 횟수끼리 단순 비율 비교하지 않는다. 짧은 시험 polling의 부담은 확인했고 생산 유휴 루프 전체가 큰 병목이라는 주장은 입증하지 못했다.

정상 OS 프로세스 cleanup은 약 8ms로 고정 수초 대기 가설을 기각했다. redaction의 물리 삭제 검증도 무조건 생략할 비용이 아니다. bootstrap hook이 두 suite에 중복 선택되는 것은 확인했지만 실제 ref upgrade 전체 E2E와 중복 wall은 아직 미측정이다.

근거: [테스트 상세 보고](tests/report.md).

## 확정 결과 3 — Garmin

| 항목 | 측정 결과 | 후속 해석 |
| --- | --- | --- |
| 새 matplotlib 폰트 캐시 | prepare 약 10.63초; 외부 system_profiler 폰트 열거 약 9.30초 | 이 Mac의 새 home/캐시 초기화 큰 비용. 기존 캐시·프로세스 재사용과 구분 |
| 기존 캐시 | 새 프로세스 prepare 약 393ms, 같은 프로세스 약 0.03ms | 매 그래프 전체 import 가설은 기각 |
| 신규 PNG 3장+독립 DB 등록 | 약 3.325초 중 sleep3회 약 3.021초 | 직렬 확인 지연 확인. core 전체 등록 E2E나 안전한 개선 동등성 검증은 아님 |
| 완료된 그래프 캐시3장 | 약 4.31ms | 완료 캐시 자체 주병목 가설 기각 |
| 작은 로그100개 scanner | 약 5.80초 | 로그마다 Node 시작이 누적. 실제 capture의 로그 수·실행 빈도 미확인 |
| 원문 약82MB+성공 이력20만 행 | 실제 user_summary endpoint의 무변경 판정 약 457ms | 성장 비용은 있으나 이 조건에서 수초 단위 주병목 아님 |
| 현재 패키지4회 digest | 약29ms | 우선순위 낮음 |
| 파일32MiB 이중 hash / stage+fsync | 약26ms / 약16ms | 이 크기·캐시 조건에서는 주병목 아님 |
| 실제 uv 준비 | 새 project/cache 약518ms, warm49ms | 설치 때 비용. 매 수집마다 uv 실행한다고 계산하지 않음 |

폰트 cold는 새 MPLCONFIGDIR이고 OS 전체 cold를 뜻하지 않는다. 그래프 실험은 실제 PNG·실제 함수·독립 최소 DB를 썼지만 완료 등록기 연결을 합성했으므로 취소·fencing·중단 재개까지 검증한 core E2E가 아니다. 원형 검증을 없애는 개선은 허용하지 않는다.

근거: [Garmin 상세 보고](garmin/report.md).

## 확정 결과 4 — SQL·프로그램 로직·인덱스

아래는 별도 PostgreSQL18, 원문 SQL/실제 순수 함수, warm-up 뒤 3회 중앙값이다. 대부분 전체 제품 API가 아니라 명시된 workload다.

| 후보 | 큰 합성 조건의 실측 | 판단 |
| --- | --- | --- |
| 세션 snapshot 지문·검증 잠금 | 메시지10만·본문100MB, 실제 core 지문 포함 두 snapshot workload 약3.65초; 잠금 약1.86초 | 큰 세션 성능 후보. 순수 TS hash·직렬화가 큰 부분이며 메모리도 약4GiB high-water 관측 |
| 반입 정리 anti-join | 완료 이력10만·미정리100건 약1.14초 → 관련 인덱스 조합 약1.02ms, 같은 결과 | 인덱스 개선 우선 후보. 모두 cleaned 유휴는 약3.56ms로 작음 |
| 흔한 검색어 점수 계산 | 10만 후보 common chunk1.54초/tool1.74초 | 상위6개 출력이어도 후보 전체 본문 점수 계산. 검색 의미·순위 보존 필요 |
| 위치 UUID::text | 10만 행 단건5.24ms→UUID조건0.31ms, mark15.24ms→0.60ms | 국소 후보. 대문자/비UUID 입력의 결과가 달라 무조건 cast는 계약 변경 |
| 채널 최신 결과 인덱스 | 요청1만×100시도 855→621ms, ×1시도68→90ms | 특정 분포에서 악화. 무조건 인덱스 추가 금지 |
| 세션 누적 이력 재조회 | 메시지·도구 각각10만, 약84ms·JSON약21MB | 큰 세션 누적 비용. 작은 조건은 약1.5ms |
| 첨부별 직렬 SQL | 신규1천개·위치2개, 9,002 SQL 약1.02초; 기존1천개 약99ms | 대량 반입 후보. 일반 소수 첨부에 동일 시간 대입 금지 |
| 기존 조각 배열 find | 5천개 unchanged 약40ms→Map약1.6ms; changed약121ms→2.35ms | 개선 여지 있으나 큰 snapshot의 주요 CPU는 hash. 작은 배열에서는 Map이 더 느릴 수 있음 |

반입 정리 인덱스 비교는 `(source,locator)`와 `request_id WHERE cleaned_at IS NULL` 조합이다. 비교 인덱스는 조사 DB에서만 만들고 rollback했다. 쓰기 비용·운영 분포·잠금/DDL 배포 정책까지 검증한 채택안이 아니다. 검색은 기존 trigram 인덱스가 있어도 흔한 단어 후보의 점수 계산·정렬 비용이 남는다. 지문 개선은 stale 검증과 반입 경쟁 안전성을 유지해야 한다.

근거: [SQL 상세 보고](sql/report.md).

## 확정 결과 5 — 시험 runner 구성 (2026-11-04 추가 조사)

기존 보존 로그·JSON만 읽은 정적 조사이며 전체 suite를 새로 돌리지 않았다. 성공한 16.6 회귀(`.brain-automation/tickets/16.6/worktree-checkpoint-archive/`)에서 기본 suite 173파일 약 82.5초, Python suite 17파일 약 582.6초로 Vitest 구간 약 665초 중 **약 88%가 Python suite**다. 같은 기록의 파일별로는 normalize 175초, import-verify 103초, body-digest 62초, hook 39초, artifacts 39초 순이다. 두 명령의 Vitest 밖 비용은 당시 약 2초였고 두 번째 build는 약 1초 규모로 추정한다.

`apps/cli/python-test/vitest.config.ts`의 `fileParallelism: false`(4601a1e, story 14.3)는 "공유 확장 role을 사용하는 Python 파일들을 순차 실행"하기 위한 것이다. `brain_ext_garmin` 같은 확장 role은 PG cluster 전역이라 DB·home만 나눠서는 충돌한다(`packages/postgres/src/extension-provision.ts`의 역할 충돌). 그래서 slot마다 독립 PG cluster와 고유 port를 주고 slot 안에서는 순차로 재사용하는 방식이 생산 role 계약을 바꾸지 않는 우선 설계다. 성공 기록의 파일 시간을 재배치한 상한 모델은 2 slot 약 286초, 3 slot 약 192초, 4 slot 약 175초다(새 cluster 준비·경쟁·18.10 뒤 변화 미포함). `tooling/bootstrap/test/hook.test.ts`는 두 config가 모두 골라 중복되며(기본 약 48.6초, Python 약 39.3초), Python 전용 보존 case는 약 2.7초다. 기본 suite는 파일 병렬이 켜져 있다.

티켓: epic 19의 19.5(Python 병렬화), 19.6(hook 중복 제거).

## TODO — 아직 남은 작업

### 티켓·실행 계획

- [ ] **18.10 구현:** 18.2 완료·원격 main 반영을 확인한 뒤 기존 승인된 자동화 순서로 진행. 이 조사 세션이 중복 워커를 띄우지 않는다.
- [x] **추가 티켓 분할·순서 결정:** 2026-11-04 epic 19 `epic-test-time`로 등록. 실측 근거가 있는 시험 시간 스토리만 티켓이다. 사용자 결정 A에 따라 시험 시간 스토리 19.1 시험 DB 초기화, 19.2 폰트 캐시, 19.3 그래프·digest 등록 대기. 반입 정리 조회는 시험 시간 목표 밖이라 티켓에서 빼고 아래 후보로 남긴다. 추가 조사로 확인한 runner 구성은 19.5 Python 통합 시험 병렬화·19.6 hook 중복 제거로 등록하고, 시험 시간 lane을 18.10 → 19.5 → 19.6 → 19.1 → 19.2 → 19.3 → 18.3으로 바꿨다(위 "확정 결과 5"). 아래 큰 세션·검색·로그 scanner 후보와 "측정·범위의 남은 공백"은 조사가 미완료라 티켓으로 만들지 않았고, 이 문서의 TODO로 남는다. 끝나면 결과에 맞는 별도 작업으로 분류한다(epic 19는 회귀 시험 시간 전용이며 제품 성능은 그 범위 밖이다). 낮은 우선순위 후보는 epic Notes의 Parked.
- [x] **시험 DB 초기화 개선 후보:** → 19.1. fixture 격리·권한·파괴적 DDL·migration 자체 검증을 유지하면서 template/초기화 재사용을 비교. 362회 반복 비용을 줄이는 것이 목표이며 테스트 assertion 축소 금지.
- [ ] **반입 정리 인덱스 후보:** (제품 성능, 시험 시간 epic 19 밖) 규모별 동일 결과, 공유 locator 차단, 쓰기/인덱스 크기·마이그레이션·배포 잠금 비용을 검증.
- [x] **폰트 캐시 후보:** → 19.2. 새 home 시험 격리·권한·한글 glyph·환경 차이를 보존하는 캐시 초기화/재사용 방식 검토.
- [x] **그래프 등록 대기 후보:** → 19.3(digest 대기 포함). 요청 발행/완료 확인을 일괄화하는 방안 비교. 실패·재개·취소 boundary·fencing·revision 캐시 보존.
- [ ] **큰 세션 처리 후보:** 실제 core hash·snapshot 재읽기·잠금·chunk 탐색을 함께 검토. 원형 바이트·stale/redaction·동시 반입 계약 보존.
- [ ] **검색 성능 후보:** 흔한/짧은/불일치 검색어·다른 문맥·순위 동등성·결과량으로 범위 설정.
- [ ] **많은 로그 scanner 후보:** 실제 합성 파일수별 배치/재사용 비교. fail-closed·크기 제한·비밀 판정·독립 검증을 유지.
- [ ] **낮은 우선순위 후보:** 위치 UUID조건, 채널 목록, 첨부 대량 반입, 원문 재해시를 실제 빈도·규모와 함께 판단. 무조건 일괄 인덱스 추가나 광범위 재작성은 하지 않는다.

조사 기록 당시(2026-11-04 14:08 KST)의 추천 우선순위는 **18.10 → 시험 초기화 → 반입 정리 인덱스 → 폰트 캐시·그래프 대기**다. 후속 사용자 결정으로 바꿀 수 있으며, 당시에는 이 순서의 추가 티켓 실행을 승인받지 않았다. 이후 확정된 순서는 위 "추가 티켓 분할·순서 결정" 항목과 epic 19 Notes가 원천이다.

### 측정·범위의 남은 공백

- [ ] 18.10 완료 뒤 전체 회귀 시간을 다시 기록하고 잔여 느린 파일을 확인. 아직 전체 약10분을 case별·구간별로 전수 설명하지 못했다.
- [ ] 실제 stateful API의 큰 세션 chunk 생성·새 쓰기·stale/claim/redaction 경쟁을 독립 환경에서 확인. SQL workload를 전체 API 시간으로 대용하지 않는다.
- [ ] 실제 core 그래프 등록 E2E에서 렌더/등록/대기와 실패·취소·재개를 분리 측정.
- [ ] bootstrap 두 suite 중복의 실제 wall과 실제 ref upgrade E2E를 허용된 독립 자원으로 계측. 구성 비용 모델을 upgrade 전체 시간이라고 부르지 않는다.
- [ ] 실제 운영 규모·빈도를 알 필요가 생기면 사용자 범위와 공개 투영을 먼저 정한다. 현재 조사는 실계정·운영 자료에 접근하지 않았다.
- [ ] 개선 후 동일 환경·fixture·기준 커밋의 전후 비교와 계약 검증을 남긴다. 현재 비교 수치를 보장 절감량으로 약속하지 않는다.

## 워커·자원·증거 체크포인트

Orca 조사 Run은 `run_1958827f1483`이며 티켓 자동화 Run과 혼동하지 않는다. 실행 파일은 이 세션에서 선택한 Orca CLI이고, 다음 세션에서는 ORCA_CLI_COMMAND/설치 스킬 지침으로 다시 선택한다.

| 조사 | Task | Dispatch | 기록 시점 결과 |
| --- | --- | --- | --- |
| 최초 설계·소비자 | task_6c5a0f6f8112 | ctx_304aa132e544 | succeeded / exited / released |
| 정적 SQL | task_a7cab25892e2 | ctx_4ab8e0efa0d7 | succeeded / exited / released |
| 정적 runtime | task_025f3bc80d16 | ctx_9f112d1e1a54 | succeeded / exited / released |
| 상세 SQL | task_db83aab3afcf | ctx_dd151dd11306 | succeeded; liveness unverifiable; terminal reclaimable |
| 상세 tests | task_fd291bdcb571 | ctx_2945fe0d2f75 | succeeded / exited / released |
| 상세 Garmin | task_c3a1b69f8a9f | ctx_8a2c103ab3fc | succeeded / exited / released |

마지막 SQL 행에서는 Task 완료와 프로세스 종료를 구분한다. `worker_done`으로 조사 완료는 확인했지만, liveness만으로 종료·재시작·삭제를 판단하지 않는다. 추가 작업은 기존 Dispatch로 send하거나 명시적인 새 Task로 배정하며, 같은 조사를 복구 명목으로 중복 시작하지 않는다.

무거운 측정은 공통 `.brain-automation/performance-deep/locked-run.py`로 직렬화했고 잠금 대기는 측정 시간에서 제외했다. 전용 DB SQL54341·tests54342·Garmin54343은 각 워커의 cleanup 보고에서 제거 완료됐다. 공용54329는 변경하지 않았다. tests의 임시 소스 6파일은 원본 SHA 일치를 확인했다. 실행 환경·미추적 파일을 일괄 clean/reset하지 않는다.

로컬 증거 위치:

| 목적 | 저장소 상대 경로 |
| --- | --- |
| 이번 기록의 로컬 재개 체크포인트 | `.brain-automation/performance-deep/resume-checkpoint.json` |
| SQL 원시 결과·계획·재현 | `.brain-automation/performance-deep/sql/` (`results.json`, `extra-results.json`, `snapshot-exact-results.json`, `reproduce.sh`, `cleanup.json`) |
| tests 반복·원복·재현 | `.brain-automation/performance-deep/tests/` (`test-runs.json`, `summary.json`, `diagnostic.json`, `restoration.json`, `cleanup.json`) |
| Garmin 반복·고정 Python 의존·재현 | `.brain-automation/performance-deep/garmin/` (`results.json`, `node-results.json`, `extra-results.json`, `requirements.lock`, `cleanup.json`) |
| 최초 건강 SQL 계측 | `.brain-automation/test-profile/` |
| 정적 후보·최초 설계 조사 | `.brain-automation/performance-survey/`, `.brain-automation/query-research/` |

## 재개 순서

1. 이 문서와 AGENTS/runbook을 읽고 현재 Git HEAD·미커밋 변경·정식 티켓·필요한 Orca 상태를 읽기 전용으로 대조한다. 이 문서는 과거 snapshot이므로 최신 상태를 덮어쓰지 않는다.
2. 18.2/18.10 자동화는 소유권을 확인하고, 정상 진행 중인 워커를 중복 시작·병행 지휘하지 않는다. 연구 완료를 이유로 18.2를 완료 처리하지 않는다.
3. 사용자가 추가 티켓 작성을 요청하면 TODO의 분할·우선순위를 바탕으로 작성한다. 근거는 이 문서와 상세 보고서를 인용하고 로컬 gitignored 로그에만 의존하지 않는다.
4. 구현을 요청받으면 해당 티켓 범위에서 비교·계약 검증한다. 구현 방식을 Python 전체 이식·SQL 전체 폐기·인덱스 일괄 추가로 고정하지 않는다.
5. 다시 측정할 때만 독립 환경을 새로 만든다. 정리된 포트에 DB가 아직 있다고 가정하지 않는다. 다른 Orca·18.2·운영 환경이나 불명 프로세스를 삭제하지 않는다.
6. 추가 결과·등록한 티켓 번호·구현 커밋·남은 TODO를 이 문서에 반영하고 다음 컴팩션·인계를 준비한다.

## 저장 범위

같은 폴더의 `sql/report.md`, `tests/report.md`, `garmin/report.md`, `health-query-design-report.md`, `health-query-profile-summary.json`은 기존 로컬 증거에서 보존한 추적용 사본이며, 재실행이나 새로운 성능 개선의 증거가 아니다. 상세 보고서의 짧은 JSON/log 이름은 원래 `.brain-automation/...` 위치를 가리킨다. 원시 입력·대형 실행 계획·전체 환경·로그를 이 저장으로 공개 Git에 복사하지 않았다.

이번 저장에서 추가 구현·티켓 생성·자동화 state 변경·새 워커 시작은 하지 않는다. 기존 `_bmad` 스크립트와 goal-watch 관련 미커밋 변경은 다른 작업의 것으로 보존한다.
