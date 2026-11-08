# 19.5 구현 전 정제 계획과 검증 계약

정제일 2026-11-08. 원본 baseline `9004c35b20c1b38b66af795668056ecdcdbaa1a9`. 중앙 지시 원본은 자기 checkout의 `.brain-automation/tickets/19.5/refinement-spec.md`에 보존했다. 이 문서는 leaf 수락조건을 구현자가 실행할 수 있도록 구체화한다. 구현 계획의 status·담당자·built를 만들지 않는다. 모든 실행·성능·정리 결과는 아직 **미실행**이다.

## 현행 코드와 역사 인계 대조

아래는 baseline 파일을 읽은 정적 관찰이다. 현재 실행 시간·동시 실행 성공을 증명하지 않는다.

| 근거 | 확인한 현재 사실 | 19.5가 지킬 계약 |
|---|---|---|
| `apps/cli/python-test/vitest.config.ts` | CLI Python `**/*.test.ts`와 hook 선택, fileParallelism false, globalSetup 공용 helper, Python 보존 flag 1, testTimeout 120초·hookTimeout 60초 | 단순 병렬 flag 변경으로 완료하지 않는다. 선택 목록·timeout 유지, slot별 순차 실행 |
| `vitest.config.ts`, `package.json` | 기본 suite는 package별 project에서 hook도 선택. 두 pnpm 전체 명령 모두 build 포함 | 기본/Python 명령 병행 금지, 사전 build 뒤 Vitest process만 병행 |
| `tooling/test-db/src/global-setup.ts` | 명시 BRAIN_TEST_DATABASE_URL이면 Docker 시작·종료하지 않음. 없으면 공용 compose 54329 사용 | slot·검증 모두 독립 URL을 먼저 주입하고 누락 시 중단; 공용 fallback으로 가지 않음 |
| `tooling/test-db/src/index.ts` | createTestDatabase는 환경 cluster 안 임의 DB 생성. createIsolatedTestDatabase는 fixture별 postgres:18 container·동적 loopback port·label을 만들고 TCP 인증 후 DB 생성. resource log·drop 상태·부분 시작 복구 존재 | URL 교체만으로 extHome이 slot을 소비하지 않는다. 명시 lease/override handoff 필요. fixture 전용 경로 유지 |
| `apps/cli/test/pg-home.ts`, `ext-fixture.ts` | extHome → pgHome의 createDatabase 인자로 createIsolatedTestDatabase를 넘김. brain_owner DB 소유·설치 identity·빈 harness·role marker 확인 정리. 복수 fixture와 실패 재정리 가능 | 같은 파일의 다른 extHome을 같은 role cluster에 넣지 않는다. 스키마 준비·권한·finally·재시도 정리 보존 |
| `packages/postgres/src/extension-provision.ts` | brain_ext_<name>은 cluster 전역. marker는 `second-brain extension:<DB>`. advisory lock 4919270912로 provision 직렬화, 다른 DB marker 충돌 거부 | DB/home만 다른 병렬화 불가. role 이름·marker·lock·grant 변경 금지 |
| `packages/postgres/src/migrate.ts` | CORE_SCHEMA_VERSION 41 | 현재 assertion을 31/옛29 등으로 되돌리지 않는다. 후속 baseline이 이동하면 실제 migration과 기대를 다시 고정 |
| `apps/cli/src/runtime/extension-python.ts` | parent PATH/HOME을 선별 전달. uv python find pin, downloads never, relocatable venv, private scratch에서 frozen/no-dev/no-editable sync, 대상 venv에 설치 | SECOND_BRAIN_HOME과 실제 HOME/uv cache를 혼동하지 않는다. UV_CACHE_DIR를 상위에서 지정하면 그대로 적용된다고 가정하지 않는다 |
| `tooling/bootstrap/test/hook.test.ts` | snapshot 임시 repo/build·임시 home을 case 간 공유. 자체 compose down -v, container 부재 확인. 개별 SLOW=900000. Python flag 1에서만 갱신 보존 case 실행 | hook 파일 쪼개기·case 병렬화 금지. 바깥 build 완료 후에도 hook 내부 snapshot build는 실제 수락 동작이므로 유지 |
| `apps/cli/src/config/resources.ts` | 임시 home hash로 project/volume/label, port는 20000 + hash % 30000 | home이 달라도 port 충돌 가능. slot 동적 port와 hook port는 별도 관리 |
| `tooling/test-changed/{rules.mjs,run.mjs}`, `tooling/test-db/test/test-changed.test.ts` | test-db·test-changed·bootstrap 경로와 config/helper exact는 Python 전체. Python 파일 단독 경로는 파일 선택. run은 Python config 직접 호출. health-perf 규칙 없음 | 새 runner가 package script에서만 작동하면 changed/직접 Vitest가 우회한다. 모든 진입점을 연결·검증하고 새 subprocess 경로 규칙 추가 |

정적 glob 기준은 CLI Python **15파일 + hook 1파일 =16파일**이다. 실제 Vitest collection은 구현 검증 단계에서 별도로 고정한다. 과거 16.6의 17파일·582.6초와 21.8의 15파일·718.55초는 각자의 SHA·선택 집합에서 나온 역사이며 현재 baseline 시간으로 쓰지 않는다. 21.8 중앙 archive의 `final-regression2-report.md`와 `logs/final-20261105T234612Z-40b825f99136/test-python.log`를 읽었으나 성공 로그에 파일별 시간이 없어 현재 최장 순위를 확정할 수 없었다. 원시 보고서·DSN·개인 경로는 공개 문서에 복사하지 않았다.

20.6 계획 `story-core-garmin-epic-16-plan.md`의 제거 목록/결과와 실제 파일 부재를 대조했다. 옛 normalize·body-digest·review-boundaries는 제거됐고, native 이식 시험은 현재 파일로 돌아왔다. `tooling/health-perf` 경로·규칙은 현재 없으므로 18.10 산출물을 다시 만드는 Task는 없다. 부모의 2026-11-05 결정이 옛 Notes를 대체한다. 새 schema41·현행 native/oracle·capture/보존 계약을 기준으로 한다.

## 파일별 Python·PG 준비 인계

아래 이름은 모두 `apps/cli/python-test/` 아래다. 설치 Python은 repo 공용 venv가 아니라 fixture home의 설치 디렉터리 venv다. 설치 검증을 빠르게 하려고 이 venv를 미리 채우지 않는다.

| 파일 | Python/runtime | PG·준비 경계 |
|---|---|---|
| garmin-artifacts.test.ts | 설치 Garmin 3.14.10, 합성 artifact/발행 자식 | extHome 독립 cluster, store·daemon·파일 정리 |
| garmin-batch-import.test.ts | 설치 Garmin 3.14.10, 합성 snapshot·재개 자식 | extHome, SIGKILL/재개·checkpoint 의미 유지 |
| garmin-capture.test.ts | repo .python-version의 3.14.10을 uv python find --no-python-downloads로 탐색, venv 요구 없음 | PG 미사용, 13개 Python case·허용된 플랫폼 skip만 유지 |
| garmin-collect.test.ts | 설치 Garmin 3.14.10·oracle·감독 자식 | extHome, 다중 계정·취소·프로세스 종료 |
| garmin-core.test.ts | Garmin 설치 명령이 private 환경 준비 | extHome, 공통 확장/core 경계 |
| garmin-import-verify.test.ts | 설치 Garmin 3.14.10 | extHome, 현재 검증·변조·비노출 보존 |
| garmin-native.test.ts | 설치 Garmin 3.14.10·독립 SQLite/PG oracle | extHome, native 반입·SQL·동등성 |
| garmin-preflight.test.ts | 설치 Garmin 3.14.10 | extHome, 준비/실패·읽기 전용 경계 |
| garmin-query.test.ts | 설치 Garmin 명령/Python | extHome, CLI/MCP·다중 fixture 격리 |
| garmin-report.test.ts | 설치 Garmin·fake model·감독 자식 | extHome, 장시간 평가·취소·process group 종료 |
| garmin-tracer.test.ts | 설치 Garmin 3.14.10·checker | extHome, 실제 설치·감독자·ABI |
| garmin-unit.test.ts | 설치 Garmin 3.14.10로 unittest discover test_*.py | extHome, GARMIN_TEST_* DSN·개별 결과 보존 |
| garmin-upgrade.test.ts | 실제 설치·갱신·migration | extHome, 기존 버전 및 현행 ledger 보존 |
| install.test.ts | pyfixture/pyresume pin 3.12.13·judge·console entry | extHome, venv 생성/이동·중단 재사용·uv 호출 횟수·marker inode 단언 보존 |
| recall-health.test.ts | Garmin 설치 후 CLI/MCP 자식 | extHome, 명시 합성 health-cases |
| 별도 hook.test.ts | snapshot 설치·Python 보존 3.12.13 fixture, 자체 build | slot PG를 소비하지 않는 자체 compose 전용 lane |

구현 시작 때 이 표와 file/case/pin 목록을 다시 비교해 baseline manifest로 고정한다. 새 파일이 생겼으면 누락하지 말고 범위와 비용을 포함한다. 사전 준비는 pin 탐색 가능 여부·의존성 cache 준비/검사 정책을 실행 전체에서 한 번 동일하게 적용하는 범위다. 저장소 `extensions/garmin/.venv`를 공유 준비하는 옛 요구는 제거한다. 실제 HOME의 uv cache 공유는 가능하되 uv 자체 잠금에 의존하고 실행기가 지우지 않는다. private venv/scratch·설치/재개 검증은 각 fixture가 소유한다. cache cold/warm과 pin 실제 출력은 측정 metadata에 기록한다.

## slot·fixture·hook 소유권 계약

향후 구현 지휘자가 확정할 내부 API 이름은 자유지만 다음 의미는 고정한다.

- 실행 ID와 slot ID, container 전체 ID/name/label, 실제 동적 port, URL(로그에서는 비밀 제거), lease ID, 파일 경계, fixture ID, 자식 PID/PGID·시작 신원, 임시 home/scratch, 정리 시도·오류를 자기 장부에 기록한다. 타인 state를 제어 장부로 쓰지 않는다.
- slot은 run 단위 독립 PostgreSQL18 cluster를 소유한다. host는 loopback 동적 publish로 할당하고 54329·54320 및 운영 URL은 거부한다. 연결 전에 소유 label/ID·port와 TCP 인증을 확인한다. 입력 URL이 있다는 이유만으로 임의 cluster를 소유했다고 보지 않는다.
- global setup이 slot을 시작하고 teardown이 종료한다. worker/file에 명시적으로 slot lease와 cluster URL을 전달하고 `tooling/test-db` → `pg-home` → `extHome`이 소비한다. 전역 process.env를 동시에 바꿔 전달하지 않는다. worker ID·스케줄러 수명이 파일/lease와 일치하는지 증명한다.
- 한 파일의 첫 독립 fixture가 slot cluster lease를 사용할 수 있다. 동시에 존재하는 추가 extHome은 기존 fixture 전용 cluster를 유지하거나 별도 소유 cluster를 받는다. 선행 fixture가 drop되어도 role marker가 남은 cluster에는 새 DB fixture를 배정하지 않는다. 같은 파일 내부 독립 fixture를 강제 공유/직렬화해 concurrency 단언을 무력화하지 않는다.
- 성공 파일 뒤에는 모든 자기 자식·연결 종료, fixture DB 제거, marker가 가리키는 자기 role 정리 완료를 확인한다. core 표준 role은 slot 수명 동안 남을 수 있으나 다른 파일 데이터·extension role marker는 남지 않는다. 불명·잔존·정리 실패 시 재사용하지 않고 해당 소유 cluster를 폐기·재생성한다. 최종 run teardown 뒤 표준 role도 cluster와 함께 사라진다.
- fixture 전용 cluster는 기존 createIsolatedTestDatabase/drop 의미와 재정리 동작을 유지한다. slot lease의 fixture drop은 DB/fixture 자원만 정리하고 slot 전체 삭제 책임은 coordinator에 둔다. `fixtureContainerRemoved`/`fixtureDatabaseDropped` 상태가 실제 소유 대상과 일치하도록 계약을 분리한다. 19.1은 이 경계와 URL을 소비하며 template 최적화는 여기서 하지 않는다.
- hook은 suite별 동일 파일 전체를 한 전용 lane에서 순차 실행한다. 모든 checkout의 hook lane이 같은 호스트 잠금 경계를 사용하게 한다. 잠금 대기 시간도 명령 wall에 포함한다. 소유 PID/시작 신원·실행 ID를 기록하고 timeout·무응답만으로 잠금을 훔치지 않는다. run 식별자로 잠금 파일을 따로 만들어 공유 경합을 피했다고 주장하지 않는다.
- hook의 hash port는 동적 slot port와도 충돌할 수 있다. 시작 전에 이미 점유된 port/project/volume의 소유를 확인해 다른 home/실행이면 fail-closed한다. 정상 격리 실행에서 새 임시 home 재선택 또는 명시 충돌 거부를 시험하되 제품의 homeResources 알고리즘은 바꾸지 않는다. 실제 bind/start 실패 시 성공한 단계의 자기 자원만 정리한다. hook의 공유 home 상태·beforeAll/afterAll·900초 개별 제한·Python 보존 flag는 그대로다.

## 실패·timeout·중단의 판정

assertion 실패 1건과 file timeout 1건을 서로 다른 주입 실행으로 검증한다. 시험 본문에 이미 있는 timeout/case/단언을 줄이지 않고 별도 합성 runner fixture로 강제한다. 부분 container create 성공 후 응답 손실·start 실패, 정리 실패, runner SIGTERM/worker 비정상 종료도 포함한다. 주입 자체의 nonzero는 예상 결과이며 정상 시험 실패를 통과로 바꾸지 않는다.

1. runner는 원래 exit/signal·실패 파일·단계와 정리 오류를 각각 기록한다. 실패한 파일만 retry해서 원래 실행을 성공으로 덮지 않는다.
2. timeout 뒤 테스트 finally만 믿지 않고 coordinator가 자기 child group의 TERM→기존 정리 deadline→필요한 KILL과 실제 종료 확인을 수행한다. hook의 snapshot build 자식도 포함한다. PID 재사용/권한/신원 불명이면 성공 종료로 간주하지 않는다.
3. 소유 marker·장부와 맞는 DB·role·container/volume만 정리한다. 같은 이름 접두사 전체 삭제나 포트만 보고 kill하지 않는다. Docker create 응답이 불명하면 고유 name+label+전체 ID로 복구한다.
4. 실패 slot의 cluster가 삭제되고 port가 반환된 뒤 새 cluster로 다음 파일을 실행한다. 다른 slot의 sentinel 파일이 통과하고, 같은 slot 후속 sentinel과 새 run sentinel도 통과해야 격리 증거다. 깨끗함을 확인 못 하면 slot을 quarantine하고 전체 run 실패로 남긴다.
5. 성공·실패·timeout·중단 각각의 전후 장부/inspect, PG DB·role 목록, 소유 process 종료·port 해제, hook volume 부재를 확인한다. 마지막 container inspect는 정확한 no-such-object와 transport/권한 오류를 구별한다. SIGKILL된 coordinator의 finally는 보장되지 않으므로 외부 소유 watchdog/다음 실행의 명시 복구 절차를 두고 강제 중단 실험에서 확인한다. 불명 자원을 삭제하거나 새 run에 재사용하지 않는다.

## 시간 판정과 실행 순서 — 향후 구현 종료 뒤에만 실행

현재 정제 세션은 아래 명령을 **실행하지 않는다**. 개발·리뷰 수정 중 시험 실행 금지이며 컴파일만 허용한다는 AGENTS 규칙을 향후 구현 Task에 명시한다. 마지막 수정 후 검증 단계에서 아래 대상 측정과 회귀를 수행한다. 측정/회귀에서 실패를 고치면 관련 시험과 test:changed로 재검증하고 최초 실패를 보존한다.

### 대상 고정과 비교

- 기존 보존 성공 기록의 파일별 시간과 현행 manifest를 대조해 최장 묶음을 정한다. 옛 normalize/body-digest는 대체 없이 제거하고 현행 collect/native/report 등 실제 소비자로 대조한다. 현재 최장 순위는 **미측정**이다.
- 동등한 현행 기록은 CLI15파일+hook을 포함한 전체 manifest의 파일별 시간과 실행 결과를 덮어야 한다. 일부 후보의 시간만 있는 기록으로 최장 순위를 정하지 않는다. 그런 기록을 확보하지 못하면 구현 종료 뒤 새 runner 1 slot으로 전체 manifest의 파일별 시간·case 결과를 선정용으로 딱 1회 수집한다. 이는 최장 묶음을 정하기 위한 진단이며 전체 suite를 warm-up+3 성능 표본으로 반복하는 것이 아니다. 이 1회는 뒤의 필수 최종 회귀를 대신하지 않고 비교 비율의 분모로도 쓰지 않는다. 선정 진단이 실패하면 실패를 보존하고 원인을 고친 뒤 누락/실패 파일만 관련 검증해 전체 manifest의 유효 파일별 기록을 완성한다. 전체 진단을 무조건 반복하지 않는다.
- 전체 manifest의 유효 파일 시간을 내림차순으로 정렬해 가장 긴 CLI Python 6파일과 hook 전체를 좁은 비교 묶음으로 고정한다(동률은 경로 사전순). hook이 상위6과 별도인 것은 모든 구성에 같은 직렬 lane 비용을 포함하기 위해서다. 따라서 install/unit/upgrade/query 등도 선정 전에 빠짐없이 관측한다. 최종 SHA·환경·프로파일·선정 근거·파일/case 목록을 1/2/3/4 slot 비교 전에 동결하며 측정 결과를 보고 유리한 묶음으로 바꾸지 않는다. 비교는 이 좁은 묶음으로만 warm-up+3을 반복한다.
- 동일 구현 SHA의 **새 runner 1 slot**이 성능 분모다. 과거 serial runner·옛 583초·파일 시간을 재배치한 175~192초 모델은 참고 열로만 쓴다. baseline과 변경 후 case/단언 동등성은 별도 정적 diff/manifest로 확인한다.
- 1·2·3·4 slot 각각 warm-up 1회 +3표본. 네 구성은 순차 실행하고 측정 host 공통 잠금을 획득한 뒤 시작한다. 잠금 대기는 별도 metadata이며 측정 구간 밖이다. 반면 runner 내부 hook lane 대기는 wall에 포함한다. 다른 성능 작업·build·PG 부하가 겹치면 그대로 기록하고 해당 표본의 무효 근거를 남긴다.
- 동일 Node/pnpm/Vitest/Python pin·lock hash·PG image ID·Docker CPU/RAM·fixture·선택 case·hook 전체 파일과 Python flag·cache/사전 준비 정책·runner 옵션을 고정한다. slot 수만 바꾼다. hook 전용 lane은 모든 구성에 동일하게 포함한다.
- wall은 새 runner 프로세스 시작부터 모든 파일·자식·slot/hook 정리가 확인된 종료까지 monotonic 시간이다. cluster 생성/TCP 대기·venv 준비·hook 내부 build·정리도 포함한다. 바깥 선행 build는 별도 시간이다. warm-up의 자원은 정리하고 timed run마다 새 소유 cluster/home을 사용하되 cache 정책은 동일하게 한다.
- 표본별 파일/case/pass/fail/skip·unittest 하위 결과·exit·wall·시작/종료·자원 정리·Node 자식 user/system CPU와 PG/Docker CPU peak·PG 연결 peak를 기록한다. CPU의 호스트/컨테이너 범위·샘플 간격(예:1초)·연결 집계 범위를 명시해 다른 단위를 더하지 않는다.
- timeout/실패 표본도 원문과 이유를 남긴다. 속도 표에는 동등 case 집합이 통과하고 정리된 유효3표본이 필요하다. 무효 표본은 교체 이유와 원래 결과를 보존하며 단순 느린 표본을 제외하지 않는다.
- 각 구성 중앙값과 `median(N)/median(1)`을 계산한다. 결과 동등성과 자원 검증을 통과하고 비율 <=0.5인 구성 중 중앙값이 가장 작은 구성을 선택한다(동률은 작은 slot 수). 하나도 없으면 E19-5 미충족이며 목표 완화·case 축소·timeout 변경·built로 대체하지 않고 중앙에 수치/한계를 보고한다.

### 기능 검증과 전체 회귀

향후 runner의 정확한 파일/옵션명은 구현 Task1에서 공개 사용법으로 확정해 plan에 치환한다. 아직 없는 실행 명령을 지금 성공한 명령처럼 적지 않는다. 직접·changed 진입점은 아래 기존 명령을 유지한다.

1. 구현 종료 후 `pnpm build`와 필요한 typecheck를 먼저 완료한다. 선택된 PG URL/lease를 적용해 `pnpm exec vitest list --config apps/cli/python-test/vitest.config.ts --filesOnly --json` 및 case 목록과 기존 결과 manifest를 대조한다. 목록 조회도 실행기로 global setup을 일으킬 수 있으므로 정제 세션에서는 금지다.
2. 새 slot runner의 위 좁은 묶음 측정과 실패/timeout/중단·정리 주입을 실행한다. 단독 파일, 전체 선택, test:changed의 Python 전체/선택 경로가 동일 slot lifecycle을 쓰는지 검증한다. 새 Python/SQL/자식 runner 경로는 rules.mjs와 그 시험에 반영한다. 기존 broad rule을 줄이는 것은 19.9다.
3. build를 끝낸 상태에서 `pnpm exec vitest run`과 `pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts`를 한 번 병행한다. 기본 suite에는 독립 검증 cluster URL을, Python suite에는 별도 실행 ID/slot cluster를 준다. hook은 양쪽 선택을 유지하고 공통 lane으로 순차 실행한다. 두 reporter의 결과/skip과 container/role 장부가 섞이지 않음을 확인한다. hook 내부 snapshot build는 별도 임시 tree이므로 checkout dist를 변경하지 않는다.
4. 마지막 전체 명령은 순차로 **`pnpm test` → `pnpm test:python` 각1회** 실행한다. 위 병행 실험은 교차 실행 안전성 검사이고 필수 순차 회귀를 대신하지 않는다. 전체 suite를 성능 표본3회로 반복하지 않는다. 명령 자체 build 시간과 Vitest/runner 시간, exit, 통과/skip, 모든 자기 자원 정리를 기록한다. 옛665/583초와 현재 각1회 시간을 나란히 적되 서로 다른 시험 집합이라는 한계를 표시한다.
5. 위 실패 수정 뒤에는 AGENTS가 허용하는 `pnpm test:changed -- <baseline-ref>`와 관련 시험으로 재검증한다. 검증 실패를 고치지 않은 상태나 미실행 항목이 있으면 built로 처리하지 않는다. 19.5는 Garmin 구현 실행 유예 대상이 아니다.

## 향후 구현 Task 분할과 공유 경계

이번에는 배정·구현하지 않는다. 한 checkout의 소스 편집자는 하나이며 각 Task에 “개발 중 시험 실행 금지, 컴파일 확인만; 마지막 구현·리뷰 수정 후 검증”을 포함한다.

| Task | 소유 변경/완료 조건 | 인계 |
|---|---|---|
| 1 | test-db의 run/slot lease·장부·동적 cluster 시작/정리·부분 실패 모델·기본 config의 기존 외부 URL 호환. 합성 runner 수명 시험 코드 작성 | 소유권·URL·독립 fixture override·정리 상태 API/사용법 확정 |
| 2 | Python config/global setup·pg-home/extHome 연결, 파일 순차·동시 fixture 별도 cluster, 단독/changed 모든 진입점. 기존 fixtures·role·Python pin/venv 계약 유지 시험 코드 | 19.1이 받을 slot URL·lease 소비/반납·기존 isolated fallback 문서 |
| 3 | hook 전용 lane·호스트 공통 잠금/신원·port 충돌 거부/정리·두 suite 병행 wiring, subprocess 경로 선택 규칙 및 의미 있는 실패/timeout/중단 시험 코드 | 19.6은 lane을 소비하고 그 뒤 중복 case 제거. 제품 port 알고리즘 변경 없음 |
| 4 | 모든 구현·리뷰 수정 종료 뒤 위 측정·실패주입·병행1회·최종 순차 회귀. 실패별 수정/관련 재검증·필요 후속 독립 리뷰·증거/결과 계획 | goal·결과/미해결을 중앙 보고. 성능 미달/정리 실패는 built 금지 |

공통 경계는 tooling/test-db·pg-home/extHome·두 Vitest config·hook/test-changed 진입점이다. 구현 착수 중앙은 당시 22.3/8.3 등 실행 중 소스 소유권과 공유 경계를 다시 대조한다. 이번 정적 문서 작업은 이 인프라를 변경·실행하지 않아 그 완료를 기다리지 않는다. 이 문서가 향후 구현 병렬 실행 승인은 아니다.

## 정제 검증 기록

- 설치 bmad-agent-po 공식 render 1회 성공. method scripts stale/missing 안내를 보존하고 setup/update는 금지 범위라 실행하지 않았다.
- 공식 store read의 repo write 절차를 확인했다. 설치 tickets.py find는 프로젝트 `built` 상태를 거부했다. 런북 지정 프로젝트 패치 `_bmad/method/scripts/tickets.py`로 find→pull→status/next를 사용하며 전역/프로젝트 스크립트는 바꾸지 않는다.
- leaf/entry의 id·title·type·after·hitl·risk·covers를 유지한다. after는 20.6, refine=true 유지. refined는 독립 Ticket check의 필수 공백 해소 뒤 true로 한다. status·assignee·중앙 state·main·에픽 상태는 수정하지 않는다.
- 이번 정제의 승인·검증 결과와 독립 Ticket check 처분은 아래 기록한다. build/typecheck/test/eval/성능 측정/PG생성은 모두 미실행이며 향후 구현 검증으로 남는다.

### 독립 Ticket check 처분 — 2026-11-08

- Sol medium fresh current-checkout depth1, 자기 Run `run_3ae5fee956ab`, Task `task_62014eb051bd`, Dispatch `ctx_2434e56e767e`. 원문 `.brain-automation/tickets/19.5/independent-ticket-check.md`, outcome succeeded. 정적 Ticket check에서 medium suggest 1건, fix0/ask0.
- 채택: 후보 밖 파일의 시간을 확인할 경로 누락. 전체 manifest를 덮는 동등 기록 또는 선정용 새 runner 1slot 진단1회로 모든 파일을 관측하고, 가장 긴 CLI6파일+hook을 비교 전에 고정하도록 보완했다. 전체 suite 반복 성능 측정은 하지 않는다. 목표/범위/선행 완화가 아닌 기존 최장 묶음 판정의 공백 보완이다.
- 지휘자 후속 정적 확인: 모든 현행 파일이 선정 입력에 포함되고, 선정1회와 좁은 묶음 warm-up+3·병행1회·최종 순차회귀가 구별된다. 원문 실패/미실행은 보존한다. 추가 독립 확인이 필요한 의도 변경이나 미해결 finding은 없다.
- 중앙의 조건부 정제 승인(중앙 refinement-spec과 사용자 지시)에 따라 leaf refined=true로 갱신한다. 구현/시험/built/done 전이는 하지 않는다. 정식 status/next와 diff 검증 결과는 최종 로컬 보고에 보존한다.
