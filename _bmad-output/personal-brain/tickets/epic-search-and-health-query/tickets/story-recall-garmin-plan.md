---
title: '17.4 recall 스킬의 Garmin 건강 수치 조회'
type: 'feature'
ticket: 4
created: '2026-11-06'
status: 'built'
baseline_revision: 'cd0b50e5ef23ad6a756c076583cb5a7ad543fbcd'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 1
followup_review_recommended: false
context:
  - AGENTS.md
  - _bmad-output/personal-brain/automation/runbook.md
  - extensions/garmin/README.md
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 21.5가 Garmin 읽기 명령(`brain ext garmin period-summary`·`daily-values`, MCP `ext_garmin_*`)을 만들었지만, 에이전트가 건강 수치 질문을 그 명령으로 바꿔 묻고 응답 근거로 답하게 하는 recall 스킬과, 그 답이 독립 손계산과 같은지 확인하는 시험이 없다.

**Approach:** 플러그인 스킬 `plugin/skills/recall/SKILL.md`에 건강 수치 조회 절차(상태 확인 → 설정 읽기 → 기간·지표·운동·집계 해석 → 확장 명령 호출 → 응답 근거로 답·구분 안내)를 쓴다. 손으로 정한 원시 행·기대값 fixture 하나를 실제 설치 fixture의 CLI/MCP 통합시험과 가짜 CLI 행동 평가가 함께 쓴다. core에는 건강 port·SQL·명령을 더하지 않는다.

## Boundaries & Constraints

**Always:** 기대값은 fixture에 손으로 쓴 리터럴이다(제품 `query.py` 집계·SQL을 import·재사용·재구현하지 않는다). 여러 달 묶음은 시험 안의 독립 정수/유리수 계산으로 리터럴과 따로 대조한다. NULL은 0이 아니고 평균 분모는 비NULL 값 수다. 날짜는 연결 시간대(`garmin.timezone`)의 현지 날짜이며 양끝을 포함한다. 미설치·비활성·0건·전부NULL·명령 오류를 서로 다른 안내로 낸다. 시험은 전용 PG·격리 home·합성 자료·fake 외부 경계만 쓴다. 공개 문서에는 합성 값만 쓴다.

**Never:** core 건강 조회 port·`brain health query`·core의 `garmin` schema SQL 추가; 21.5 Garmin 명령 계약·`extensions/garmin` 제품 코드 변경; core migration·설치 전환·legacy guard(21.9 범위) 수정; recall 텍스트 검색 절차·`meta.extensions`(17.5 범위) 추가; `plugin/app-ref` 변경; 운영 DB·앱·설정·계정·예약·실수집·실발신 접근; 스킬이 값을 직접 계산·추정하거나 NULL을 0으로 바꾸는 것.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 합계·평균 | Asia/Seoul 연결, steps 2026-01-01..03 = [10, NULL, 30] | sum 40·mean 20, unit count, observed 2, null 1, 기간 그대로 | — |
| 전부 NULL | 기간의 행이 모두 NULL | value null, observed 0, null = 행 수 | 답은 "값 없음(0 아님)" |
| 0건 | 기간에 행 없음 | value null, observed 0, null 0 | 답은 "기록 0건", 오류와 구분 |
| 자정 경계 | 1/31·2/1 행, 2월 질의 | 2/1 행만 포함 | — |
| DST | America/New_York 연결, 2026-03-08·2026-11-01 포함 기간 | 손계산 값과 같음; "어제" 해석은 시간대 규칙(04:30Z 2026-03-09 → 현지 2026-03-09 00:30 EDT → 어제 2026-03-08) | 시간대 불일치 입력은 명령 오류로 안내 |
| 미설치·비활성 | garmin 미설치 / disable 뒤 | `ext status`가 installed/enabled false, 명령·MCP 도구 없음 | 스킬은 명령을 부르지 않고 미설치/비활성 안내 |
| 명령 오류 | 명령 `ok:false` | 오류 코드 보고 | 0건으로 합치지 않음 |

</intent-contract>

## Code Map

- `extensions/garmin/manifest.json` `commands[]` — `period-summary` 입력 `{connection_id, timezone, start_date, end_date, metric, aggregation(sum|mean), activity_type?, exercise?}`, 출력 `{value, unit, observed_count, null_count, start_date, end_date}`; `daily-values` 출력 `{rows:[{date,value,unit}]}`. 설정 키 `garmin.connection_id`·`garmin.timezone`. 읽기 전용, 변경 금지.
- `extensions/garmin/src/query.py` — 제품 집계(`METRICS` 지표/단위/허용집계, 연결 timezone 불일치 거부). 기대값 근거로 쓰지 않는다.
- `apps/cli/python-test/garmin-query.test.ts` — `extHome()`·`fixture.run`·`fixture.db.query`·MCP `mcp serve` 호출 패턴을 재사용한다. 새 시험은 별도 파일.
- `apps/cli/test/ext-fixture.ts` — 격리 home + `createIsolatedTestDatabase`(`BRAIN_TEST_DATABASE_URL`). 변경하지 않는다.
- `apps/cli/src/bin.ts` — 동적 확장 명령 등록(비활성·미설치면 `ext.garmin` 미등록), `apps/cli/src/mcp/serve.ts` 미등록 도구는 `EXTENSION_COMMAND_UNAVAILABLE`. `apps/cli/src/commands/config-get.ts` 점 포함 키 허용, `ext-status.ts`의 installed/enabled.
- `plugin/skills/channels/SKILL.md`, `tooling/bootstrap/test/channels-skill.test.ts`, `tooling/channels-eval/eval.mjs`, `tooling/install-eval/eval.mjs`, README 764·1169행 — 13.7 정적 검사·가짜 CLI 행동 평가 방식(prepare/fake/verify, calls.jsonl·outputs.jsonl·report.txt).
- `tooling/test-changed/rules.mjs` — Python 통합시험 선정 규칙. 새 공유 fixture 경로를 더한다.
- `plugin/.claude-plugin/plugin.json` `version` 0.1.17 — 새 스킬 배포를 위해 올린다. `plugin/app-ref`(472caa7, 21.5 명령 포함)는 바꾸지 않는다.
- 정적 검사 대상 core 소스: `packages/core/src`, `packages/postgres/src`, `packages/postgres/migrations`, `packages/second_brain/src`, `apps/cli/src`. 현재 `garmin` schema SQL 0건(`supervisor.ts`의 kind 문자열은 SQL 아님).

## Tasks & Acceptance

**Execution:**
- [x] A. `tooling/recall-eval/health-cases.json`(신규), `apps/cli/python-test/recall-health.test.ts`(신규), `tooling/test-changed/rules.mjs`(+규칙 시험) — 손계산 원시 행·질의·기대 출력 fixture와 실제 설치 fixture 통합시험: garmin 설치 → 합성 행 삽입 → CLI·MCP로 매트릭스 전 사례가 기대 출력과 정확히 같음, 여러 달 묶음의 독립 유리수 대조, 시간대 불일치 오류, 미설치·비활성의 status/명령 부재/MCP 도구 부재. `tooling/recall-eval/` 변경이 Python 시험을 고르게 한다.
- [x] B. `plugin/skills/recall/SKILL.md`(신규), `tooling/bootstrap/test/recall-skill.test.ts`(신규), `packages/core/test/extension-sql-boundary.test.ts`(신규), `plugin/.claude-plugin/plugin.json` — 스킬 절차 작성; 정적 검사(스킬의 `brain` 호출이 CommandSpec 또는 Garmin manifest 명령·입력 필드에 존재, 필수 안내 문구), core 소스에 garmin schema SQL 없음 검사, plugin version 0.1.18.
- [x] C. `tooling/recall-eval/eval.mjs`(신규), `package.json` `eval:recall`, `tooling/bootstrap/test/recall-eval.test.ts`(신규), `README.md` — 사례 `sum`, `mean`, `all-null`, `zero`, `dst-yesterday`, `not-installed`, `disabled`, `command-error`의 prepare/fake/verify. fake 출력은 `health-cases.json` 기대 출력, 입력은 Garmin manifest 입력 schema로 검증. 판정기 자기시험은 고정 입력이며 실제 에이전트 평가가 아님을 README에 쓴다.

- [x] E. (리뷰 R1 bad_plan) `tooling/recall-eval/health-cases.json`, `apps/cli/python-test/recall-health.test.ts`, `tooling/recall-eval/eval.mjs`, `tooling/bootstrap/test/recall-eval.test.ts` — 일별 조회 사례(`daily-values`, 날짜별 값·NULL 보존 rows 기대값)와 운동 조건 사례(합성 workout 행, `workout.duration_s` 등과 `activity_type`, 필요하면 `exercise`)를 손계산 리터럴로 더해 실제 CLI·MCP 통합시험과 행동 평가(prepare 질문·fake·verify의 rows 보고 검사)에 넣는다.
- [x] F. (리뷰 R1 patch) `tooling/recall-eval/eval.mjs`, `tooling/bootstrap/test/recall-eval.test.ts`, `plugin/skills/recall/SKILL.md`, `tooling/bootstrap/test/recall-skill.test.ts`, `packages/core/test/extension-sql-boundary.test.ts` — 판정기: 각 Garmin 조회 앞에 성공한 config 두 개·guide schema가 있어야 함, 허용 읽기 호출 외 brain 호출 실패, dst-yesterday는 transcript `명령:` 줄에 IANA 시간대를 쓴 시간대 도구 실행 증거 필요, 미설치 안내는 "미설치/설치되어 있지 않/설치되지 않"만 인정; 음성 자기시험(구조화 보고 변조, 상태 전 조회, `psql` 우회, 설정 늦게 읽기, 쓰기 호출 끼우기, 도구 없는 dst transcript, "설치되어 있습니다"). 스킬: schema는 지표 목록만 주고 지표별 허용 집계는 명령이 판정하므로 거부되면 오류 코드와 다른 집계 가능성을 안내. SQL 경계: 쉼표 FROM 항목·주석 사이 `garmin.` 참조 검출과 양성 표본.

- [x] G. (리뷰 R2 patch) `tooling/recall-eval/{health-cases.json,eval.mjs}`, `apps/cli/python-test/recall-health.test.ts`, `tooling/bootstrap/test/{recall-eval,recall-skill}.test.ts`, `plugin/skills/recall/SKILL.md`, `packages/core/test/extension-sql-boundary.test.ts`, `README.md` — Review Triage Log R2의 patch 행.

- [x] H. (리뷰 R3 patch) `tooling/recall-eval/eval.mjs`, `tooling/bootstrap/test/recall-eval.test.ts`, `packages/core/test/extension-sql-boundary.test.ts` — Review Triage Log R3의 patch 행.

**Acceptance Criteria:**
- Given 합성 Garmin 행을 넣은 설치 fixture, when 시험이 CLI와 MCP로 각 사례를 질의하면, then 출력이 fixture의 손계산 기대값(값·단위·관측 수·NULL 수·기간)과 정확히 같고 여러 달 묶음은 독립 유리수 계산과도 같다.
- Given Garmin 미설치 또는 비활성 home, when `brain ext status garmin`·`brain ext garmin period-summary`·MCP `tools/list`를 부르면, then 미설치/비활성 상태와 명령 부재가 관찰되고 0건 결과와 다르다.
- Given 준비된 eval 폴더의 실제 스킬, when 실제 에이전트가 각 사례를 수행하고 `pnpm eval:recall verify <폴더>`를 돌리면, then 기대 명령·입력을 불렀고 보고의 value·unit·observed_count·null_count·start_date·end_date가 마지막 명령 출력과 같으며 미설치·비활성·0건·전부NULL·오류 안내가 구분된다(8사례 모두 ok).
- Given core 소스 트리, when 정적 검사를 돌리면, then `garmin` schema를 읽는 SQL이 0건이다.

## Implementation Notes

- Task A(ctx_c5feaa7633ed): `health-cases.json` 9사례(sum 40, mean 20, all-null, zero, month-boundary 70, dst-sum 60, dst-mean 20, multi-month 40, dst-yesterday 12)와 `recall-health.test.ts`(CLI·MCP toEqual, 여러 달 독립 BigInt 대조, 시간대 불일치 ok:false, 미설치·비활성은 CLI `USAGE`·MCP 도구 없음, `garmin.*` config set/get), `rules.mjs`에 `tooling/recall-eval/` 규칙. `pnpm test:changed` exit 0.
- Task B(ctx_e05308042440): `plugin/skills/recall/SKILL.md`, `recall-skill.test.ts`, `extension-sql-boundary.test.ts`(core 소스 garmin schema SQL 0건), plugin version 0.1.18. `pnpm test:changed` exit 0. 첫 실행이 Orca 재시작으로 끊겨 그 실행 로그에 생성 기록이 있는 fixture 컨테이너 한 개만 정확한 ID로 정리했다.
- Task C(ctx_7567f539e8ce): `tooling/recall-eval/eval.mjs`(prepare/fake/verify, 8사례), `eval:recall`, 판정기 자기시험, README 한 문단. `pnpm test:changed` exit 0.
- 행동 평가 1회차(Terra 평가 워커 8개): 옛 판정기로 8/8 ok였으나 dst-yesterday 에이전트가 처음 2026-03-07(서머타임 미반영)을 조회하고 가짜 CLI 오류를 보고 3/8로 정정했다. 실제 명령은 틀린 날짜에도 다른 기간 값을 내므로 결함으로 판정했다.
- Task D(ctx_2e661aac8505): 스킬 3단계에 시간대 데이터베이스 도구로 현지 날짜를 구하고 재조회로 답을 찾지 말라는 지침, 판정기가 모든 조회 입력을 검사(정정 재시도 실패), 음성 자기시험. 첫 `test:changed`에서 기존 `postgres/redaction.test.ts`·`cli/ext-install-resume.test.ts`가 실패 후 재실행 통과(병렬 부하 의심, 전체 회귀에서 재확인). 최종 exit 0.
- 행동 평가 2회차(새 폴더·새 워커 8개): 강화 판정기로 8/8 ok. dst-yesterday는 python `zoneinfo`로 현지 날짜를 구해 첫 조회부터 2026-03-08. 1회차 기록은 강화 판정기에서 실패로 판정된다.
- Task E(ctx_ab2f30194b55): `daily`(rows 10·null·30)·`workout`(strength 60+90=150, NULL 1, run 300 제외) 사례를 fixture·통합시험·eval에 추가. `pnpm test:changed` exit 0(`.brain-automation/logs/taskE-20261106.log`).
- 사용자·중앙 지시(2026-11-06, 중앙 msg_8d327af7e81e): 개발 중 시험 실행 금지, build·typecheck·diff --check만. 개발 완료 후 커밋 전 `pnpm test` → `pnpm test:python` 순차 1회, 실패 수정 재검증만 `test:changed`. 이 지시가 계획 Verification의 반복 `test:changed`보다 우선한다.
- Task F(ctx_a51437efb85c): R1 patch 11행 반영(판정기 순서·허용 호출·DST 도구 증거·미설치 문구, 음성 시험, 스킬 집계 문구, SQL 경계 주석·쉼표). 최종 상태 `pnpm build`·`pnpm typecheck`·`git diff --check` exit 0. 지시 전에 시작된 `test:changed` exit 0은 최종 상태 증거가 아니다.

## Plan Change Log

- R1(2026-11-06): BH5·BH6(행동 평가와 fixture에 일별 조회·운동 조건 사례 없음)이 bad_plan이다. 티켓 description이 운동 조건과 `daily-values`를 recall 행동 표면으로 명시했는데 계획의 사례 목록이 걸음 수 period-summary만 정했다. Execution E를 더했고, 같은 패스의 patch 지적은 Execution F로 함께 재도출한다. 피한 나쁜 상태: 일별·운동 질문을 잘못 변환해도 평가가 통과하는 것. KEEP: Task A~D의 기존 코드 전체(health-cases 9사례·통합시험·스킬 절차·정적 검사·eval 8사례·Task D의 시간대 도구 지침과 모든 호출 입력 검사)는 검증을 통과했고 재도출해도 같으므로 되돌리지 않고 보존한 채 E·F만 더한다(전체 revert 생략은 지휘자 판단, 같은 checkout의 증거·로그 보존 목적). intent-contract는 수정하지 않는다.

## Review Triage Log

### 2026-11-06 — Review pass R1
- verdicts: 14 findings — high 0, medium 12, low 2, false 0, maybe-false 0 (intent-alignment는 기술 보고로 별도 지적 0건; 일별·운동·가을 DST 상대 날짜 표면 차이를 기술했고 앞 둘은 BH5·BH6과 같다)
- findings:
  - `medium` `patch` BH1 스킬이 guide schema로 허용 집계를 확인하라 했으나 schema에는 지표별 허용 집계가 없다(`query.py` METRICS: weight_kg mean만, hrv_avg 없음) — F에서 스킬 문구를 명령 거부 시 오류 안내로 정정.
  - `medium` `patch` BH2 판정기가 config·schema 조회가 Garmin 조회보다 앞섰는지 보지 않는다 — F 순서 검사·음성 시험(ECH1과 같은 원인).
  - `medium` `patch` BH3 허용 외 brain 호출(`config set`, `ext enable`)을 거부하지 않는다 — F 허용 호출 목록·음성 시험.
  - `medium` `patch` BH4 dst-yesterday가 시간대 도구 실행을 검증하지 않는다 — F transcript `명령:` 줄의 IANA 시간대 도구 증거 요구(ECH2와 같은 원인).
  - `medium` `bad_plan` BH5 일별 조회 분기의 행동 평가·fixture 사례가 없다 — 계획 Execution E 추가.
  - `medium` `bad_plan` BH6 운동 조건 변환 행동 사례가 없다 — 계획 Execution E 추가(BH5와 같은 원인: 계획 사례 목록 누락).
  - `low` `patch` BH7 SQL 경계 정규식이 쉼표 FROM 항목·주석 사이 `garmin.` 참조를 놓친다 — 경계 시험이 지키려는 규칙의 우회이며 수정이 정규식 보강뿐이라 F에서 고침.
  - `medium` `patch` ECH1 설정·schema를 조회 뒤에 읽어도 통과 — BH2와 같이 F.
  - `medium` `patch` ECH2 DST 도구 실행 증거 없음 — BH4와 같이 F.
  - `low` `reject` ECH3 `calls.jsonl`에 null 행이면 예외로 verdict.json 미갱신 — jsonl은 fake CLI만 배열로 쓰고 이 경우도 CLI는 종료 1로 실패하므로 일상 사용에서 만나기 어렵고 수정은 가드 추가다.
  - `medium` `patch` ECH4 미설치 판정 `/미설치|설치/`가 "설치되어 있습니다"도 통과 — F 정규식 정밀화·음성 시험.
  - `medium` `patch` VG1 구조화 보고만 변조한 음성 시험 없음 — F 시험 추가.
  - `medium` `patch` VG2 상태 확인 전 조회의 음성 시험 없음 — F 시험 추가.
  - `medium` `patch` VG3 DB 우회(`psql`) transcript 음성 시험 없음 — F 시험 추가.

### 2026-11-06 — Review pass R2
- verdicts: 13 findings — high 0, medium 6, low 7, false 0, maybe-false 0 (BH 7, ECH 4, VG 1, intent-alignment 기술 보고에서 지휘자가 뽑은 1)
- findings:
  - `low` `reject` BH1 성공 출력의 data를 기대값과 대조하지 않는다 — outputs.jsonl은 fake만 쓰고 fake는 성공 시 expected만 내며 자기시험이 fake 응답을 고정하므로 일상 평가에서 만나기 어렵고 수정은 검사 추가다.
  - `medium` `patch` BH2 일별 보고에 응답에 없는 날짜 행을 덧붙여도 통과 — G: 보고의 날짜 행 전체를 파싱해 rows와 개수·내용 대조, 음성 시험(ECH2와 같은 원인).
  - `medium` `patch` BH3 실제 관측값 0 행이 없어 0을 결측으로 다루는 오류를 못 잡는다 — G: 값 0 행·사례(value 0, observed 1, null 0) CLI·MCP 대조, 스킬에 "값 0은 기록된 0" 안내.
  - `medium` `patch` BH4 `exercise` 조건 사례가 없다 — G: exercise_log 합성 행과 운동명 하나만 묻는 사례를 통합시험·행동 평가에 추가.
  - `low` `reject` BH5 상태 오류·설정 누락 분기를 평가하지 않는다 — 의도의 구분 대상(미설치·비활성·0건·명령 오류) 밖이고 연결 UUID는 추정할 수 없으며 새 사례 추가는 복잡도 증가다. 스킬에는 중단 지침이 있다.
  - `low` `reject` BH6 DST 도구 증거를 `echo`로 위조할 수 있다 — 평가 대상은 정직한 에이전트 행동이고 최종 입력 날짜는 호출 로그로 확인하며 지휘자가 transcript 원문을 직접 읽는다.
  - `low` `patch` BH7 SQL 경계가 `FROM ONLY`·`--` 주석을 놓친다 — G: 정규식 보강과 양성 표본(ECH1과 같은 원인).
  - `low` `patch` ECH1 쉼표 FROM 항목이 다음 줄에 오면 놓친다 — BH7과 같이 G.
  - `medium` `patch` ECH2 일별 추가 날짜 — BH2와 같이 G.
  - `low` `reject` ECH3 fake에 `__proto__` 명령명을 주면 예외 — 적대적 입력이며 평가 에이전트의 정상 호출에서 생기지 않는다.
  - `low` `patch` ECH4 MCP 자식이 응답하지 않으면 cleanup이 안 돈다 — G: 요청 제한 시간과 finally의 자식 종료(시험 자원 누수 방지, 직접 수정).
  - `medium` `patch` VG1 command-error를 "기록 0건"으로 보고한 경우의 음성 시험 없음 — G 시험 추가.
  - `medium` `patch` IA-R2(지휘자 감사) 티켓 verify의 "미설치·비활성 때 명령이 없음을 안내"를 스킬·판정기가 요구하지 않는다 — G: 스킬에 조회 명령을 쓸 수 없음(명령 없음)을 안내하도록 쓰고 판정기가 그 안내를 요구.
- 설계 확인: 의도 정합성 R1·R2가 기술한 "실제 설치 경로를 지나는 단일 에이전트 실행이 없다"는 계획 Design Notes의 값 사슬 결정(실제 명령 출력 == fixture 기대값, 에이전트 입력·답 == 그 출력)으로 다룬다. Auto Run Result에 가정으로 남긴다.

### 2026-11-06 — Review pass R3 (R2 수정 확인, 단일 Sol 리뷰어)
- R2 patch 9행(BH2·BH3·BH4·BH7·ECH1·ECH2·ECH4·VG1·IA-R2) 모두 해결로 판정. 손계산 기대값 전 사례를 원시 행으로 재대조해 일치.
- verdicts: 2 findings — high 0, medium 1, low 1, false 0, maybe-false 0
- findings:
  - `medium` `patch` R3-1 일별 보고를 정확한 역순으로 쓰면 판정기가 거부한다(`eval.mjs` rows 배열 순서 비교) — H: 날짜 행을 날짜순 정규화 후 개수·내용·중복 대조, 역순 양성 시험.
  - `low` `patch` R3-2 SQL 경계 검사가 문자열 리터럴 `'--'` 뒤 `from garmin.x`를 주석으로 지워 놓친다 — H: 원문과 주석 제거본을 모두 검사(어느 쪽이든 매치면 위반), 양성 표본 추가. 수정이 직접적이라 고친다.

## 복구 후 평가 실패 수정 — Task I

- [x] I. 평가 3차 실패 2건을 수정한다. 일별 조회에서 스킬이 안내한 period-summary schema 조회도 허용되는 읽기 호출로 판정하고 양성 회귀 시험을 추가한다(허용하지 않은 명령·잘못된 조회 입력 거부는 유지). 미설치·비활성 안내에 조회 명령 부재를 반드시 별도 문장으로 보고하도록 스킬을 명확히 한다. 정적 스킬 시험을 보강한다. 담당 파일: `tooling/recall-eval/eval.mjs`, `tooling/bootstrap/test/recall-eval.test.ts`, `plugin/skills/recall/SKILL.md`, `tooling/bootstrap/test/recall-skill.test.ts`.

기존 3차 daily 결과는 schema 추가 조회만 실패했고 실제 일별 입력·값은 일치했다. not-installed 결과는 미설치·설치 안내는 있었으나 필수 명령 부재 안내가 없었다. 원문 평가 기록을 변경하지 않는다. 수정 중 시험 실행 금지, 컴파일 확인만 수행하고 독립 후속 리뷰 후 검증 실패에 대한 관련 재검증을 진행한다. 기존 최종 전체 회귀 결과는 수정 전 증거로 보존한다.

## Design Notes

- 값 사슬: 통합시험이 "실제 명령 출력 == fixture 기대값"을, 행동 평가가 "에이전트 호출 입력 == 기대 입력, 답 == 그 출력"을 증명한다. 두 시험이 같은 JSON을 읽어 사슬이 끊기지 않는다.
- 스킬 절차: (1) `brain ext status garmin --json` — installed false면 미설치(second-brain-garmin 플러그인 설치 안내), enabled false면 비활성(활성화는 사용자 결정) 안내 후 중단, 실패면 상태 확인 불가. (2) `brain config get garmin.connection_id --json`·`garmin.timezone` — 없으면 설정 필요 안내. (3) 질문을 현지 날짜 기간(양끝 포함, 상대 날짜는 현재 시각을 `garmin.timezone`으로 바꿔 계산)·지표·운동 조건·집계로 바꾸고 `brain guide schema ext.garmin period-summary --json`으로 지표·집계를 확인. (4) `brain ext garmin period-summary --input '<json>' --json`(또는 MCP `ext_garmin_period_summary`), 일별은 `daily-values`. (5) 응답의 값·단위·관측 수·NULL 수·기간·시간대로 답한다. 손으로 다시 계산하지 않는다.
- 운영 인계: 실제 설치본에서의 스킬 발견·실행은 17.7(이 Mac 확인)이다. 텍스트 검색 절차는 17.5가 같은 스킬에 더한다.

## Verification

**Commands:**
- `pnpm build` · `pnpm typecheck` -- exit 0 (중간 지점).
- `BRAIN_TEST_DATABASE_URL=<전용 PG> pnpm test:changed` -- 반복 검증, exit 0.
- `pnpm eval:recall prepare <사례> <새 임시 폴더>` → 실제 에이전트 워커 수행 → `pnpm eval:recall verify <폴더>` -- 8사례 ok, 지휘자가 호출·출력·보고 원문 확인.
- 마무리 직전 순차 1회: `BRAIN_TEST_DATABASE_URL=<전용 PG> pnpm test` → `BRAIN_TEST_DATABASE_URL=<전용 PG> pnpm test:python` -- 둘 다 exit 0, 로그는 `.brain-automation/`에 고유 ID로 보존.
- `git diff --check` · 변경 파일 개인 홈 절대 경로 검색 0건.

### 2026-11-06 — Review pass R4 (복구 후속)

- verdicts: 2 findings — high 0, medium 0, low 2, false 0, maybe-false 0
- findings:
  - `low` `reject` R4-1 문자열 `--`와 FROM 뒤 블록 주석을 결합한 SQL은 정적 경계 검사가 놓친다 — 원문은 블록 주석 때문에 불일치하고 제거본은 문자열 내부 `--` 뒤를 지워 불일치한다는 정적 반례를 확인했다. 현재 제품 소스에 해당 의존은 없고, 이 결합을 일반적으로 처리하려면 인용 문자열과 TS 템플릿·SQL 주석 문맥을 구별하는 파싱 분기를 추가해야 한다. 일상 변경에서 만날 가능성이 낮은 low 문제의 복잡성 추가에 해당하여 수정하지 않는다. 정적 검사는 완전한 SQL 파서가 아니라는 잔여 한계를 보존한다.
  - `low` `reject` R4-2 설명 주석 속 Garmin SQL을 원문 검사에서 의존으로 오탐한다 — 원문 검사 때문에 과거 SQL을 주석으로 추가하는 경우 실패할 수 있다는 정적 반례를 확인했다. 원문 검사를 단순 삭제하면 R3의 문자열 `--` 검출이 다시 깨지므로 직접 삭제로 해결할 수 없고 문맥 파싱이 필요하다. 현재 소스에는 해당 오탐이 없으며 일상 변경에서 드문 low 사례로 복잡성 추가 없이 거절한다. 향후 주석 추가로 경계 시험이 실패하면 실제 의존 여부를 확인해야 한다.

R4는 H의 일별 순서 정규화·중복 거부, I의 schema 추가 읽기 허용·필수 schema 유지·입력 불일치 거부·미설치와 비활성 명령 부재 안내를 해결로 확인했다. 추가 제품 결함은 없다. 새 코드 수정은 없으며 독립 리뷰 전문은 로컬 `.brain-automation/reviews/r4.md`에 보존한다. 남은 검증은 수정 후 시험 재검증과 실패 사례 행동 평가다.

## 복구 후 검증 증거

- Task I: 일별 schema 허용 판정 불일치와 미설치 명령 부재 안내 누락을 수정했다. 음성 시험 입력을 fixture와 다른 날짜로 정정했다. build·typecheck·diff 검사 종료 0, 수정 중 시험은 실행하지 않았다.
- 독립 후속 R4: Task H/I 해결을 정적으로 확인했다. low 2건은 위 triage 근거로 거절했고 SQL 경계 정적 검사의 제한을 보존했다.
- 행동 평가 3차는 11건 중 9건 통과, daily·not-installed 실패였다. 원문은 보존했다. 수정 후 새 폴더의 실제 에이전트 평가 4차에서 daily·not-installed·disabled가 모두 판정 종료 0으로 통과했다. calls·outputs·report·transcript를 지휘자가 직접 대조했다. daily의 NULL 보존과 unavailable 상태에서 추가 조회 없음·필수 안내를 확인했다.
- 수정 전 최종 전체 회귀: `pnpm test` 종료 0(189 files, 4217 passed, 1 skipped), 이어 `pnpm test:python` 종료 0(16 files, 69 passed). 원본 로그는 로컬 `.brain-automation/logs/final-pnpm-test-t174-1.log`, `final-pnpm-test-python-t174-1.log`에 보존한다. 수정 후 재검증 결과와 혼동하지 않는다.
- 수정 후 관련 재검증 1회차는 종료 1: 기본 188파일 통과·1파일 실패, 4214 passed·3 failed·1 skipped이며 Python 단계는 실행되지 않았다. 기존 `ext-install-resume.test.ts`의 인증 일감 ID 재사용 1건과 SIGINT 종료 코드 2건 실패다. 원본 로그 `.brain-automation/logs/recovery-test-changed.log`를 보존한다.
- 소스 수정 없이 `VITEST_MAX_WORKERS=2 pnpm test:changed -- cd0b50e5ef23ad6a756c076583cb5a7ad543fbcd`로 재검증해 최종 종료 0: 기본 189파일·4217 passed·1 skipped, Python 16파일·69 passed. 로그 `.brain-automation/logs/recovery-test-changed-retry.log`. 부하에 민감한 700ms 인증·300ms SIGINT 시간 조건과 정합하지만 최초 실패의 원인을 확정한 것은 아니며 높은 부하에서의 불안정성은 남는다.

## Auto Run Result

- 결과: `built`(사용자 인수 전). recall 건강 조회 스킬과 실제 CLI/MCP 독립 기대값 통합시험, fake CLI 실제 에이전트 행동 평가·판정기 및 정적 SQL 경계 검사를 구현했다.
- 변경 파일: `plugin/skills/recall/SKILL.md` 조회·안내 절차; `plugin/.claude-plugin/plugin.json` version 0.1.18; `tooling/recall-eval/{eval.mjs,health-cases.json}` 합성 fixture·평가; `apps/cli/python-test/recall-health.test.ts` 실제 CLI/MCP 대조; `packages/core/test/extension-sql-boundary.test.ts` SQL 경계; `tooling/bootstrap/test/recall-{eval,skill}.test.ts` 판정·정적 계약; `tooling/test-changed/rules.mjs`와 `tooling/test-db/test/test-changed.test.ts` Python 선정; `package.json`과 `README.md` 평가 실행 진입점; 이 계획은 구현·검증·리뷰 근거다.
- 리뷰: R1 14건(12 medium·2 low), R2 13건(6 medium·7 low), R3 2건(1 medium·1 low), R4 2건(low 2). 각 행의 patch·bad_plan·reject 처분과 근거는 Review Triage Log에 보존했다. deferred 없음. R4 patch는 0건이며 후속 리뷰 권고는 false다. 거절 항목은 R1 ECH3, R2 BH1·BH5·BH6·ECH3, R4 R4-1·R4-2로 각 기록의 근거를 유지한다.
- 검증: 위 최종 전체 회귀(순차 각1회)와 실패 후 제한 worker changed 재검증 종료 0, 실제 행동 평가의 11사례 기록 및 변경 영향 3사례 새 평가 통과. 판정기 자기시험을 실제 행동 평가로 계산하지 않았다.
- 격리·정리: 최종 전체 회귀 및 복구 재검증 로그의 fixture 생성 ID 469개를 실제 Docker와 대조해 잔존 0개를 확인했다. 자기 전용 PG `brain-t174-pg-3263ed`도 정확한 ID로 정리했다. Python 실행이 만든 기존 추적 cache 변경은 로컬에 보존 후 원래 바이트로 되돌려 커밋에서 제외했다. 다른 티켓 자원은 수정하지 않았다.
- 잔여 한계: 최초 시간 조건 실패의 근본 원인은 확정하지 않았다. 제한 worker 재검증으로 회복된 실행 증거를 남겼으며 고부하 안정성 개선은 이번 수정으로 주장하지 않는다. SQL 경계는 R4의 드문 주석 조합 누락/오탐이 있는 정적 검사다. 실제 명령 fixture 통합시험과 fake CLI 행동 평가의 값 사슬을 사용하며, 실제 설치 CLI를 에이전트가 직접 사용하는 운영 확인은 17.7 범위다.

## 중앙 수락 전 main 통합 보완

- 중앙 지시 `msg_bccc18b13383`에 따라 원래 baseline과 기존 결과를 보존한 채 main `6f22d9708df2ecaaa0db938b08f3e0cdf16b8067`을 이전 티켓 tip `1091369653720528fc6e3057845d5f3dfafeff58`에 정상 merge한다. 충돌은 없었고 검증 전 merge commit은 만들지 않았다.
- main의 21.9 릴리스가 이미 version 0.1.18을 사용하므로 recall 배포 version은 0.1.19로 올린다. app-ref는 main의 `118df4718cb44ec99a12f6e24048f5131b2df923`을 그대로 보존한다. 앞선 0.1.18·app-ref 미변경 기록은 통합 전 이력이다.
- R5 독립 Sol 리뷰는 installer/store의 legacy 전환·validateOnly와 recall fixture의 최신 schema 초기화·Garmin owner migration·installed.json·CLI/MCP fence·core SQL 경계를 추적해 구체 통합 결함과 병합 누락이 없음을 확인했다. main 변경 파일은 main과 동일하고 티켓 제품·시험 파일은 기존 tip과 동일하다. 새 제품/시험 수정은 없다.
- R5 발견 0건, patch 0건, deferred 없음. 보고서 `.brain-automation/reviews/r5-main-integration.md`. 리뷰의 전체 회귀 제안보다 중앙의 이번 통합 전용 `VITEST_MAX_WORKERS=2 test:changed` 지시를 적용한다. 원래 baseline 대비 staged/unstaged main 통합 변경과 recall 시험을 함께 선정해 핵심 시험 선택·실행 증거를 남긴다. version/docs만의 변경으로 행동 평가나 전체 명령을 별도로 반복하지 않는다.
- 검증 완료 전 상태는 in-review로 유지한다. 최종 stage에서 0.1.19·app-ref를 다시 확인하고 정상 merge commit·티켓 브랜치 재push 후 원격 SHA를 보고한다.
- 통합 재검증 1회차: 기본 190파일 중 189파일 통과, 4294 passed·1 failed·1 skipped. 실패는 `extension-plugin.test.ts:86`의 app-ref→HEAD 조상 검사 한 건이며, `--no-commit` merge에서 HEAD는 아직 이전 티켓 tip이어서 main에서 가져온 app-ref가 그 조상이 아니다. Python 단계는 도달하지 않았다. 로그 `.brain-automation/logs/main-integration-test-changed.log`를 보존한다. 제품·시험 소스를 바꾸거나 검사를 우회하지 않고 정상 merge commit으로 필요한 Git 이력을 만든 뒤 재검증한다. 이 이력 의존 검사는 merge commit 전 통과할 수 없으므로 먼저 로컬 merge를 확정하되, 모든 재검증이 끝나기 전 원격 push는 하지 않는다. 최초 baseline과 부모 두 개를 보존한다.
- 정상 merge commit `bf7536e5664a667114736448060de145eb55d00f` 뒤 유일 실패 파일의 관련 시험 6개가 종료 0으로 통과했다. 기존 TS189파일 통과 결과는 소스 변경이 없어 반복하지 않았다. 이어 이전 실패로 미실행됐던 `PYTHONDONTWRITEBYTECODE=1 VITEST_MAX_WORKERS=2 pnpm test:python`은 16파일·69개 통과, 종료 0이다. 로그 `.brain-automation/logs/main-integration-release-ref-recheck.log`, `main-integration-test-python.log`. 자기 fixture 생성 ID176개 잔존0을 확인했고 전용 PG도 정확한 ID로 정리했다.
- 이어 중앙 최신 지시 `msg_144c095ef46e`로 main21.10 `bfcb3e3ff359ff5f4ec10e16cd5cc13c55ba8664`를 추가 통합한다. 위 0.1.19 시점 검증과 이력을 보존한다. 유일 충돌은 plugin version0.1.19/0.1.20이며 새 recall 배포0.1.21로 해결했다. app-ref는 main의 `8513bf9c46960658e63c26ec6f89f27457e88bf8`을 보존한다. 제품·시험 소스 충돌이나 직접 추가 수정은 없다. R6에서 새 replacementRequired/실행 gate·legacy manifest 처리와 recall fresh fixture·CLI/MCP 상호작용을 정적으로 확인한 뒤 실제 영향에 필요한 검증을 수행한다.
- R6 독립 Sol 리뷰 결과 구체 통합 findings0건, patch0건, deferred없음. main 전용 소스/시험은 main과 동일하며 plugin0.1.21은 index에도 있고 app-ref8513bf9가 보존됐다. 보고 `.brain-automation/reviews/r6-main2110-integration.md`. replacement_required 전용 recall 복구 안내는 없지만 비활성 상태에서 중단하며, 비정상 활성 상태도 공통 gate가 차단한다. MCP 미등록 도구의 오류 코드는 CLI 교체 진단과 다를 수 있으나 성공값/옛 코드 실행으로 우회하지 않는다. 이 설명 한계를 결과에 보존한다.
- 최신 중앙의 불필요 전체 회귀 반복 금지에 따라 새 통합 영향의 R6 TS14파일(installer·migration·manifest·실행 gate·recall 계약·SQL 경계·릴리스 이력)과 Python `recall-health.test.ts` 전체를 지정해 재검증한다. 이는 새 실행 gate 아래 실제 fresh Garmin 설치와 CLI/MCP 합성값·미설치/비활성 명령 부재를 확인하는 범위다. 빌드·typecheck 후 제한 worker2로 TS→Python을 순차 실행하며, 앞선 전체 검증 이력을 이번 트리의 pass로 옮겨 쓰지 않는다. 릴리스 시험에 필요한 정상 mergecommit을 먼저 로컬 확정하고 통과 전 push하지 않는다.
- 정상 merge `48076c1b82c36f55c6eb856d2a8791f6c66a8d18`의 두 부모는 `bf7536e5664a667114736448060de145eb55d00f`, `bfcb3e3ff359ff5f4ec10e16cd5cc13c55ba8664`다. version0.1.21/app-ref8513bf9를 보존하며 제품·시험 소스 추가 수정은 없다.
- R6 검증: `pnpm build`·`pnpm typecheck` 종료0. `VITEST_MAX_WORKERS=2` 지정 TS14파일의 첫 실행은 13파일 통과·1파일 실패(661 passed,4 failed). 새 `install-legacy-manifest.test.ts`의 CLI fixture가 관리자 인증값을 고정하는데 자기 시험 PG는 임의 인증값을 사용한 환경 불일치였다. 원문 `.brain-automation/logs/r6-integration-ts.log`를 보존한다. 자기 전용 PG만 해당 합성 fixture 전제에 맞췄으며 제품·시험 소스는 수정하지 않았다.
- 실패한 legacy-manifest1파일만 재검증해31개 통과·종료0, 이어 이전 실패로 미실행된 Python `recall-health.test.ts` 전체3개 통과·종료0. 정상 Garmin 설치 후 손계산 fixture 전 사례의 CLI/MCP 값과 미설치/비활성 명령 부재를 실제 확인했다. TS13파일은 환경 수정만으로 반복하지 않았다. 로그 `.brain-automation/logs/r6-integration-legacy-retry.log`, `r6-integration-python.log`; 단계별 정확한 명령·종료코드 `.brain-automation/r6-verification-steps.json`, `r6-verification-retry-steps.json`. 첫 TS14파일 명령이 전체 통과했다고 표기하지 않는다.
- R6 자기 fixture 생성 ID41개를 실제 Docker와 대조해 잔존0개를 확인했고 자기 전용 PG도 정확한 ID로 정리했다. 이전 검증 이력·최초 시간 조건 실패3건·SQL 정적 검사 한계는 그대로 보존한다. 새 통합 findings와 미해결 검증 실패는 없다. 최종 상태 built, 후속 리뷰 권고 false, 인수 전 done 아님. 이번 최종 릴리스는0.1.21이고 앞선0.1.18/0.1.19 기록은 당시 이력이다.
