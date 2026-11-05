---
title: '21.5 Garmin core 예약·조회·발신·플러그인 연결'
type: 'feature'
ticket: 5
created: '2026-11-06'
status: 'built'
baseline_revision: '9490bac7e8e69af9744a8f64b8cb67844cc3c30f'
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
  - extensions/garmin/README.md
  - extensions/garmin/UPSTREAM.md
warnings: [oversized]
deferred:
  - summary: >-
      원본 Markdown의 날짜 상대 그래프 링크와 별도 첨부 전송은 문서 단독 소비 때 링크가 해석되지 않는다.
    evidence: |-
      R1 BH-04. baseline 원본 _assemble은 YYYY-MM-DD/이름을 만들고 TelegramReportSink는 md 하나와 사진을 별도 전송했다. 이번 변경은 같은 원본 문서 의미를 보존하고 core file_id 관계를 추가한다. URL/압축/문서 소비 UX 선택은 별도 판단이 필요하다.
    location: >-
      extensions/garmin/src/garmin_pipeline/report.py::_assemble
    severity: medium
---

<intent-contract>

## Intent

**Problem:** PG 수집·분석은 있지만 manifest 조회·cron 의존·결과 게시·marketplace 설치 연결이 없어 공통 실행 경로로 사용할 수 없다. 17.4가 소비할 조회 producer 계약도 없다.
**Approach:** 확장이 조회와 분석 의미를 소유하고 기존 core의 manifest 명령·예약·파일·채널·패키지 설치 계약을 소비한다. 필요한 장치 확장만 범용 계약으로 추가한다.

## Boundaries & Constraints

**Always:** 21.2 native 계정/revision/store/RR·file metadata, 21.3 보호 tokenstore와 binding·수집 보호·attempt, 21.4 scope 재개·모델후손 정리·body IPC·모델대기 transaction 0을 유지한다. 원본 계산·프롬프트·schema·KST 의미를 유지한다. 고정 `7fb33dd1661ad25cd73e14ed63abe0a87151f62e` tracked 원본과 독립 SQLite oracle을 읽기 전용으로 보존한다. settings는 core snapshot만 읽는다. 신규 파일은 중립 metadata(kind/report_date/scope/original_path_hash)와 평가 revision→file_id를 잇는다. 사용자 예약/설정/삭제표식·회차/성공기록은 재설치로 덮지 않는다. 채널은 기존 semantic UNIQUE·bundle·불명/재시도 정책을 따른다. 시험 코드는 작성하고 모든 시험 실행은 **21.8로 이관, 미실행**이다.

**Never:** 실계정/실모델/실건강자료/운영DB·설치·예약·원본 checkout 실행/변경, fixture 생성/checker/합성 수집·반입·평가/직접·changed·전체 시험 실행, core Garmin 지표·표·reader·프롬프트 재도입, 중앙state/공용follow-ups/main 병합·push, 전역스킬·BMAD setup/update·옛 loop helper 수정/사용. 공개문서·프롬프트·커밋에 개인홈절대경로/비밀/계정/실건강값 금지다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 조회 | 현지 start/end 날짜(양끝 포함), IANA timezone, metric, 선택 운동 조건 | daily-values는 행별 날짜/값/단위, period-summary는 동일 필터의 value/unit/관측수/NULL수/적용기간 | invalid 날짜/zone·허용표 밖 metric·집계·운동조건은 안전거부 |
| NULL | 합성 [10,NULL,30], sum/mean; 0건/전부NULL | 40/20, 관측2·NULL1; 0건/전부NULL value=null·관측0, NULL은 0이 아님 | 비유한 JSON/식별자 주입 불가 |
| 평가조회 | scope·limit와 runtime self | recent-evaluations는 최신 revision의 요지/날짜/file_id, 자기 연결만 | 잘못된 scope/limit·타 사용자 범위 거부 |
| 예약 | 설치 기본 11:00 수집/11:30 분석 Asia/Seoul, missed latest | 같은 현지 날짜·대상의 수집 성공 후에만 분석, 미성공 모델0, 성공 뒤 중복회차 억제 | 재시작·늦은 성공·실패/부분수집은 잘못된 성공으로 간주하지 않음 |
| 게시 | 저장된 평가와 새 report/graph, core 파일 완료/지연/실패 | metadata·평가 revision 관계, 안정 의미키로 결과 묶음 한 번; REPORT_FAILED도 core 요청 | 발신 실패/불명에도 평가 보존·재생성 없음, 기존 retry 유지 |
| 수명주기 | disable/enable·재설치·사용자 수정/삭제 예약 | 발화/새청구/명령 중지와 재개, native/평가/core파일·사용자예약 보존 | core registry/잠금/quiesce 재사용 |
| 배포 | 같은 marketplace Garmin plugin package/digest/ref/version | 얇은 entry가 core ext install --package 위임, core 없으면 안내만 | 자동 core설치 금지·호환/신원/잠금/복구 우회 없음 |

</intent-contract>

## Code Map

- `extensions/garmin/manifest.json`: collect/report/regenerate 및 settings는 존재, commands/default_schedules/필요기능·패키지 identity는 미선언. `src/reader.py`는 SQLite 반입 reader이므로 조회는 새 `query.py`/`query_runtime.py`로 분리한다.
- `migrations/0014_native_store.sql`: day_summary(date·steps 등), workout(date/type/activity_id), exercise_log와 account_connections, evaluation 최신 view·evaluation_files를 사용한다. `garmin_pipeline/store`의 self/connection·read-only RR와 짧은 fence를 재사용한다. core는 이 SQL을 읽지 않는다.
- `packages/core/src/extensions/commands.ts::executeExtensionCommand`, CLI `runtime/extension-commands.ts`: stdin ABI self/settings/input, timeout/출력제한, schema→mask→재검증과 CLI/MCP 공통등록을 그대로 사용한다.
- `packages/core/src/extensions/manifest.ts`, `schemas/extensions/v1/manifest.schema.json`, 공유 fixture/Python checker: work.followup/missed/default_schedules 기존 decoder. `queue/schedule-tick.ts`, `packages/postgres/src/{schedules,work}.ts`와 0033 회차 회계를 재사용하되 기존 followup만으로 같은 날짜 성공 의존을 충족하지 못한다. 새 범용 선언과 성공 의존의 실제 claim 소비 지점을 연결한다.
- `garmin_pipeline/report.py::run_supervised`, `_save_evaluation`, `_render_charts`, `_assemble`, `_write_report`, `_notify_failed`와 `src/native_artifacts.py`: 평가 성공 보존·재개 후 파일/채널 게시를 추가한다. 기존 core 요청 공개결과 view·fenced INSERT·staging·metadata를 재사용한다.
- `packages/postgres/migrations/0017_channels.sql`, `0020*`, `src/channels.ts`, `extension-provision.ts`: 의미키 UNIQUE·bundle·파일 의존·출처 제한. 채널 대화는 self 소유 core 공개계약에서 선택하며 비밀/임의 Telegram 호출을 만들지 않는다.
- `garmin_pipeline/{cli,telegram,schedule,config}.py`: 제품의 옛 운영경로 제거, Config 자료형/snapshot 사용은 유지. `tests/oracle/src` 원본은 변경하지 않고 제품 package 파일 목록에서 제외한다.
- `.claude-plugin/marketplace.json`, `plugins/testext` 틀, core `extensions/install.ts`, CLI `extension-transition.ts`, postgres `extension-install-lock.ts`: package bytes/digest·호환 core identity·공통잠금/quiesce·registry/복구를 재사용한다.
- `apps/cli/python-test/garmin-{native,collect,report}.test.ts`, `extensions/garmin/tests`, `fixtures/native`, `tooling/test-changed/rules.mjs`: 실제 설치·supervisor·소유 PG/격리home·fake 외부 경로로 시험 코드를 등록한다. oracle 독립성 유지. 조사 근거는 로컬 `.brain-automation/exploration.md`다.

## Tasks & Acceptance

**Execution:**
- [x] 1. `extensions/garmin/src/query.py`, `query_runtime.py`, `manifest.json`, `tests/test_query.py`, `README.md` — 세 읽기명령의 엄격 input/output schema·지표/단위/허용집계 표·날짜/zone/운동 조건·self 연결/RR 조회 producer를 완성한다. native 일별/운동/운동세트 지표의 기존 단위와 의미를 보존하며 표를 README에 명시한다. NULL/0건/거부/최근평가와 CLI/MCP 공통소비 시험 코드를 작성한다.
- [x] 2. core `extensions/manifest.ts`·JSON schema·공유 fixture/checker, `queue`/`ports/store.ts`, postgres `work.ts`/`schedules.ts`·새 forward migration·fake/계약, Garmin manifest — 범용 필요기능 channel.send와 같은 현지날짜·대상·사용자 선행 성공 의존을 선언/검증/소비한다. 기본 cron 0 11/30 11 Asia/Seoul, missed latest를 연결하고 user변경·삭제·회차·성공은 보존한다. 실패/늦은성공/재시작/중복/disable 시험 코드를 작성한다.
- [x] 3. `extensions/garmin/src/report_publish.py`, `garmin_pipeline/report.py`, 필요한 forward SQL/manifest — 저장된 revision부터 새 report/graph를 core file_requests→평가 file_id로 잇고 안정 의미키의 core channel bundle/REPORT_FAILED 요청을 만든다. pending 파일/발신실패/재시작·재생성 없는 재게시를 시험 코드로 덮는다.
- [x] 4. `garmin_pipeline/{cli,telegram,schedule,config,ports}.py`, `pyproject.toml`, `manifest.json`, `UPSTREAM.md` — 제품 Telegram 직접호출·launchd·옛 config파일읽기 경로를 제거하고 snapshot/Config만 유지한다. 독립 oracle와 provenance는 제품 package에서 제외한다. 제거 후 참조/실행경로 없음과 원본 의미 보존 시험 코드를 작성한다.
- [x] 5. `plugins/garmin/{package,bin,.claude-plugin,skills,app-ref}`, `.claude-plugin/marketplace.json`, 패키징 도구·시험 — Garmin package files/core_compat/plugin_version와 digest, 얇은 진입점을 완성한다. package실바이트/기준src/identity/ref/version 동기화·core미설치 안내·위임 fixture 시험을 작성한다. app-ref는 구현 commit 이후 release commit에서 이전 commit을 가리키며 해당 plugin version을 함께 올린다.
- [x] 6. `apps/cli/python-test/garmin-core.test.ts`, 필요한 fake child/fixtures·Python/PG 시험, `tooling/test-changed/{rules.mjs,시험}`, `extensions/garmin/README.md` — 실제 설치manifest→scheduler/supervisor→파일/채널 및 CLI/MCP, disable/enable·재설치·plugin위임의 전체 matrix 관찰을 무조건 등록한다. fake clock/Codex/Telegram·합성native·전용PG/격리home, 21.8 명령·기대관찰·소유자원 정리 인계를 완성한다.

**Acceptance Criteria:**
- Given 합성 native와 설치 manifest, when CLI `brain ext garmin` 및 MCP로 세 명령을 호출하면, then 선언된 같은 날짜/시간대/지표/운동조건·NULL/0건·허용집계 결과와 평가 file_id를 가려진 schema 유효 JSON으로 얻는다.
- Given 기본 cron과 fake clock, when 수집 미성공/성공 전후 11:30 분석 회차를 처리하면, then 같은 날 수집 성공 전 모델호출0·성공 뒤 한 분석/한 결과묶음이며 놓친 회차 latest와 기존 회계가 유지된다.
- Given 저장된 평가, when 파일/채널 실패·불명·재개가 발생하면, then 평가를 지우거나 모델로 재생성하지 않고 중립 metadata/파일관계와 core 의미키·재시도 정책을 지킨다.
- Given 사용자 설정/예약 변경·삭제표식과 기존 native/평가/core파일, when 재설치 및 disable→enable하면, then 값/회계/자료를 보존하며 비활성 발화·새청구·명령은 멈추고 활성 후 재개한다.
- Given marketplace Garmin 플러그인 fixture, when entry를 호출하면, then core 미설치 안내 또는 검증된 package를 기존 core 설치기로 위임하며 제품 운영경로에 Telegram/launchd/config파일읽기·독립oracle가 없다.
- Given 구현 완료, when 정적컴파일·독립리뷰·필요수정/후속리뷰가 끝나면, then built·정상hook commit·티켓branch push/원격SHA 확인과 한국어 보고가 남으며 시험은 21.8 이관 미실행으로 기록한다.

## Implementation Notes

- R2b: 현재normalizeversion+유효projection을함께준비해sleep그래프입력을보존하고재설치전fakeclock소유daemon종료·잠금/ready제거후실시간소유daemon을시작해직접CLI로재설치한다. 차단/중단/정규화/성공각정확attempt로종료를기다린다. 지휘자가변경코드를확인했고typecheck/Pythoncompileexit0, 모든시험21.8이관·미실행이다.

- R2a: 예약성공callback을원본run status성공transaction에호출해work/self/connection/날짜근거를정규화전에원자저장한다. 수동은연결을만들지않고신규run도정확한근거를요구한다. DB오류/프로세스중단뒤no-op정규화복구·타work근거거부시험코드와package재생성/build/typecheck/Pythoncompileexit0을기록했다. 지휘자가실제성공transaction경계를확인했다. 시험21.8이관·미실행이다.

- R1d: 실제PG활동/휴식세트와운동필터결과,기존report의self채널/fake전송·실파일drain,실패regenerate7d단독재개/기존파일보존,다른대상완료문서/사진거부시험코드를보강했다. source변경없이typecheck/Pythoncompileexit0로그, 시험실행21.8이관·미실행이다.

- R1c: work/revision키에날짜를포함하고발화/정산의행잠금전공통advisory순서를추가했다. 예약수집은정규화실패·pending·미처리raw를거부하고같은work성공run근거로재시도정규화를복구한다. 지휘자가source/diff·신규실PG경쟁/날짜시험코드를확인했다. package재생성/build/typecheck/Pythoncompileexit0, 시험은21.8이관·미실행이다.

- R1b: 원래그룹순서10장분할·report봉투UUID와모델전core공개중립대화검증·filename JSONtype/NULL/제어문자거부를구현했다. 지휘자는source/SQL/diff와경계시험코드를확인했다. package재생성/build/typecheckexit0, 시험은21.8이관·미실행이다.

- R1a: 차트strict실패와데이터없음을구분하고day그래프집합공유·비쓰기렌더·평가관계를구현했다. 최초결합문서동시제출및transaction밖60초boundedpoll/heartbeat/fence를추가했다. 지휘자는source/diff를확인했으며시험은21.8이관·미실행이다. 여섯Task완료워커를정식worker_done근거로보존하고새Terra워커에R1b부터배정한다.

- Task6: package설치→fakeclock cron→실감독/fakeGarmin·Codex→파일drain·가짜Telegram→CLI/MCP·disable/enable·재설치표면통합코드를작성했다. 지휘자는전체시나리오를읽었고빌드/typecheck로그exit0을확인했다. 실제성공여부는아직확인하지않았으며시험실행21.8이관·미실행이다.

- Task5: second-brain-garmin marketplace/얇은위임과엄격제품package/digest생성기·동기화시험을추가했다. 초기version0.1.0/ref는baseline이전37e5a002978a7b9fdc25eab6b30d6f1b5db00654다. 후기수정마다 `node tooling/package-garmin/build.mjs`로재생성하며구현commit뒤ref/version상승releasecommit은지휘자가수행한다. package생성은배포산출물제작이고설치/시험은21.8이관·미실행이다.

- Task4: 제품직접Telegram·schedule모듈·config파일로더를제거하고Config/snapshot·notice/계산의미를보존했다. Python배포는src만포함하고oracle/fixture/provenance는제외한다. 지휘자diff와oracle미변경을확인했다. 실제marketplace파일목록/digest는Task5, 통합관찰은Task6/21.8이며시험은미실행이다.

- Task3b: core공개범용함수0038에서현재attempt·확장출처·self대화·같은대상완료파일을검증하고기존의미키로요청을조정한다. 확장은설정channel_conversation_id로대화를선택하고저장revision묶음/결합문서와REPORT_FAILED를게시한다. 지휘자가소스/diff·권한계약을읽었다. 정적컴파일exit0로그가있고실제SQL권한/비동기전송은21.8이관·미실행이다.

- Task3a: work별선택revision과게시바이트/요청을고정하는forward0016·report_publish를추가했다. 재시도는저장revision을재사용하고파일pending/failed에서도평가를보존한다. 지휘자는소스/diff/시험코드를확인했다. 채널3b 및 실제파일drain관찰은후속필수이며시험실행은21.8이관·미실행이다.

- Task2c: 청구봉투의 단일현지날짜와 range를 검증해 collect/report에 전달하고 예약success외 상태는 COLLECT_INCOMPLETE로 정산한다. 선행latest누적도 단일청구하며 기본cron/after_schedule/target_setting을 연결했다. 지휘자가 source/diff를 확인했다. 실제통합실행은21.8이관·미실행이며 Execution6에서설치→예약→감독관찰시험을완성한다.

- Task2b: after_schedule 선언·설치·forward0037·실제claim의 날짜/user/target 선행done gate와 의존latest·같은날중복 skipped 및 공정성을 구현했다. 지휘자diff확인: 아직latest정리가 의존예약에만 적용되므로2c에서 선행수집의 누적회차도 하나의현지날짜로 청구하도록 보완해야 한다. build/typecheck·정적컴파일 exit0 보고/로그가 있으며 시험은21.8이관·미실행이다.

- Task2a: requires 허용목록과 user string target_setting, forward0036·설치·발화의 대상고정을 구현했다. 지휘자는 diff/시험 및 build/typecheck 로그 exit0을 확인했다. 미설정은 회차를 소비하지 않고 수동설정대상 run은 안전거부한다. 2b에서 미설정 예약의 due목록 독점과 선행대기 후보의 claim 독점을 방지해야 한다. 모든시험은21.8이관·미실행이다.

- Task1: 세 조회 명령·strict schema·명시 self 소유 connection/동일 timezone·지표표·RR와 NULL/0건/조건거부/최근평가 및 CLI/MCP 시험 코드를 작성했다. 지휘자는 소스/시험/diff를 읽었다. 구현자 정적컴파일 성공 보고는 있으나 명령 로그가 없어 최종 정적검증 때 실제 로그를 남긴다. 모든 시험 실행은21.8로 이관, 미실행이다.

## Plan Change Log

- R2: BH07의성공run↔work저장을정규화전동일transaction으로원자화하는R2a와통합시험의graphseed/clock/attempt동기화를고치는R2b로세분화한다. KEEP: 성공외상태게이트·정규화미완료거부·동일work의보호재개, 기존core준비gate/계정/attempt/의미키·원본문서·독립oracle. 부분코드는보존하고intent-contract는수정하지않는다.

- R1: 18지적high8/medium10중17행을R1a(원자렌더·공유그래프·정상파일대기),R1b(앨범분할·조기채널검증·SQL파일명),R1c(날짜키·잠금순서·정규화성공),R1d(실제PG/기존fixture·재시도/파일경계시험)로수정한다. BH04는원본동일문서소비한계로defer한다. KEEP는아래triage와같으며사용자부분작업보존에따라해당경계만재도출한다. intent-contract는유지한다.

- Execution3은 파일게시3a와 채널게시3b로 분리한다. 3a는 저장된 revision을 원천으로 report/graph 생성·file_requests·중립metadata·완료후file_id관계와 재개/실패 시험까지다. 3b는 해당결과의 core채널 bundle/REPORT_FAILED·안정의미키·실패평가보존을 연결한다. 이전구현워커는6개Task를완료/부분보고했으므로 정식succeeded/settled와 retained/user_requested를확인하고 세션을보존한채 새Terra워커로교체한다. 동시편집자는없다.

- Task2의 조사 결과로 Execution2를 2a/2b/2c로 나눈다. source 수정 없는 부분보고를 실패 완료로 집계하지 않는다. KEEP: 기존 예약 회계/사용자 수정/삭제표식, 보호 binding, 범용 core 경계. 2a는 manifest 기본예약의 선택 `target_setting`(동일 확장 user string설정)을 추가하여 발화 transaction에서 해당 사용자의 유효 설정값을 target_id로 고정하고 work/회차에 연결한다. 미설정/invalid이면 회차를 소비하지 않으며 기존 열린 work의 대상은 설정변경으로 바꾸지 않는다. Garmin은 명시 `garmin.connection_id` 설정을 사용하고21.7 운영자가 binding과 함께 선택한다. core는 UUID나 Garmin 표를 해석하지 않는다. capability는 범용 `requires: [channel.send]` 허용목록 선언/거부 계약으로 추가한다.
- 2b는 기본 분석예약이 수집예약 key에 같은 현지 날짜·사용자·고정 대상의 성공을 요구하는 범용 선언을 추가한다. claim은 충족된 회차만 선택하며 늦은 성공 뒤 재개된다. latest의 여러 누적 pending은 최신만 남기고 명시 skipped 회계로 남긴다. 선행실패·취소·다른대상 성공은 gate를 열지 않는다. 기존 pending/claimed의 대상은 work에 고정된 값을 사용한다.
- 2c는 확장 실행기가 실제 청구된 BRAIN_OCCURRENCES/range 날짜를 검증해 하나의 현지 날짜로 고정하고 실행시점 today로 대체하지 않는다. 예약 수집은 원본 상태 success만 성공 이벤트를 내며 partial/blocked/auth/noop은 성공회차로 정산하지 않는다(수동 기존 status보고는 유지 가능). 날짜가 섞인 봉투는 안전거부하며 core latest 청구가 하나의 날짜를 보장한다. 이 세 항목은 기존matrix를 충족하기 위한 세부설계이며 수락조건을 축소하지 않는다.

## Review Triage Log

### 2026-11-06 — Review pass R5
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- 독립 `.brain-automation/review-r5-verification.md`가AUDIT-01의정상attempt/work정산·claim정리·동일대상새work생성·근거도용거부도달을실SQL제약과대조해해결확인했다. R3source는추가확정제품결함0, R4/R5한정검증은최종fixture수정의추가확정결함0이다. 실행통과판정은아니다.

### 2026-11-06 — Review pass R4 및 지휘자 최종대조
- verdicts: 1 findings — high 0, medium 1, low 0, false 0, maybe-false 0
- 독립 `.brain-automation/review-r4-verification.md`는VG-R3-001해결확인·추가발견0을보고했다. 단, 지휘자최종대조에서아래별도fixture충돌을확인했다.
- [medium] [patch] AUDIT-01 중단subtest2의타work생성이열린work유일키와충돌 — `test_store_contract_integration.py`의index1은garmin.import/extension/account의기존work가열린채같은키other_work를INSERT하며0001의work_items_open_key_idx가이를거부한다. index0의기존target은synthetic라숨겨진차이다. runtime성공재개단언뒤기존work/attempt를정상성공정산한상태로준비한다음동일대상새work를생성하고근거도용거부를검사한다. 제품유일성/attemptgate는그대로유지한다. fixture최소수정과독립재확인이필요하다.

### 2026-11-06 — Review pass R3
- verdicts: 1 findings — high 0, medium 1, low 0, false 0, maybe-false 0
- 원문 `.brain-automation/review-r3-source.md`·`review-r3-verification.md`. 소스리뷰는R2-SRC-01원인해결·R1수정유지·추가확정제품결함0, 검증리뷰는R2세건해결을확인했다.
- [medium] [patch] VG-R3-001 PG중단복구fixture timestamp밀리초누락 — scheduled_date의엄격형식은.000필수이며시험의+00:00앞소수가없어서InvalidCollectInput이주입전에발생한다. 제품형식은유지하고fixture를실core봉투형식으로정정해등록경계시험의도달을확인한다.

### 2026-11-06 — Review pass R2
- verdicts: 4 findings — high 1, medium 3, low 0, false 0, maybe-false 0
- 원문 `.brain-automation/review-r2-source.md`·`review-r2-verification.md`. R1의다른제품원인/검증보완은정적해결확인, 아래4건은현재미완료다.
- [high] [bad_plan] R2-SRC-01 BH07복구미완료 — raw run success commit과collect_work_runs연결이별도여서normalize DB오류/중단뒤no-op재시도는연결을복원못한다. 실제collect성공transaction/후속조회조건을확인했다. R2a에서동일work/날짜의성공근거를정규화전원자저장하고DB오류/중단→재개·모델gate시험을작성한다. 수동성공을임의귀속하거나force호출하지않는다.
- [medium] [bad_plan] VG-R2-001 그래프seed재구성소실 — normalize_version없는새계정에서day_summary직접seed는첫rebuild로지워지고fake원문은모두NULL이다. R2b에서유효한원문/샘플또는명시현재version+projection을준비해실제graph단언을유지한다.
- [medium] [bad_plan] VG-R2-002 미래ready와실시간재설치gate충돌 — daemon은이틀뒤clock, CLI는실시간이라ready age<0이며살아있는동일home daemon때helper도대체못한다. R2b에서소유fake daemon종료확인뒤실시간소유daemon으로전환해재설치/사용자예약보존을확인한다. 제품ready검사를약화하지않는다.
- [medium] [bad_plan] VG-R2-003 과거차단COLLECT_INCOMPLETE재사용 — 누적count>0은새normalize실패attempt를기다리지않는다. R2b에서work/attempt토큰별종료/실패/정규화결과확인후marker해제하며모델0을유지한다.

### 2026-11-06 — Review pass R1
# R1 판정

18개 원문 지적을 수신 순서대로 개별 판정한다. 총 high8/medium10/low0/false0/maybe-false0. 수락조건을 줄이는 의도 공백은 없다. 알려진 결함을 완료로 숨기지 않는다. 시험 실행 유예 자체는 지적이 아니다.

- [medium] [bad_plan] VG-R1-001 활동/휴식 세트 실제 PG 결과 공백 — SQLfake만으로 제외결과를구별못한다. R1d에서행/합계/관측수·운동조건을외부조회로단언.
- [medium] [bad_plan] VG-R1-002 기존report fixture의필수채널누락 — required_settings gate가모델진입전실패한다. R1d에서self소유대화와fake채널/파일처리를준비하고기존모델·취소시험의관찰을유지.
- [medium] [bad_plan] VG-R1-003 재생성재시도기대가저장scope재호출요구 — 실제work별revision재개와충돌한다. R1d에서7d만재시도·기존revision/파일관계보존을검증.
- [medium] [bad_plan] VG-R1-004 다른대상완료파일문서/사진거부공백 — 같은source/다른target실파일이없어guard회귀를못잡는다. R1d에서두대상정상파일과요청불변을검증.
- [high] [bad_plan] EC-21.5-R1-001 앨범11장이상거부 — 실제renderer01~49최대49장/SQL10장한도를확인했다. R1b에서원래10장분할복원.
- [high] [bad_plan] EC-21.5-R1-002 날짜이동work revisionPK충돌 — 읽기날짜필터와PK(work_id,scope)가다르며coreensureWork가재사용한다. R1c에서날짜포함키·같은work두날짜저장/재개시험.
- [high] [bad_plan] BH-01 앨범한도 — EC001과동일원인, R1b.
- [high] [bad_plan] BH-02 schedule→work/완료work→schedule잠금역전 — 실제ensureWork/lockOpenSupervisedWork/settleScheduledSuccess를추적해확인했다. R1c에서공통순서를정하고중복정산경쟁도보존하는실PG동시성시험코드.
- [high] [bad_plan] BH-03 날짜이동revisionPK — EC002와동일원인, R1c.
- [medium] [defer] BH-04 Markdown상대그래프링크 — baseline원본의_assemble도동일YYYY-MM-DD/파일링크를만들며TelegramReportSink도동일단일md와사진만별도전송했다. 이번수락조건은core파일/평가관계와기존원본의미보존으로새문서링크체계를정하지않는다. 원래전달구조의소비한계이며기능결함수정을위한임의URL/압축규격은추가하지않는다. 링크소비UX를별도판단하도록deferred에증거보존.
- [medium] [bad_plan] BH-05 개별렌더실패publication영구고정 — charts.render가개별예외를삼키는실경로를확인했다. R1a는없음과실패를구분하고실패목록이있으면완성publication으로고정하지않음.
- [medium] [bad_plan] BH-06 invalid/타self채널설정늦은거부 — 모델후success에서만UUID검증한다. R1b에서envelopeUUID와모델전범용core공개검증으로존재/소유확인,설정오류분류·모델0시험.
- [high] [bad_plan] BH-07 normalize실패에도collectsuccess — collect._notify_normalize_failed는실패notification만쓰고run.status를변경하지않음을확인했다. R1c에서예약성공gate는이번정규화실패/미완료입력도거부하고재개후성공가능해야함.
- [medium] [bad_plan] BH-08 그래프4회렌더/저장·락점유 — 같은day의charts.render를각scope에서호출하고채널은day만쓴다. R1a에서day그래프집합공유·각scope평가관계/파일을보존하고고비용렌더는write_session밖.
- [medium] [bad_plan] BH-09 정상파일pending15분두단계 — FilesPending이일반REPORT_UNAVAILABLE→900000msretry로흐르는것을확인했다. R1a에서결합문서도최초제출하고정상완료대기를짧은boundedpoll/heartbeat로분리한다. 대기중transaction0·취소/fence를보존하고기존core장애retry정책은유지.
- [medium] [patch] BH-10 filename JSONnull우회 — length/regex가NULL이어서IF가거부하지않는다. R1b에서문자열/NULL/제어문자거부와실PG입력경계단언.
- [high] [bad_plan] IA-001 앨범한도 — EC001/BH01과동일원인, R1b.
- [high] [bad_plan] IA-002 날짜이동PK — EC002/BH03과동일원인, R1c.

KEEP: native원형/revision불변·oracle독립성,보호tokenstore/binding·attempt·모델후손/bodyIPC·대기transaction0,query/schema·core범용경계,예약/user설정/삭제표식/회계·파일/채널의미키와기존retry. 사용자의부분작업보존지시를우선해일괄revert하지않고확정된계약경계만작은Task로재도출한다. 수정후필요정적컴파일과source/verification 독립후속리뷰를수행한다. 모든시험실행은21.8이관·미실행.


## Design Notes

범용 예약 의존 장치를 추가하되 Garmin kind/표/지표를 core에 넣지 않는다. 날짜는 요청 IANA 시간대의 현지 날짜이며 native 날짜의 연결 timezone 일치가 필요하다. 다른 zone의 날짜를 단순 문자열로 오인하지 않게 명시적으로 거부하거나 원본 시각 의미에 따라 변환한다. 구체 허용 지표표는 원본 native 단위에 근거해 README와 schema에 함께 고정한다. 채널 및 파일의 비동기 완료는 모델 재호출과 분리한다.

## Verification

이번 실행: `pnpm build`, `pnpm typecheck`, `PYTHONPYCACHEPREFIX=<temp>/brain-21-5-pycache python3.14 -m compileall -q extensions/garmin/src extensions/garmin/tests`와 새 Python fixture/child 정적컴파일, `git diff --check`. 로그와 종료코드를 로컬 `.brain-automation/`에 보존한다. 시험 실행은 **21.8로 이관, 미실행**이며 matrix는 시험 코드 등록/독립 정적리뷰까지만 확인한다.

21.8: README의 전용 compose 프로젝트·소유 DB/role·격리home/합성자료를 준비하고 `pnpm test` → `pnpm test:python`을 순차 실행한다. 새 `garmin-core.test.ts`, 기존 native/collect/report/unit와 core/PG/CLI/platform/package/경로분류 시험을 포함한다. 실패 원인별 최소수정·관련시험 재검증, 기준SHA·환경/소유자원·명령/종료코드/로그·처분을 남긴다. 자신이 만든 자원만 정리한다. 새·기존 시험 미실행 또는 미해결 실패가 있으면21.8 built/21.7 시작 금지다. 운영설치/계정전환·모델선택·tokenstore binding 확인은21.7 운영조치로 인계한다.

## Auto Run Result

- 결과: **built**(사용자 인수 전). manifest 조회3종·11:00수집/11:30분석 Asia/Seoul cron/latest/같은날선행성공·설정snapshot·core파일/채널게시·Garmin marketplace제품package를연결했다. query지표/단위/허용집계·운동조건·NULL계약은확장이소유하며core에는Garmin reader/지표/프롬프트를추가하지않았다.
- 변경경계: 확장 query/collect/report runtime·durable게시·신규0016/native버전·제품legacy퇴역; core manifest/schema/예약장치·공통PG0036~0038/권한·잠금; plugins/garmin package/digest/진입점·marketplace/생성기; 실제설치/PG/CLI/MCP/외부fake시험과경로분류·README/UPSTREAM인계. 원래SQLite oracle는변경하지않았다.
- 독립리뷰: R1공식thorough4렌즈(18행)→수정R1a~d→R2 source/verification(4행)→수정R2a/b→R3 source/verification(1행)→timestamp수정/R4확인→지휘자AUDIT-01(1행)→fixture수정/R5확인. 원문24행중23행수정·1행defer, 기각0. R1 high8/medium10, R2 high1/medium3, R3/AUDIT 각medium1. 중복원인도원문행별판정을보존했다. 마지막source/한정verification리뷰의추가확정결함0·필수미완료0이다.
- 후속리뷰권고 false: 확인된제품원인은R3source, 마지막단순fixture정정은R4/R5독립verification에서해결확인됐다. 새제품변경없는마지막pass의high patch는0이다. BH04의원본문서상대링크한계만frontmatter deferred에남겼으며필수수락조건을숨기지않는다.
- 실제정적검증: 최종 `pnpm build` exit0(`.brain-automation/build-final.log`), `pnpm typecheck` exit0(`typecheck-final.log`), `PYTHONPYCACHEPREFIX=<temp>/brain-21-5-final-pycache python3.14 -m compileall -q extensions/garmin/src extensions/garmin/tests extensions/garmin/fixtures/native plugins/garmin/package/src packages/core/fixtures/extensions/v1` exit0(`python-final.log`), `sh -n plugins/garmin/bin/install.sh` exit0, `git diff --check` exit0. 변경173파일의개인홈절대경로정적검색0건. 최종fixture는컴파일이후추가변경없다.
- **시험 실행은21.8로 이관, 미실행.** 직접시험·fixture생성/checker·합성수집/반입/평가·실모델·운영연결·changed/전체시험을실행하지않았다. 컴파일/정적리뷰를기능시험통과로표현하지않는다. package생성은배포산출물제작이며실제설치실행은아니다.
- 21.8 인계: README의전용소유compose/PG·role·격리home·합성자료에서새garmin-core(database/exit)/garmin-query와기존native/collect/report/unit, core/PG/CLI/platform/package/분류전체를 `pnpm test` → `pnpm test:python` 순차실행한다. 실패별원인수정/관련재검증·기준SHA·환경/소유자원·명령/종료코드/로그/처분을보존한다. 자기소유자원만정리한다. 미실행/미해결이면21.8 built/21.7시작금지다.
- 운영조치(21.7): 선택self/connection과보호tokenstore·brain-account-binding.json동일계정확인, garmin.connection_id/garmin.timezone/analysis_model·agent/effort/timeout 및 자기channel_conversation_id설정, 실제marketplace설치/운영전환·옛예약해제는별도운영인수다. 사용자설정/예약/삭제표식과기존native/평가/core파일을재설치로덮지않는다. 20.4공통잠금/quiesce/registry/복구·legacy안전거부/불명잠금보존은유지한다.
- 잔여위험: 실제PG원자성/동시성·DDL권한·모델후손/대기·파일/채널비동기·합성fixture/독립oracle동등성·새/기존전체회귀의실행결과는21.8에서확정된다. 원본문서상대그래프링크의단독소비한계는deferred1건이다. 다중사용자보안완성을주장하지않는다.
- 배포: 구현commit뒤플러그인ref는그이전구현commit을가리키도록별도releasecommit에서올리고같은commit에plugin version/package.plugin_version/digest를동기화한다. 정상hook의티켓branchcommit/push·원격SHA일치증거는로컬최종보고에기록한다. main병합/push·에픽전이·중앙state변경은하지않는다. worktree/로컬branch/세션과로컬증거를보존한다.
