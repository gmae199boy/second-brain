---
title: '21.4 감독 분석·체성분 이식과 scope 재개'
type: 'feature'
ticket: 4
created: '2026-11-06'
status: 'built'
baseline_revision: '199be7c5ababf26f92354900b666c4c26259d9c2'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 2
followup_review_recommended: false
context:
  - AGENTS.md
  - _bmad-output/personal-brain/automation/runbook.md
  - _bmad-output/personal-brain/tickets/epic-garmin-extension/epic-garmin-extension.md
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** PG report 입력·평가 revision 저장은 있으나 감독 분석 진입·모델 설정·body 명령이 연결되지 않았고, day 저장 후 중단되면 기간 scope를 재개하지 못한다.

**Approach:** 고정 원본 report/report_input/body와 계산·프롬프트·schema를 재사용하여 확장 감독 분석을 완성한다. 모델과 후손은 감독 그룹에 남기고, 짧은 RR 입력 읽기와 fenced append 저장 사이에 모델을 실행한다.

## Boundaries & Constraints

**Always:** 원본은 `~/github/garmin` commit `7fb33dd1661ad25cd73e14ed63abe0a87151f62e`의 tracked git show만 읽는다. 기존 PG AccountContext·self/settings snapshot·선택 connection·report session lock·RR·attempt_valid/transaction·revision append/latest를 재사용한다. 유효 attempt를 저장까지 운반한다. 원본 argv/ChatGPT 로그인·API키 제거·workspace-write 및 날짜/단위/schema/프롬프트/계산 의미를 보존한다. 사진 측정은 원본 body.write/reject 검증 경로만 확정한다. 성공 scope는 즉시 append하고 이전 평가 원문을 보존한다. 수락 시험 코드는 작성하되 시험 실행은 **21.8로 이관, 미실행**이다.

**Never:** 실모델/실계정/건강자료/운영 자원·원본 현재 checkout/untracked 접근이나 변경, 직접 시험/fixture 생성/checker/합성 반입/산술 재현/changed/전체 시험 실행을 하지 않는다. core에 Garmin schema/지표/프롬프트/reader를 넣거나 적용 migration을 고치지 않는다. 임의 보안·격리 정책을 추가하지 않는다. 결과 file_requests/채널·cron·플러그인 운영 연결은21.5, 운영전환은21.7이다. standalone config.load/옛 예약/Telegram은 활성화하지 않는다. 중앙state·공용follow-ups·전역스킬·main 병합/push를 변경하지 않는다. 공개 문서/로그/프롬프트에 개인홈절대경로·계정·비밀·건강값·평가본문을 적지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| supervised | 설치 manifest 수동 report/report-regenerate, self/connection/settings/attempt | 선택 계정과 snapshot의 analysis 설정으로 실행, ABI 최종 이벤트 한 건 | invalid UUID/타 self/불명 connection/설정은 모델 호출 전 거부 |
| order/resume | day→7d 저장 뒤 감독자 kill, 재시작 | day→7d→30d→all 순서·scope별 즉시 저장, 재시작은30d/all만 호출 | 실패 scope는 성공으로 기록하지 않고 다음 실행에서 재시도 |
| skip/regenerate | 오늘 네 scope 존재 / 명시 같은날 재생성 | 일반 실행 모델0·당일day 재사용, 명시 실행은 새 revision·latest 한행·기존 본문 유지 | 후속 실패가 이전 성공을 삭제/덮지 않음 |
| transactions/fence | 모델 대기, 취소/회수 attempt, 동시 same/different account | 모델 동안 열린 DB transaction0, 같은 계정 직렬화·다른계정 독립, 유효 attempt만 확정 | 회수 attempt는 평가 저장 거부·기존행 유지 |
| model/process | fake CLI 정상/invalid/실패/timeout/취소·손자·감독자 종료 | 원본 argv/환경/프롬프트/schema, 감독 프로세스그룹 후손 정리·reap, 정당한 진행/lease | 모델 JSON stream은 ABI stdout으로 누출하지 않고 공개 오류는 비밀/본문 없음 |
| body | 합성사진/텍스트·정상측정/잘못된JSON/실패·재시도/취소 | 원본 strict schema/날짜/단위/mtime 병합·검증 후 측정JSON과 processed, 미처리 입력 pending 유지 | 모델실패를 자동 reject하지 않음, 확정 전 취소 입력 보존·이미 확정된 측정 유지 |
| oracle/memory | 고정 SQLite fixture·PG 입력/NULL/배열/경계/기간/체성분 | 원본과 입력·값·계산·프롬프트·schema 의미 동일, 기존 session/message/file 보존 | PG 출력으로 oracle 기대값을 만들지 않음 |

</intent-contract>

## Code Map

- R1 Execution8 재도출: 모델 sandbox의 body CLI는 계정 runtime 안에서 원자 파일요청/응답을 사용하고 호스트 보고프로세스가 대기 poll 사이 요청을 처리한다. 요청의 account/work/attempt는 호스트가 이미 검증한 context로만 결정하며 모델이 넘긴 식별자를 신뢰하지 않는다. 기존 body.execute의 fenced 검증/확정은 호스트 전용으로 유지하고 CLI는 PG에 접속하지 않는다. scope 종료 후 남은 요청을 다음scope에 확정하지 않으며 실패/취소시 미처리 입력을 보존한다. 모델/후손은 새세션/새그룹 없이 감독그룹에 남기고, 정리대상은 현재 entry의 소유그룹 구성원에 한정한다. 자기entry를 kill하지 않고 TERM/grace/KILL/잔존확인을 수행하며 종료 불명에서는 다음 모델을 시작하지 않는다. 테스트/비감독 프로세스그룹을 잘못 정리하지 않도록 소유group 조건을 명시 검증한다.

- `extensions/garmin/src/collect_runtime.py:envelope`, `src/collect.py`: ABI·canonical UUID·settings/self·ZoneInfo·AccountContext 검증 패턴. collect의 snapshot allowlist는 현재 문자열4종만 허용하므로 typed analysis 설정이 같은 snapshot에 들어와도 정상 collect를 거부하지 않게 함께 조정한다. credential/login/tokenstore 검증은 수집 소유로 그대로 둔다.
- `extensions/garmin/src/garmin_pipeline/config.py:Config`, `body.py`: 원본 Config loader를 호출하지 않고 runtime adapter가 Config를 구성한다. body는 파일 장부이며 strict JSON/measurement schema/mtime/원자 replace/processed·unreadable 의미를 유지한다. `body.runtime_root(cfg)`와 pending/profile/sidecar 경로를 선택 계정 runtime에 맞춘다.
- `src/garmin_pipeline/report.py:CodexWriter`, `codex_argv/prompt`, `_evaluate`, `_save_evaluation`, `run`: 원본 argv·schema·usage·실패분류·기간 순서 재사용. 현재 run은 day 존재시 전체 skip하고 graphs/write/delivery까지 연결하므로21.4 분석 전용 경계를 분리한다. 기존 독립 CLI는 계속 비활성이다. day 성공 및 기간성공을 각각 조회하여 누락 scope만 수행한다. 기본 writer의 start_new_session=True와 `_end_group(proc.pid)`는 별도 그룹 가정이므로 함께 교체해야 한다.
- `src/garmin_pipeline/report_input.py:build/_snapshot/build_period/_previous_evaluations`, `digest.py`: account-scoped raw_current·짧은 RR·원본 projection/cutoff/NULL/배열/기간 계산을 유지한다. 각 모델 호출 전 읽기 연결을 닫고 scratch만 갱신한다. 평가원문은 scratch 정리와 별개다.
- `src/garmin_pipeline/store/__init__.py`: supervised_account(AccountContext), report_session의 autocommit session advisory lock, transaction의 전후 fence, append_evaluation의 자연키별 revision 직렬화를 그대로 쓴다. `0014_native_store.sql`의 immutable evaluation_revisions/latest view 및 기존 migrations는 수정 금지다.
- `extensions/garmin/manifest.json`, 새 `src/report.py`·`src/report_runtime.py`: garmin.report/manual report와 garmin.report_regenerate/manual report-regenerate를 supervised로 선언한다. 같은날 명시 재생성은 후자 kind로 구분한다. 분석만 호출하며 file_requests/전송/cron은 연결하지 않는다.
- `apps/cli/src/daemon/supervisor.ts`의 protected launch는 지정 BRAIN_*만 전달하므로 HOME/PATH 모델 탐색·로그인 환경을 현재 runner/모델 계약에 맞춰 출처중립 방식으로 전달한다. Garmin 분기·키/로그 누출·임의 environment 보안정책은 금지한다. `apps/cli/src/runtime/process-group.ts`/core supervisor 기존 그룹 cleanup·recovery를 재사용하고 불필요한 변경은 피한다. progress/heartbeat의 차이를 고려하여 원본20분 timeout이15분 stall에 잘리지 않게 모델이 실제 살아 있는 동안 적절한 진행을 보낸다.
- 원본 `skill/{garmin-body-intake,garmin-daily-analysis,garmin-period-review}/SKILL.md`를 확장 리소스로 이식한다. 내용의 계산/추출·schema 의미는 보존하고 runtime 경로/명령만 supervised adapter로 잇는다. 원본 body skill은 intake JSON이 status/detail이며 실제 measurement는 별도 body 명령으로 쓴다. 비활성 standalone CLI를 되살리지 말고 supervised envelope를 검증하는 좁은 body 명령 adapter를 제공한다.
- `extensions/garmin/tests/oracle/src`는 고정SQLite oracle 수정 금지. `tests/test_report_store_pg.py`, `test_report_input_pg.py`, `test_store_contract_integration.py`, `test_native_store.py`를 확장한다. `apps/cli/python-test/garmin-collect.test.ts`, `test/{ext-fixture,pg-home,supervisor-fixture}.ts`는 실제 manifest→daemon→entry·owned PG·격리home·fake 자식/후손·계정경합·memory 보존 harness 재사용점이다. `garmin-unit.test.ts`는 test_*.py discovery의 skip도 거부한다.
- `tooling/test-changed/rules.mjs`는 extensions 전체와 daemon/runtime 및 python-test test.ts를 이미 분류한다. 새 경로도 분류 assertion으로 명시하고 경로 밖 자식/SQL이면 규칙을 추가한다. 상세 정적조사는 로컬 `.brain-automation/investigation-report.md`;21.2/21.3 계획과 UPSTREAM/README를 이어간다.

## Tasks & Acceptance

**Execution:**
- [x] 1. `manifest.json`, 새 `src/report_runtime.py`, `collect_runtime.py`, `tests/test_report_runtime.py` — report/report-regenerate 선언, typed analysis_agent(codex)/analysis_model/analysis_reasoning_effort/analysis_timeout_minutes 설정과 원본 기본값, strict snapshot·self/선택계정·timezone/attempt 검증·계정별 runtime Config를 구현한다. 수집과 새 설정 공존·잘못된 설정/계정 거부 시험코드를 작성한다.
- [x] 2. `src/garmin_pipeline/report.py`, 필요한 generic `apps/cli/src/daemon/supervisor.ts` 및 관련 TS/Python 시험 — 모델과 후손을 감독 그룹 안에서 실행하고 취소/timeout/정상종료/감독자 종료 recovery 정리·reap을 완성한다. 원본 모델 argv/환경 계약과 ABI progress/최종 출력의 분리를 보존한다. typed 환경 HOME/PATH 전달 및 모델대기 중 DBtransaction 부재 관찰 코드를 준비한다.
- [x] 3. 확장 `skills/` 리소스와 좁은 `src/body_runtime.py`(또는 동등 adapter), 관련 `tests/test_body_runtime.py` — 원본 세 skill을 이식하고 경로/명령만 runtime에 맞춰 body pending/write/reject를 감독 envelope·account·유효 attempt에 연결한다. 측정 validation/실패pending·재시도·취소 보존 시험코드를 작성한다. standalone 거부와 수집 credential 제약을 유지한다.
- [x] 4. 새 `src/report.py`, `report_runtime.py`, `garmin_pipeline/report.py` 및 `tests/test_report_supervised.py` — 분석 전용 intake→report_input/digest→day→7d→30d→all을 연결하고 각 성공 즉시 append·저장기반 재개·완성당일 skip·명시 revision 재생성을 구현한다. read snapshot을 호출 전에 닫고 supervised_account를 모든 저장까지 유지한다. graphs/파일등록/발송/cron은 연결하지 않는다. 실패·재생성·stale·계정경합 시험코드를 작성한다.
- [x] 5. 새 `apps/cli/python-test/garmin-report.test.ts`, `extensions/garmin/tests/`의 fake CLI/합성사진·프로세스 child — 실제 설치 manifest→enqueue→daemon→entry→모델자식→PG를 덮는 matrix 시험을 작성한다. scope 호출장부/평가행·7d확정직후kill→30d/all재개·당일skip·재생성/이전본문·동시성·stale·DBtransaction0·취소/timeout/손자·body 정상/invalid/pending/재시도/취소·기존기억을 외부 표면에서 검증한다. 실제 모델을 쓰지 않는다.
- [x] 6. `tests/test_report_input_pg.py` 및 신규 oracle 비교 child/원본 fixture·시험이식, `UPSTREAM.md`, `README.md`, `tooling/test-changed/` 분류시험 — 고정SQLite와 PG 입력·NULL·배열·계산/프롬프트/schema 의미를 독립 대조하는 코드를 유지·보강하고 새경로 영향분류 및21.8 인계를 완성한다. 고정 원본 fixture는 추적bytes만 가져오며 생성/checker를 실행하지 않는다. 실행명령/준비·소유cleanup/기대관찰/미실행을 문서화한다.

- [x] 7. `manifest.json`, `src/report_runtime.py`, `garmin_pipeline/report.py`와 대응 시험 — 모델 누락은 실행전 설정 오류로 거부하고 intake status ok여도 최초 pending이 남으면 실패로 분류한다. 완성당일 skip·원본 reject·후속scope 계속은 유지한다.
- [x] 8. 모델 실행·`body_runtime.py`·새 호스트 body 요청 처리 및 대응 시험 — 동일 감독 그룹의 모델 후손을 scope 완료/timeout마다 정리·직접자식 reap하고 다음scope 전에 종료를 확인한다. 원본 workspace-write·모델 argv/환경을 유지하며 sandbox 안 body 명령은 파일 요청만 수행하고 호스트가 짧은 fence 안에서 기존 body 검증/확정을 처리한다. PG 직접접속을 sandbox에 요구하거나 새 네트워크/격리 정책을 추가하지 않는다. pending/write/reject의 원본 명령 의미·실패pending·취소보존을 유지한다.
- [x] 9. `garmin-report.test.ts`, fake CLI, `test_report_process.py` — 기본 writer progress 연결·실제 기간폴더/프로필 읽기·계정별 구별 raw/projection/평가/body 입력배제·skill/cwd/unknown prompt 거부·schema valid failed·실패재생성/최신view 값과count1·7d저장후 daemon kill/restart→30d/all재개·다음scope 동안 이전후손0 관찰을 보강한다. fake는 실제 입력표식을 평가에 반영한다.
- [x] 10. `test_body_runtime.py`와 호스트 body 처리 시험 — sidecar replace 직후 및 복수source 첫이동 뒤 취소를 주입하고 다음 실행의 pending·병합·이동 복구를 확인한다. 최초pending 잔존 성공보고·호스트 요청 취소/실패도 덮고21.8 README 인계를 보완한다.

- [x] 11. `body_ipc.py`·모델호스트 대기 및 `report.py` — 각 미시작 body요청 전 모델생존/deadline을 재확인하여 종료/timeout후 요청을 처리하지 않는다. pending 최초/잔존조회와 특정기간 파일준비의 로컬오류는 실패로모아 뒤scope를 계속하되 stale/store/cancel은 중단한다. 대응 시험코드를 작성한다.
- [x] 12. 실제감독 fake/TS·body CLI/실PG경계 시험 — digest 파일게시를 알려진합성값과 독립대조, 실제pending→이미지argv순서, 배포body명령문법, TERM무시손자SIGKILL승격, 파일확정중 실제PGfence 회수직렬화·재시도, 날짜/source거부, 선택모델/effort실argv를 관찰한다. 고정oracle 파일도 계산digest를 써서 비교하고21.8인계를갱신한다.

- [x] 13. `garmin-report.test.ts`·fake 호출장부 — retryable 실패는 attempt 상태를 관찰하고 소유fixture에서 기존일감 재시도를명시추적한다. 토큰회수 후 정산불가attempt의 finished_at 대신 실제프로세스종료/부작용거부를관찰한다. daemon자동복구와재개는work+attempt토큰을구별해호출순서를검사한다. 제품재시도정책은변경하지않는다.

**Acceptance Criteria:**
- Given 격리 설치본·owned PG·fake Codex와 합성 입력, when 수동 report를 감독 실행하고7d 저장 직후 중단·재시작, then 최초day/7d 다음30d/all만 실행되고 평가가 scope별 남는다.
- Given 오늘 성공 scope들과 이전 평가, when 일반 재실행과 명시 report-regenerate, then 일반 실행은 저장된 성공을 건너뛰고 재생성은 새revision을 추가하며 이전본문과latest 한행이 유지된다.
- Given 실제 모델 자식·손자와 유효/회수 attempt, when 대기·timeout·취소·감독자 종료 recovery·동시 실행, then 모델 대기 중 열린transaction이 없고 후손은 감독 그룹 정리 대상이며 stale 확정은 거부되고 계정이 섞이지 않는다.
- Given 합성사진·정상/잘못된 출력과 실패·취소, when intake와 좁은 body 명령을 실행, then 원본 schema로 검증된 측정JSON만 확정되고 미처리 입력은 pending으로 남아 재시도한다.
- Given 고정SQLite oracle과 같은 합성fixture, when PG 입력 및 모델 계약을 비교, then 원본 값/NULL/배열/계산/프롬프트/schema 의미가 같고 기존기억은 보존된다.

## Implementation Notes

- Task13: retryable실패는attempt상태, 회수lost는실제프로세스종료, daemon자동재개는동일work의새token으로관찰하도록시험을수정했다. 제품retry/fence/entry변경없음. 타입/Python/fake구문/diff확인종료0, 시험실행21.8이관·미실행.

- Task12: digest실파일/독립계산oracle게시·사진첨부순서·배포body명령·TERM무시후손·실PG파일확정회수직렬화/재시도·날짜/source거부·모델effort실argv 시험을보강했다. build/typecheck/compileall/fake구문/diff-check종료0 로그확인. 이전정적컴파일이재생성한기존추적pycache한파일은baseline바이트로복원하여티켓diff에서제외했다. 시험실행21.8이관·미실행.

- Task11: IPC요청별active/deadline재확인, pending조회/기간파일준비의로컬오류수집·뒤scope계속을복원했다. store/stale/cancel즉시전파와당일skip유지, Python정적컴파일/diff-check종료0. 두번째구현워커6Task완료로12는새Terra워커에배정한다.

- Task10: 실제body CLI→호스트 처리에서 sidecar replace뒤·첫source이동뒤 취소/재시도와 미처리IPC scope폐기 관찰을 작성하고README/UPSTREAM/분류를갱신했다. build/typecheck/compileall/diff-check 종료0 로그확인. 시험실행은21.8로이관·미실행.

- Task9: 실제daemon 7d확정뒤SIGKILL/recovery·scope재개, 구별된account raw/body/projection/평가/프로필의 실입력 읽기, 실패재생성/latest count1/max본문, valid-schema failed, 기본writer progress 공개출력을 관찰하는 시험코드를 보강했다. 타입/Python컴파일/diff-check 종료0, 모든실행시험21.8이관·미실행.

- Task8: 감독entry 세션/그룹 소유확인·scope별 TERM/grace/KILL/잔존확인과 host-fenced body IPC를 작성했다. body CLI는 DB접속 없이 호출별 파일요청을 내며 호스트만 유효context로 기존측정검증/확정을 수행한다. stale/정리불명은 다음scope를 중단한다. 정적 build/typecheck/compileall/diff-check 종료0 보고확인, 시험미실행.

- Task6: 별도 고정SQLite child와 PG의 입력/계산/프롬프트/schema/측정 validation 비교 및 원본추적fixture·분류시험·README/UPSTREAM 인계를 작성했다. 지휘자 최종 정적 build/typecheck/compileall/fake구문/diff-check 종료0. Matrix 행은 report-runtime·body-runtime·process·supervised·실제 garmin-report·독립oracle 시험코드에 대응한다. 사용자 최신지시로 실행 audit은21.8에 이관·미실행이며 통과로 처리하지 않는다.

- Task5: 실제 설치manifest→daemon→entry→fake Codex→PG 통합시험코드를 작성했다. scope 장부/7d확정뒤kill·resume·당일skip·revision·계정경합·stale·열린transaction0·body·timeout/손자/recovery·기존기억 관찰을 포함한다. 시험 실행증거는 없으며21.8로 이관했다. 정적 컴파일4종 및 fake CLI 구문 확인 종료0. 동일 구현워커6Task 완료로 Execution6은 새 Terra/medium 워커를 사용한다.

- Task4a: intake/모델 실패를 모아 성공scope는 즉시 저장하고 나머지를 계속한 뒤 ABI 실패를 보고한다. stale/store/cancel은 중단하고 각 모델 전 유효attempt를 짧게 확인한다. 재생성은 nonblocking lock으로 복원했다. 정적 컴파일4종 종료0. 모든scope가 완성된 당일 모델skip과 실패pending 재시도의 우선순위는 원본 skip을 유지하여 명시재생성/다음날로 pending을 잇는다(통합시험 Task5에서 고정).

- Task4: 실제 entry·account 검증·skill 배치·분석전용 저장/재개를 작성하고 정적 컴파일4종 종료0. 지휘자 diff 대조에서 원본의 실패 후 후속scope 계속 실행과 명시재생성 즉시 잠금거부가 빠진 것을 확인하여 Task4a로 수정한다. intake 실패시 미처리 pending은 보존하되 원본처럼 분석 입력 생성을 계속한다. stale/cancel은 계속실행 대상이 아니다.

- Task3: 세 skill 이식·감독 body pending/write/reject adapter 및 시험코드를 작성했다. 선택계정 runtime은 패키지 digest 제외 경로인 reports/accounts 아래로 옮겼다. 원본 body 검증/mtime/원자쓰기 의미를 유지하며 파일확정은 짧은 유효attempt fence 안에서 한다. 정적 컴파일4종 종료0, 시험 미실행.

- Task2: 모델 그룹 상속·직접자식 reap·모델 대기 ABI progress 및 generic HOME/PATH/Codex 위치 전달을 구현했다. 잔여후손은 기존 감독 그룹 최종 cleanup이 책임진다. 실제 timeout/취소/recovery·PG 열린transaction0의 외부 관찰은 Execution5에서 연결한다. 정적 컴파일4종 종료0, 시험 미실행.

- Task1: 분석 선언·typed snapshot/runtime Config·collect 공존 및 시험코드를 작성했다. build/typecheck/compileall/diff-check 종료0 보고를 확인했다. 선택계정 검증의 실제 호출과 report entry는 Execution4에서 연결한다. 시험 실행은21.8로 이관, 미실행.

## Plan Change Log

- R2: IPC service의 각요청 시작전 호출생존/deadline 검사를 Execution11에명시했다. 원본의파일로컬오류뒤scope계속을복원하고새검증공백은12에서보강한다. KEEP은R1과동일하며기존정상코드·전체R2diff를보존하고해당경계만재도출한다. intent-contract변경없음.

- R1 수정계획: model descendant 정리 지연과 sandbox 내부 PG 의존을 피하는 호스트 body 확정 경계를 Execution8로 명확히 했다. 모델필수/성공보고 검증은7, 외부관찰 공백은9, 파일확정 중단은10이다. 사용자 부분작업 보존 지시가 우선하므로 R1 전체 diff를 `/private/tmp/brain-214-review-r1.diff`에 보존하고 정상 구현을 일괄 revert하지 않으며 해당 경계를 새로 도출한다. KEEP: 고정원본 프롬프트/schema/계산·workspace-write argv·감독그룹·AccountContext/RR/fenced append·원문revision·scope독립 재개·원본 reject/실패계속·21.8 실행유예. intent-contract는 변경하지 않는다.

## Review Triage Log

### 2026-11-06 — Review pass R5 최종확인
- verdicts: 0 findings. R4V1은합성attempt환경추가로해결·기존exit18검증유지·추가발견없음.
- R3기능확인에서제품미해결0, R4에서R3상태관찰3건해결, R5에서마지막fixture회귀해결을독립확인했다. R1~R4의34행은high6/medium23/false5이며확인된수정대상은모두처리됐다. 보류finding없음, deferred는빈목록유지.

### 2026-11-06 — Review pass R4 상태관찰 재확인
- R3V1~3은 모두 정적해결확인. 수정회귀1건.
- verdicts: 1 finding — high 0, medium 1, low 0, false 0, maybe-false 0
- `[medium]` `[patch]` R4V1 unknown-skill시험필수attempt환경누락 — fake는새token을먼저조회하나직접subprocessfixture에키가없어KeyError로exit1. Execution13의작은후속수정으로합성token을제공해기존exit18거부분기에도달하게한다.

### 2026-11-06 — Review pass R3 표적확인
- 기능리뷰: 추가발견0, R1/R2실제결함해결확인. 검증리뷰:3건.
- verdicts: 3 findings — high 0, medium 3, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` R3V1 retryable실패를work terminalfailed로대기 — 저장소는attempt만실패기록하고workoutcomeNULL/15분후retry다. Execution13에서attempt실패·소유fixture기존work재시도관찰로수정, 제품정책유지.
  - `[medium]` `[patch]` R3V2 토큰회수뒤finished_at대기 — lost정산은이전attempt를쓸수없고NULL이정상이다. Execution13에서소유그룹실종료와파일/평가/stale부작용거부를관찰.
  - `[medium]` `[patch]` R3V3 daemon자동복구와수동enqueue혼동 — 같은work재청구또는완료뒤새noop둘다가능해work만으로호출목록비교불가. Execution13에서attempttoken장부와자동재개추적.

### 2026-11-06 — Review pass R2
- verdicts: 11 findings — high 1, medium 10, low 0, false 0, maybe-false 0
- EC: 추가발견0, 이전후손정리해결 확인. VG: 이전두공백 해결확인.
- findings (도착순):
  - `[medium]` `[patch]` R2VG1 감독digest 파일게시 관찰누락 — fake가digest를읽지않고oracle도fixture문자열을게시함. Execution12에서알려진합성값을실파일소비결과와대조.
  - `[high]` `[bad_plan]` R2BH1 IPC묶음중모델종료/timeout미확인 — service가모든request를처리해두번째확정이호출종료뒤시작될수있음. Execution11에서요청별활성호출guard.
  - `[medium]` `[patch]` R2BH2 pending조회 파일오류전체중단 — 초기/재조회가오류수집밖. Execution11에서로컬오류는intake실패로수집·뒤scope계속.
  - `[medium]` `[patch]` R2BH3 기간파일준비 오류전체중단 — build_period가scope별오류경계밖. Execution11에서로컬scope오류수집·DB/stale/cancel은전파.
  - `[medium]` `[patch]` R2BH4 실제사진첨부관찰누락 — helperargv만검사, fake는pending만소비. Execution12에서실pending의-i/첨부목록·순서검사.
  - `[medium]` `[patch]` R2BH5 body배포명령연결누락 — name만검사하고fake명령하드코딩. Execution12에서배포명령계약단언.
  - `[medium]` `[patch]` R2BH6 TERM무시손자KILL승격누락 — 기본sleep과mock만존재. Execution12에서실TERM무시후손·후속scope전종료확인.
  - `[medium]` `[patch]` R2BH7 파일확정중실PGfence관찰누락 — 파일중단은mocktransaction, 실PG는사전회수만. Execution12에서소유PG확정중회수경합/재시도관찰.
  - `[medium]` `[patch]` R2BH8 독립oracle digest파일고정문자열 — 객체계산비교는있지만실게시관찰없음. VG1과같은근본원인이지만별도행보존, Execution12계산파일/소비관찰.
  - `[medium]` `[patch]` R2BH9 bodyCLI날짜/source거부공백 — 원본거부는있지만새요청경계는정상source만관찰. Execution12에서미래/비정규날짜·외부/절대/symlink거부·기존자료보존.
  - `[medium]` `[patch]` R2BH10 모델/effort실argv관찰누락 — Config와별도helper만검사. Execution12에서선택값과실fake호출argv대조.

### 2026-11-06 — Review pass R1
- verdicts: 19 findings — high 5, medium 9, low 0, false 5, maybe-false 0
- findings (도착순, 병합 전 개별 판정):
  - `[high]` `[bad_plan]` EC1 timeout 후 후손과 다음scope 경합 — 직접자식만 종료하고 실패뒤 계속하는 경로 확인. Execution8에서 scope 경계 종료확인으로 수정.
  - `[high]` `[bad_plan]` IA1 7d확정과 실제 daemon 재시작 결합공백 — 현재 그룹kill과 day0행 daemon kill이 분리됨. Execution9에서 하나의 결합관찰 작성.
  - `[false]` `[reject]` IA2 모든 판독불가 pending 해석 — 고정원본은 명시 reject→unreadable이며 사용자 원본보존 지시가 선택을 정한다. 실패pending은 실행/검증실패의 미처리입력이며 원본 reject를 변경하지 않는다.
  - `[false]` `[reject]` IA3 사진시각인식 품질 미검증 — 사용자가 fake CLI를 지정했다. 사진→첨부→검증명령→측정JSON의 외부경계를 검증하며 OCR품질을 입증한다고 주장하지 않는다.
  - `[false]` `[reject]` IA4 성공접두부 의존 해석 — 고정원본은 실패scope 뒤도 계속한다. 원본보존 지시와 성공scope 재개가 독립scope 해석을 정한다.
  - `[false]` `[reject]` IA5 재생성 세대별 재개 — 원본 및 티켓에 세대키 요구가 없다. 명시재생성은 새전체시도, 일반재개는 저장성공scope 기준이다. 세대별 원자평가는 추가하지 않는다.
  - `[medium]` `[patch]` IA6 최신view 값/count 관찰 — 배열길이4만 확인해 잘못된최신본문도 허용함. Execution9에서 revision별 다른본문과 count1/max 비교.
  - `[medium]` `[patch]` VG1 기간입력 전달 공백 — oracle 직접builder와 fake scope문자만으로 실경로오류를 잡지못함. Execution9에서 prompt 경로를 읽고 저장표식 비교.
  - `[medium]` `[patch]` VG2 기본writer progress 연결공백 — 직접 _run 콜백/출력helper만 검증함. Execution9에서 기본 공개메서드 stdout관찰.
  - `[medium]` `[patch]` BH1 model 미설정 반복실패 — Config None은 네모델실패가 된다. Execution7에서 required_settings·report envelope 실행전거부.
  - `[false]` `[reject]` BH2 계정timezone과 KST 스킬 — 고정원본 스킬 그대로이며 이번요구는 프롬프트 의미보존이다. 임의 timezone 문구변경을 하지 않는다. 원본의 한국시각 서술한계는 최종위험에 명시한다.
  - `[high]` `[bad_plan]` BH3 timeout 후 후손 지연 — EC1과 같은근본원인이나 별도행 보존. Execution8 수정 및 다음scope hold 관찰.
  - `[medium]` `[patch]` BH4 intake 자기보고만 수락 — status ok 후 최초pending이 남는 경로확인. Execution7에서 미처리잔존 검증.
  - `[high]` `[bad_plan]` BH5 sandbox body PG 경계 — 새adapter가 모델sandbox에서 TCP PG/fence를 요구하고 fake는 이를 우회함. 원본 sandbox 의미보존을 위해 Execution8에서 파일요청→호스트fenced 처리로 재도출, 실제모델 미사용 계약시험 작성.
  - `[high]` `[patch]` BH6 계정격리 입력공백 — 현재 두account가 빈원본이라 WHERE 누락을 검출못함. Execution9에서 계정별 입력표식 상호배제.
  - `[medium]` `[patch]` BH7 실패재생성 PG공백 — 첫실패/성공재생성만 분리됨. Execution9에서 기존revision을 둔 실패재생성 관찰.
  - `[medium]` `[patch]` BH8 파일공개후 취소공백 — replace전예외/명령전hold만 있음. Execution10에서 replace후·첫이동뒤 중단/재시도.
  - `[medium]` `[patch]` BH9 skill배포 공백 — fake는 접두어만보고 unknown도day로처리함. Execution9에서 배포skill/cwd/명령확인·unknown거부.
  - `[medium]` `[patch]` BH10 schema valid failed 누락 — fail/invalid만 있음. Execution9에서 정상exit/validJSON/failed 상태를 추가.

## Design Notes

원본의 day 존재 skip과 티켓의 저장scope 재개를 함께 지키기 위해 이미 성공한 day는 재호출하지 않되 누락된 기간scope를 채운다. 네 scope가 모두 존재하면 전체 모델작업을 건너뛴다. `report-regenerate`는 같은 target의 명시 별도kind이며 일반 report의 재시도 의미를 바꾸지 않는다. 기존 revision 저장 primitive와 report_session을 재사용하므로 새 저장방식을 만들지 않는다.

body intake의 최종 status/detail은 측정JSON이 아니다. 원본 skill→검증 body.write→sidecar라는 실제 경계를 유지한다. 실패가 이미 성공한 측정을 rollback한다는 원본에 없는 보장을 추가하지 않고 미처리 pending의 보존을 검증한다. 모델 호출 중에는 DB transaction을 유지하지 않으며 파일 명령의 확정 fence도 짧게 유지한다.

## Verification

**이 티켓에서는 허용된 정적 컴파일만 실행한다. 시험 실행은21.8로 이관, 미실행이며 시험통과로 보고하지 않는다.**

- `pnpm build` — 모든 workspace 빌드 종료0. 의존 다운로드가 있으면 처음부터 require_escalated.
- `pnpm typecheck` — workspace 타입 확인 종료0(실제 package scripts에 맞춰 동등 명령 사용).
- `python3.14 -m compileall -q extensions/garmin/src extensions/garmin/tests` — Python 소스/시험의 구문 정적컴파일 종료0. 원본 oracle 실행·계산 없음.
- `git diff --check` — 공백오류 없음. 독립4렌즈와 필요한 수정·후속리뷰를 수행한다.

21.8에서 전용 소유 PG/role/compose·격리home·합성자료를 README 절차로 준비하고 `pnpm test` → `pnpm test:python`을 순차 실행한다. 관련 수정 후 재검증은 `pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-report.test.ts apps/cli/python-test/garmin-native.test.ts apps/cli/python-test/garmin-unit.test.ts`다. 모든 새·기존 Garmin 시험·Python discovery·분류시험을 포함한다. 명령·기준SHA·환경/소유자원·종료코드·로그·실패별처분/재검증을 기록하고 이 실행이 직접 소유한 home/DB/role/compose만 정리한다. 미실행·미해결 실패가 있으면21.8 built 및21.7 시작금지다.

## Auto Run Result

상태: **built**(사용자인수전). 공식 bmad-build-auto full/thorough를사용했고 원본명세전체는로컬 `.brain-automation/independent-spec.md`에보존했다.

- 구현: 감독 report/report-regenerate·typed analysis설정·계정runtime, intake→원본입력/digest→day→7d→30d→all, 성공즉시revision append·저장성공scope재개·완성당일skip·명시재생성의기존본문보존을연결했다.
- 프로세스: 원본workspace-write/argv/프롬프트/schema/계산을유지하고모델/후손을감독그룹에서scope별정리한다. 소유/종료불명은후속모델을중단한다. 모델대기중DBtransaction은없고호스트body요청/평가저장만짧은fence로확정한다.
- body: 모델sandbox에서PG직접접속을요구하지않는다. 파일요청을호스트가유효account/attempt로검증·처리하며원본strictJSON/날짜/단위/mtime/atomic측정/processed·unreadable의미를유지한다. 실패pending·공개후취소·재시도시험코드를작성했다.
- 변경파일: `manifest.json`과report/runtime/body IPC는실행선언/연결, `garmin_pipeline/report.py`는scope/모델경계, `skills/`는고정원본리소스, generic `apps/cli/src/daemon/supervisor.ts`는HOME/PATH/Codex위치전달, Python/TS시험과fake/독립oracle는수락코드, README/UPSTREAM/분류는출처와21.8인계다. core에Garmin계산/schema/reader는추가하지않고기존migration은수정하지않았다.
- 리뷰: 같은폴더 `reviews/story-report-day7d30dall-2026-11-06/`에R1독립4렌즈·R2독립3렌즈·R3기능/검증2확인·R4/R5동일검증후속원문을보존했다. 전체34발견행을각각triage하고29수정대상행(중복원인포함)을해결했다. false5는원본reject·fake모델품질범위·원본실패계속·미요구재생성세대·원본KST프롬프트보존근거로기각했다. R3기능추가발견0, 최종R5추가발견0. 최종pass patch수0, 추가후속리뷰권고false다.
- 최종정적검증: `pnpm build`, `pnpm typecheck`, 임시pycache의`python3.14 -m compileall -q extensions/garmin/src extensions/garmin/tests`, fake CLI의`py_compile`, `git diff --check` 모두종료0. 실제명령·종료코드·로그는로컬 `.brain-automation/final-compile-results.json`, `.brain-automation/logs/final-*.log`다.
- **시험 실행은21.8로이관, 미실행**이다. 직접시험/fixture생성/checker/합성수집·반입·모델/산술재현/changed/전체시험은실행하지않았다. 위정적결과는시험통과가아니다.

### 가정·잔여위험·운영인계

일반재개는계정/날짜/scope의저장성공을기준으로하며실패한중간scope뒤성공을남기는원본의미를지킨다. 명시재생성은새전체시도이며별도의원자세대재개는요구하지않는다. 판독불가의명시reject는원본처럼unreadable로옮기고실행/검증실패의미처리입력은pending으로남긴다. 원본daily skill의한국시각서술지시도그대로유지하여다른timezone의서술한계가있다. 실제모델/OCR품질과Codex sandbox실행은이번정적검증으로확인하지않았다.

21.8은README의전용소유PG/role/compose·격리home·합성자료에서새·기존시험전체 `pnpm test` → `pnpm test:python`을순차실행하고실패별수정/관련재검증을수행한다. 기준SHA·환경/소유자원·명령·종료코드·로그·실패처분/재검증증거를남긴다. 실제감독kill/restart·attemptretry/fence·IPC/파일중단·TERM무시후손·계정입력/digest·고정SQLite동등성을포함한다. 미실행또는미해결실패가있으면21.8built/21.7시작금지다. 설치본의모델실행경로와workspace sandbox에서body파일요청의허용도실모델호출없이소유시험환경에서확인한다.

운영조치:21.5가결과파일등록·발송/cron/플러그인연결을맡고21.7이운영계정/credential확인·전환을맡는다. 이번작업은운영설치/운영DB/실계정/실모델/예약을변경하지않았고main병합/push·중앙state·공용follow-ups도변경하지않았다. 티켓브랜치commit/push와원격SHA증거는최종로컬보고에남기며main병합·에픽전이는중앙소관이다.
