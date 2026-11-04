# tests 영역 추가 성능 조사

반복되는 새 DB fixture 초기화가 store·work-store 시험의 주된 병목으로 확인됐으며, 25ms polling의 연결 반복은 시험 특수 비용이고 정상 cleanup·동일 ref bootstrap은 작았다.

## 범위와 환경

기준 SHA `51018bbb7988fb5e367b6488a6d315e7c4959f21`의 실제 TS/PG 시험 4개 파일을 새 PostgreSQL 18.6에서 계측했다. Darwin arm64 / Mac16,11 / 12 CPU / 호스트 64GiB, Docker VM 12 CPU·약 15.7GiB, Node 24.17.0, pnpm 12.16.1, Python 3.14.10, Vitest 5.0.3이다. 이미지 ID·입력 크기는 `environment.json`에 있다. 전용 `brain-perf-tests-42ce`, `127.0.0.1:54342`만 사용했다. 공용 54329·운영 계정·실제 transcript·건강값·다른 워커 환경을 사용하지 않았다. 빈 합성 Claude config와 합성 DB를 썼다.

모든 DB 생성·migration·시험/build·성능 비교는 `../locked-run.py`의 공통 flock 아래 실행했다. 워밍업 1회 뒤 독립 반복 3회의 중앙값을 쓴다. 원시 각 반복도 JSON으로 남겼다. 표의 CPU는 계측한 Node process 또는 명령 자식들의 user+system CPU이며 PostgreSQL 서버 CPU는 포함하지 않는다. OS foreground 부하·Docker 스케줄링까지 통제한 전용 물리 호스트 실험은 아니다. 예를 들어 1,000회 재연결은 2.94~8.30초로 변동했다.

AGENTS/runbook을 읽었고 일반 조사 Dispatch만 수행했다. orchestration 스킬로 중앙 보고를 했다. 중앙 state·티켓·18.2 워크트리·브랜치·index·원격은 변경하지 않았다. 원래 존재한 `_bmad` 및 goal-watch 작업은 보존했다.

## 판정

| 담당 후보 | 판정 | 실측으로 확인한 범위와 판단 |
| --- | --- | --- |
| createDB/prepareRole/migrate/drop 반복 | 확인 | 4파일당 DB 362개, store·work-store의 85~87%가 준비/정리; 시험 성능 별도 후보 |
| sessions-ingest/work-store/store/redaction 파일 내 비중 | 확인 | 아래 새 실행 표; sessions의 잠금·fallback 검증은 별도 필요 비용 |
| no-op 118 / 초기 176 SQL 가설 | 확인 | native compiled API에서 정확히 118/176회, no-op 21.8ms; 단독 생산 병목 주장은 기각 |
| 25ms schema/manifest/connection 반복 | 확인 | 실제 daemon을 실행해 초당 수십 회 관측; 기본 설정의 큰 생산 병목 주장은 이 작은 합성 입력에서 기각 |
| bootstrap hook 중복·cold/warm install/build | 확인/미확인 분리 | 두 config의 hook 선택 중복과 실제 pnpm 구성 비용·동일 ref no-op을 확인; 두 전체 suite의 hook 총 wall 및 실제 end-to-end ref upgrade는 미확인 |
| ps/sysctl·정상 cleanup 고정 수초 가설 | 기각 | 실제 자기 자식 종료 후 cleanup `died`, 5~9ms; 정상 경로가 grace+confirm 전부 대기하지 않음 |
| redaction 물리 cleanup이 파일 전부를 소비 | 기각 | 별도 4회 실행에서 69 API 호출 합계 약 2.06초, 초기화 약 8초보다 작음; 실제 계약 삭제·검증 축소 근거 없음 |

## 4개 파일의 실제 구간

`pnpm test:changed -- HEAD`에서 Vitest list/run에 네 파일 필터와 직렬 실행만 주입했다. Python config는 해당 네 파일을 포함하지 않아 선택 0개였고 다른 시험·전체 suite는 실행하지 않았다. warm-up와 반복 3회 모두 **353 case 통과**, 명령 wall 중앙값 **128.785초**, 명령 자식 CPU 중앙값 **45.140초**다. 과거 Vitest 캐시 duration은 이 표에 쓰지 않았다.

단위 초. 각 열은 별도 중앙값이므로 열끼리 더한 값과 합계 중앙값은 조금 다를 수 있다. `prepareRole`에는 cluster role 잠금/권한/비밀번호 및 대상 schema/ledger 준비가 함께 들어간다. `testBody 등`은 파일 실행 span에서 네 측정 phase 합계를 뺀 잔여이며 순수 assertion 시간만이 아니다. self user·shim/config·store close·프로세스 실행·의도적 잠금대기 등도 포함하므로 이를 별도 profiler로 직접 측정한 함수 시간이라고 주장하지 않는다.

| 파일 | 실제 DB 수/회 | 파일 | createDB | prepareRole | migrate | drop | testBody 등 잔여 | 준비·정리 비중 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| packages/postgres/test/redaction.test.ts | 39 | 14.228 | 0.751 | 0.785 | 5.262 | 1.020 | 6.063 | 56.8% |
| packages/postgres/test/store.test.ts | 83 | 19.620 | 1.692 | 1.689 | 11.431 | 2.267 | 2.480 | 87.3% |
| packages/postgres/test/work-store.test.ts | 167 | 40.435 | 3.326 | 3.342 | 22.886 | 4.478 | 6.234 | 84.6% |
| apps/cli/test/sessions-ingest.test.ts | 73 | 51.087 | 1.575 | 1.443 | 10.378 | 2.416 | 35.292 | 30.9% |

네 파일을 묶은 명령 전체에서 준비·정리 합계 중앙값은 **75.512초(명령 wall의 약 58.6%)**였다. 이 128.8초 범위의 결과만 설명하며 전체 약 10분 suite의 비중은 아니다.

DB 수는 정적 callsite 수가 아니라 helper 호출을 실제로 센 값이다. work-store는 159 case 안에서 167개, sessions는 72 case 안에서 73개 DB를 사용한다. store 83, redaction 39다. 따라서 한 파일이 40초 걸린다는 사실을 단일 쿼리 40초로 해석하면 틀린다. 초기 migration은 파일들에서 약 0.135~0.142초/fixture이고, 362회 반복으로 큰 누적 비용이 된다. 별도 진단의 초기 migration 149.6ms도 같은 규모다.

sessions-ingest의 DB 외 잔여 약 35.3초 중, 실제 lock/doctor/spool fallback을 검증하는 느린 네 case가 각 약 3.5~4.6초였다(`summary.json`의 case별 값). 각각 holdTheLock(20,000)을 호출해도 finally에서 holder를 먼저 종료하므로 20초를 네 번 더하지 않았다. 일부 큰 transcript 입력·여러 CLI 자식 실행도 이 파일의 본문이다. 이 잠금 deadline 검증을 빼는 것을 최적화로 제안하지 않는다.

redaction만 별도로 4회 다시 실행해 maintenance API를 감쌌다. 매회 39 case 통과, 7종 표의 cleanup API 호출 69회, 합계 중앙값 **2.061초**, 파일 실행 중앙값 약 **13.8초**다. API 값에는 성공한 VACUUM FULL/CHECKPOINT 외 잠금/권한 오류·retained tuple 검사도 포함된다. 이를 성공 VACUUM만의 순수 실행 시간으로 부르지 않는다. 본문에는 실제 heap/TOAST 바이트 제거·오래된 snapshot·권한·fencing·실패 재시도 검증이 남는다. 물리 작업은 모두 이 워커의 독립 cluster에서만 실행했다.

## 작은 DB 작업·연결·프로세스 진단

단위 ms. `diagnostic.mjs`는 기존 compiled API를 직접 부르며 SQL text를 저장하지 않고 query 호출 수·입력 SQL 바이트·반환 JSON 행/바이트만 센다. 단계별 client connect/end도 기록했다. pool close 후 실제 socket end가 비동기로 완료돼 인접 stage의 end callback으로 잡힌 경우가 있으므로 단일 stage의 end 수를 생성 연결 수로 대용하지 않는다.

| 진단 | wall 중앙값 | CPU 중앙값 | SQL 호출 수 |
| --- | ---: | ---: | ---: |
| createDB | 18.290 | 1.788 | 1 |
| prepareRole | 18.179 | 3.017 | 8 |
| initialMigration | 149.647 | 15.054 | 176 |
| noopMigration | 21.799 | 13.269 | 118 |
| dropDB | 24.969 | 1.373 | 1 |
| queryPersistent.100 | 17.085 | 4.522 | 100 |
| queryReconnect.100 | 308.152 | 131.305 | 100 |
| queryPersistent.1000 | 152.525 | 31.932 | 1000 |
| queryReconnect.1000 | 3622.719 | 1066.144 | 1000 |
| process.bootTime | 3.210 | 0.735 | 0 |
| process.startedAt | 3.117 | 0.930 | 0 |
| process.cleanExitedOwnChild | 8.009 | 1.650 | 0 |

29개 migration SQL은 195,576바이트다. 초기 176회는 반환 436행/JSON 약 60,439바이트, no-op 118회는 899행/126,898바이트를 관측했다(ledger와 advisory lock SELECT 등 합계; PostgreSQL wire bytes가 아님). 최신 ledger 29행을 여러 번 읽기 때문에 no-op의 반환량이 더 많다. 초기 SQL 입력 201,694바이트, no-op 3,247바이트이며 parameter wire bytes는 제외했다.

ledger SELECT의 단일 참고 EXPLAIN은 29행 Seq Scan·shared hit 1블록·execution 0.085ms였다. 이는 1회 plan 증거이며 반복 벤치마크 중앙값이 아니다. 작은 표의 스캔 자체보다 29번 transaction/lock/validate/commit과 왕복·복원이 no-op의 구조적 비용이다. 초기에는 DDL·인덱스·grant·ledger INSERT가 추가된다. no-op만 빨라져도 새 DB fixture의 초기 DDL이 없어지는 것은 아니다.

SELECT 1은 100→1,000회로 늘려 연결 유지와 매회 connect/query/end를 비교했다. 결과는 매번 같은 단일 행이며 검증을 줄인 비교가 아니다. 연결 재사용은 이 로컬 환경에서도 유리하지만 실제 시험의 연결 생명주기·격리 계약에 맞춰야 한다.

`sysctl` bootTime과 `ps` startedAt은 실제 OS에서 found를 반환했다. 종료를 확인한 자기 detached Node 자식에 대한 cleanProcessGroup은 항상 `died`, grace 1초·confirm 2초를 소모하지 않았다. 큰 가짜 pgid(2147483000)는 이 OS의 ps에서 `unknown`이었고 cleanup도 fail-closed `unknown`으로 반환했다. 이를 정상 absent 성공으로 계산하지 않았다. 살아 있는 손상 그룹·권한 오류·SIGKILL escalation의 비용은 이번 정상경로 수치에 포함되지 않는다.

## 25ms 시험 polling과 생산 기본값

실제 `runDaemon`을 빈 queue와 enabled 합성 testext manifest 1개로 실행했다. 25ms는 ext-fixture와 같이 `imports: undefined`를 적용했고, 기본값은 imports를 켠 생산 구성이다. filesystem watcher는 빈 합성 config에서 이벤트를 주지 않았다. 쿼리·connection·close·schema method·manifest 파일 I/O를 계측했다. 아래 수치는 warm-up 후 3회 중앙값이며 서로 다른 기간의 절대 횟수다.

| 설정/관측 기간 | store create/close | PG connect | SQL | schema 점검 호출 | extension 목록/manifest read·파일 lstat | Node CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 시험 25ms / 약 2.203초 | 65 / 65 | 65 | 1,156 | 142 | 각각 78 | 271.5ms |
| 기본 supervisor 5초·drain 10초 / 약 11.207초 | 3 / 3 | 3 | 44 | 5 | 각각 3 | 26.9ms |

25ms에서도 40Hz 고정이 아니었다. supervisor manifest 읽기는 약 35회/초, drain 연결 생성은 약 29회/초였다. supervisor store는 수명 동안 유지되고 drain이 매회 새 store를 열고 닫는다. 25ms에서 PG connect 누적 약 191.6ms, query 누적 약 451.6ms, manifest read 누적 약 8.5ms·manifest-file lstat 약 1.9ms였다. 동시에 도는 두 루프의 누적 시간이므로 이를 wall의 상호 배타적 구간으로 합산하지 않는다. directory lstat는 별도 timing 집계에서 제외했다.

짧은 시험 polling은 실제 DB와 CPU 일을 늘린다. 그러나 이 실험은 유휴 1개 확장·빈 이력이며 health 쿼리 대기 중 전체 suite의 발생 횟수를 잰 것은 아니다. 기본값의 낮은 비용만 보면 생산 hot loop 최적화를 우선 티켓으로 만들 근거는 약하다. 생산에서 확장 수·이력·활성 work가 늘 때의 비용은 별도 입력이다.

## bootstrap 구성 비용과 중복 범위

기본 Vitest config와 Python config 양쪽의 `vitest list`가 **같은 hook.test.ts를 선택**하는 것을 실행해 확인했다(`hook-selection.json`). Python 쪽은 추가 보존 case가 있어 두 파일 실행이 완전히 같은 case 집합은 아니다. 두 전체 suite를 다시 돌려 중복 총 wall을 재는 일은 이번에 하지 않았다.

같은 SHA의 `git archive`로 tests 아래 독립 snapshot 4개를 만들고 각 trial마다 비어 있는 private pnpm store를 썼다. 바깥 경로를 가리키는 agent skill symlink는 snapshot에서 제외했다(컴파일 입력과 의존성은 원본). 실제 `pnpm install --frozen-lockfile --ignore-scripts --store-dir <private>`를 실행했고 로그상 70개 패키지 모두 reused 0 / downloaded 70으로 내려받았다. OS·네트워크·registry 중간 캐시까지 비운 cold 환경은 아니다. build는 지시대로 `pnpm test:changed -- HEAD`의 실제 build를 사용했고, 이 **구성 비용 진단에서만** Vitest list를 빈 목록으로 반환했다. 이 진단은 시험 통과 증거가 아니며 시험 생략을 성능 개선으로 제안하지 않는다. 기존 검증이 줄지 않은 353 case 실측은 앞 표다.

| 실제 구성 단계 | wall 중앙값 초 | 자식 CPU 중앙값 초 | warm-up 제외 반복 |
| --- | ---: | ---: | ---: |
| coldInstall | 0.558 | 2.417 | 3 |
| warmInstall | 0.030 | 0.048 | 3 |
| coldBuild | 1.331 | 3.039 | 3 |
| warmBuild | 0.846 | 2.932 | 3 |
| upgradeInstall | 0.030 | 0.048 | 3 |
| upgradeBuild | 0.833 | 2.912 | 3 |

coldInstall은 store·node_modules가 비어 있고, warmInstall은 동일 작업 폴더·store 재사용이다. cold/warmBuild는 새 dist/이미 존재하는 dist에서 각각 실행했다. `upgradeInstall/Build`는 **같은 lockfile·같은 tree에서 재설치/재빌드하는 구성 비용 모델**이다. 새 ref의 git fetch/checkout·실제 installer/DB/launchd·확장 보존까지 포함한 end-to-end upgrade 시간이 아니다. 따라서 과거 hook 48초를 위 build 비용으로 전부 설명하지 않는다.

동일 ref의 실제 bootstrap `main`을 기존 프로세스에서 1,000회씩 실행했을 때 호출당 중앙값 **0.02755ms**, 외부 명령 **0회**였다. 별도 Node 프로세스에서 실제 bootstrap bin을 10번씩 실행한 no-op 중앙값은 호출당 **26.383ms**다. 매 SessionStart가 install/build를 반복한다는 가설은 기각한다.

현재 hook.test.ts는 환경 DB URL을 지우고 home별 이름·포트의 실제 container를 생성/정리한다. 이번 허용 리소스는 지정된 단일 이름·54342이므로 원본 hook E2E 전체를 그대로 실행하지 않았다. bootstrap 구현을 바꾸거나 Docker 검증을 mock해 성공이라고 주장하는 대신 위 실제 구성 비용으로 범위를 나눴다. 남은 측정은 bootstrap E2E가 만드는 추가 이름/포트를 명시적으로 격리 허용한 뒤 hook.test.ts만 임시 계측 대상으로 추가하고 `python3.14 .brain-automation/performance-deep/locked-run.py pnpm test:changed -- HEAD`를 실행하는 것이다. 두 config의 중복 wall을 확정하려면 같은 조건의 각 config 선택을 별도로 기록해야 한다.

## 영향·18.10·티켓 판단

- **시험 전용 우선 후보:** fresh DB 초기화를 유지하면서 안전한 계약 subset에서 template 또는 초기화 재사용 가능성을 비교하는 조사/개선. store·work-store의 85~87%라는 직접 근거가 있다. 지금 template 구현·비교를 한 것은 아니므로 최대 절감량을 보장하지 않는다. role·권한·독립 DB·파괴적 DDL·migration 자체 시험의 격리를 보존해야 한다.
- **별도 생산/설치 후보:** no-op migration의 118 왕복은 확인했으나 약 22ms라 우선순위가 낮다. 기본 유휴 daemon도 작은 입력에서는 낮은 비용이다. 초단기 polling 최적화는 시험 scheduler의 응답성·대기시간과 같이 봐야 하며 생산 기본값을 바꿀 근거는 아니다.
- **bootstrap 분류 후보:** 두 필수 suite에 걸친 hook 선택 중복은 확인했다. cold install/build 및 실제 upgrade E2E 보장 범위를 확인한 뒤 독립 시험 성능 작업으로 판단한다. 현재 필수 회귀 명령을 생략하지 않는다.
- **필요 비용:** lock fallback·물리 삭제·권한·retained tuple·정상/비정상 process identity 검증은 그대로 유지한다. 정상 ps/cleanup 자체를 큰 병목으로 우선 최적화할 근거는 없다.
- **기존 18.10과 별개:** 이번 초기화·connection·manifest·process cleanup 비용은 health_current/resolution의 큰 SELECT 반복과 다른 경로다. 초기 migration이 뷰를 생성해도 기존 건강값 판정 SELECT 병목을 실행하는 것은 아니다. 18.10의 뷰 의미·성능 개선 범위를 여기로 확대하지 않는다. 기존 normalize 147.96초·전체 약 10분을 이번 128.8초 표와 합산하거나 모두 설명했다고 말하지 않는다.

이번 작업에서는 구현·티켓 생성·commit/push를 하지 않았다.

## 재현·증거·정리

저장소 루트에서 순서대로 실행한다. 전용 container와 synthetic URL만 사용하고 다른 세션과 같은 공통 lock을 쓴다. `instrument.py`는 시작 전 바이트·SHA·dirty 여부를 `original/`, `originals.json`에 남기며 이미 계측된 소스에 다시 덮어쓰지 않는다. 기존 출력 파일은 새 실행 전에 별도 보관하거나 자기 결과만 비워야 한다(JSONL append 방식).

```sh
python3.14 .brain-automation/performance-deep/tests/instrument.py
python3.14 .brain-automation/performance-deep/locked-run.py python3.14 .brain-automation/performance-deep/tests/run-tests.py
BRAIN_TEST_DATABASE_URL=postgresql://postgres:synthetic-tests@127.0.0.1:54342/postgres python3.14 .brain-automation/performance-deep/locked-run.py node .brain-automation/performance-deep/tests/diagnostic.mjs
python3.14 .brain-automation/performance-deep/locked-run.py node .brain-automation/performance-deep/tests/hook-noop.mjs
python3.14 .brain-automation/performance-deep/locked-run.py python3.14 .brain-automation/performance-deep/tests/redaction-extra.py
python3.14 .brain-automation/performance-deep/locked-run.py python3.14 .brain-automation/performance-deep/tests/bootstrap-bench.py
python3.14 .brain-automation/performance-deep/locked-run.py python3.14 .brain-automation/performance-deep/tests/hook-launch.py
python3.14 .brain-automation/performance-deep/tests/summarize.py
python3.14 .brain-automation/performance-deep/tests/write-report.py
```

container 재생성 명령은 `cleanup.json`과 이 보고서의 전용 이름/포트를 참고한다. 최초 `docker run`은 `postgres:18 -c statement_timeout=60000 -c shared_preload_libraries=pg_stat_statements`로 만들었다. runtime query는 adapter 고유 deadline도 적용된다. 이번에 60초 이상 쿼리는 발생하지 않았다. migration/maintenance의 adapter는 일부 timeout=0을 의도적으로 사용하므로 거대 fixture 확장 시 서버 deadline이 덮이지 않는지 별도 확인해야 한다. Docker/OS 접근은 sandbox 차단 후 승인된 require_escalated로 실행했으며 자동 승인 거부는 없었다.

- `run-0..3.json`, `test-runs.json`, `phases-0..3.jsonl`: 네 파일의 새 실측과 353 case 결과.
- `run-redaction*.json`, `phases-redaction*.jsonl`: 39 case 보존·maintenance 추가 계측.
- `diagnostic.json`: migration query/행/바이트·plan·polling·connection·process 진단. `pg-*.jsonl`은 CLI native 자식에서만 얻은 보조 자료이며 Vitest 내부의 모든 query를 센 전수 trace가 아니다.
- `bootstrap.json`, `bootstrap/*-*.log`, `hook-noop.json`, `hook-launch.json`: 합성 구성 비용. 서로 다른 baseline/cold 의미를 위 설명대로 구분한다.
- `restoration.json`: 여섯 테스트 파일 모두 원본 바이트/SHA 일치. 덮어쓰기 때 외부 변경이 있으면 보존하도록 검사했고 이번에는 없었다. 최초 Vitest list의 optional JSON 인자 처리로 한 임시 테스트 파일이 목록 출력으로 덮였던 일은 즉시 보관 바이트로 복구한 뒤 전체 반복을 새로 수행했다. 그 실패 실행은 측정 수치에서 제외했다.
- `cleanup.json`: 자신이 만든 container·snapshot/private store·합성 home 정리 결과. 로그·결과·원본 백업·재현 스크립트만 이 영역에 보존했다. 원시 JSON/log의 개인 home prefix는 `<repo>` 또는 `~`로 치환했다.

전체 suite·실제 생산 이력·큰 확장 수·원격 DB RTT·cold OS page cache·실제 end-to-end bootstrap upgrade는 이 조사 결과로 확정하지 않는다.
