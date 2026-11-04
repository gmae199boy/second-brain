결론: **새 matplotlib 폰트 캐시 준비와 신규 그래프의 직렬 1초 확인 대기는 실제 큰 비용이며, 작은 로그를 다수 스캔할 때의 Node 시작도 누적된다; 현재 크기의 패키지 digest·파일 이중 해시·fsync는 주된 병목으로 확인되지 않았다.**

## 범위와 근거

- 기준 SHA `51018bbb7988fb5e367b6488a6d315e7c4959f21`. 운영 자료 없이 합성 입력만 사용했다. 구현·티켓 생성·소스/시험 수정·재빌드·Git index/branch/state 변경은 하지 않았다. 워커를 추가 생성하지 않았다.
- 출발 근거는 `performance-survey/sql-report.md`, `runtime-report.md`, `test-profile/summary.json`. 기존 **18.10의 health_current/resolution 조회는 이번 시간에 포함하지 않았다.** 전체 suite를 실행하거나 전체 10분을 설명한 조사가 아니다.
- Python 3.14.10, matplotlib 3.11.2, psycopg/psycopg-binary 3.3.6, Node v24.17.0, macOS 27.0.1 arm64. PostgreSQL 18.6 Debian aarch64, Docker 29.8.2/OrbStack, 12 CPU·약 16.8GB VM 메모리, 자기 컨테이너의 별도 CPU/메모리 제한 없음. 상세는 `environment.json`, transitive Python 고정 버전은 `requirements.lock`.
- 자기 컨테이너 `brain-perf-garmin-42ce`, `127.0.0.1:54343`, DB `garmin_perf`만 사용했다. 공용 54329, 운영 DB/계정, 다른 워커 환경에 접근하지 않았다.
- DB/fixture/설치/성능 작업은 모두 공통 `locked-run.py` 안에서 실행했다. 잠금 대기는 수치에서 제외했다. 각 조건은 **warm-up 1회 후 최소 3회** 측정했고 표는 wall 중앙값이다. CPU는 프로세스 자체 및 가능한 자식 누적 CPU를 JSON에 별도 기록했다. DB CPU는 Python CPU에 포함되지 않는다. SQL statement timeout은 55초다.
- 파일 및 DB 캐시는 운영체제 전체에서 비우지 않았다. 폰트 cold는 **새 전용 MPLCONFIGDIR**, uv cold는 **새 전용 project·HOME·cache**다. OS·망 전체가 cold라는 의미는 아니다.
- Python은 기준 SHA의 Garmin blob을 `baseline/`에 복사해 사용했다. 기존 dist는 `check-dist.mjs`로 기준 TypeScript에서 타입·주석·의미 없는 포매팅을 제거한 결과와 전부 일치함을 확인했다(`dist-check.json`). 새 빌드는 하지 않았다.

## 후보별 판정

| 담당 항목 | 판정 | 생산 영향 / 시험 영향 | 18.10 관계·후속 판단 |
|---|---|---|---|
| 1 unpublished/retry_items 무변경 전수 읽기·해시·이력 | 확인: 입력·이력 비례 비용 / 보통 크기의 주병목 주장은 기각 | 수집 no-op·재시도에도 발생 / 누적 이력을 가진 fixture에 영향 | 별도 원인. 장기 이력 규모·호출 빈도 근거를 갖춘 후 후보로 보존 |
| 2 신규 그래프 직렬 poll / 완료 캐시 | 확인: 신규 3장 중 약 3초가 sleep / 완료 캐시 병목은 기각 | 새 그래프 등록의 사용자 지연 / 차트 통합 시험에도 동일 경로 | **별도 그래프 발행 성능 후보**. 실패·재개·취소·캐시 계약을 보존해야 함 |
| 3 matplotlib cold/warm·폰트·렌더 | 확인: 새 캐시 약 10.6초 / prepare 매장 재import 주장은 기각 | 첫 실행·캐시 유실 때 큰 비용 / 새 home fixture가 반복하면 증폭 | **별도 캐시 초기화·시험 격리 비용 후보**. 환경 특이성을 명시해야 함 |
| 4 로그별 Node scanner | 확인: 작은 로그 100개 약 5.8초 | 로그가 많은 capture / 반입·독립 검증에서 재호출되면 누적 | 별도 다수 로그 후보. 기능·fail-closed 검증을 생략하는 절감으로 해석하지 않음 |
| 5 이중 hash·stage/fsync·snapshot 파일 비용 | 측정 범위에서 주병목 주장 기각 | 큰 파일 수/총바이트에는 비례 / 측정 크기에서는 수십 ms 이하 | 새 우선 티켓 근거 약함. snapshot SQL의 18.10 비용과 분리 |
| 6 확장 digest·uv 준비 반복 | 현재 패키지 digest 주병목 주장 기각 / 설치 준비 고정 비용 확인 | 설치·업그레이드 경로 / fixture마다 설치할 때 누적 | 현재 digest 단독 최적화 우선순위 낮음. 매 work마다 uv를 실행한다는 근거 없음 |

등록 전체 core E2E, 실제 계정의 이력 분포·실행 빈도, 전체 suite 누적 비율은 **미확인**이다. 아래 계측으로 그 범위를 대신했다고 주장하지 않는다.

## 1. 무변경 원문·정규화 이력

기준 `normalize_store.py:148`의 실제 `unpublished` 함수와 실제 PostgreSQL 조회를 사용했다. 결과는 매번 pending 0건이다. 본문은 합성 JSON이며 해시와 성공 ledger를 맞췄다. 이력은 같은 버전 8의 누적 행이다. 아래 점진 표는 비표준 합성 endpoint로 기본 성공 집합/해시 경로를 측정한 값이며, 실제 normalizer의 targets 분기는 별도로 추가 측정했다.

| 현재 원문 행 / 본문 총바이트 | 성공 이력 행 | unpublished wall | Python CPU | 본문 SHA만 따로 실행 |
|---|---:|---:|---:|---:|
| 100 / 102,400 B | 100 | 2.220ms | 0.636ms | 0.061ms |
| 1,000 / 8,192,000 B | 1,000 | 18.483ms | 8.196ms | 3.068ms |
| 1,000 / 8,192,000 B | 20,000 | 31.810ms | 17.485ms | 4.460ms |
| 10,000 / 81,920,000 B | 200,000 | 322.981ms | 219.296ms | 30.761ms |

같은 최대 행 수·본문량을 실제 `user_summary` endpoint로 만든 추가 조건에서는 **457.176ms / Python CPU 345.742ms**였다. 실제 NORMALIZERS와 `raw_revision` 구현을 사용해 null 재발행 대상 판정을 위한 targets 집합 분기도 포함했다. 이 추가 조건은 endpoint 변경 후의 별도 실행이며 두 수치 차이를 특정 분기만의 순수 비용으로 주장하지 않는다. 이력 증가에 비례하는 수백 ms라는 판단은 같다.

단일 key의 `anticipated_revision`도 실제 함수를 독립 DB에서 측정했다. 같은 key의 과거 revision 1/1,000/10,000개를 읽어 `revision_for`를 수행하는 비용은 각각 **0.317/0.431/3.113ms**였다(Python CPU 0.057/0.164/1.429ms). 항목별 이력이 매우 커지면 늘어나지만 이 범위에서는 계정 전체 전수조회보다 작다. SQL은 version으로 제한하지 않는 원본 조건을 유지했다.

최대 조건은 SQL 2회, 수신 10,000+200,000행이다. 마지막 반복의 원문 execute/fetch는 84.56/8.97ms, 상태 execute/fetch는 66.15/34.07ms였다. 이 값은 마지막 단일 반복이며 중앙값과 직접 빼서 정확한 단계 중앙값으로 취급하면 안 된다. 순수 해시보다 전송·문자열 복원·dict/set 생성과 전체 이력 처리가 더 큰 부분을 차지한다.

동일 입력의 EXPLAIN ANALYZE는 원문 Seq Scan→메모리 quicksort 10.59ms(정렬 약 1,010KiB), 이력 Seq Scan 19.93ms였다. 해당 dataset이 fixture의 전부여서 전수 결과를 읽는 선택은 합리적이다. 인덱스가 없어서 느린 쿼리라는 결론은 아니다. EXPLAIN은 본문을 실제 클라이언트로 직렬 전송하는 비용을 그대로 측정하지 않아 323ms와 차이가 난다. 실행계획·buffer·SQL 문장·행 수·반복별 wall/CPU는 `results.json`에 남겼다.

`retry_items`는 pending을 받은 뒤만 항목 정규화를 실행하므로, pending 0인 이번 값은 무변경 재시도의 실제 후보 선정 구간이다. coverage_snapshot·카탈로그·수집 전체·건강 뷰 조회를 포함하지 않았다. 이력 증가가 낭비를 만드는 구조는 확인했지만 이 조건의 수백 ms를 기존 9초 health 조회나 전체 suite 주원인으로 바꾸어 설명할 수 없다.

## 2. 실제 PNG·독립 DB와 그래프 등록 대기

실제 `charts.graph_jobs`에서 유효한 yesterday 1장·session 2장을 선택했다. 실제 `render_one`, `publish_graphs`, `graph_lookup`, `graph_request`, `_write`, `stage`, advisory lock을 실행했다. 각 그림은 합성 1,000점이고 실제 PNG signature를 확인했다. 결과는 성공 3장·실패 0장이다.

| 경로 | wall 중앙값 | Python CPU 중앙값 | 마지막 반복의 관측 |
|---|---:|---:|---|
| 신규 3장 | 3,325.084ms | 282.346ms | render 3회, request 3회, lookup 9회, sleep 3회 합계 3,021.13ms |
| 완료 캐시 3장 | 4.311ms | 1.047ms | lookup 3회, render/request/sleep 0회 |

신규 마지막 반복의 render 합은 약 256.35ms, request 합은 약 30.58ms였다. stage 약 2.27ms와 내부 lookup은 request에 포함되므로 다시 더하지 않는다. 완료 처리를 20ms 주기로 확인하는 합성 등록기를 두어, 실제 작업이 빠르게 끝나도 조회 전 `sleep(1)`이 그래프마다 실행되는 것을 확인했다. **등록 처리 자체가 1초 걸렸다는 뜻이 아니다.**

최소 schema는 실제 조회/요청이 쓰는 열·PK·view를 제공하지만 core migration 전체·실제 core 파일 반입자는 실행하지 않았다. `garmin.attempt_valid`는 항상 참인 합성 함수이고, 등록기는 결과를 completed로 바꾸는 연결 경계다. 따라서 attempt fencing·취소·실패·중단 재개·손상 캐시를 검증한 E2E 결과가 아니다. 이를 보존하는 일괄 처리 구현과의 동등성 비교도 하지 않았다. 관측된 3초를 무조건 제거 가능한 절감량으로 약속하지 않는다.

## 3. Python 시작·matplotlib·PNG 단계

| 조건 | wall 중앙값 | 자식 CPU 중앙값 또는 자체 CPU |
|---|---:|---:|
| Python no-op 새 프로세스 | 19.734ms | 자식 12.253ms |
| psycopg import 새 프로세스 | 160.410ms | 자식 151.741ms |
| 실제 prepare 새 프로세스·새 폰트 캐시 | 10,629.159ms | 자식 10,500.523ms |
| 실제 prepare 새 프로세스·기존 폰트 캐시 | 393.278ms | 자식 385.501ms |
| 실제 prepare 같은 프로세스·기존 캐시 | 0.030ms | 자체 0.029ms |

매 그래프 `prepare`를 부르는 사실은 매 그래프 matplotlib 전체를 새로 import한다는 뜻이 아니다. 새 home에서 첫 cache가 만들어지는 경로와 새 프로세스 import를 구분해야 한다. 같은 home을 실제 생산에서 재사용할 때와 fixture가 새 home을 만드는 경우의 비용이 크게 다르다.

추가 단계 분해는 원본 prepare와 같은 순서로 matplotlib import→Agg 설정→font_manager import→findfont를 새 프로세스에서 실행했다. cache cold/warm 각각 warm-up 후 3회다(`font-phase-details.json`, `extra-results.json`).

| 단계 | 새 cache 중앙값 | 기존 cache 중앙값 |
|---|---:|---:|
| import matplotlib | 299.555ms | 299.104ms |
| matplotlib.use(Agg) | 0.014ms | 0.013ms |
| import font_manager | 9,561.117ms | 14.724ms |
| findfont | 2.180ms | 1.975ms |

cold font_manager가 호출한 **`system_profiler -xml SPFontsDataType` 한 번이 중앙값 9,299.125ms**였다. fc-list 시도는 약 3ms였고 warm에는 둘 다 실행되지 않았다. 외부 명령 결과의 폰트 이름·경로는 저장하지 않고 명령 이름·시간만 보존했다. 따라서 이 호스트의 cold 주원인은 실제 macOS 폰트 열거이며 PNG 생성이나 psycopg import가 아니다. 추가 분해 전체는 cold 9.909초/warm 356ms로, 앞 prepare 10.629초/393ms와 다른 반복군이다. 환경과 실행 간 변동이 있어 두 군의 차이를 구현 개선으로 주장하지 않는다. Linux의 폰트 탐색 비용이 같다는 근거도 없다.

| 합성 yesterday 점 수 | render_one wall | tight_layout 중앙값 | savefig 중앙값 | 마지막 PNG 바이트 |
|---:|---:|---:|---:|---:|
| 100 | 69.434ms | 15.466ms | 46.659ms | 96,738 |
| 10,000 | 77.306ms | 16.911ms | 50.107ms | 39,077 |
| 100,000 | 782.464ms | 30.160ms | 737.904ms | 32,634 |

prepare cache가 존재하는 동일 프로세스에서 실제 Figure/한글 라벨/Agg/1800×900 PNG를 만들었다. 10만 점의 고밀도 선에서는 PNG 바이트가 작아져도 경로 래스터화 시간이 늘었다. 출력 파일 크기만으로 렌더 비용을 추정하면 틀린다. tight_layout/savefig는 원본 메서드 호출 전후를 메모리 내에서 계측했고 소스 파일은 변경하지 않았다.

## 4. 로그별 Node scanner

실제 `artifacts.scan_log`와 기존 `secret-scan.js`를 사용했고 각 결과는 hasSecrets=false였다. 안전한 합성 UTF-8 입력이며 실제 비밀은 사용하지 않았다.

| 로그 수 × 파일 바이트 | wall 중앙값 | Python CPU / 자식 누적 CPU 중앙값 |
|---|---:|---:|
| 1 × 1,024 B | 58.272ms | 14.166 / 50.891ms |
| 20 × 1,024 B | 1,160.982ms | 285.188 / 1,007.126ms |
| 100 × 1,024 B | 5,796.698ms | 1,426.434 / 5,042.919ms |
| 1 × 1MiB | 67.641ms | 17.255 / 62.034ms |
| 1 × 32MiB | 392.275ms | 120.092 / 417.292ms |

CPU는 사용자+시스템 누적량으로 병렬 실행·복사·I/O와 겹칠 수 있어 wall에 단순 합산하지 않는다. 작은 로그는 파일당 프로세스 시작·모듈 로드가 지배적이고, 큰 로그는 바이트 복사·decode·regex도 늘어난다. 100개 작은 로그가 큰 파일 하나보다 느렸다. 실제 반입과 독립 검증에서 재스캔할 수 있지만 실제 capture의 파일 개수를 측정하지 않았으므로 5.8초를 모든 생산/시험 실행에 대입하지 않는다. 배치 구현이나 검증 축소와 비교하지 않았다.

## 5. 파일 이중 hash·staging·검증 snapshot

| 1개 파일 크기 | preflight file_digest 2회 | 실제 read_relative | 신규 stage+fsync | 기존 locator stage+fsync |
|---|---:|---:|---:|---:|
| 1KiB | 0.038ms | 0.095ms | 0.424ms | 0.464ms |
| 1MiB | 0.785ms | 0.545ms | 1.143ms | 1.158ms |
| 32MiB | 25.563ms | 13.761ms | 15.602ms | 18.613ms |

원본 hash 두 번은 정확히 두 번 읽는다(32MiB 입력이면 64MiB). read_relative는 no-follow·파일 변경 경계 검증과 hash를 유지했다. stage는 hash·실제 쓰기·파일 fsync·hardlink·디렉터리 fsync를 모두 유지했다. 기존 locator도 임시 쓰기/비교 경로를 실행한다. warm OS cache·현지 APFS 환경의 값이므로 느린 디스크나 수백 대형 파일에 일반화하지 않는다.

실제 `prepareImportVerification`와 `localFileStore.get`로 파일 확인·해시·metadata 일치·JSON 직렬화·Python private writer·fsync를 측정했다. 두 readVerification은 합성 snapshot을 반환하여 SQL 비용을 제외했다.

| 파일 입력 | 전체 파일 단계 wall | 마지막 실제 get 총시간 | snapshot 횟수 / 파일 get 횟수 |
|---|---:|---:|---:|
| 1 × 1KiB | 14.136ms | 0.146ms | 2 / 1 |
| 100 × 1KiB | 23.089ms | 7.928ms | 2 / 100 |
| 1 × 32MiB | 31.298ms | 3.172ms | 2 / 1 |

두 번째 snapshot은 시도 유효성을 다시 확인하지만 **이 함수가 파일 자체도 두 번 읽는 것은 아니다.** 파일 한 번 읽기와 두 DB snapshot을 혼동하면 18.10과 파일 비용을 중복 계산한다. JSON의 모든 metadata_matches=true를 확인했다. snapshot에 담기는 대형 테이블 JSON과 실제 SQL·전체 preflight SQLite analyze는 이번 파일 단계에서 미측정이다.

## 6. 패키지 digest·실제 uv 설치 준비

실제 checkTree 및 packageDigest 구현으로 source/installed 전체·migration 제외를 네 번 순회했다. 현재 패키지는 기준 Garmin blob 105개, 1,303,437B다. 비교 대상 source/installed 역할에는 동일 기준 tree를 사용하여 디스크 위치·cold 캐시 차이를 섞지 않았다.

| 입력 | 네 번 digest+checkTree wall | Node CPU 중앙값 |
|---|---:|---:|
| 현재 Garmin 105개 / 약 1.3MB | 28.914ms | 31.582ms |
| 합성 100개 / 819,200B | 26.933ms | 29.032ms |
| 합성 1,000개 / 8,192,000B | 257.548ms | 286.552ms |

현재 크기에서는 작고 파일 수가 크게 늘면 증가한다. `.venv` 등을 제외하는 원본 규칙을 유지했으며 생성된 Python 환경 전체를 네 번 해시했다고 주장하지 않는다. 비교 digest의 동일 출력도 확인했다.

실제 `prepareExtensionPython`을 별도 project·HOME으로 실행해 `uv --version` → `uv python find` → `uv sync --frozen --no-dev` → Python 버전 확인과 기존 프로세스 identity/cleanup을 유지했다. 기존 Garmin uv.lock을 그대로 사용했다.

| 환경 | wall 중앙값 | Node CPU 중앙값 |
|---|---:|---:|
| 새 project·HOME/cache·venv | 517.725ms | 11.384ms |
| 같은 project·venv/cache | 49.000ms | 8.598ms |

Node CPU는 uv/Python 자식 CPU를 포함하지 않는다. cold 수치는 이 호스트의 빠른 패키지 공급·OS 캐시 조건이며 다른 네트워크 최초 설치의 보장이 아니다. 매 수집마다 이 준비를 수행하는 경로는 아니므로 매 work의 고정 비용으로 곱하지 않는다.

warm project에서 같은 하위 명령을 별도 Python 부모로 실행한 분해는 다음과 같다. 위 실제 Node 준비 함수와 다른 반복군이므로 단순 합산해 정확한 총시간으로 취급하지 않는다.

| 하위 명령 | wall 중앙값 | 자식 CPU 중앙값 |
|---|---:|---:|
| uv --version | 9.628ms | 4.679ms |
| uv python find 3.14.10 --no-python-downloads | 10.966ms | 5.866ms |
| uv sync --frozen --no-dev | 12.424ms | 7.248ms |
| Python platform.python_version | 19.253ms | 14.295ms |

## 재현·미확인 범위·정리

원시 반복·SQL trace/plan은 `results.json`, Node 반복은 `node-results.json`, 추가 정상 endpoint·단일 key 이력·uv/폰트 분해는 `extra-results.json`과 `font-phase-details.json`, 타입 제거 대조는 `dist-check.json`, 콘솔은 각각 `.log`에 있다. 비교 최적화 구현을 만들지 않았고 검증·실패 처리·취소·캐시 계약을 줄여 얻은 절감 주장을 하지 않았다.

같은 repo root에서 자기 포트/컨테이너가 비어 있을 때 실행한다. baseline 스냅샷과 모든 스크립트는 이 조사 폴더에 있다. `locked-run.py`의 공통 잠금 사용을 유지한다.

```sh
python3.14 .brain-automation/performance-deep/locked-run.py docker run -d --name brain-perf-garmin-42ce -p 127.0.0.1:54343:5432 -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=garmin_perf postgres:18
python3.14 .brain-automation/performance-deep/locked-run.py uv --cache-dir .brain-automation/performance-deep/garmin/uv-cache venv .brain-automation/performance-deep/garmin/venv --python python3.14
python3.14 .brain-automation/performance-deep/locked-run.py uv --cache-dir .brain-automation/performance-deep/garmin/uv-cache pip install --python .brain-automation/performance-deep/garmin/venv/bin/python -r .brain-automation/performance-deep/garmin/requirements.lock
node .brain-automation/performance-deep/garmin/check-dist.mjs
python3.14 .brain-automation/performance-deep/locked-run.py node .brain-automation/performance-deep/garmin/node-bench.mjs
python3.14 .brain-automation/performance-deep/locked-run.py .brain-automation/performance-deep/garmin/venv/bin/python -B .brain-automation/performance-deep/garmin/bench.py
python3.14 .brain-automation/performance-deep/locked-run.py .brain-automation/performance-deep/garmin/venv/bin/python -B .brain-automation/performance-deep/garmin/extra.py
```

Docker/localhost/OS process inspector/PyPI가 sandbox EPERM·DNS로 차단된 호출은 승인된 require_escalated로 정상 실행했다. 자동 승인 거부는 없었다. 재현 때 새 postgres:18 태그가 이동하면 기록된 18.6/이미지 ID와 대조해야 한다.

생산 빈도·실제 history 분포·cold 빈도·대형 snapshot SQL/직렬화·core 등록 전체 E2E·전체 suite 누적은 남은 불확실성이다. 다음 조사 명령은 위 개별 재현 스크립트이며 core E2E는 전용 PostgreSQL에서 기존 garmin-charts 통합 시험을 단계 계측하되 원본 검증·실패/재개/취소 case를 모두 유지해야 한다. 이번 워커에게 소스/시험 편집 권한은 없어서 그 연결 측정을 하지 않았다.

정리 완료: 전용 컨테이너를 `docker rm -f brain-perf-garmin-42ce`로 제거하고 정확한 이름 필터의 빈 결과로 부재를 확인했다. 자기 `data/`(합성 파일·각 uv project/cache·폰트 cache), `venv/`, `uv-cache/`도 제거했다. 소스 스냅샷·고정 lock·재현 스크립트·JSON·로그·보고서만 약 1.6MB 남겼다(`cleanup.json`). 텍스트 증거에 개인 홈 절대 경로가 없는 것도 확인했다. 재현에는 위 setup 명령을 다시 실행해야 한다.

후속 우선순위는 **새 home의 macOS 폰트 열거 비용 → 신규 그래프 확인 지연 → 실제로 로그가 많은 capture의 scanner 시작 누적**이다. 무변경 이력은 별도 성장 비용으로 보존하고 파일·digest의 작은 비용은 현 규모에서 우선 최적화하지 않는다. 18.10 자체는 이번 별도 원인들과 구분해 유지한다.
