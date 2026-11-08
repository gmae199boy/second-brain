---
title: 'redaction cleanup 실패와 복구의 결정적 회귀'
type: 'bugfix'
ticket: 14
created: '2026-11-09'
status: 'built'
baseline_revision: 'a14d9eeca8722e7c949e248067b5e2ce04b1e31a'
original_baseline_revision: '2f23d30b7a894a9979567311544c7f28e3f25a5a'
registration_main_revision: '57331d5d339b05d777471e34e19935d31fc0df39'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context: ['.brain-automation/tickets/19.14/independent-spec.md', '.brain-automation/tickets/19.14/po-independent-review.md', '.brain-automation/tickets/19.14/po-followup-review.md']
warnings: ['oversized']
deferred: []
operator_actions: []
---

<intent-contract>

## Intent

**Problem:** 19.5 source87f7b3e79e74b3da7a1de055259ed0016a989567의 전체 회귀에서 권한 상실 cleanup 실패 기대1/실제2를 관찰했다. 원행 식별 정보가 접혀 없어 역사 원인 귀속은 미확정이며 단독39pass로 해결을 선언할 수 없다.

**Approach:** 기존 PG18 실제 cleanup/queue/실패 저장 경로를 보존하고 시험 전제·격리를 명시한다. 권한 단독 입력과 방해 입력을 분리해 전체 대상/실패 집합·물리 비밀 바이트 제거·명시적 retry·새 세대 보호를 결정적으로 검증한다. 외부 snapshot 영향은 우선 후보이지 확정 원인이 아니다.

## Boundaries & Constraints

**Always:** 시험 실행 금지, 컴파일 확인만. 개발·리뷰 수정 중 pnpm build/typecheck/git diff --check만 실행한다. 마지막 실질수정·독립 후속 뒤 VITEST_MAX_WORKERS=2 pnpm test → pnpm test:python 전체순차각1회 필수, 실패 수정 뒤 관련 시험/test:changed만 재검증한다. 합성입력·전용 cluster/role/HOME/TMP/venv·동적loopback포트, 정확소유ID·원시exit·자원부재 증거를 보존한다. 전체 work/failure 안전JSON 진단에 관측시점·대상·code·fingerprint·occurrences·work id/attempts/outcome/claim/last_error를 포함하고 URL/원문 payload/암호는 제외한다. 다른 checkout/중앙main/state는 읽기전용이다.

**Never:** 기대1→2, 단순 대상필터로 추가 실패 숨김, skip/timeout증가/무한retry/성공까지반복, mock으로 물리cleanup 대체. 19.5 runner/slot/hook/측정/config,19.13 Drive 두 시험,migration0001~0043,plugin,lock,공용API 변경 금지. 공통 fixture/test-db/core/PG 제품 편집은 실제원인·최소diff·영향을 중앙에 질문한 뒤에만 가능하다. 전역환경/서비스 변경·운영DB·실제Drive/transcript/비밀 사용 금지. 문서·보고·prompt에 개인홈절대경로 금지. 구현자는 소스/시험만 편집하고 커밋/push/티켓전이는 지휘자가 한다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 권한 단독 | 독립cluster·세 cleanup대상·messages MAINTAIN회수 | messages만10attempts·실패1·미완료0,나머지성공·실패0·실제rewrite/비밀제거,doctor warn | 전체집합 불일치·예상밖실패는 안전JSON과함께실패 |
| 권한 복구 | 위 실패뒤grant·명시retry | added1/skip0,실제messages rewrite·비밀제거/control보존·기존실패1해소·미해결0·doctor ok | 기존한도내완료못하면실패·원오류보존 |
| 방해 입력 | 독립cluster의 명시적 오래된snapshot·합성redaction | 실제cleanup이미완료를검출,경고/비밀잔존,해제뒤유한retry·실제비밀제거 | 과거2행원인으로소급확정하지않음·예상집합은입력으로결정 |
| 저장/새 세대 | 동일fingerprint중복·다른대상/원인·오래된claim | 동일행occurrences증가,다른실패보존,승리한해당target의완료만해소 | 기존stale-claim회귀보존·물리검증별도 |

</intent-contract>

## Code Map

- `packages/postgres/test/redaction.test.ts` — fixture(17~43)는 공유cluster의DB를쓴다. `database(true, factory)`의기존seam을통해국소적으로기존isolated factory를소비할수있다. MAINTAIN사례(261~283)는세작업을빠른합성시각10회소진뒤전체실패행1을기대하지만건강대상의외부방해를통제하지않는다. `nodes`/`heaps`/`recoverAndDrainCleanup` 재사용. 후자는외부DB의deadtuple보존가능성을주석으로명시한다.
- `packages/postgres/test/fixture.ts` — 읽기전용. database(migrate=true,createDatabase=createTestDatabase)가factory seam을제공하며예외시db.drop한다.
- `tooling/test-db/src/index.ts` — 읽기전용. createTestDatabase는공유cluster의DB만분리,createIsolatedTestDatabase는자체postgres18 tmpfs/dynamicport·role cluster를만들고resource로그·정확ID제거를제공한다. helper재구현금지. 이버전isolatedfactory는19.5의lease기능을직접소비하지않는다.
- `packages/postgres/src/maintenance.ts` — 읽기전용. VACUUM FULL VERBOSE·relfilenode전후·checkpoint·retained notice를확인. retained>0은DB_LOCKED,handler는TABLE_CLEANUP_WAITING으로분류한다. 권한/notice/checkpoint실패는다른경로다.
- `packages/core/src/queue/drain.ts`, `packages/core/src/maintenance/table-cleanup-work.ts` — 읽기전용. 최대10attempts·결정적fingerprint·terminal failure기록을유지한다.
- `packages/postgres/src/work.ts` — 읽기전용. recordFailure의target/stage/fingerprint upsert와occurrences증가,completeWork의winningclaim CAS만대상실패해소. 실패row자체에work/attempt FK가있다고추정하지않는다.
- `packages/postgres/test/redaction.test.ts` 기존older-snapshot·staleclaim두verb회귀는보존한다. 실제관측2행의target/code는없으며source87f7b3e에서이파일/fixture/maintenance는원본과같지만공통test-db/workload영향은미배제다.

## Tasks & Acceptance

**Execution:**
- [x] E1 `packages/postgres/test/redaction.test.ts` — 기존factory seam으로권한사례만독립cluster에배치하고권한단독/복구입력의정확세대상·실패1·물리bytes/control·work상태와안전진단을보강한다. 필요시같은디렉터리의자기전용helper만허용한다. 첫Task는이계약만구현한다.
- [x] E2 `packages/postgres/test/redaction.test.ts` — 원인후보를구별하는결정적방해·해제입력과필요한실제store집약/대상별복구음성검증을작성한다. 기존snapshot·staleclaim회귀중복은최소화한다. cross-DB snapshot후보를명시적snapshot gate로구별할수있으면그입력을쓴다. 정적으로정당화할수없거나실행관측이필수면실행하지말고원인구분목적·정확case·최대1회·합성입력·관측·기존한도·예상시간을지휘자에보고해중앙판단을받는다.
- [x] E3 `packages/postgres/test/redaction.test.ts` — 각matrix행의시험대응을대조하고예외/finally의snapshot rollback·클라이언트종료·정확cluster drop과원오류보존을정리한다. 기존39case의집합·단언·timeout을약화하지않고추가case의의도를기록한다. build/typecheck/diff확인만한다.

- [x] E4 `packages/postgres/test/redaction.test.ts` — blind F1/F2: snapshot 복구 뒤 표별 control/정확body·target을 확인하고, snapshot을 계속 보유한 명시 retry가 물리 정리·failure 해소를 우회하지 않는 유한 음성단계를 추가한다.
- [x] E5 `packages/postgres/test/redaction.test.ts` — blind F3/F4: direct recordFailure 해소뒤재발의 ID/occurrences/재개방과 다른대상보존, 서로다른발생시각의 최초/최신·복구시각을 검증한다.
- [x] E6 `packages/postgres/test/redaction.test.ts` — blind F5/F6: 각 drain의 round/합성시각·완료후단계를 안전진단에 넣고 work/failure 조회를 독립 수집해 한조회실패가 다른 성공행집합을 버리지 않게 한다.
- [x] E7 `packages/postgres/test/redaction.test.ts` — 중앙AC3보완의 전용cluster증거: 기존factory 소유영수증의 정확containerID·port와 실제PG연결을 대조하는 결정적단언을 권한사례에 추가한다. 공유factory로회귀하면검출해야하며 isolated:true 문자열이나메타데이터존재만으로끝내지않는다. 기존seam/도구를 소비하고공통source는변경하지않는다. 실제DB와정확container의서버식별값을비교하거나동등한확실한연결매핑을사용한다. 승인된최종회귀에서공개가능한소유/매핑증거를출력하고원시보존한다.

**Acceptance Criteria:**
- Given 권한단독독립입력, when 기존한도내drain, then 세대상전체상태·messages실패1/attempt10·나머지물리정리/실패0·warn이leaf AC1대로검증된다.
- Given 권한복구또는방해해제, when 명시retry와실제cleanup, then leaf AC2의정확실패해소/control보존및새세대보호를검증한다.
- Given 결정적합성입력, when 마지막회귀실행, then 물리경로음성입력은잘못된완료를거부하며역사원인미확정을숨기지않는다. 원행누락은해결못한관측한계로기록한다.
- Given 마지막실질수정·독립Sol4렌즈와필요후속완료, when 전체TS→Python순차각1회, then 원시실패처분·자원정리·19.5/19.1 workload인계까지증거가완결돼야built다.

## Implementation Notes

- E7 코드작성완료: 정확factory containerID/port와세URL loopback포트를검증하고정확ID의docker exec psql 시스템식별자를실제fixture SQL pg_control_system값과대조한다. 공유factory복귀는metadata부재에서,다른실제cluster연결은시스템ID불일치에서검출한다. 공개가능한매핑JSON출력,명령15초·기존case40초유지. build/typecheck/diff0·Docker/PG/시험미실행. 독립후속과최종실행증거는아직남음.

- E4~E6 완료: snapshot보유중retry3/미완료·failure불변/bytes잔존/warn을확인하고해제뒤alreadyOpen3·attempt2복구,표별control과정확readSession을추가했다. direct실패재개방ID/occurrences3·발생/복구시각을검증한다. 안전진단은round/now와독립조회성공행을보존한다. build/typecheck/diff0·시험미실행. 지휘자가변경본문을읽고6건의직접보강을확인했다. PO AC3문서표적확인 fix/ask0,보고 .brain-automation/tickets/19.14/po-ac3-targeted-review.md.

- E2/E3 완료: 같은DB snapshot을 명시적으로 보유한 세대상10회소진/WAITING3행과 해제뒤 retry3/실제물리정리를 추가했다. 실제store upsert 집약·다른원인/대상분리·winningclaim의대상별해소를 별도 검증한다. afterEach는 한cleanup실패뒤에도남은자원을종료하고오류집합을보존한다. 지휘자가 전체diff를 읽고 matrix4행의코드대응을확인했다. build/typecheck/diff exit0·시험미실행. crossDB snapshot영향은 정적으로확정못해 중앙에최대1회관측필요성판단을요청한다. 같은DB결정적음성대조를역사2행의소급원인으로쓰지않는다.

- E1 완료: 권한사례만 기존isolated factory를 소비하며 전체work/failure·실제relfilenode/heap bytes·권한복구 retry1/실패해소와 안전JSON 진단을 추가했다. build/typecheck/diff exit0, 시험 미실행. 지휘자가 원diff를 읽고 E1 매핑을 확인했다. 최초Terra ready/depth1/Task/Dispatch 영수증은 로컬 구현 evidence에 보존했다.

- 등록문서만a14d9eeca8722e7c949e248067b5e2ce04b1e31a에커밋했다. 원본main2f23d30/schema43과등록main57331d5는별도보존한다. PO F1~F5/F6,S1~S2해결,후속보고는context에있다. 구현코드변경전깨끗한tree를확인했다.

## Plan Change Log

- 2026-11-09 중앙 msg_262f3e0c3fe7: leafAC3의 이전 “수정 전 시험 전제 또는 제품 결함과 수정 후 동작을 구별하는 결정적 회귀”는 동일입력의구source실패/신source통과까지과도하게넓혀읽힐수있어 중앙이시험전제격리범위로보완했다. 원행식별유실로역사원인/제품결함재현을주장할수없다. intent-contract의원래기술은역사로보존하며 E7과명시수락해석을추가한다. 필수3근거는구공유/신전용factory원문diff·실제권한PG의정확소유ID/실제연결매핑으로공유복귀검출·정확물리계약및같은DB음성/해제실제통과다. 다른AC/안전/최종회귀완화없음, 추가crossDB/구source실행배정없음. 독립PO표적확인을수행한다. KEEP: 정확전체실패집합·기존물리/CAS회귀·역사귀속미확정·개발중시험금지.

## Review Triage Log

### 2026-11-09 — Review pass 2 (독립후속)
- verdicts: 0 new findings — high 0, medium 0, low 0, false 0, maybe-false 0
- blind는 F1~F6 모두해결, edge/gap은지적0, intent는최신AC3필수3근거코드대응을확인했다. E7정확ID systemidentifier/실제SQL매핑은공유factory복귀·다른연결을검출한다. PO표적문서확인도fix/ask0이다.
- round1의7개처분은E4~E7에반영됐고의도I1은중앙명세보완으로해결했다. 수정한테스트/안전진단의동적통과는최종회귀로확인하며정적후속을실행성공으로쓰지않는다. 보고서는 .brain-automation/tickets/19.14/review-round2-{blind-hunter,edge-case-hunter,verification-gap,intent-alignment}.md 및po-ac3-targeted-review.md.
- 후속pass에서추가patch0이며followup_review_recommended=false. 마지막전체회귀가남아built전이하지않는다.

### 2026-11-09 — Review pass 1
- verdicts: 7 findings — high 0, medium 6, low 1, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` blind F1 표별 정상데이터보존공백 — 합친control존재는한표정상행손실을놓칠수있다. snapshot사례에도정확body/tooltarget와표별control을직접추가한다(E4).
  - `[medium]` `[patch]` blind F2 snapshot보유retry음성공백 — retry는같은handler를소비하지만새작업의조기해소를검증하지않는다. 보유중유한retry/drain후미해소·bytes/warn을단언하고해제뒤복구를보존한다(E4).
  - `[medium]` `[patch]` blind F3 해소후direct실패재개방공백 — 기존supervised재개방은다른진입점이다. direct경로ID/occurrences/resolved재개방·타대상보존을직접검증한다(E5).
  - `[low]` `[patch]` blind F4 집약시각구분공백 — 동일시각입력은최초시각덮어쓰기와최신시각미갱신을검출못한다. 기존사례입력시각과투영을직접교정한다(E5).
  - `[medium]` `[patch]` blind F5 round/합성시각진단유실 — loop중실패와소진후실패가같은단계다. round/now와완료후단계를직접진단에추가한다(E6).
  - `[medium]` `[patch]` blind F6 진단부분조회성공행유실 — 둘째조회실패시첫째work집합까지버리는reachable catch경로다. 두조회를독립수집한다(E6).
  - `[medium]` `[patch]` intent I1 AC3동일입력구source/신source실행미입증 — 중앙msg_262f3e0c3fe7가동일입력전후요구를필수에서명시제외하고전용cluster실제소유/연결매핑증거를필수로보완했다. 문서이전문구/이유보존과E7,독립PO표적확인으로처리한다. 역사원인해결/제품개선주장은금지한다.
- verification-gap: 지적0, edge-case-hunter: 지적0. 의도렌즈의나머지기술은정적구조·최종실행대기설명이며추가결함주장이아니다.
- 실질patch후 독립후속필수. 실제patch완료와최종회귀는아직미완료이며built아님.

## Design Notes

원인선택은열어두되권한단독입력의격리전제는명확히한다. 합성시각을매drain뒤1시간전진시키는기존fixture는외부snapshot이짧게지속돼도10attempts를빠르게소진할수있다. 따라서단독성공반복이아닌방해의명시적보유/해제로검증한다. factory의자원장부로소유container를기록하며다른티켓자원은정리하지않는다. case별cluster준비비용증가는19.1및19.5에명시한다. 제품결함이발견되면현재 소유 범위에서 임의로 수정하지 않고 중앙에 질문한다.

## Verification

- 개발중 `pnpm build` → `pnpm typecheck` → `git diff --check` — exit0. 의존성없으면 `pnpm install --frozen-lockfile`부터수행하며lockfile을변경하지않는다. 다운로드가필요한명령은처음부터require_escalated로실행한다.
- 독립Sol/medium4렌즈(의도·적대·경계·검증)와실질수정후필요후속. 시험실행금지·컴파일만.
- 마지막에전용환경에서 `VITEST_MAX_WORKERS=2 pnpm test` → `pnpm test:python` 전체각1회순차. source/env/UTC/KST/명령/exit/원시/resourceID/정확부재를보존한다. 원본87f7b3e실패를전체pass로고쳐쓰지않는다. 실패 수정 뒤 관련 시험/test:changed로 재검증한다.
- 공개가능한work/failure진단·행집합·물리bytes/control·명시retry·새세대보호를시험출력과대조한다. 실제matrix시험실행/통과감사는최종회귀뒤수행하며개발중시험으로앞당기지않는다.

## Verification Results

- 개발 중 시험/vitest/재현/PG/성능 실행0. E1,E2/E3,E4~E6,E7 뒤 build/typecheck/diff check는모두0이다. 마지막실질수정과독립후속4렌즈뒤아래전체명령을순차각1회수행했다. verbose/silent=false는원시매핑/결과보존용reporter옵션이며case/timeout변경이아니다.

| 실행 | UTC (2026-11-08) / KST (2026-11-09) | 결과 | 처분 |
|---|---|---|---|
| VITEST_MAX_WORKERS=2 pnpm test --reporter=verbose --silent=false | 20:38:55~20:48:49 / 05:38:55~05:48:49 | exit1;226파일중223pass/3fail,4941case중4928pass/12fail/1기존조건부skip;Vitest591.89s | redaction41/41pass. hook7은전용HOME genuine status위임오류, sessions-ingest4/runtime1은repo안TMP의경로전제오류 |
| pnpm test:python --reporter=verbose --silent=false (동일maxworkers2) | 20:48:49~20:55:44 / 05:48:49~05:55:44 | exit1;16파일중15pass/1fail,76case중68pass/8fail;Vitest414.53s | hook8은같은상태위임오류;나머지68pass |
| 관련 root3파일(hook,sessions-ingest,runtime), pnpm exec vitest run --project bootstrap test/hook.test.ts --project cli test/sessions-ingest.test.ts test/runtime.test.ts --reporter=verbose --silent=false | 20:56:08~20:56:58 / 05:56:08~05:56:58 | exit1;2파일pass/1fail;101pass/7fail/1skip | repo밖TMP교정으로경로5실패해결. sessions/runtime합계94casepass. hook은제한PATH의env127위임오류로분리 |
| 관련 Python-config hook 단독 | 20:56:58~20:57:06 / 05:56:58~05:57:06 | exit1;8fail | 제한PATH env127동일원인.원시보존 |
| 관련 root hook 단독, pnpm exec vitest run --project bootstrap test/hook.test.ts --reporter=verbose --silent=false | 20:57:55~20:59:03 / 05:57:55~05:59:03 | exit0;7pass/1기존조건부skip;68.05s | /usr/bin/env 절대경로로실제CLI status만위임.같은제한PATH에서변경전127/변경후실제Running0을먼저확인 |
| 관련 Python-config hook 단독, pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts tooling/bootstrap/test/hook.test.ts --reporter=verbose --silent=false | 20:59:03~21:00:16 / 05:59:03~06:00:16 | exit0;8pass;72.18s | Python전용보존case까지실행·통과.최초전체실패는덮어쓰지않음 |

첫전체2회와관련실패파일재검증만실행했다. 전체재반복/crossDB/구source/성능실험은없다. 현재코드의첫전체가둘다exit0이었다고보고하지않는다. 실제원시환경오류를교정하고각실패사례가관련검증에서통과한처분이완결됐으며현재미해결필수실패0이다. 환경교정중제품/시험코드는변경하지않았고source-manifest의동일해시를확인했다.

### AC3 실행 및 물리 계약 감사

- 정적원문diff: 구 fixture→database()→createTestDatabase(공유cluster내DB) 대비 신권한사례 isolated옵션→database(true,createIsolatedTestDatabase). 공통factory/fixture소스는불변이다. 원문은 verify/source.diff와round2diff에보존했다.
- 실제권한사례 매핑JSON: containerId `30a333d492f7dc3a54eaba40474a834ec506d7f7eb84fd0574f03207ff813204`,port35916,systemId `7705904827180199977`. 정확ID의container내pg_control_system과실제fixtureSQL이일치한뒤출력됐다. 해당ID부재도별도inspect exit1/no such object로확인했다. 공유factory복귀/다른실제cluster는독립리뷰가검증한단언경계에서거부된다.
- 권한사례 정확세대상/실패1/attempt10/건강대상물리정리·복구,같은DBsnapshot보유실패3·보유retry미완료/해제복구,실패집약·재개방·대상별해소 모두통과. 기존sameDBsnapshot및두verb staleclaim회귀도포함해redaction41개모두실행·통과했다. matrix4행에미실행/skip사례없다.
- 같은DB음성대조는방해보유/해제복구계약만입증한다. 별도DBsnapshot영향과역사87f7b3e두행의target/code/원인은미확정이다. 제품동작개선/역사원인해결/무변경확정으로제출하지않는다.

### 격리·자원·원시 보존

- 최초전용PG18 tmpfs/dynamicloopback35732,관리자암호fixture계약postgres,소유ID `d8c6b390df9e290e2818835fbc0a10c7e8029c0846106736c9f2de62e8117385`. 공용54329/운영DB/실제Drive/계정/transcript는미사용이다. 코드시험은합성입력을사용한다.
- 처음HOME/TMP를repo의gitignored영역에뒀고genuine running파일1개위임이실제orb status에는충분하지않았다. 원시환경실패를인정하고재검증은repo밖전용임시HOME/TMP·private uv환경으로교정했다. 실제OrbStackcontext metadata와Compose실행파일만연결,orb status한정원HOME실제CLI위임으로실제출력그대로전달했다. 가짜Running·status디렉터리전체링크·전역서비스변경없다. 제한PATH에서env127을실증후절대/usr/bin/env로교정했다.
- 최초전체PG와fixture생성기록269개모두정확ID별부재확인. 두관련검증용주PG도각정확ID부재확인. hook은자기소유composeID의정리·부재를기존afterAll로검증했다. 다른티켓자원은정리하지않았다. 임시HOME/TMP와로그는삭제하지않고보존한다.
- 로컬원시: .brain-automation/tickets/19.14/verify/{summary.json,pnpm-test.log,pnpm-test-python.log,redaction-results.txt,fixture-resources.jsonl,fixture-container-absence.json,source-manifest.json,source.diff,related-summary.json,related2-summary.json,related-root.log,related-python-hook.log,related2-root-hook.log,related2-python-hook.log,restricted-orb-wrapper-diagnosis.json}. 원19.5자료5개는evidence/manifest.json의출처·SHA256과함께보존했다. 원단독재검증시각은20:00:23Z~20:00:32Z이며기존20:00Z전설명오류는원문보존/정정했다.

### 19.5/19.1 인계

- 이티켓의실행코드변경은redaction시험1파일뿐이다. MAINTAIN입력과새snapshot입력에기존factory전용cluster를각1개추가소비하고DB준비·정리비용및Docker systemID조회1회가추가된다. 원39case는보존·강화하고새2case로41개다. 공통afterEach는실패뒤에도남은자원을정리한다.
- core/PG제품·공통fixture/test-db·runner/config/slot/hook/측정기·migration0001~0043·plugin·lock/API는원본기준바이트불변이다. 그러나시험workload/DB준비·정리·동시부하는바뀌므로19.5 measured source87f7b3e의표본을새source의성능으로재사용하지않는다. hook의repository snapshot도새시험/문서바이트를포함할수있다. 직접미편집만으로간접영향없음을단정하지않는다.
- 이번전체TS226파일/4941case는19.5 measuredsource의237파일/5007case와다른집합이다(이번작업에19.5 runner제품변경을통합하지않았다). Python은16파일/76case이지만같은case수만으로같은바이트/성능조건을주장하지않는다. 전체시간은위단일실행이력이며성능비교수치가아니다. 19.1은새redaction의case별cluster준비비용을포함해동일조건새기준을잡아야한다.

## Auto Run Result

- 결과: built (사용자인수done아님). 시험전제격리·결정적회귀보강을완료했다. 원래두행의원인귀속미확정은명시된관측한계이고중앙이보완한현필수AC를defer로숨긴것이아니다.
- 소스변경: packages/postgres/test/redaction.test.ts의국소격리·정확실패/물리복구·음성retry·집약/재개방·안전진단·실제cluster매핑. 문서는등록14/next15·부모/19.5인계·AC3보완이력·본계획이다.
- 독립PO초기/후속/AC3표적확인,Sol4렌즈와실질수정뒤4렌즈후속완료. 초기7처분(6리뷰보강+AC3중앙명세보완)완료,최종추가지적0·미해결필수0·deferred0·operator_actions0. 후속pass추가patch0·추가후속권고false.
- 검증: build/typecheck/diff0. 전체TS/Python은각1회순차실행후환경실패를원시보존했고,해당실패파일의관련검증으로모두해결했다. 전체첫실행둘다pass로고쳐쓰지않는다. redaction41/41및실제전용cluster매핑통과,소유자원정리증거보존.
- 제출한source와정확최종commit/일반branchpush/remoteSHA·clean은지휘자의 .brain-automation/tickets/19.14/final-report.md에기록한다. 중앙main/state는변경하지않으며main병합/push는중앙소유다.
- 잔여한계: 역사두행식별유실로원인미확정,같은DBsnapshot범위한정,별도crossDB/구source실행없음. 제품변경주장없음. 19.5의최종통합source와workload/측정영향재대조는중앙인계사항이며과거표본의자동수락근거가아니다.
