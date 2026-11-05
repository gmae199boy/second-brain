---
title: '21.6 Garmin 감독 입력 검증 중복 정리'
type: 'refactor'
ticket: 6
created: '2026-11-06'
status: 'built'
baseline_revision: 'b940389693e61eb6f61b9c5398efd7853a669a01'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context: [AGENTS.md, _bmad-output/personal-brain/automation/runbook.md, extensions/garmin/README.md]
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 21.3·21.4의 collect/report 감독 봉투가 ABI·generation·UUID·snapshot 검증을 중복하고, collect가 설정 검증을 위해 report_runtime을 불러 분석 의존을 가진다. 이 유지 지점을 줄이는 에픽 내부 정리다.
**Approach:** 확장 내부 공통 감독 입력 모듈에 중복 순수 검증과 설정 검증을 모으고 두 소비자는 각자 Config/필수값/공개 오류를 소유한다. 관찰 가능한 입력 수락·거부와 결과는 유지한다.

## Boundaries & Constraints

**Always:** self/connection/work/attempt·정규 UUID·generation·DB URL·snapshot exact keys/version/user를 유지한다. collect는 기존 json.loads의 마지막 중복 키 값 수락, report는 모든 깊이 중복 키 거부를 유지한다. collect는 모델/채널 필수가 아니고 report/regenerate는 둘 다 필수다. Config 기본값·경로·검증 순서와 InvalidCollectInput/InvalidReportInput 분류를 보존한다. package 산출물은 공식 생성기로 동기화한다. 시험 실행은21.8로 이관, 미실행.

**Never:** 새 보안/설정/운영 정책이나 기능 추가, core 수정, 고정 SQLite oracle·적용 migration·원본 계산/프롬프트/schema 변경. credential 승인/복구·raw/current·revision/최신view·scope재개·후손정리/bodyIPC·모델대기transaction0·파일/채널 의미키·예약 성공/날짜/user/target·사용자예약/삭제표식/회계·query NULL/집계/가리기·disable자료보존·설치quiesce를 바꾸지 않는다. 운영/실계정/모델/DB/설치/예약 실행, fixture/checker/시험 실행, main 병합/push·중앙state·공용follow-ups 변경 금지.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 정상 감독 입력 | collect/report/regenerate, 서로 다른 합성 user/connection/work/token·설정 | 기존 AccountContext와 Config 값/경로/기본값 그대로 | DB·외부 I/O 전 순수 검증 |
| 봉투 거부 | 잘못된 ABI/kind/target/DB URL/generation/UUID/snapshot shape/version/user | 각 기존 InvalidCollectInput/InvalidReportInput | run에서 store/외부 진입0 |
| JSON 중복 | 루트 및 values 내부 중복 키 | collect 마지막 값 수락, report/regenerate 거부 | 기존 소비자 차이 보존 |
| typed 설정 | 잘못된 값/미지키·모델누락·채널누락 | 공통 typed 검증 유지, collect 모델/채널 없이 가능, report는 필수 | 기존 오류·필수성 유지 |
| 배포 | 공통 새 Python 모듈·두 호출처 변경 | package 같은 바이트·파일목록/digest·이전 구현ref와 version 일치 | 기존 설치/검사 계약 그대로 |

</intent-contract>

## Code Map

- `extensions/garmin/src/collect_runtime.py::envelope`: ABI→DB URL→generation→canonical UUID→snapshot 검사 후 report_runtime.validate_settings를 내부 import한다. Config 및 collect 보호/credential/SQL/성공근거는 그대로 둔다.
- `extensions/garmin/src/report_runtime.py::envelope`, `validate_settings`, `_uuid`, `_unique_object`: 같은 봉투검사와 설정 원천. report만 object_pairs_hook으로 중복 거부. 채널/model/timezone/home/Config·run/validate_account/install_skills는 소비자 소유다.
- 새 `extensions/garmin/src/supervised_input.py`: 공통 검증·canonical_uuid·validate_settings를 두며 decode 함수는 허용 work kinds와 duplicate key 정책을 명시 인자로 받는다. AccountContext와 values만 반환하고 Config/예외 래핑/실행 I/O를 소유하지 않는다.
- `extensions/garmin/tests/test_collect_runtime.py`, `test_report_runtime.py`: 기존 환경 builder와 공개 envelope/run 검증 관찰 재사용. 새 `test_supervised_input_contract.py`는 두 소비자 결과와 거부·I/O0·중복키 비대칭을 직접 단언한다. helper만 재호출하는 시험은 피한다.
- `apps/cli/python-test/garmin-unit.test.ts`: test_*.py를 무조건 discover한다. `tooling/test-changed/rules.mjs`의 extensions/ prefix가 신규 모듈/시험을 이미 포괄하며 `tooling/test-db/test/test-changed.test.ts`에 구체 경로 사례를 더한다.
- `tooling/package-garmin/build.mjs`: source src 자동 포함·manifest.files/plugin_version/digest 생성. `plugins/garmin/app-ref`, `.claude-plugin/plugin.json`은 구현 commit 뒤 release에서 이전 구현commit ref·version 0.1.2와 package.plugin_version/digest를 함께 갱신한다.

## Tasks & Acceptance

**Execution:**
- [x] 1. `extensions/garmin/src/supervised_input.py`, `collect_runtime.py`, `report_runtime.py` — 중복 순수 봉투/UUID/설정 검증을 공통화하고 collect→report_runtime import를 제거한다. 기존 동작 차이와 예외 경계를 유지한다.
- [x] 2. `extensions/garmin/tests/test_supervised_input_contract.py`, 필요 기존 runtime 시험, `tooling/test-db/test/test-changed.test.ts` — matrix의 소비자 수락/거부·Config·I/O0·중복키/typed/필수성 경계를 합성 시험코드로 작성한다. 실행하지 않는다.
- [x] 3. `extensions/garmin/README.md`, `plugins/garmin/package/**` — 정리와21.8 인계를 문서화하고 공식 package 생성기로 새 모듈/바이트를 동기화한다. 지휘자가 구현commit→ref/version releasecommit·최종push를 담당한다.

**Acceptance Criteria:**
- Given 기존 감독 입력과 합성 경계 입력, when collect/report/regenerate 공개 envelope/run을 소비하면, then 기존 context/Config·수락/거부·오류분류와 외부진입 순서를 유지하는 등록 시험코드가 있다.
- Given 정리된 제품 코드, when 정적으로 호출부를 추적하면, then 중복 감독 봉투검사는 한 모듈에 있고 collect의 report_runtime 의존이 없다.
- Given 새 package, when 파일목록/바이트/identity를 정적 대조하면, then source의 공통 모듈이 포함되고 digest/ref/version 계약이 동기화돼 있다.
- Given 최신 시험 유예, when 마무리하면, then 독립 thorough/필요 후속리뷰·정적컴파일·built·commit·티켓push 증거와21.8 미실행 인계가 있다.

## Implementation Notes

- R1 보완: BH1 중복블록을 직접삭제하고 BH2~7의 소비자교차kind·검사순서·선택문자열/timeout/scheme/generation 정상경계·collect 기본값 단언을 추가했다. 지휘자가 수정diff/시험본문을 확인했고 package생성 종료0이다. 독립후속리뷰로 원인지적 해결을 재확인한다. 시험미실행.

- Task3: README에 공통 검증과21.8 인계를 적고 공식 package 생성 종료0을 확인했다. 새모듈/두 소비자/manifest.files/digest를 재생성했다. ref/version은 구현commit 뒤 release로 분리한다.

- Task2: 새 공개소비자 계약시험6개 메서드와 경로분류 사례를 작성했다. 지휘자가 matrix별 context/Config·run 사전거부/I/O0·루트/values/깊은중복·typed/필수성 단언 및 garmin-unit의 test_*.py discovery를 정적으로 확인했다. 시험 실행은21.8로 이관, 미실행.

- Task1: 공통 decode_envelope/canonical_uuid/typed 설정을 추출하고 두 소비자를 이식했다. 지휘자가 diff와 새 모듈을 읽어 기존 검사 순서·예외 경계·collect 마지막중복값/report 중복거부 차이를 확인했다. collect→report_runtime 참조0건. 실행/시험 없음; Task2/3은 별도 순차 배정한다.

## Plan Change Log

## Review Triage Log

### 2026-11-06 — Review pass R2 최종 독립확인
- verdicts: 0 new findings — high 0, medium 0, low 0, false 0, maybe-false 0
- 원문 `.brain-automation/review-r2-verification.md`가 BH1~7 각각의 분기 도달성과 단언/중복삭제를 추적해 해결확인했다. 추가 제품회귀·검증공백·잘못된단언·검사실패0이다. R1의7행(중복검사1·계약시험개선6)을 모두반영했으며 defer/기각/미해결0이다. 정적확인이며 실행통과판정이 아니다.


### 2026-11-06 — Review pass R1
- verdicts: 7 findings — high 0, medium 5, low 2, false 0, maybe-false 0
- 원문: 로컬 `.brain-automation/review-r1-{edge-case-hunter,blind-hunter,intent-alignment,verification-gap}.md`. EC/VG 확정결함0, IA 확정의도위반0이다. BH의 개선7행을 각각 판정한다. 승인된 시험미실행은 결함이 아니다.
- findings:
  - `[low]` `[patch]` BH1 collect 문자열중복 검사 — 공통 _STRING_SETTINGS가 네 키를 모두 검사하므로 뒤 분기는 도달불가다. 직접삭제·package재생성으로 유지지점을 줄인다.
  - `[medium]` `[patch]` BH2 다른 감독kind 상호거부 공백 — 현재시험은 garmin.import 거부뿐이며 collect의 report/regenerate 수락회귀를 못 잡는다. 모든 필수설정을 갖춘 교차kind 입력을 추가한다.
  - `[medium]` `[patch]` BH3 검사순서 관찰공백 — 단일실패만으로 ABI/DB/generation/UUID/snapshot 순서 회귀를 구분못한다. 복수실패의 기존 cause를 직접관찰하는 최소 단언을 추가한다.
  - `[medium]` `[patch]` BH4 선택 문자열키 타입공백 — connection_id/capture_manifest/legacy_conversation_id가 목록에서 빠지면 다른거부가 없을 수 있다. 기존허용 문자열키별 숫자/null 거부를 추가한다.
  - `[medium]` `[patch]` BH5 timeout 정상경계 공백 — 현재45만으로 상한축소/정수float거부 회귀를 못 잡는다. 1/9007199254740991/45.0의 소비자 Config를 직접단언한다.
  - `[medium]` `[patch]` BH6 DB scheme·generation 정상경계 공백 — postgresql:// 및9자리 정상generation 수락을 추가한다. 현재제품 거부결함은 아니다.
  - `[low]` `[patch]` BH7 collect에 report설정 존재시 기본값 관찰공백 — 현재기본값시험은 설정생략뿐이다. 기존마지막루프에 collect의 (None,high,20) 직접단언을 추가한다.


## Design Notes

착수 범위 근거:21.2·21.3·21.4 deferred0,21.5의 유일한 BH04는 원본 Markdown 날짜상대그래프 링크의 단독 소비 한계다. 새 URL/압축/소비UX는 새 규격이므로 제외한다. 네 계획 Code Map/Design Notes/Review Triage/Auto Run Result와 공용 follow-ups를 대조했으며 알려진 필수 수정은 모두 선행 티켓에서 해결 기록이다. 이번 중복은21.3/21.4 입력 코드의 실제 동일 검사에서 확인했다. 단순 모듈 이동을 넘어 두 개의 봉투검사 유지 지점과 collect→report 의존을 줄인다.

선행21.3 보호tokenstore/binding운영자 증거,21.4 KST서술/명시재생성 전체시도/reject unreadable/실패 pending,20.4 A1/legacy안전거부/offline운영자확인/hook·JSON·yes 제한,20.3 attempts 누적은 이번 범위 밖이며 그대로 보존한다. 운영설치·계정/예약전환은21.7이다. 공용 follow-ups는 중앙 소관이라 수정하지 않는다.

## Verification

이번 실행은 `pnpm build`, `pnpm typecheck`, `PYTHONPYCACHEPREFIX=<temp>/brain-21-6-pycache python3.14 -m compileall -q extensions/garmin/src extensions/garmin/tests plugins/garmin/package/src`, `git diff --check`만 수행한다. 로그·종료코드를 `.brain-automation/`에 남긴다. package 생성은 산출물 제작이며 설치/검사/시험 실행이 아니다.

**시험 실행은21.8로 이관, 미실행.** 새 시험은 기존 garmin-unit unittest discover에 등록하고 분류시험에 경로를 명시한다.21.8은 README의 전용 소유PG/role/compose·격리home·합성자료/fake외부를 준비해 선행20.6·20.1~20.5·21.2~21.5 및 이번 영향 시험을 모두 포함한 `pnpm test` → `pnpm test:python` 순차 실행·실패별 최소수정·관련재검증을 수행한다. 이번 영향은 garmin-unit/collect/report/core/native/query·package 동기화·test-changed 분류다. 기대는 위matrix와 선행계획/README의 oracle 동등성·재개/동시성·파일/채널·예약/보존이다. 준비/정리는 기존 harness의 직접 소유 자원에만 한정한다. 기준SHA·환경/소유자원·명령/종료코드/로그·실패처분·재검증을 기록한다. 새·기존 시험 미실행 또는 미해결이면21.8 built/21.7 시작 금지다.

## Auto Run Result

- 결과: **built**(사용자인수전). 공식 bmad-build-auto full/thorough로 착수 범위를 확정하고 Terra/medium의작은Task3개·R1보완1개를 같은워커에 순차배정했다. 두감독소비자의 공통봉투/UUID/typed설정 검증을 `supervised_input.py`에 모으고 collect→report_runtime 의존과 남은 중복 문자열검사를 제거했다.
- 변경파일: 공통모듈과 collect/report runtime은 순수검증 유지지점 축소, `test_supervised_input_contract.py`는 공개소비자10메서드의정상/거부·I/O0·중복/순서·typed/경계 관찰, test-changed시험은새경로분류, README는21.8인계, Garmin package는새모듈/동일소비자/manifest.files/digest동기화다. core·기존시험·oracle·migration·계산·프롬프트·schema는변경하지않았다.
- 독립리뷰: R1 Sol/medium 네렌즈 모두완료(EC0·VG0·IA의도위반0·BH7개개선). R1판정 medium5/low2 모두patch, high0·false0·defer0. R2 독립verification이7개각각해결·추가발견0을확인했다. 원문은로컬 `.brain-automation/review-r1-*.md`, `review-r2-verification.md`다. R1에는medium5patch여서후속검토를수행했고 최종R2patch0·미확인새위험없음으로 `followup_review_recommended=false`다.
- 정적컴파일: `pnpm build`, `pnpm typecheck`, 임시PYTHONPYCACHEPREFIX의 `python3.14 -m compileall -q extensions/garmin/src extensions/garmin/tests plugins/garmin/package/src`, `git diff --check`가 보완후모두exit0이다. 실제명령/종료코드 `.brain-automation/compile-r2-results.json`, 전체로그 `build-r2.log`·`typecheck-r2.log`·`python-r2.log`·`diffcheck-r2.log`. lockfile고정의존준비exit0이며추적lock변경없음. 공식package생성은산출물제작이지설치/검사/시험실행이아니다.
- **시험 실행은21.8로 이관, 미실행.** 직접/changed/전체·fixture생성/checker·합성수집/반입/평가·실모델·운영연결을실행하지않았다. matrix의코드등록/정적리뷰확인만수행했으며 기능시험통과를주장하지않는다.
-21.8 인계: 선행20.6·20.1~20.5·21.2~21.5와이번영향시험모두포함한 `pnpm test` → `pnpm test:python` 순차실행·실패별수정/관련재검증필수. 이번직접영향은garmin-unit(신규10메서드 discovery)·collect/report/core/native/query와package/경로분류다. README의전용소유compose/PG/role·격리home·합성자료/fake외부를준비하고기준SHA/환경/소유자원·명령/종료코드/로그·실패처분/재검증을남긴다. 자기소유자원만harness/compose절차로정리한다. 새·기존시험미실행/미해결실패시21.8 built/21.7 시작금지다.
- 잔여위험: PG/oracle/실권한·credential crash/fsync·모델후손/bodyIPC·예약경쟁·파일/채널비동기·설치/전체회귀의실행결과는21.8에서만확정된다. 신규운영조치없음. 선행BH04문서링크한계/보호tokenstore귀속증거/KST서술/명시재생성·reject/실패pending·20.4 A1/quiesce/legacy안전거부/offline확인/자동hook·JSON·yes제약·20.3 attempts는 Design Notes의처분대로보존한다. 새제품/보안/운영정책추가없음.
- 티켓branch정상hook commit/push·원격SHA확인뒤실제최종보고파일을작성·내용확인해중앙Run으로보낸다. main병합/push·에픽전이·중앙state/공용follow-ups변경은하지않는다. worktree/branch/세션/증거는보존한다. 구현commit뒤별도release에서이전구현commit참조·Garmin pluginversion0.1.2·package.plugin_version/digest를함께갱신한다.

- 릴리스: 이전 구현commit `4be310a8ab97bddcf5a80f565f7d9bf5ab0f9a44`을 Garmin app-ref로 선택하고 plugin version0.1.1→0.1.2와 package.plugin_version/digest를 같은releasecommit에동기화한다. 제품source/SQL/시험코드는구현commit뒤변경없다. 최종branch/remoteSHA는실제최종보고에남긴다.
