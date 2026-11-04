# 건강 현재값 조회 성능 — 18.10 입력 근거

## 사용자 결정과 범위

2026-11-04 이 대화에서 사용자는 느린 테스트의 원인을 조사하도록 요청했다. 병목을 계측한 뒤 SQL의 설계 이유와 사용처를 Orca 워커로 조사했고, 18.2(입력 snapshot) 완료 뒤 18.3 전에 별도 성능 개선 티켓을 만들도록 요청했다. 티켓은 18.10이다.

18.2의 입력 snapshot 요구(E18-1)와 기존 건강 판정 의미는 유지한다. SQL 최적화와 후보·규칙 일괄 조회 후 공통 프로그램 판정을 비교하고 실제 개선을 구현한다. Python 전체를 TypeScript로 이식하거나 수집 빈도·분석 정책을 바꾸는 요청은 아니다. 이 문서는 조사 근거이며, 인수 기준의 원천은 18.10 entry의 description·verify·notes다.

## 측정 근거

이 채팅에서 합성 데이터 전용 PostgreSQL 18 컨테이너와 임시 계측으로 정규화 시험 한 파일을 측정했다. 공용 시험 컨테이너의 확장 role 준비 실패를 발견해 별도 컨테이너로 격리했고, 측정 뒤 소스 계측은 원복하고 임시 컨테이너는 제거했다. 실제 계정·건강 자료는 사용하지 않았다.

| 측정 | 관찰값 |
| --- | --- |
| 정규화 시험 상세 계측 실행 | 147.96초, 1파일 1시험 통과 |
| 시험의 DB 결과 조회 367회 누적 | 131.03초 |
| 그중 1초 초과 조회 17회 누적 | 129.49초 |
| 정규화 Python 프로세스 14회 누적 | 6.57초, 중앙값 약 0.44초 |
| 단순 SELECT 100회, 연결 유지 | 약 0.087초 |
| 연결·SELECT·종료를 100회 반복 | 약 0.890초 |
| 한 계정·날짜·지표의 현재값 EXPLAIN ANALYZE | 약 8.89~9.34초 |
| 같은 조회의 JIT 비활성화 | 약 7.14~7.99초 |
| 관측과 판정 양쪽에 같은 논리 키 조건 명시 | 약 0.320~0.324초, 비교한 합성 사례의 결과 일치 |

위 값은 진단 결과다. EXPLAIN 비교는 시험과 함께 실행돼 CPU 간섭이 있었고, 데이터도 시험 진행에 따라 변했다. 엄격히 고정한 성능 벤치마크나 전체 10분 회귀의 전수 분석이 아니다. 첫 계측은 진단용 Python atexit 기록 오류가 있었고 시험은 190.40초에 통과했다. 상세 계측에서는 기록 코드를 보완했다. 전후 성능 인수는 반드시 18.2 병합 후 커밋·데이터·환경을 고정해 새로 수행한다. 과거 실행 시간을 절대 상한으로 쓰지 않는다.

실행 계획의 한 표본은 관측 2,608행, 판정 단계 약 1,133개 행, 하위 계획 93개, 전체 노드 311개, shared buffer hit 약 560만 회였다. JIT 생성·최적화·코드 방출도 약 3.6~3.8초를 사용했지만 JIT를 끄는 것만으로 해결되지는 않았다.

원시 로컬 증거는 `.brain-automation/test-profile/summary.json`, `store.jsonl`, `jit-comparison.json`, `narrowed-query.json`, `detailed-run.log`에 있다. gitignored 파일이므로 다른 checkout에 존재한다고 가정하지 않는다. 이 문서가 새 작업자가 읽을 영구 요약이며, 재현 가능한 성능 러너·fixture와 전후 결과는 구현 티켓이 남긴다.

## 설계와 사용처 조사

Orca 조사 Run `run_1958827f1483`, Task `task_6c5a0f6f8112`, Dispatch `ctx_304aa132e544`의 성공 보고를 받았다. 조사 기준은 `03c7b2b50829343b80a22dc6c7923cf070937481`이다. 전체 로컬 보고서는 `.brain-automation/query-research/report.md`이며 조사 중 소스·DB·티켓 상태는 바꾸지 않았다.

확인한 코드·역사 근거:

- `packages/postgres/migrations/0023_health_contract.sql` — 권위·지원 버전·현재값 판정 도입. `15ceb529147d61690ce5668f6d907d3c2dca6608`(14.2).
- `packages/postgres/migrations/0025_original_text.sql` 및 `0026_health_json_comparison.sql` — 원형 identity 보존과 논리 text/JSON 비교. `143ebf5fc002a08ba4aba72fe58ef71ae32960c0`(14.4). 판정 뷰의 최종 정의는 0026이다.
- `packages/postgres/src/imports.ts` — 필터 없는 readHealth와 source별 readVerification snapshot의 뷰 소비.
- `apps/cli/src/runtime/import-verification.ts` → `extensions/garmin/src/import_verify.py` → `verify_compare.py` → `reports.py` — DB 판정 snapshot을 독립 Python 기대 판정과 비교해 검증 보고서를 만드는 제품 경로.
- `apps/cli/python-test/garmin-normalize.test.ts`, `packages/postgres/test/health-contract.test.ts`, `import-contracts.test.ts` — 현재값·권위·revision·지원 버전·논리 값 충돌의 기존 검증.

위 커밋에서 readHealth DTO와 SQL 집계 함수의 실행 호출은 시험에서 확인됐다. 반입 검증 snapshot은 제품 경로였다. 18.2는 그 뒤 구현 중인 새 분석 입력 소비자이므로 착수 시 병합된 구현을 다시 확인한다. 해당 시점 조사에서 그래프·일반 보고서·LLM 입력의 직접 소비가 확인되지 않았다는 사실을 이후 소비자 부재로 일반화하지 않는다.

## 유지할 계약과 최적화 주의점

여러 원본·revision·버전을 보존하면서 신뢰 조건을 통과한 측정만 현재값으로 노출하는 것이 계약이다. health_resolution은 선택·탈락 ID와 ambiguity 이유·권위 provenance를, health_current는 성공한 대표 관측을 반환한다. 기록에는 이 의미의 이유는 있으나 현재의 전체 CTE·상관 서브쿼리 형태 자체를 선택한 성능 근거는 없었다.

판정 키는 source·원형 account/activity/sub identity·metric·local_date 또는 observed_at·time_zone이다. dataset·revision·normalization_version은 이 키 안에서 경쟁하는 후보이므로, 그것을 먼저 필터링해 원래의 충돌을 없애면 결과가 달라진다. 한 원본의 계정 미확인이 같은 키의 다른 후보 선택도 막을 수 있고, revision 충돌은 최고 지원 버전 선택보다 먼저 판정한다. 계정 표시 문자열만 같다고 원형 바이트 identity가 같은 것도 아니다.

조건을 판정 뷰에도 명시한 실험은 좁은 한 사례의 가능성을 보였을 뿐이다. 날짜 없는 instant 값·NULL·원형 identity·wildcard 권위 범위·cutoff·다중 dataset 등 전체 동등성은 별도로 검증해야 한다. 전체 조회는 후보를 빠뜨리거나 날짜 필터를 강제해 빠르게 만들면 안 된다. 일괄 조회 방안을 택해도 독립 Python 검증기를 같은 판정 구현 호출로 바꾸어 정답 검증의 독립성을 잃지 않는다.

## 검증 인계

구현 entry에 명시한 판정 동등성, snapshot 일관성, 성능 전후 비교를 함께 검증한다. SQL 분리·프로그램 판정 여부는 비교 결과로 정하며, 공통 DB·Store 계약을 없애거나 시험을 우회하지 않는다. 실제 자료를 공개 증거로 남기지 않고 합성 fixture로 재현한다. 구현 반복은 AGENTS.md의 `pnpm test:changed`, 마지막 전체 회귀는 `pnpm test`와 `pnpm test:python` 순차 실행 규칙을 따른다.
