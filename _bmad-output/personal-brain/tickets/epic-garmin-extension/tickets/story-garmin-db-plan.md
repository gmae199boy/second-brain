---
title: '통합 시험 실행·수정'
type: 'chore'
ticket: 8
created: '2026-11-06'
status: 'in-review'
baseline_revision: '505188d3a2259f058988c2dd4f68f8dbce4a7b57'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 1
followup_review_recommended: false
context: [AGENTS.md, extensions/garmin/README.md, .brain-automation/independent-spec.md, .brain-automation/21.8-investigation.md]
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 20.1~20.5·21.2~21.6은 기능 시험 실행이 유예되어 새 Garmin 및 공용 계약의 실제 통합 성공이 아직 입증되지 않았다.

**Approach:** 고정 기준에서 전용 소유 PG·격리 home·합성 자료와 fake 외부 경계로 새·기존 시험을 실제 실행한다. 실패별 최소 수정과 관련 재검증, 독립 thorough 리뷰 및 최종 전체 회귀로 전환 전 검증을 완성한다.

## Boundaries & Constraints

**Always:** `pnpm test` 다음 `pnpm test:python`을 순차 실행한다. 전체 stdout/stderr·시각·정확한 종료 코드·실행 SHA/dirty diff와 수집 목록, 자원 소유권/정리 내역을 보존한다. 미해결·미실행은 built와 21.7을 막는다. 고정 oracle와 적용 migration은 불변이다.

**Never:** 실계정·실모델·운영 DB/원본 프로그램·운영 전환, main 병합/push, 중앙 state/공용 follow-ups/에픽 상태 수정. skip 추가·시험 삭제·assertion 축소·원인 없는 timeout 증가로 실패를 숨기지 않는다. unrelated 개선은 하지 않는다. 개인 홈 절대 경로를 공개 문서/프롬프트/커밋에 쓰지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 공용 및 Garmin 회귀 | 전용 PG·합성 fixture·fake 외부 경계 | T/P/U 시험과 capture 시험이 실제 실행되며 실패 0 | 실패를 기능/fixture/환경으로 분류하고 최소 수정 후 재검증 |
| 실행 누락 | 선행 AC와 실제 수집 결과 | 새·기존 파일/메서드 대조에서 미실행 0 | 선택 경로 보완·상세 로그 보존, 누락이면 built 금지 |
| 중단/재개·경쟁·권한 | native/collect/report/core 시험의 crash·stale·NULL·독립 oracle | 선행 계획의 불변·복구·보존·정규화·조회 계약 충족 | 계약을 완화하지 않고 원인 수정 |
| 자원 충돌 | 기존 컨테이너/포트가 이미 사용 중 | 고유 이름·빈 포트로 새 소유 PG 생성 | 기존 자원을 재사용/삭제하지 않음 |

</intent-contract>

## Code Map

- `package.json`, `vitest.config.ts`: T 전체 TS 프로젝트 및 build/typecheck.
- `apps/cli/python-test/vitest.config.ts`: P 전체 Python 통합 TS 래퍼와 hook update.
- `apps/cli/python-test/garmin-unit.test.ts`: U discovery, 소유 owner/extension/app DSN. 성공 시 개별 메서드 로그가 사라지는 공백을 보완한다.
- `tooling/garmin-import/test_capture.py`: 기존 합성 capture 시험. 전체 명령에 현재 연결되지 않았으므로 P 래퍼로 선택을 보장한다.
- `tooling/test-db/src/{global-setup,index}.ts`, `apps/cli/test/{ext-fixture,pg-home,environment}.ts`: 명시 BRAIN_TEST_DATABASE_URL, 무작위 DB/role, 임시 home와 withoutHarnessFolders.
- `extensions/garmin/tests/`, `tests/oracle/src/`, `fixtures/native/`: 합성 PG/독립 SQLite/fake 경계. 고정 원본은 변경하지 않는다.
- `.brain-automation/21.8-investigation.md`: 선행 20.6·20.1~5·21.2~6 전체 계획/리뷰와 실제 파일을 대조한 AC→시험→T/P/U 표. 정적 선택 증거이며 실행 결과로 채워야 한다.

## Tasks & Acceptance

**Execution:**
- [x] 1. `apps/cli/python-test/garmin-unit.test.ts`, 새 capture 래퍼 및 필요 `tooling/test-changed/rules.mjs` — 개별 Python 실행 로그와 기존 capture 시험의 전체 선택을 보장한다. 선언된 조건부 skip은 사유/영향을 기록하며 임의 제거하지 않는다.
- [x] 2. `.brain-automation/environment.md`, `resources.json`, `logs/` — 버전/lock/기준과 기존 자원을 읽기 확인한 뒤 고유 PG18 tmpfs 컨테이너 및 소유 시험 환경을 준비한다. 의존은 frozen lock으로 설치한다. 기존 54329는 점유돼 있으므로 사용하지 않는다.
- [x] 3. `.brain-automation/logs/`, `failure-ledger.md` — 동일 checkout에서 `pnpm test`→`pnpm test:python`을 실제 순차 실행한다. 비영 종료는 원인 수집의 산출물이며 Task 자체 실패로 취급하지 않는다. 원시 로그와 실행 manifest를 보존한다.
- [ ] 4. 실패한 소스/fixture/시험 파일 — 실패 장부의 계약 경계별 최소 수정과 관련 시험 재검증. 제품 바이트 변경은 Garmin package 재생성, app-ref 변경은 이전 commit 참조와 version 동반 증가. 새 Python/SQL/자식 전용 경로는 changed 규칙도 보완한다.
- [ ] 5. `.brain-automation/coverage.md`, 계획 및 리뷰 파일 — AC→파일/메서드→실제 로그를 대조하고 선언 skip 영향을 판정한다. 독립 full/thorough 리뷰와 필요한 후속 수정/리뷰를 수행한다.
- [ ] 6. `.brain-automation/logs/`, `ticket-21.8-report.md` 및 본 계획 — 최종 코드의 두 전체 회귀를 순차 완료하고 소유 자원만 정리한다. 미해결 0일 때 built·정상 hook commit·티켓 branch push·remote SHA 확인 후 실제 보고서 전체를 읽고 중앙 Run에 전송한다.

**Acceptance Criteria:**
- Given 선행 계획의 모든 수락조건, when 실제 전체 시험과 수집 로그를 대조하면, then 기존 공용 및 Garmin 새·기존 시험에 실행 누락이 없고 선언 skip의 정확한 범위/영향이 설명된다.
- Given 고유 소유 PG18 및 합성 fixture, when `pnpm test` 다음 `pnpm test:python`을 실행하면, then 최종 코드에서 두 종료 코드가 0이고 모든 실패의 최소 수정/관련 재검증 증거가 있다.
- Given 제품 수정과 실행 증거, when 독립 thorough 리뷰 및 필요한 후속 리뷰를 마치면, then 필수 보완·미해결 실패·필수 미실행이 0이다.
- Given 완료 증거와 자원 소유 목록, when 마무리하면, then 자기 자원만 정리하고 built 및 티켓 branch remote SHA/최종 보고가 있으며 중앙의 main 확인 전 21.7은 시작하지 않는다.

## Implementation Notes

- 공식 render full/thorough 성공. Git metadata refresh는 권한 확장 후 성공, 기준 branch clean 확인. 최초 Orca 조사 `ctx_732ea64b2087`/`task_c554808418eb`, 자기 Run `run_10bae991a6ba`, ready 영수증 보존.
- Node v24.17.0, pnpm 12.16.1, Python 3.14.10. 기존 PG 컨테이너 8개와 54329 점유 확인. 이들의 데이터베이스에 접속하지 않는다. 현재 node_modules 없음.

- Execution 1: capture 래퍼/개별 unittest 결과 출력 및 changed 분류 보완. 정적 diff 확인 완료, 실제 실행 검증은 Execution 3에서 수행한다.

- Execution 2~3: PG18.6 소유 컨테이너 포트33134, pnpm frozen 설치. 최초 T 86 실패/P 35 실패, 모두 exit1. 전체 원시 로그·장부 보존. built 불가.

## Plan Change Log

- 전체 선행 조건702행의 단언 대조에서 실제 행동444·역사처분189·비시험정적66·외부관찰공백3을 식별했다. 미연결 checker의 유효 미대체 단언은 COV-A/B로, CAS conflict·비교불가 version·native unsupported의 세 원문 matrix 가지는 COV-C로 실행 보완한다. 새 기능이 아니라 기존 AC 시험 누락을 닫는 범위이며 과거 schema16 거부는 현행16수락 계약으로 대체된 이력으로 보존한다.


- Python 환경이 migration 뒤 준비되는 실제13.3 회귀를 확인했다. 4f/4f1 두 부분 결과의 계획 공백을 독립 Sol 설계 검토로 보완했다(`.brain-automation/python-design-review.md`). owned prepared stage의 relocatable/non-editable 환경 선행 및 stage를 보존하는 SQL 멱등 수정 경계를 선택한다. 이전 활성환경·owner gate·applied checksum·source symlink 거부를 유지하며 실제 relocation/fault 시험을 완료조건으로 한다. 실행 순서는 4f2 stage SQL 보존 API/복구 → 4f3 환경 선행/relocation → 후속 리뷰다.


## Review Triage Log

- Python 전환 설계/후속 독립 Sol 검토: 4f2·4f3 고정 diff의 확정 결함 0건. DDL0·same-stage correction·목표고정·owner/tree 거부·실제 relocation 및 관련 로그를 확인했다. 전체회귀/전체 AC 대조 gate는 미완료다. 원문 `.brain-automation/python-transition-followup-review.md`.


## Verification

- 소유 DSN을 명시해 `pnpm test` → `pnpm test:python` 순차 실행, 최종 상태 각각 exit 0 및 전체 로그.
- 실패별 관련 파일 재실행(명세가 직접 승인) 또는 `pnpm test:changed -- 505188d3a2259f058988c2dd4f68f8dbce4a7b57`.
- 실제 수집 파일/메서드 및 선언 skip를 AC 대조표와 확인. source SHA와 dirty diff digest를 각 실행에 기록.
- `git diff --check`, 독립 리뷰/후속, 정상 hook commit/push 후 `git ls-remote` SHA 대조.

## Review 준비 — 2026-11-06

4a~4n의 제한 재검증과 COV-A/B/C 보완을 완료했다. 최종 전체 두 회귀와 최종 수집 대조는 미완료이며 현재 성공으로 판정하지 않는다. 4m의 기존79 checker 행은 현재 계약과 역사 변경을 구별했고, 4n은 세 외부 실패표면을 추가 검증했다. 이번 전체 diff의 독립 thorough 네 렌즈를 먼저 수행하고 필요한 수정 후 최종 순차 전체 회귀를 수행한다. 원시 로그와 상세 보고는 `.brain-automation/fix-4*-report.md`에 보존한다.

## Plan Change Log — thorough pass1 계약 경계 보완

14건을 `.brain-automation/review-triage-pass1.md`에서 개별 판정했다. 원인별로 PG 생명주기, Python prepared 환경 재확인/빌드 부산물/취소, 배포 버전 갱신, capture/native 관찰 경계를 보완한다. 제품 무결성을 지키며 빌드 공간을 분리하고 정상 환경 재개에서는 sync를 반복하지 않는다. 이전 패키지→새 패키지의 실제 갱신과 실패 중간 컨테이너 정리·정리재시도를 검증한다. 사용자 보존 지시에 따라 선행 변경을 유지하고 원인 경계만 재도출한다. KEEP: 기존 고정oracle/적용migration, stage소유·SQL목표고정·crash복구·relocation·기존 실패로그·안전거부·현재 전체 사례를 보존한다. 회피할 상태: DDL 뒤 환경손상 발견, backend 부산물로 활성화 뒤 무결성실패, 같은version 새digest 거부, 준비/정리 실패 자원누출.

## Review Triage Log

### 2026-11-06 — Review pass1
- verdicts: 14 findings — high 0, medium 14, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[bad_plan]` VG1 — 새 createIsolatedTestDatabase 실패 catch의 remove는 있지만 생성 후 실패 시 실제 제거·타fixture 보존 시험은 없다. 실패주입 계약을 추가한다.
  - `[medium]` `[bad_plan]` EC1 — install.ts 동일version/differentdigest 거부가 실제 배포패키지 소비를 막는다. 확장1.2.1/plugin0.1.3 및 이전패키지→새패키지 갱신 관찰을 계획에 추가한다.
  - `[medium]` `[bad_plan]` EC2 — pg_isready 기본 Unix socket과 실제 mapped TCP 접속이 다르며 createDatabaseAt 재시도는 없다. 실제 TCP 인증준비 경계를 추가한다.
  - `[medium]` `[bad_plan]` EC3 — extHome cleaned=true가 db.drop 성공보다 앞서므로 실패한 rm 재시도가 생략된다. 진행중 공유/실패 재시도·정리완료 후 완료표시를 추가한다.
  - `[medium]` `[bad_plan]` BH1 — EC1과 같은 원인. 배포 manifest version과 plugin version이 그대로인 것을 확인했다.
  - `[medium]` `[bad_plan]` BH2 — prepared에서 completed(environment)이 실제 .venv 검증을 생략하고 digest가 .venv를 제외한다. 재개 때 실행가능/pin 확인, 실패DDL0 및 기존stage 보존을 추가한다. 정상 성공환경에 sync 반복은 금지한다.
  - `[medium]` `[patch]` BH3 — 환경 fact/mark 후 signal 검사에서 cancelled()를 우회해 progress.result null이 남는다. 기존 cancelled 경로를 사용하고 저장직후 abort를 주입한다. bad_plan 경계 재도출에 함께 보존한다.
  - `[medium]` `[bad_plan]` BH4 — EC2와 같은 원인. Unix socket 초기서버 성공으로 TCP ready를 증명할 수 없다.
  - `[medium]` `[bad_plan]` BH5 — 새 execFile Docker 호출에 개별 timeout/signal이 없어 준비 반복횟수가 총상한을 보장하지 않는다. 생성/준비/정리 명령을 유한하게 하고 소유ID를 보존한다. 시험 timeout 증가는 하지 않는다.
  - `[medium]` `[bad_plan]` BH6 — EC3과 같은 원인. 완료flag가 실패 후 재시도를 막는다.
  - `[medium]` `[bad_plan]` BH7 — uv sync는 stage에서 backend를 실행하고 전체digest는 build/egg-info를 제외하지 않는다. backend의 source 부산물 경계를 허용한 환경 설치계약에 공백이 있다. 합성 backend로 재현 후 원본제품무결성·relocation·같은stage 보존을 유지하며 빌드 작업공간을 분리한다. 무조건 산출물을 digest 제외하는 해결은 금지한다.
  - `[medium]` `[bad_plan]` BH8 — 취소시험은 부모PID만 관찰한다. 기존 그룹종료 계약에 실제 자손PID·소멸 관찰을 추가한다.
  - `[medium]` `[bad_plan]` BH9 — unsupported 시험의 파일목록은 실행전만 수집되고 일부 보존표가 제외된다. 종료후 전체목록/hash 및 빠진 보존표 전체를 비교하도록 보완한다. 제품이 이미 오염시킨다는 주장은 아니다.
  - `[medium]` `[bad_plan]` BH10 — capture wrapper는 unittest OK(skipped=N)도 허용한다. 현재 FS 조건부1개 이외 메서드 skip을 구별해 거부하는 수집증거를 추가한다. 현재 skip추가가 있다는 주장은 아니다.

IA는 확정 의도 변경0건이며 여섯 관찰 표면 설명을 수락했다. 필수 최종 실행과 누락0은 아직 미완료다.

## 증거 사고 — 2026-11-06

5b 구현자가 환경 확인 중 기존 실행스크립트를 source하여 최초T raw/start 및collection raw를 덮어썼다. 독립복구감사는 T86/P35 식별자121/121와원래행을 대조했고 P raw/plain byte동일성을 확인했으나 최초T raw byte와start원파일·collection raw/정확조회시각은 미복구다. T85397byte 보존텍스트와 당시보고/archived실행기록은 남아 있다. `.brain-automation/evidence-index-correction.md`로참조를정정하며 중앙에역사텍스트수용판단을요청한다. 새최종회귀로과거raw가복구됐다고주장하지않는다. 재발방지로모든신규로그는고유디렉터리/배타생성하고기존실행스크립트를source하지않는다.

### 중앙 역사 증거 사용 범위 수용

중앙 message `msg_1c15fbd0bf0b`는 직접 해시 대조와 별도사본보존 후 T85397byte 텍스트/실패121개/출처명시시각/최초185·15이름집합의 제한적 역사사용을 수용했다. 최초T raw전체동일성·원래start·collection raw/정확시각 미복구 사실은 남으며 원래raw보존충족이나built승인이 아니다. 사고재실행과옛종료기록을결합하지않는다. 최종전체회귀/누락0/미해결0/필요후속리뷰는별도필수다. 같은역사복구감사반복은종료한다. 기존runner는원문을별도보존하고source/직접실행모두거부하도록퇴역시켰다.

### Pass1 수정 결과와 후속 리뷰

5a의 실제 TCP/실패정리·재시도4시험,5b·5b1의 환경재확인/취소/부산물격리 및실제package재개6시험,5c의배포1.2.1·plugin0.1.3/실제이전패키지갱신/native전체보존/capture13결과보완을 수행했다. 관련TS180·41 및P6·9 제한검증을 각보고에 보존했다. 네렌즈후속독립리뷰로해결여부와새회귀를확인한다. app-ref release와최종전체T→P/누락대조는미완료다.

### 2026-11-06 — Review pass2 (followup)
- verdicts: 2 new findings — high 0, medium 2, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` EC2-1 docker rm이 실제제거후timeout이면재시도시없는ID를계속삭제실패 — remove catch가실제부재를확인하지않고id를유지한다. 정확ID inspect의부재확인만성공으로인정하고존재/관측불명은오류·재시도유지하는최소수정과실제실패주입시험을수행한다.
  - `[medium]` `[patch]` BH2-1 역할정리SQL실패가소유컨테이너/home정리를막음 — roles await뒤에만db.drop/homes.cleanup이있어finally보장이사라졌다. 단계별정리를끝까지시도하고원래오류와정리실패를보존하며PG중단/SQL실패회귀를수행한다.

앞선14건은 네후속리뷰에서수정된실제분기/시험으로해결을확인했다. IA의6표면설명은결함수로세지않으며VG새공백0이다. 새2건은관련PG정리경계만최소수정한다. 후속pass의patched high0이므로계산상전체후속권고false이나새실패정리결과확인을위한집중독립검토는수행한다. 최종전체회귀는별도필수다.

### 2026-11-06 — 집중 후속 완료

EC2-1/BH2-1 정리패치의고정438행과실제코드/시험/5d로그를독립Sol이대조해두건해결·새회귀0을확인했다(`.brain-automation/review-cleanup-final.md`). 관련10시험·생성15/제거15 ID일치·exit0을검토했으며직접중복시험은하지않았다. 최종전체회귀를시작하며추가실패시수정/재검증후해당최종gate를다시충족한다.

### 전체 후보 회귀와 6a 처분

후보실행20261105T225201Z-f9711333에서T186파일/4204통과·기존hook조건부skip1/exit0, P15파일/65통과·core1실패/exit1이었다. 실패는합성clock전진으로채널재시도가미완료관찰보다앞설수있는실행가능경쟁을6a제어재현으로입증했고clock전진을최초500정산뒤로고정했다. 원래실패당시상태는진단부재로소급확정하지않는다. 수정뒤core2/hookP8통과·START/PASSmarker, 독립Sol검토추가결함0을확인했다. 후보실행에서변경된tracked생성pyc는실행전hash=HEAD임을확인하고변경사본보존후정확기준바이트로복원했다.

검토된구현commit과그이전commit을참조하는release를분리한다. 이구현commit은built판정이아니며, 최종release상태의전체T→P와coverage/누락0/실패별최종처분을완료한뒤상태를built로기록한다. 전체raw/해시/시각은고유실행ID로보존한다.
