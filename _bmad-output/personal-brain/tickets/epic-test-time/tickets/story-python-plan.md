---
title: '단독 시험의 Python 전체 선택 좁히기 (19.9)'
type: 'feature'
ticket: '9'
created: '2026-11-09'
status: 'in-review'
baseline_revision: '7b09aead25094304f8aee9359899a69fc477a932'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/.brain-automation/tickets/19.9/independent-spec.md', '{project-root}/.brain-automation/tickets/19.9/investigation.md']
warnings: ['oversized']
deferred: []
operator_actions: []
---

<intent-contract>

## Intent

**Problem:** 시험 파일만 바꿔도 넓은 접두사 때문에 Python 전체가 선택된다. 실제 Python/자식 런타임 입력과 독립 시험 본문을 구별할 근거가 필요하다.

**Approach:** 현 baseline에서 역의존을 추적한 정확 네 파일만 넓은 prefix 판정에서 제외한다. 기본 Vitest changed는 유지하고, 동일 고정 입력을 기준/후보 runner에 모의 자식으로 공급해 v1 선택 기록을 대조한다.

## Boundaries & Constraints

**Always:** 원baseline/schema44 및 migration0001~0044 바이트·query-perf 역사 guard를 보존한다. 구현Terra medium/독립Sol medium 네 렌즈·필요후속. 개발중 시험 실행 금지, 컴파일 확인만; list/PG/재현/측정도 실행하지 않는다. 마지막 실질수정과 독립확인 뒤 전용 환경에서 VITEST_MAX_WORKERS=2 pnpm test → pnpm test:python 순차 각1회. 최초 실패 원문 보존 후 관련 재검증만. hook Python 전용8case·기본changed·migration전체·Python직접파일 선택과 원 API 의미를 보존한다. 입력마다 분류해 혼합 runtime이 전체를 유지한다.

**Never:** test폴더/임의suffix 일괄 제외, fixture/globalsetup/sourcealias/제품/자식 파일읽기 경로 제외, 기능case/단언/timeout 축소, 성능절감량 보장을 하지 않는다. 19.1 DB준비와8.6 검색·공통fixture/제품, run.mjs/record.mjs/기존기록회귀의 무관재작성, plugin/DDL, 중앙main/state·peer자원은 비편집이다. 공용54329·운영DB·실계정·credential을 쓰지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 정확 독립시험 | 네 정확 경로 각각/조합/중복 | Python all→none, 기본changed 관련시험 유지 | 파일존재 검사로 결정하지 않음 |
| 인접·혼합 | fixture/globalsetup/config/source/자식 또는 후보+runtime | 원 Python 전체 및 이유 보존 | 알 수 없는 새 파일도 넓게 유지 |
| migration·직접파일 | SQL 또는 직접 Python시험/후보혼합 | SQL은 Postgres/Python전체, 직접파일은 기존 files | 삭제된 직접파일은 missing |
| 경로형태 | 빈입력·삭제·rename·미추적·구분자·대소문자 | 기존 문자열API/Git no-renames 합집합 의미 | 닮은 경로를 임의 정규화하지 않음 |
| v1 비교 | 고정 최근diff·대표경로 동일입력/동일모의list | 기준/head/input/selection/reasons/stages 비교 가능 | list는 완료manifest가 아님 |
| 기록장애·가림 | 기록불가·민감입력·tracer | 기존 exit/명령 보존·가림·공유시간null | redacted 동일파일 추정금지 |

</intent-contract>

## Code Map

- `tooling/test-changed/rules.mjs`: `rules` prefix·exact·bootstrap의 pythonAll 및 reasons, 별도 migration postgresAll/direct pythonFiles. `classifyChanges`는 경로 정규화/존재 검사를 하지 않는다. 넓은 rules 자체는 보존하고 입증한 네 정확파일만 prefix용 입력에서 제외한다.
- 정확 후보: `tooling/test-db/test/test-changed.test.ts`, `tooling/test-db/test/test-changed-record.test.ts`, `packages/postgres/test/schedule-occurrences.test.ts`, `packages/postgres/test/user-keys.test.ts`. 현재 역참조는 독립 Vitest 등록뿐이다. 각 본문은 rules/runner/SQL/fixture를 읽는 방향이며 Python진입점이 본문을 실행하는 역방향은 없다. 세부 정적 근거를 README에 이관한다.
- `apps/cli/python-test/vitest.config.ts`: Python 시험+hook만 등록, globalsetup→test-db src; `apps/cli/test/pg-home.ts`→test-db/제품postgres/동적shim. 모두 넓게 보존. `vitest.config.ts` 기본 test 등록/sourcealias와 두 패키지 tsconfig src-only build 경계를 재사용한다.
- `tooling/bootstrap/test/hook.test.ts:686`: git ls-files 기반 포괄복사/snapshot/clone/install/build는 후보도 바이트 간접입력으로 읽는다. 본문이 제품build/runtime에서 실행되는 의미입력과 구별한다. package/config/설치경로를 제외하지 않는다.
- `tooling/test-db/test/test-changed.test.ts`: 분류·모의경로 route 및 실제 hook8case 목록 회귀 유지. 양성/인접음성·혼합/형태를 추가한다.
- 새 `tooling/test-db/test/test-changed-selection.test.ts` 및 `test/fixtures/test-changed-selection/`: 기존 기록회귀 패턴을 좁게 재사용하되 기존 파일 무관재작성 금지. baseline rules는 Git 원본 고정 사본+SHA/hash, 최근 티켓 diff 입력도 fullSHA/부모/경로를 고정한다. run/record는 현재 그대로 복사한다. 가짜 git/pnpm/node만 실행하는 독립 회귀이며 실제 child suite를 호출하지 않는다.
- `tooling/test-changed/README.md`: v1 계약 불변, 후보별 역의존·간접 snapshot 한계·양성음성·선택비교 읽는법을 추가한다. tracer shared/null·redacted·불완료/기록장애 의미를 보존한다.

## Tasks & Acceptance

**Execution:**
- [x] 1 `rules.mjs`, `test-changed.test.ts`, `README.md` -- 네 정확 후보 제한·양성/인접음성 및 matrix 분류 회귀·파일별 정적 역의존 증거 작성. 임의 새 후보 추가 금지.
- [x] 2 새 `test-changed-selection.test.ts`와 전용 fixtures -- baseline 고정 rules와 최근19.6/19.8/8.5 fullSHA 부모diff를 동일 모의자식 v1 전후 비교. 대표 정확후보/인접/혼합/migration/direct/missing/삭제rename/4종Git입력·기록장애/가림을 검증한다. 비교결과를 선택 범위로 해석하며 실제선택/성능실측이라고 쓰지 않는다.
- [x] 2a `tooling/bootstrap/test/hook.test.ts` 및 필요한 전용 helper/합성회귀 -- 중앙 msg_4d4013010f49 승인 test-only 실패교정. spawned daemon PID와 raw daemon.pid fullcommit/installed/snapshot·생존을 정확검증, CLI commit은 공개codec 기대와 정확검증. phone형/일반 고정합성SHA 독립기대·원본불변으로 가림계약을검증.
- [ ] 3 지휘자 -- 전체diff와 matrix 정적 감사·4렌즈 독립/필요후속·환경 preflight·최종 TS→Python순차 각1회·실패처분/관련재검증·정확자원회수·built/범위commit/일반branchpush/정확원격SHA·clean/중앙보고.

**Acceptance Criteria:**
- Given 네 후보 단독/조합만 입력, when 기본 changed runner가 분류/실행, then 관련 기본 시험은 그대로 선택되고 Python 전체/list/run이 빠진다.
- Given 각 후보의 인접fixture/globalsetup/config/제품/자식경로 또는 runtime혼합, when 같은 runner를 호출, then 기존 전체선택과 migration/Postgres 및 직접Python 선택이 유지된다.
- Given 고정 최근diff와 대표경로 집합, when 기준/후보에 동일 모의입력·list를 공급, then v1의 full 기준/head·inputs·선택명/이유·단계결과가 차이를 설명하고 의도한 후보전용 외의 선택은 같다.
- Given 삭제/rename/미추적/빈/중복/대소문자/구분자와 기록장애, when 기존 API로 처리, then 원 API/exit/가림·tracer 공유시간 계약이 유지된다.
- Given 최종실질수정과 독립확인이 끝남, when 격리 전체회귀와 자원감사를 수행, then 필수회귀 결과와 정확소유 회수·원baseline/migration 보존·리뷰 처분이 증거로 남는다.

## Implementation Notes

- Terra 리뷰수정 Task3: BH1~7/ECH1 명령·단계·분기실패·가림·고정diff hash·Git4출처·진단을 보강했다. 모든인접경계를 개별case로 유지했다. build/typecheck/diff-check exit0, 개발중시험 미실행.

- Terra 항목2: 고정 baseline rules/hash·최근3티켓 부모diff와 모의자식 v1 비교회귀 작성. build/typecheck/diff-check exit0, 시험/list/PG 미실행.

- Terra 항목1: 네 정확후보 제한과 분류 matrix·README 정적근거 작성. build/typecheck/diff-check exit0. 최초 비확장 build DNS 재시도는 중단 후 확장으로 재실행했다. 시험/list/PG 미실행.

## Plan Change Log

- 중앙 msg_4d4013010f49는 최초Python실패의 test-only 범위확장을 승인했다. Execution2a로 hook시험/필요전용helper·합성회귀만 추가한다. 제품daemon/codec/phone가림·timeout·기존8기능case·선택규칙 불변. raw fullcommit은 snapshot/installed와, raw/status PID는 이번 spawn PID와 정확비교하고 생존을 확인해 과거/다른daemon 통과를막는다. CLI는 가림기대와만 정확비교한다. 같은함수양쪽호출만으로증명하지않고 phone형/일반 고정합성SHA의 독립가림기대·원본불변을검증한다. 랜덤SHA재시도/둘중아무거나허용 금지. Terra컴파일만→Sol실제해결독립확인→hook전체8case와필요합성/관련선택회귀 각1회. 최초전체결과보존·전체중복금지, hook snapshot입력바이트 변화와재검증source를구별한다.


## Review Triage Log

### 2026-11-09 — hook 교정 독립확인

- Sol 새finding0. rawfullcommit=installed=snapshot, raw/statusPID=spawnPID, kill(pid,0)+exit/signal 생존, phone형/일반 고정SHA 독립가림기대·raw객체불변 및 다른PID/commit/죽은process 음성회귀를 원코드에서확인했다. 제품/phone가림·8case/timeout은불변이다.
- 필요한 실행확인은 hook전체8case와 새합성/관련선택회귀 각각1회다. 기본test:changed는 rules/bootstrap변경 때문에Python전체를재선택하므로 명시파일범위를사용한다. 최초전체결과를덮어쓰거나전체재반복하지않는다. hook snapshot입력바이트변화는새재검증source로구별한다.


### 2026-11-09 — 후속 r2

- 새확정finding0. source-only edge-case 재검사 succeeded/[]로 초기절차실패를 보완했다. 독립 수정확인은 BH1~4·BH6/ECH1의 명령·단계·가림·digest고정·입력경계를 확인했다. 실제digest와 시험통과는 최종회귀에서 감사한다.
- BH5는 내용 전면가림과 error name/출력길이·baseline/source 진단을 추가한 제한적개선이다. error.code/실제stderr 상세원인은 여전히 보존하지 않으므로 완전진단해결이라고 쓰지 않는다. 이 선택규칙 변경의 새확정결함은 아니며 비밀/경로노출을 막는 한계를 기록한다.
- BH7은 전체검증집합/시동횟수 유지·개별case분리다. 비용절감으로 해석하지 않는다. 새수정/추가독립리뷰 필요위험은 없고 최종회귀로 진행한다. 후속리뷰권고 false, deferred[] 유지.


### 2026-11-09 — 독립 네 렌즈 r1

- verdicts: 12 findings — high0/medium6/low2/false4/maybe-false0. verification-gap 새finding0. edge-case는 계획이 diff에 섞여 선행읽기 절차실패(outcome failed)이며 성공으로 세지 않는다. 새 source-only diff로 재검사한다.
- `[medium]` `[patch]` BH1 명령계약: 비교가 명령전체를 검증하지 않아 직접 --files/기준ref 공백이 있다. 비Python 명령 완전동등과 Python 분기별 정확인수 단언을 추가한다.
- `[medium]` `[patch]` BH2 전체Python 단계: 공통 비교가 Python단계를 전부 빼서 전체유지 사례의 생략을 놓친다. 동일모드 전체단계 및 전환사례의 정확단계를 단언한다.
- `[medium]` `[patch]` BH3 과거diff 고정: paths를 입력/기대 양쪽으로 쓰면 누락이 검출되지 않는다. Git 원본과 정적으로 재대조한 digest·추출근거를 고정한다.
- `[medium]` `[patch]` BH4 Python분기 실패: default-list 실패만 있어 변경분기 실패 보존이 비어 있다. 혼합전체/direct의 Python list/node 실패·기록불가 명령/exit/단계를 추가한다.
- `[low]` `[patch]` BH5 실패진단: spawn error/stderr를 버려 최초전체 실패진단을 막는다. 제한된 가림 진단을 반환해 단언 메시지에 연결한다.
- `[medium]` `[patch]` BH6 입력출처: 후보단독 untracked/삭제와 후보간rename이 runner 수준에서 빠진다. 네Git출처 정확후보 단독·미존재·후보간rename 모의회귀를 추가한다.
- `[low]` `[patch]` BH7 한case 자식시동 집중: 36runner를 한it에 묶어 진단/timeout 집중을 만든다. 모든 경계를 보존하며 표기반 개별case로 나눈다. 시험/단언/timeout 완화는 하지 않는다.
- `[medium]` `[patch]` ECH1 .gitignore 가림: safePath가 dotfile을 redacted로 기록하는데 원문 diff.paths 단언이어서 실제 실패다. 예상된 가림만 명시한 별도 기대목록으로 교정한다. 가려진 이름의 역복원을 하지 않는다.
- `[false]` `[reject]` IA-A 역의존 상세도: diff에 상세 장부가 없다는 관측은 맞으나 증거 부재 결함은 아니다. .brain-automation/tickets/19.9/investigation.md에 Python config/globalsetup/pg-home→src·동적shim, tsconfig src-only·hook snapshot와 네본문 외향의존/역검색 경계가 보존돼 있다. 공개 README에 핵심 소비자 경로를 더 명시해 추적성을 보완한다.
- `[false]` `[reject]` IA-B 실제목록: 명세가 모의자식/실행없는 선택비교를 먼저 요구한다. 기존 --changed 호출 불변과 모의기록 비교가 현재 증거이며 실제Vitest목록/완료manifest/성능측정이라고 주장하지 않는다.
- `[false]` `[reject]` IA-C 경로상태: 기존API는 문자열/no-renames 합집합이며 모의Git입력은 허용한 선택비교다. 실제Git변형 실측을 새수락gate로 만들지 않는다. 모의출처 누락은 별도 BH6에서 교정한다.
- `[false]` `[reject]` IA-D 최종완료: in-review 단계에 전체회귀/push가 없는 것은 결함이 아니다. 최종gate로 별도 수행하며 미실행을 pass로 쓰지 않는다.


## Design Notes

현재 후보들은 hook 포괄복사에는 포함된다. 이를 파일읽기0으로 주장하지 않는다. 설치/빌드 의미입력은 src·manifest/config·잠금파일이며 독립 시험본문은 등록된 기본 Vitest에서 실행한다. 현재 근거 밖의 파일은 넓게 둔다. 원19.8 합성사본 의존성9경로 오추적과 부분Python중단 관측을 교훈으로 실제선택 관측은 승인 없이 실행하지 않고, 모의자식 비교를 최종전체회귀 안에서 검증한다. 추가 실도구관측이 필수이면 정확범위/횟수/합성입력/시간을 중앙에 먼저 질문한다.

## Verification

- 개발중 `pnpm build`, `pnpm typecheck`, `git diff --check`만. 다운로드/권한이 필요한 명령은 require_escalated. matrix 실행감사는 개발뒤 전체회귀 결과로 마친다.
- 독립4렌즈/실질수정별 필요한 후속 뒤 checkout밖 전용 HOME/TMP/venv/uv cache·전용PG/role을 사용한다. 실제private Dockercontext/Compose·genuine OrbStack status 한인자 위임·관리자postgres암호/DOCKER_HOST 없음 preflight. 자식 ignored job TMP와 부모외부TMP를 구별해 기록한다.
- `VITEST_MAX_WORKERS=2 pnpm test` → `pnpm test:python` 순차 각1회. source/config/UTC/exit/최초실패/log·정확소유 자원ID를 보존한다. 실패수정 후 관련시험 및 `pnpm test:changed -- 7b09aead25094304f8aee9359899a69fc477a932`만 재검증한다. 전체자동반복 금지.
- 모의비교 회귀의 JSON은 v1 입력/선택 범위 증거다. 실제Vitest 관련파일명 실측·완료manifest/시간절감량과 구별한다. 원schema44/0001~0044 hash 대조 및 query-perf/제품/타소유 비편집을 정적으로 확인한다.

## Verification Results

- 최초전체 TS: UTC02:33:16.671396~02:46:03.827813, 767.149초, exit0, 240파일5259시험 pass. 새선택비교61·기존기록37·선택분류9 pass로 matrix 실행감사를 확인했다.
- 최초전체 Python: UTC02:46:03.828250~02:49:51.850731, 228.021초, exit1, 16파일75pass1fail/0skip. hook8개 중7pass1fail; 나머지파일은pass. 전체반복/추가재현은 하지 않았다.
- 실패: hook.test.ts:385의 synthetic snapshot commit에 전화번호 모양 숫자가 들어가 CLI status JSON에서 기존가림계약대로 치환됐으나 시험은 raw installed commit과 비교한다. raw daemon상태와 가려진출력을 구별하는 test-only 교정 후보를 정적으로 조사했다. 제품가림완화/운좋은hash재실행은 하지 않는다. 최소 hook교정 소유범위를 중앙 msg_1b347681f204로 질문했으며 수락조건을 defer로 바꾸지 않는다.
- 전용 외부HOME/TMP/uv/venv·최소privateDockercontext/Compose·genuine orb status단일위임·postgres암호·전용포트37349를preflight했다. 부모외부TMP와 runner내부 ignored jobTMP를 구별한다. 원baseline/schema44/migration44hash·baseline규칙 및고정diff3개Git원본은일치했다.
- 정확소유container262개 모두부재/unknown0, hook project/container/network/volume부재·포트반환·home부재, runner cleanupErrors/quarantine[]다. 원시/소스지문/장부는 .brain-automation/tickets/19.9/verify/와 .brain-test-runs/ecd26435066cb6a54f887b65/에보존했다. 최종Python전체pass나built는아직아니다.

### 교정 후 승인 관련 재검증

- UTC02:59:19.611667~03:00:08.951666, 명시관련4파일109pass/exit0(분류9·기록37·선택비교61·합성2). 이후03:00:08.951948~03:01:23.992852 Python runner --files hook 8pass/0fail/0skip exit0. 전체suite를반복하지않았다. 실패했던daemon사례도 rawfullcommit/PID/생존과공개가림 검증으로통과했다.
- 실행전후tracked+비무시untracked내용지문동일. 최초전체지문대비 hook시험/helper/합성/계획4파일이달라 snapshot입력바이트변화를구별했다. 제품/codec/run/record·migration44개는최초지문과동일했다. 원시/지문/UTC/정확명령·hash는 .brain-automation/tickets/19.9/verify-related/에보존했다.
- 새외부HOME/TMP/uv/venv·privateDockercontext/Compose·genuine orb status한인자·postgres인증/전용포트37618 preflight. sandbox OrbStack접근실패는자원생성전이고확장재실행성공을구별했다. base정확ID부재/포트반환, hook project/container/network/volume/home부재/포트31281반환·process gone, cleanupErrors/quarantine[]를확인했다. 최초bind검사EPERM은후속확장bind성공/리스너부재로해소했다. 원시/HOME/TMP/장부/세션은보존한다.

### 수락 source 통합 예정

- 진행명령 정상종료후 중앙수락19.8 source def615ae783c14b67dd6832a0f879c372272e431와 main a5d40c60614b764f2530f5ec69a12c866c583469를확인했다. incoming4파일은record helper/기록회귀/19.8계획/중앙followups뿐이고 rules·명령·exit·v1형식은불변이다. 원baseline·최초전체/관련결과를보존하며 자기branch에정상통합/독립영향확인·필요관련검증으로마무리한다.
