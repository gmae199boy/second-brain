---
title: 'test:changed 구조화 실행 기록 (19.8)'
type: 'feature'
ticket: '8'
created: '2026-11-09'
status: 'built'
baseline_revision: '4e63538383590b575847754362c61630acd82a3b'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/.brain-automation/tickets/19.8/independent-spec.md']
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** test:changed는 선택 파일을 개수로만 출력하며 단계 비용과 실패/미완료 상태를 구조화해 남기지 않는다. 19.9의 선택 전후 비교에 필요한 입력과 이유가 사라진다.

**Approach:** 기존 명령·선택·종료 동작에 best-effort 로컬 JSON 관측을 붙인다. 실행별 고유 ID와 버전 계약으로 시작/완료/실패/중단/미완료 및 단계 선택 근거를 읽을 수 있게 한다.

## Boundaries & Constraints

**Always:** 원baseline/schema43·19.6 hook Python 단독소유8case·19.5 기본4slot/lease/정확ID회수/기존scratch·명령순서/flags·원exit/signal·자식정리 계약을 보존한다. 기록 쓰기 실패가 명령 실행/결과를 바꾸지 않는다. 시간은 UTC와 monotonic 경과로 구별하고 관측 불명은 null/명시 상태로 남긴다. 선택된 파일·입력·규칙은 repo상대 안전 정규화/가림만 기록하고 외부오류원문·env·credential·개인홈 절대경로는 저장하지 않는다. 같은 checkout 소스편집자1, 구현Terra medium/독립Sol medium. 개발/리뷰수정 중 시험/list/재현/측정/PG생성 실행 금지, 컴파일 확인만. 최종 독립확인 후 전체 TS→Python 순차 각1회.

**Never:** 선택규칙 축소19.9·DB준비19.1 소유 파일·Drive8.5·제품/migration/setup/plugin·중앙main/state·peer자원을 수정하지 않는다. 새 필수gate·성능캐시·시험/단언/timeout완화·전체반복·공용54329·운영데이터·가짜orb응답을 도입하지 않는다. SIGKILL 뒤 teardown 성공을 주장하지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 문서만 | 합성 git변경+list | build→기본changed, PostgreSQL/Python 생략과 이유·선택0 기록 | 기존 exit0 유지 |
| 전체선택 | migration/runtime 규칙+중복 list | 기존순서와 고유파일명·모든 매칭이유·Python runner전체 기록 | 기존 flag/선택 불변 |
| 파일선택 | 직접 Python시험·삭제파일 | 존재하는 파일만 기존 --files, 누락 이유 구별 | 선택0 성공 유지 |
| 앞단계실패 | build/list/run nonzero 또는 spawn 오류 | 실패단계 관측 exit/signal/오류분류, 뒤단계 미실행 | 기존 runner exit1 유지, 원오류 외부원문 기록금지 |
| signal | 실행중 SIGINT/SIGTERM 또는 자식 signal | 관측한 주체·signal·종료와 미완료 구별 | 원전파·자식수명 보존, 기록이 child를 남기지 않음 |
| 강제종료/부분쓰기 | SIGKILL/중단시 snapshot | 완료근거 없는 상태를 incomplete로 읽음, 유효 직전 JSON 또는 미기록 | 정상 teardown 주장금지 |
| 기록불가/동시실행 | unwritable 경로·겹친 두 실행 | 명령/exit 동일, ID 충돌없이 기록 구별 | best-effort, 기록오류가 시험을 막지 않음 |
| 비밀/경로 | 외부 list·ref·민감오류 | 상대 안전값/가림만 구조화 | 전체 env/stdout/stderr 저장금지 |

</intent-contract>

## Code Map

- `tooling/test-changed/run.mjs`: spawnSync 공통 command, build→git ref확인/4종경로수집→classify→기본 list/run→Postgres list/run→Python list/slots전체 또는 --files. list는 현재 Set.size만 반환한다. tracer는 기본 suite 파일에 포함되며 별도 tracer 명령은 없다. tracer 관측은 실제 선택된 tracer 파일/포함단계와 시간을 구별하고 가상실행을 만들지 않는다.
- `tooling/test-changed/rules.mjs`: prefix/exact/bootstrap reasons와 pythonAll/pythonFiles/postgresAll. 19.9 축소 금지. 이유를 파일에 연결할 필요가 있으면 기존 boolean/파일 집합을 보존하는 additive 노출만 허용.
- `tooling/test-db/test/test-changed.test.ts`: 분류 및 fake git/pnpm/node PATH fixture로 실제 run.mjs dispatch를 검증하는 패턴. 실제 list hook0/Python8case 회귀도 이미 있음; 유지한다.
- `.gitignore`: `.brain-automation/`, `.brain-test-runs/` 기존 제외. 새 기록 기본위치를 명시적으로 ignore해 hook snapshot·untracked 입력으로 들어오지 않게 한다.
- `tooling/test-changed/` 새 기록helper/README: run별 JSON atomic snapshot·스키마/읽는법·불명/미기록 정의. 기록 helper는 이 경로의 기존 넓은 Python rule에 포함된다.
- 읽기전용 `vitest.config.ts`, `apps/cli/python-test/vitest.config.ts`, `tooling/test-db/src/python-slots.ts`: 소유config/runner/flags/자원/cleanup계약. 19.1의 fixture/pg-home/index/cluster/lease와 migration0001~0044 불변.

## Tasks & Acceptance

**Execution:**
- [x] 1 `tooling/test-changed/` 기록 helper 및 `run.mjs`, `.gitignore` -- 단계관측/선택명·이유/비교ref·SHA·입력·best-effort/고유원자적 snapshot 통합. 기존 선택/명령/종료 불변.
- [x] 2 `tooling/test-db/test/test-changed.test.ts` 및 필요 전용회귀 -- 위 matrix 모든 행의 모의자식 계약 회귀 코드 작성. 기록 enabled/불가의 명령순서·exit/signal 동등성과 비밀가림/강제종료/동시실행을 검증. 시험 실행 금지, 컴파일 확인만.
- [x] 3 `tooling/test-changed/README.md` -- version/필드·위치·읽는법·시간/exit주체·생략/미완료·tracer포함단계/기록실패 계약을 19.9가 소비할 수 있게 기록.
- [x] 4 지휘자 -- diff/matrix 감사·4렌즈 독립리뷰·필요수정/독립후속, 전용환경 preflight 뒤 전체TS→Python 각1회·실패별 관련재검증·정확자원감사·built/commit/일반branchpush/중앙보고.

**Acceptance Criteria:**
- Given 합성 변경과 list/실행 결과, when 실제 runner를 호출, then 한 실행의 버전 JSON에서 기준/head·입력·파일명/이유·각단계 시작/끝/경과/exit/중단·완료상태를 복원한다.
- Given 문서전용/전체Python/직접파일/앞단계실패, when 기록 성공과 기록불가를 대조, then 선택과 명령순서/flags·기존 종료코드가 동일하고 실제 선택목록과 기록이 일치한다.
- Given signal/강제중단/부분쓰기/동시실행, when 기록을 읽고 자식을 확인, then 불명/미완료를 성공으로 분류하지 않고 각 실행을 구분하며 기존 자식수명/신호전파를 보존한다.
- Given 민감 경로·ref·자식오류와 env, when JSON을 읽음, then 금지값 없이 repo상대 안전값·분류만 있고 README 계약으로 후속19.9가 해석할 수 있다.

## Implementation Notes

- Terra Task1 기록통합 build/diff-check exit0, Task2 matrix회귀/README typecheck/diff-check exit0. 최초typecheck 배열타입 오류는 같은 Task에서 교정했다. 개발 중 시험은 미실행.

## Plan Change Log

## Review Triage Log

### 2026-11-09 — Review pass r4 resolution

- R3-1 resolved, 새finding0. Sol 독립확인이 Stripe 두접두·입력/이유/기본/직접파일 가림·명령인수보존 정합을 확인했다. r1~r4 보고는 `.brain-automation/tickets/19.8/`에 보존한다. 마지막실질수정과 독립확인 종료, 최종전체회귀로 진행한다.

### 2026-11-09 — Review pass r3 resolution

- verdicts: 1 finding — medium1, 나머지0. `[medium]` `[patch]` R3-1 Stripe접두 구분자 — 새패턴 sk-live-는 실제 sk_live_/sk_test_를 가리지 못한다. 구분자 직접교정과 합성회귀를 보완한다. R2-1 GitHub PAT 및 입력/이유/선택/명령보존은 독립확인 resolved.

### 2026-11-09 — Review pass r2 resolution

- verdicts: 1 finding — high0/medium1/low0/false0/maybe-false0.
- `[medium]` `[patch]` R2-1 알려진 credential접두 — ghp_ 형태가 allowlist와 가림패턴을 통과한다. 알려진접두/인증정보형태 최소가림과 입력·이유·선택명 합성회귀를 보완하고 후속 독립확인한다. 임의불투명값 자동판별 보장은 하지 않는다.
- r1의 signal/baseline·오류·시간·입력/장애회귀는 독립코드확인에서 resolved. 시험은 미실행.

### 2026-11-09 — Review pass r1

- verdicts: 17 findings — high 2, medium 10, low 1, false 4, maybe-false 0. 네 렌즈 원문을 보존하고 아래 각 행을 개별 판정했다. IA는 서술형 A~F를 각각 판정했다. 지휘자 추가 C1도 별도 계산했다.
- `[high]` `[patch]` BH1 신호리스너+spawnSync — 기본 signal종료를 새 리스너가 지연시킨다. 새 리스너를 제거해 원래 동기 runner의 즉시 종료를 보존한다. 관측 못한 runner-only signal은 incomplete/불명으로 남기며 child signal은 계속 관측한다.
- `[medium]` `[patch]` BH2 credential 형태 경로 — api-key/sk-proj 합성키가 현재 allowlist를 통과한다. 안전한 제한 패턴 가림과 회귀를 보강한다.
- `[medium]` `[patch]` BH3 ENOBUFS 분류 — 시작실패와 출력한도 초과가 spawn-error로 합쳐진다. 제한된 오류분류와 원signal관측을 분리하고 원 exit1은 보존한다.
- `[low]` `[patch]` BH4 시간경계 — UTC/monotonic 시작점을 HEAD읽기 전 같은 경계로 이동한다.
- `[medium]` `[patch]` BH5 baseline 비교부재 — enabled/blocked 둘 다 변경runner여서 공통신호회귀를 놓친다. 원baseline runner의 고정 fixture와 명령/exit/신호수명을 대조하고 signal 후 즉시 release로 결함을 숨기지 않는다.
- `[medium]` `[patch]` BH6 네 입력출처/중간Git실패 — 출처별 응답·합집합 중복제거와 실패부분snapshot 회귀를 보강한다.
- `[medium]` `[patch]` BH7 중간쓰기/rename 실패 — 실제 helper 경계 제한주입으로 직전JSON·불완료·명령/exit불변과 갱신중parse를 검증한다.
- `[high]` `[patch]` ECH1 runner신호지연 — BH1과 동일 결함/수정이며 행은 보존한다. 새 신호리스너 제거와 baseline 비교를 따른다.
- `[medium]` `[patch]` VG1 linkedworktree HEAD — loose/packed ref·상대commondir 회귀를 추가한다. 실제 구현결함 단정이 아닌 검증공백이다.
- `[medium]` `[patch]` VG2 inputReasons 연결 — migration/extension/direct/docs 혼합의 입력별 정확이유·플래그 회귀를 추가한다.
- `[false]` `[reject]` IA-A tracer고유비용 — 현재 별도tracer실행이 없고 선택불변과 불명구분이 명시돼 있다. 공유단계/null은 의도상 허용되며 독립시간을 만들어내지 않는다.
- `[false]` `[reject]` IA-B 실제내부manifest — 원문이 기존list 개수→파일명 보존을 명시한다. 개별it/import graph설명·하위내부manifest 새계약은 요구하지 않는다. README에서 list관측이며 실행완료manifest가 아님을 명확히 한다.
- `[medium]` `[patch]` IA-C baseline보존 검증 — BH5와 같은 공백이며 동일 고정fixture 비교로 보완한다.
- `[medium]` `[patch]` IA-D 장애종류 검증 — BH7과 같은 공백이며 실제write/rename제한주입 회귀로 보완한다.
- `[false]` `[reject]` IA-E usage호출 — 유효파이프라인 진입 전 기존 exit2이며 시험실행이 없는 호출이다. README에 기록범위를 명시한다. 모든invalid호출의JSON까지 새필수gate로 만들지 않는다.
- `[false]` `[reject]` IA-F 인도미완료 — 진행중인 in-review이고 검증/push 미완료를 숨기지 않는다. 최종gate에서 완료한다.
- `[medium]` `[patch]` C1 지휘자 fake escape — TS template안의 과도한 이스케이프가 fake JS의 개행/NUL 대신 literal 역슬래시를 출력해 command log JSON과 git입력 회귀를 깨뜨린다. 생성문자열을 올바르게 교정한다.

- 정정: 위 개별행 기준 total17 = high2/medium10/low1/false4/maybe-false0. 첫 집계줄의 오기를 이 값으로 정정하며 개별행을 우선한다.
- 후속 독립확인은 signal/baseline·장애주입·가림과 회귀fixture의 실제정합에 필요하다. 개발중시험금지는 유지한다.

## Design Notes

- r1 신호수정: spawnSync의 기본 신호종료를 보존하려면 runner-only signal을 JS에서 관측하지 못할 수 있다. 새리스너로 종료를 지연시키지 않고 snapshot incomplete/null로 남긴다. child signal/일반실패는 관측대로 구별한다.

- tracer는 현행 기본 changed 명령의 일부다. 별도 명령을 추가하면 선택불변을 깨므로 포함관계를 기록하며 독립 측정할 수 없는 tracer 전용 시간은 unknown/공유단계로 명시한다.
- 원 runner는 명령 실패를 최종exit1로 변환한다. 관측한 자식exit와 최종runner exit를 혼동하지 않고 기록 추가만으로 exit정책을 변경하지 않는다.

## Verification

- 개발/리뷰 수정 중 `pnpm build`, `pnpm typecheck`, `git diff --check`만. 의존성 다운로드가 필요한 컴파일은 처음부터 require_escalated.
- 마지막 실질수정·독립확인 뒤 checkout외 전용 HOME/TMP/venv·실제 Docker context/Compose·genuine orb status 한인자 위임·PG암호 전제/DOCKER_HOST명시override거부를 preflight한다. 다른 자원/전역context는 불변.
- `VITEST_MAX_WORKERS=2 pnpm test` → `pnpm test:python` 순차 각1회. 최초 UTC/source/명령/exit/log·시간·환경/소유자원 장부를 보존한다. 실패 수정 뒤 관련시험 및 `pnpm test:changed -- 4e63538383590b575847754362c61630acd82a3b`만 재검증한다.
- 전체TS에서 새 모의자식 회귀 모든 matrix 행의 실제 pass를 감사한다. 실제 관련 실행의 JSON/선택/명령 정합을 확인하며 기록검증을 이유로 전체suite를 반복하지 않는다.
- 최종 소유 정확ID 자원 부재·금지경로/비밀 미기록·gitignore/untracked집합·원baseline·remote branch SHA/clean을 확인하고 중앙Run run_eeb956b860e8에 보고한다.


## Verification Results — 2026-11-09

- 원baseline `4e63538383590b575847754362c61630acd82a3b`/schema43을 보존했다. 최종실질수정·독립확인 뒤 최초 필수 `VITEST_MAX_WORKERS=2 pnpm test`는 **237파일/5042시험 pass, exit0, 742.9058초**, UTC01:36:42.641487~01:49:05.549991이다. 새 기록회귀37개와 기존선택회귀8개 모두 실제pass다.
- 이어 최초 필수 `pnpm test:python`은 **16파일/선택고유76case pass, exit0, 229.3816초**, UTC01:49:05.550423~01:52:54.932972이다. Python runner run `a85322b1f128f76456b54cfc`, report의15개garmin-report shard는 각각1회, hook8case도 포함한다. 두 필수전체명령을 병행하지 않았으며 각1회 정상완료했다.
- raw `verify/final-source.json`은 전체회귀 당시 HEAD/소스파일별SHA256, `final-results.json`은 원명령/UTC/exit/시간, `final-ts.log`, `final-python.log`는 원출력을 보존한다. 아래 관측실수나 후속incoming통합의 소스를 이 최초전체pass소스로 소급하지 않는다.
- v1 계약: `.brain-test-changed/<UUID>.json`, `version/id/status/startedAt/endedAt/elapsedMs/runnerExitCode/interruption/comparison/inputs/selection/stages/tracer`. comparison은 ref/baseSha/headSha, selection은 default/postgres/python/pythonMode/postgresAll/reasons/inputReasons/pythonMissing이다. stages는 명령별 name/status/UTC/monotonic/exitCode/signal/error 및 생략reason을 담는다. 완전필드/불명/가림/공유tracer 해석은 `tooling/test-changed/README.md`에 있다. 실제실행완료manifest나 성능캐시가 아니며 runner-only미관측신호는 incomplete다.

### 실제 runner 관측의 준비실수와 처분

- 별도 격리합성사본에서 문서변경1건의 실제 Git/pnpm/Vitest list 정합을 확인했다. 첫 관측은 symlink node_modules가 pnpm 안전검사에 거절되어 **build실패/runner exit1**이었다. 기록은 failed와 뒤단계prior-failure를 정합하게 남겼다. 제품결함이 아닌 사본의존성 준비실수이며 안전검사를 끄지 않았다.
- 사본의존성을 독립복사로 고친 두번째 관측에서, 준비 때 의존성symlink9개가 합성Git에 추적됐던 실수를 미리 검사하지 못했다. symlink→directory가 삭제입력9개로 관측돼 기존넓은규칙이 **의도하지 않은 추가Python전체 선택·부분실행**을 시작했다. 필수전체각1회만 실행했다거나 추가heavy가 전혀 없었다고 숨기지 않는다. 지휘자의 관측준비 오류다.
- 자기합성사본 Run `77bd4fb35f7a4f0d537e793e`의 coordinator PID/start를 장부와 ps로 대조하고 SIGTERM을 보냈다. Python은143, 상위runner는1로 종료했다. rawreport signal=SIGTERM, quarantine0이고 cleanupErrors는 **unassigned files**1행이다. 이는 미실행집합표시이며 정상전체완료나 새기능실패로 바꾸지 않는다. 실제 자원부재는 별도정확ID감사로 확인했다. 최초필수전체pass는 그대로 보존한다.
- 합성Git의 잘못된 의존성index만 교정하고, 실행전에 tracked변경0/미추적문서정확1건/최종소스지문일치를 검증한 마지막 관측은 **exit0**, 실제입력문서1개/default선택0/Python none/모든하위run생략이었다. 전체suite를 다시 정상실행하지 않았다. raw attempt1/2/최종JSON·log·head·시간·중단영수증을 `verify/real-record-smoke*`, `smoke-attempt2*`에 보존한다.
- root선택회귀가 남긴5개JSON도 valid v1이고 개인홈절대경로0이다(`verify/record-audit.json`). 모의자식계약과 실제도구의 문서전용list관측을 구별한다.

### 환경과 자원

- checkout밖 전용 HOME/TMP/uv cache/uv Python설치영역, private Docker설정의 genuine orbstack context/Compose, orb status 한인자만 원래HOME로 genuine실행, DOCKER_HOST없음·관리자postgres암호를 preflight했다. 공용54329·운영서비스·실계정·실transcript를 쓰지 않았다. parent HOME/TMP와 사본/venv/원시/장부는 보존한다.
- 기존19.5 runner의 자식TMP는 ignored `.brain-test-runs/<run>/<file>`이다. 모든자식도 외부TMP였다고 쓰지 않는다. 새기록 `.brain-test-changed/`는 git check-ignore와 untracked목록에서 제외됐다.
- 필수회귀·관측의 장부가 소유를 입증한 **249개정확containerID 전부부재**, unknown0이다. 마지막 전용PG도 이름/라벨/ID재대조 뒤 제거했다. hook2개 project/container/network/volume부재와 portbind를 확인했다. 정상hookhome은부재, 중단관측hookhome은합성증거로보존돼있다. 운영자원/peer자원 정리는 하지 않았다(`verify/resource-audit.json`).

### 수락 main 통합

- 중앙은8.5 source `ed915a226b26f7e14dda67003c0a94b8706399c8`, main `8839c35408cbd02e07d2d6b62ebd848cdb03e4ca`/schema44를 수락했다. 진행명령 종료 뒤 자기branch에 정상merge하고 incoming영향/독립확인/관련선택검증을 수행한다. 원baseline·최초전체결과·관측실패 이력은 변경하지 않는다. 추가전체자동반복은 하지 않는다.


### 수락 main 통합 결과

- 19.8 source `f361d8d40a8170c0e1fd470d665428440d7d782a`를 보존한 정상 merge HEAD는 `93d4bb20d6b52cf6bf98744388b16a67dcdb2fe6`이다. 중앙수락 main `8839c35408cbd02e07d2d6b62ebd848cdb03e4ca`/schema44를 포함한다. 19.8 source/helper/rules/회귀는 incoming에 의해 바뀌지 않았다.
- 통합 build/typecheck/diff-check exit0. 원baseline과 비교한 migration0001~0043바이트 동일, 새0044와 postgres자식fixture3개는 기존넓은규칙에 모두포함된다. query-perf4파일의baseline39/current44·미래45거절·0044manifest정합은 독립Sol이 확인했다.
- incoming73경로 각각의 원분류와 현재분류는 동일하다. 실제Vitest list는 기본185/Python16, exit0이며 하위suite는 실행하지 않았다. 이 선택이면 Python/Postgres전체를 고르지만 추가전체반복은 하지 않았다(`verify/incoming-selection.json`).
- 독립 `review-incoming-evidence.md`는 새finding0, 관련45시험이면교차계약확인에충분하다고판정했다. 이후 위 mergeHEAD에서 **관련2파일45시험 pass/exit0/22.3184초**, UTC02:04:55.582855~02:05:17.901635를확인했다(`verify/incoming-related.json/log`). 최초전체를merge후전체pass로소급하지않는다.
- root 기록은 최초회귀5개+관련회귀5개로총10개 valid v1/절대홈값0이다(`verify/record-audit-final.json`). 원시/사본/브랜치/워크트리/세션/장부는보존한다.

## Operator Actions

- 추가운영입력·계정조치없음. 중앙의결과수락/main병합·push와사용자인수는별도다. 보존한합성증거영역을자동삭제하지않는다.

## Auto Run Result

- 상태 **built**(사용자인수전). 실행단계·전용Run/Task/Dispatch·최초Terra ready/depth1·최상위부모없음·원baseline·검증/리뷰/자원증거는 `.brain-automation/worker.json`과19.8로컬보고에보존했다. 최종범위commit/일반branchpush·정확원격SHA/clean영수증은 `.brain-automation/tickets/19.8/final-report.md`에서확인한다. 중앙main/state는변경하지않는다.
- 구현: runner의기존선택/명령/exit를유지하며v1 JSON관측을추가했다. `.gitignore`는기록입력혼입을막고, `record.mjs`는안전필드/atomic best-effort snapshot, README는소비계약, 전용회귀와고정baseline/preload는matrix와비간섭을검증한다. rules와제품/migration은19.8에서편집하지않았다.
- 리뷰: 공식4렌즈r1의17행(high2/medium10/low1/false4)을개별triage했다. 채택항목은신호/가림/오류/시간/fixture/검증공백수정과r2~r4 독립확인으로해결했다. r2/r3각medium1(가림접두/Stripe구분자)도수정·독립확인했다. IA-A공유tracer/IA-B list표면/IA-E usage범위/IA-F 진행중인도는원문과실행구조근거로기각했다. deferred는단일빈목록이다.
- 후속리뷰권고 **false**: r1의높은위험수정에필요한독립확인과수락main교차계약/증거감사가끝났고미확인기능결함은없다. 관련45시험까지실제통과했다.
- 검증: 최초필수전체TS237파일5042시험/Python16파일76case exit0을순차확보했다. 새기록37+기존선택8 pass, 실제도구문서전용관측pass, incoming컴파일/목록/분류/관련45pass. 별도관측준비오류로발생한추가Python부분실행의SIGTERM중단과미배정표시·상위exit1은위에원형보존했다. 이를정상완료로꾸미지않는다.
- 한계: 첫전체는원소스/schema43+19.8구현의결과이며incoming/schema44는수락8.5증거·독립영향감사·관련검증으로확인했다. tracer시간은공유단계/null, list는실제완료manifest가아니며runner-only신호는미관측incomplete일수있다. 임의불투명비밀완전판별보장은없다. parentHOME/TMP와중단hookhome은합성증거로보존돼있고PG/container/volume잔존과구별한다.


## 수락 후 최소 교정 — 알려진 sk- 접두 누락

- 중앙 지시 `msg_0a05a2a0a4c6`(2026-11-09)에 따른19.8후속교정이다. 원baseline `4e63538383590b575847754362c61630acd82a3b`와최초전체/추가부분실행이력은보존한다. 이번시작점은중앙수락main `7b09aead25094304f8aee9359899a69fc477a932`, 기존제출 `892b62f9384885cc1878818b1a9ced2e62f99529`를포함한다.
- 결함: `docs/sk-ABCDEFGHIJKLMNOPQRST.txt`가현재safePath를통과하지만읽기전용core `packages/core/src/domain/secret-patterns.ts` api_key패턴은 `(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{16,}`를비밀로인식한다. 새접두보강은core의문자집합/길이/왼쪽경계를대조하고기존가림을약화하지않는다. 실제비밀·실사용자환경조회는금지한다.
- 허용소스편집은 `tooling/test-changed/record.mjs`, `tooling/test-db/test/test-changed-record.test.ts`, 이계획뿐이다. v1필드/기록상태·실제경로선택/runner명령/exit는불변이다. 19.9소유 rules.mjs와기존선택시험(test-changed.test.ts), core패턴·기타제품·README는읽기전용이다.
- 구체관측: Given core api_key패턴의sk-합성값과경계값, when 실제runner의모의자식계약fixture가기록을생성, then16자이상허용본문은입력/이유/기본·Postgres·Python·tracer선택/직접·누락목록과JSON에원문을남기지않으며실제명령에는원경로가전달된다. Given15자/왼쪽alnum·underscore로차단된가짜접두/일반파일명, when동일관측, thencore패턴의양음성및기존정책과맞게일반경로를보존한다. 기존sk-proj같은보수적가림은유지한다.

### Followup Execution

- [x] F1 Terra medium — 허용helper/record회귀2파일의접두누락과core대조/합성양음성/JSON모든기록경로회귀를최소교정한다. 시험 실행 금지, 컴파일 확인만.
- [x] F2 Sol medium — 실제수정과원core경계대조·기존가림/선택/명령/exit/v1불변·허용편집경계를독립확인한다. 시험실행금지.
- [x] F3 지휘자 — 마지막수정·독립확인뒤전용합성HOME/TMP의관련record시험파일만재검증한다. 기존최초전체회귀후속규칙에따라전체/test:changed/list/성능/PG는추가실행하지않는다. 범위commit/자기branch일반push/정확원격SHA/clean과 `ticket-result:19.8-followup` 중앙보고를남긴다.

### Followup Verification

- 개발/리뷰수정중 build/typecheck/git diff --check만. 처음의6Task Terra는settled이며새Terra를배정해컨텍스트누적을피한다. 기존보존세션은닫지않고동시소스편집자1을유지한다.
- 독립해결확인뒤 `VITEST_MAX_WORKERS=2 pnpm exec vitest run --project test-db tooling/test-db/test/test-changed-record.test.ts`만실행한다. 새원시/UTC/HEAD/소스지문/exit/회귀수를 followup디렉터리에보존하고기존결과를덮어쓰지않는다.


### Followup Implementation Notes

- Terra는core와같은case-sensitive sk-패턴(허용본문16자이상/왼쪽alnum·underscore차단)을추가했다. 기존credentialShape와sk-proj보수적가림은유지하며schema/runner/분류는변경하지않았다.
- 새회귀는core실제SECRET_PATTERNS api_key표현식을가져와15/16/초과길이·왼쪽영문/숫자/underscore/하이픈경계를대조하고JSON입력/이유/모든suite/tracer/직접/누락경로와명령원경로·기록불가exit동등성을검증한다.
- build/typecheck/diff-check exit0, 개발중시험미실행. worker_done의filesModified목록은시험파일만표시했으나실제Git diff에서허용helper+시험2파일수정을확인했다. 계획은지휘자수정이다.


### Followup Review Triage

- Sol `ctx_477fcaae36fc` 독립실제해결확인: 새finding0. core실제export의sk-허용문자/16자이상/왼쪽alnum·underscore차단과helper동등성, JSON모든기록경로/원경로명령인수·기록불가exit불변·기존보수적가림·허용3파일범위를확인했다. 상세 `followup/sol-review.md`를보존한다. 이정적확인을실제시험pass로소급하지않고관련record파일검증으로진행한다.


### Followup Verification Result / Auto Run Result

- 상태 **built 유지**, 수락후후속교정이며done으로올리지않는다. Terra medium구현/컴파일과Sol medium독립실제해결확인(새finding0)을완료했다.
- 허용2소스파일+자기계획만바꿨다. core api_key의알려진sk-16자이상/허용본문/왼쪽경계누락만보강했고기존가림·v1·실제경로선택·runner명령/exit는불변이다. rules.mjs·test-changed.test.ts·core/제품·README는읽기전용으로보존했다.
- 독립확인뒤관련명령 `VITEST_MAX_WORKERS=2 pnpm exec vitest run --project test-db tooling/test-db/test/test-changed-record.test.ts`만실행했다. **1파일38시험 pass, exit0, wall23.2996초**, UTC2026-11-09T02:56:57.235876→02:57:20.535803. 신규core경계/모든JSON기록경로/기록불가·원경로명령회귀가포함됐다.
- 전용합성HOME/TMP와unused loopback PG URL을사용했고실제비밀·사용자설정·credential을복사/조회하지않았다. 추가전체/test:changed/list/성능/PG생성은실행하지않았다. 원최초전체/추가부분실행/중단및원시를이번결과로덮어쓰지않는다.
- raw/명령/UTC/exit/소스지문은 `.brain-automation/tickets/19.8/followup/record-result.json`, `record.log`, `record-source.json`, 구현/독립확인은 `terra-report.md`, `sol-review.md`에보존한다. commit/자기branch일반push/정확원격SHA·clean/중앙 `ticket-result:19.8-followup` 영수증은같은followup디렉터리에보존한다. 중앙main/state/peer소유는변경하지않는다.
- 후속미해결0/deferred단일빈목록/추가운영입력없음. 기존list/sharedtracer/미관측신호·임의불투명비밀판별한계는그대로이며추가독립리뷰권고false다.
