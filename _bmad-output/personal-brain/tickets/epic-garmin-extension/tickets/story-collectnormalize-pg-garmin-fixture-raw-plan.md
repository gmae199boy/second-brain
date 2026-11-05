---
title: '21.3 감독 수집·정규화 PG 연결과 원본 동등성'
type: 'feature'
ticket: 3
created: '2026-11-05'
status: 'built'
baseline_revision: 'd4d8c33e3c2bccc7a652356366586acd12124064'
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

**Problem:** 21.2의 PG native 라이브러리는 있으나 감독 collect 일감과 검증된 계정·설정 입력 연결이 없다. raw 불변 저장과 원본의 재확인 정책을 함께 충족해야 취소 뒤 이어 받을 수 있다.
**Approach:** 고정 원본 collect/auth/normalize/coverage/digest를 재사용하여 확장 supervised entry에 연결한다. 원형은 불변 이력으로 보존하고 원본이 관찰하던 현재 raw·checked 상태를 명시 선택하여 같은 결과를 낸다.

## Boundaries & Constraints

**Always:** 고정 원본 `~/github/garmin` commit `7fb33dd1661ad25cd73e14ed63abe0a87151f62e`의 추적 소스/시험/fixture만 읽는다. runtime self/settings snapshot/선택 connection/attempt를 실제 소비 경로에서 검증한다. 연결별 session lock·짧은 fenced transaction·RR·durable pending/staging atomic publish·exercise 순서 provenance를 재사용한다. 원본 인증·token/MFA·당일 차단·호출 간격·첫 호출 보호·계획·재시도·계산·프롬프트·schema 의미를 유지한다. raw 원형은 불변, 현재 선택/확인 metadata와 분리한다. 현재/어제 미확정일 및 activity freshness 등 원본의 재확인 예외를 '누락만'과 함께 보존한다. 새 SQL은 forward migration이며 기존 적용 migration은 수정하지 않는다. 시험 코드는 모든 AC를 덮고 실행은21.8로 이관, 미실행이다.

**Never:** 실계정/API/모델/Telegram/운영 자원/원본 작업트리에 접근·변경하지 않는다. fixture 생성/checker/반입/직접·changed·전체 시험을 실행하지 않는다. 옛 config.load·launchd·Telegram·독립 CLI를 활성화하지 않는다. core에 Garmin schema/지표/프롬프트/reader를 추가하지 않는다. 모델은21.4, 실제 cron/채널/배포는21.5, 운영전환은21.7이다. 중앙state/공용follow-ups/main·전역스킬을 변경하지 않는다. 계정·비밀·건강자료·개인홈절대경로를 공개문서/프롬프트/로그에 적지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| entry | 설치 manifest 수동 collect, runtime self/target/settings/attempt | 선택 연결로 collect→normalize·coverage/digest, ABI 최종 이벤트 한 건 | 누락/invalid UUID/default/타 self/위조 snapshot·불명 연결은 외부 호출 전 거부 |
| credentials | import한 연결 tokenstore_ref NULL, 명시 선택·검증된 귀속 증거 | self/connection/profile에 일치하는 전용 tokenstore만 fenced 조건부 연결 | 누락/불일치·재사용·symlink·권한·기존값 충돌은 추정하지 않고 호출 전 거부 |
| protection | MFA/재인증 필요·당일 차단/불량파일·429/403·첫 endpoint·transient/rejected | 원본과 같은 대기/상한/분류/중단/재시도, 사전 차단은 네트워크 0 | 비밀/본문 없는 ABI 오류/상태, 수집 중 대화형 로그인 없음 |
| raw | 동일 응답 재확인·NULL→data·변경 data·data→NULL | 모든 받은 원형 불변 보존, 현재 raw/fetched/checked/library 의미는 SQLite와 동일 | fenced 원자 확정, 충돌/회수된 attempt는 확정 금지 |
| restart | raw commit 뒤 중간 취소·재시작·정규화 중단 | 받은 raw 보존, 누락/원본 재확인 예외만 요청, pending 재개·atomic publish | 감독자 그룹 정리·후손 reap, stale 쓰기 거부 |
| scope | 같은 연결 동시 작업·다른 연결·다른 self | 같은 연결 직렬화, 다른 연결 진행·데이터 한정 | 네트워크 대기 동안 DB transaction 없음 |
| oracle | 고정 시간/시간대·fake 응답·NULL/배열/동률/경계일/운동 | raw/run/coverage/day_summary/workout/exercise_log/daily metric 및 digest가 독립 SQLite와 동일 | 기대값을 제품PG결과로 만들지 않음 |
| memory | 감독 collect/취소 전후 기존 session/message/file | 공용 기억 데이터 유지 | 확장 밖 쓰기·데이터 삭제 없음 |

</intent-contract>

## Code Map

- `extensions/garmin/src/garmin_pipeline/collect.py`: collect/run/_enter/_plan/_fetch와 끝 normalize 호출을 재사용. `garmin/__init__.py`는 tokenstore flock·block.json·호출대기·오류/MFA 정책 원천, `auth.py`의 TTY/login 보호는 유지한다.
- `extensions/garmin/src/garmin_pipeline/store/__init__.py`: AccountContext/_connect는 BRAIN_ACCOUNT 외부identity를 요구하나 실제 supervisor는 이를 채우지 않는다. entry의 BRAIN_TARGET_ID connection UUID를 self로 조회해 명시 context adapter를 둔다. session advisory lock과 transaction 전후 attempt_valid를 재사용한다.
- `extensions/garmin/migrations/0014_native_store.sql`: account_connections(user_id,connection_id,external_identity,tokenstore_ref,timezone), raw_response 불변 trigger. native_import는 profile 확인 후 NULL tokenstore_ref를 만든다. 기존표/반입원형을 보존하며 새 forward로 append raw 관찰/현재선택 계약을 추가한다.
- `extensions/garmin/src/garmin_pipeline/{coverage,digest,normalize,report_input,capture}.py` 및 하위: raw 읽기와 fetched/checked 변경 추적을 감사하고 공통 현재선택 relation으로 연결한다. 계산·정렬·RR·pending·atomic rebuild는 유지한다. `native_import.py` 원형복사·검증 경로와 현재관찰을 혼동하지 않는다.
- `extensions/garmin/manifest.json`, 새 `src/collect.py`/runtime adapter: supervised garmin.collect/manual collect와 필요한 typed/machine tokenstore 설정만 선언. core ABI는 `BRAIN_SETTINGS_SNAPSHOT`의 version/extension/user_id/values, target UUID, work/attempt/generation을 제공한다. 오래된 config.load는 사용하지 않는다.
- `extensions/garmin/tests/oracle/src`는 고정 SQLite oracle(수정 금지), `tests/normalize_oracle_child.py`·`test_normalize_oracle_pg.py`·`fixtures/native/synthetic.py`·`apps/cli/python-test/garmin-native.test.ts`는 별도 프로세스/실PG/격리home/기억보존 재사용점이다.
- `apps/cli/test/daemon-supervisor-cancel.test.ts`와 Python 시험 harness의 실제 supervisor 경로를 재사용하여 설치 entry/fake 네트워크 장부/취소 후손정리/attempt 회수/동시성을 검사한다. `tooling/test-changed/rules.mjs`와 분류시험에 새 Python/SQL/자식경로를 등록한다.
- 정적조사 상세는 로컬 `.brain-automation/investigation.md`; 고정원본 provenance는 `extensions/garmin/UPSTREAM.md`;21.2 계획의 기존 store·normalization 설계를 이어간다.

## Tasks & Acceptance

**Execution:**
- [x] 1. `extensions/garmin/manifest.json`, `src/collect.py`, 새 `src/collect_runtime.py`, store context adapter — supervisor ABI·self/target/snapshot 검증과 원본 Config 기본 보호값의 명시 구성, count/status만 내는 ABI entry를 만든다. garmin.collect를 선언하고 tokenstore/귀속 검증 인터페이스를 둔다. 해당 입력 거부/전달 시험코드를 작성한다.
- [x] 2. `extensions/garmin/src/collect_runtime.py` 또는 전용 credential helper, 필요시 새 forward SQL, `tests/test_collect_runtime.py` — 선택 연결과 tokenstore 귀속을 명시적으로 검증한다. NULL 참조는 확인된 self/connection/profile 증거와 tokenstore 동일성으로만 조건부 연결하고 다른 연결 재사용/기존값 덮어쓰기/불명 credential은 거부한다. machine snapshot을 쓰고 토큰 자체는 출력/설정에 넣지 않는다. 증거 없는 운영 연결은21.7 준비 대상으로 명시한다.
- [x] 3. `extensions/garmin/migrations/0015_*.sql` 이후, `src/garmin_pipeline/store/__init__.py`와 raw SQL 소비부 — 기존 불변 raw를 유지하며 새 불변 관찰 이력·현재선택으로 고정SQLite의 NULL/data/재확인/fetched_at/checked_at 의미를 복원한다. stale 거부·동일연결락·원자게시·normalize 변경추적을 덮는 시험코드를 작성한다.
- [x] 4. `src/collect.py`, `src/garmin_pipeline/{collect,garmin,ports}.py`, 관련 Python 시험 — 실제 entry에 인증/차단/MFA/간격/상한/재시도/계정락과 TableNotifier를 연결한다. 기존 auth 보호·원본 수집정책을 바꾸지 않고 fake 네트워크 장부 기반 호출0·호출순서/수·대기 시험코드를 작성한다.
- [x] 5. `extensions/garmin/tests/test_collect_oracle_pg.py`, 새 고정SQLite child 및 추적 fixture 이식, 필요한 normalize/coverage/digest 연결 — 원본 tests/fixture를 PG 계약으로 이식하고 전체 matrix 값/NULL/배열/동률/시간대·중단 raw/pending 복구의 독립 기대값 비교를 작성한다. oracle 원본과 제품계산은 변경하지 않는다.
- [x] 6. `apps/cli/python-test/garmin-collect.test.ts`와 격리 child/fake fixture, `tooling/test-changed/rules.mjs`/분류시험, `extensions/garmin/README.md` — 실제 설치manifest→supervisor→collect 소비로 fake 요청 장부·kill/restart·stale·계정동시성·자식후손정리·공용기억보존 시험을 등록하고21.8 준비/정리·명령·기대관찰을 인계한다.

**Acceptance Criteria:**
- Given 설치된 확장과 합성 계정/설정/유효attempt, when 감독 collect를 실행하면, then 고정SQLite와 raw/run/coverage/day_summary/workout/exercise_log/daily metric 및 digest 결과가 같으며 runtime self/connection으로 한정된다.
- Given MFA/재인증 필요·차단 또는 불명 credential/다른 self, when 같은 실제 entry로 수집을 시도하면, then 사전차단 상태는 외부요청0이고 원본 보호정책·비밀 없는 실패 분류를 유지한다.
- Given commit된 raw와 미완료일·취소/회수attempt, when 감독 취소 뒤 재시작하면, then 원형이 남고 누락/원본 재확인 예외만 요청하며 정규화는 pending부터 복구하고 stale 확정은 거부된다.
- Given 같은/다른 계정의 동시 일감과 기존 공용기억, when 감독 수집/취소하면, then 연결별 직렬화와 범위를 지키며 자식/후손은 정리되고 기억 데이터는 보존된다.
- Given 최신 시험 유예, when 완료를 보고하면, then 수락시험 코드는 등록되고 독립리뷰·필요수정/후속리뷰·정적컴파일 증거가 있으며 시험 실행은21.8로 이관, 미실행이라고 기록한다.

## Implementation Notes

- R8b: 범용고정status(success/partial/blocked/auth_required/error/noop)·runs/errors safeinteger JSON을생산하고기존supervisor보호필터에정확한고정형식만허용한다. core에새Garmin전용명칭/reader/schema는없다. 실제감독success/partial/auth/noop의result_summary와predecessorNULL시험및비밀/추가키거부시험을작성했다. daily_weigh_ins를명시NULL로복원했다. 시험실행21.8이관·미실행이다.

- R8a: 검증완료후삭제전용.brain-cleanup이름으로원자전환·fsync하고부분파일/빈dir을멱등정리한다. 동일OS사용자의보호tokenstore/session락을신뢰하며불명/unsafe잔여는보존한다. recover운영I/O와credential검증오류를분리하고실제recover→ABIretry·원형보존/후속복구시험을작성했다. 모든시험실행21.8이관·미실행이다.

- R7d: 실제manifest/supervisor풍부한fixture↔고정SQLite최종표/요청순서, MFA/만료data0·차단/credential외부0, 같은연결별도work/driver락대기·다른연결진행·해제후진행시험을무조건it로등록했다. 시험실행21.8이관·미실행이다.

- R7c: 실제PG↔고정SQLite의오늘/어제재확인·data→NULL checked·활동목록변경세트상세freshness·동일절대시각UTC/Seoul현지일·timezone_mismatch비교와report snapshot두번째payload/최초원형보존시험을작성했다. oracle원본미변경, 시험실행21.8이관·미실행이다.

- R7b: 상태요약SQL을짧은fencedtransaction으로고쳤다. profile일치후정확한작업token snapshot+승인marker를fsync하고승인사본만게시한다. 미승인중단은기존DB참조(NULL포함)/token/확인서유지·소유형식확인후정리하며승인후작업token추가변경은게시하지않는다. 각DB/파일/rename/정리crash시험을작성했고실행은21.8이관·미실행이다.

- R7a: time별칭/ABI내import·오류retry분류·profile필수확인·상태/건수요약과인증오류시험을작성했다. 장부는R7b전임시안전거부다. 지휘자후속읽기에서새요약SQL이writable connection의transaction밖인결함을확인했으므로R7b시작전명시transaction으로고치는필수수정을함께배정한다. 시험실행은계속21.8이관·미실행이다.

- Task6: 설치manifest→실감독entry fake장부/취소/후손/회수attempt/재개·정상갱신·연결락/공용기억 시험과21.8·21.7README인계를 작성했다. 경로분류시험을 보강했다. 구현자build/typecheck보고에 로그가 없어 지휘자가 정적검증증거를 새로 남겼다: build/typecheck/전체Python정적compile/공백확인exit0(.brain-automation/*-pre-review.log). 모든시험은21.8이관·미실행이다.

- Task5: 고정SQLite collect child·동일fake응답장부·추적lifestylefixture와 실PG 비교시험을 작성했다. 중단5응답후 raw/run보존·재개·projection실패/pending·표/coverage/digest·배열/동률/시간대/운동순서를 독립원본과 비교한다. test_*.py discovery에등록되며실행은21.8이관·미실행이다.

- Task4: 실제collect→normalize·TableNotifier를 연결했다. sessionflock 안에서 차단·credential검증·profile대조 뒤 호출하며 정상token갱신은0700작업사본/복구장부와fenced지문변경·원자파일게시로 재개한다. 동일OS사용자 보호디렉터리/라이브러리atomic dump 신뢰가정과 crash경계는 독립리뷰 대상이다. fake장부·인증뒤data0·대기/상한·갱신재개 시험코드를 작성했고실행하지않았다.

- Task3: forward0015에 불변 raw_observations·현재 raw_current_state/view를 추가하고 library 소비부를 연결했다. 최초원형은 기존 raw_response에 남고 nativeimport/verifier는 이를 검사한다. 고정SQLite 의미: 동일/data→NULL은 checked만, NULL→data/변경data는 raw/fetched/checked/version 갱신. 관찰은 모두 보존한다. 기존 fetched millisecond 변경추적 한계는 원본대로 유지한다. 정적compile/공백확인exit0; 모든시험실행21.8이관·미실행.

- Task2: 보호된 tokenstore의 운영자 확인서(version/self/connection/profile/token SHA256)를 명시적 오프라인 신뢰근거로 채택했다. NULL 참조만 fenced 조건부 연결하고 중복지문/충돌/권한/symlink/변경중파일을 거부하는 코드와 시험을 작성했다. 운영자는21.7에 같은 계정임을 확인해0600확인서를 준비해야 한다. 실제자원 접근은 없었다. 토큰 정상갱신에 따른 지문변경과 검증→tokenstore락 시간차는 수집 연결 Task4에서 해결할 필수경계이며 단순 운영보류로 숨기지 않는다.

- Task1: 감독 collect 선언·self/target/snapshot 검증·명시 AccountContext와 입력 시험코드를 작성했다. credential 검증 전에는 외부 호출 없이 안전 실패하며 실제 수집 연결은 후속 Task다. Python 정적compile/공백확인 exit0; 시험 실행은21.8로 이관, 미실행.

## Plan Change Log

- R2: 부분삭제도재개가능한삭제전용상태·운영I/O retry분리와범용안전요약의실제정산·명시NULL입력을R8a/b로구체화한다. KEEP: profile/hash승인전게시금지·기존자격보존, raw/current/oracle독립성, 원본계산/종료정책, 공개요약정보보호. 사용자부분작업보존지시에따라해당경계만수정하고intent-contract는유지한다.

- R1: 네독립렌즈의19지적을검토해진입/profile/ABI·갱신durable승인/잔여정리·oracle재확인/시간대·실제감독값/경합시험을아래R7a~d로구체화한다. KEEP: 고정SQLite원본, 원형불변/현재선택, session계정락·짧은fence·pending/atomicpublish·기존보호/계산. 기존부분작업보존·작은Task수정이라는사용자명세에따라소스를일괄revert하지않고해당계약경계만재도출한다. intent-contract는수정하지않는다.

## Review Triage Log

### 2026-11-06 — Review pass R3
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- 원문 `.brain-automation/review-r3-source.md`·`review-r3-verification.md` 두독립Sol/medium리뷰모두R2-S1/S2/S3/V1원인해결·추가확정결함0을보고했다. 삭제전용부분정리·recover→ABIretry·범용요약실정산/NULL선행결과·명시NULL독립oracle입력을정적으로확인했다. R1보완은R2두리뷰가확인했다. 실행통과판정이아니다.

### 2026-11-06 — Review pass R2
- verdicts: 4 findings — high 1, medium 3, low 0, false 0, maybe-false 0
- 원문: `.brain-automation/review-r2-{verification,source}.md`. R1수정은정적으로확인됐으나아래새경계는미완료다.
- findings:
  - `[medium]` `[patch]` V1 공통fixture최상위NULL누락 — lifestyle을풍부한값으로바꿔기본matrix의NULL단정과충돌한다. R8b에서동일fixture의수집대상endpoint에명시NoData를추가해NULL커버리지와독립oracle비교를유지한다.
  - `[high]` `[bad_plan]` S1 장부부분삭제후영구거부 — finished/미승인active에서필수파일삭제후다음recover가전체장부를요구한다. R8a에삭제전검증/게시완료와삭제전용상태분리·부분파일/빈디렉터리멱등정리를명시한다.
  - `[medium]` `[bad_plan]` S2 복구I/O장애영구오류분류 — recover의OSError전체변환이재개가능게시실패를COLLECT_INVALID로만든다. R8a에검증실패와운영I/O장애타입분리·실제recover→ABIretry시험을명시한다.
  - `[medium]` `[bad_plan]` S3 supervisor정산에서요약소실 — 기존publicCollectSummary는옛Garmin전용형식만허용해새문자열을버린다. 새Garmin전용reader/schema를core에넣지않고R8b에서작은범용상태/건수형식의생산/보호필터/정산을일치시킨다. 기존보호필터는약화하지않고임의문자열저장을허용하지않는다.

### 2026-11-05 — Review pass R1
- verdicts: 19 findings — high 9, medium 9, low 0, false 1, maybe-false 0
- 원문: 로컬 `.brain-automation/review-r1-{verification-gap,intent-alignment,edge-case-hunter,blind-hunter}.md`. 보고 도착 순서로 각 지적을 별도 기록한다. 승인된 시험미실행 자체는 결함이 아니다.
- findings:
  - `[medium]` `[bad_plan]` VG1 report_input 현재raw 소비시험 공백 — 기존 단일삽입 snapshot은 원형/current차이를구별못한다. R7c에 날짜/활동2회입력·snapshot새값/원형불변시험을명시한다.
  - `[medium]` `[bad_plan]` VG2 token게시후확인서전 crash공백 — 기존crash는token게시전뿐이다. R7b의혼합영속상태별재개시험으로보완한다.
  - `[high]` `[patch]` VG3 time이름충돌 — datetime.time이모듈을덮고기본인자평가실패; import가try밖이다. R7a에서별칭분리·ABI보호내import로수정한다.
  - `[high]` `[patch]` IA-F1 진입import실패 — VG3와동일정적경계다. R7a로수정한다.
  - `[medium]` `[bad_plan]` IA-F2 실제감독값비교표면공백 — libraryoracle은풍부하지만감독fake는None/빈배열뿐이다. R7d에실제설치일감의풍부한fixture와고정SQLite최종표/요청비교를추가한다.
  - `[medium]` `[bad_plan]` IA-F3 실제entry인증보호공백 — 새override의login오류와실제entryMFA/만료장부시험이없다. R7a·R7d에보강한다.
  - `[false]` `[reject]` IA-F4 물리raw와논리raw표면차이 — 원문raw불변과원본재확인을동시충족하는명시분리이며제품reader는current를읽는다. 데이터손실/덮어쓰기결함이아니라는리뷰자판단과일치한다. 독립명세도원본계산/보호정책보존을요구한다.
  - `[high]` `[patch]` EH1 time충돌 — VG3와동일. R7a로수정한다.
  - `[high]` `[bad_plan]` EH2 profile검증전kill후미승인token게시 — recover는old/new해시만확인하고로그인검증증거가없다. R7b에profile+tokenhash의durable승인없이는게시금지·기존값보존을명시한다.
  - `[high]` `[patch]` BH1 time/import ABI누락 — VG3와동일. R7a로수정한다.
  - `[high]` `[bad_plan]` BH2 profile누락/None허용 — 실제분기가누락을허용한다. 오프라인운영자확인과별개로로그인후profile확인불가는data전거부하도록R7a에명시한다.
  - `[medium]` `[bad_plan]` BH3 모든예외영구입력오류 — write_session락/DB장애가진입에서같은COLLECT_INVALID로잡힌다. R7a에비밀없는코드·retry분류와ABI시험을명시한다.
  - `[medium]` `[bad_plan]` BH4 도메인결과항상complete — collect.run은차단/auth/partial에도정상반환한다. 원본종료정책은KEEP하고R7a에서최종run상태·개수요약을반영한다.
  - `[medium]` `[bad_plan]` BH5 stage/finished잔여미정리 — rename전/후kill은현재recover탐색밖이다. R7b에소유/형식확인아래잔여정리·미검증자료보존/거부정책을명시한다.
  - `[medium]` `[bad_plan]` BH6 영속게시crash경계시험누락 — VG2와같은근본공백. R7b에token/확인서/rename/정리각경계시험을작성한다.
  - `[high]` `[bad_plan]` BH7 login실패명칭만있는시험 — loginfake는예외없고mismatch만검사한다. R7a에실제override에서재인증/MFA/429/403/transient와data0·차단·분류/장부를검사한다.
  - `[high]` `[bad_plan]` BH8 재확인예외oracle공백 — 단일일자/재개만있어오늘어제/activityfreshness재계획을못검출한다. R7c에원본현재값·checked와요청순서비교를추가한다.
  - `[medium]` `[bad_plan]` BH9 시간대경계oracle공백 — 같은DAY/systemtimezone설정만있다. R7c에동일절대시각의현지일경계·timezone_mismatch비교를추가한다.
  - `[high]` `[bad_plan]` BH10 같은계정별도writer경합공백 — queue합치기는DB락검증이아니다. R7d에별도work/driver로같은연결락대기·첫해제전호출쓰기0·해제후진행을추가한다.

## Design Notes

토큰 연결은 자동계정 추정이 아니다. 명시 선택과 profile 근거를 검증하고 NULL 참조만 fenced로 연결한다. 안전한 오프라인 귀속 증거 형식/동일성 검사는 구현에서 구체화하고21.7에 준비절차를 적는다. 실제 계정/토큰을 지금 조회·발급하지 않는다. 기존 raw_response 반입원형은 불변 보존하며 현재 선택은 새 관찰 관계에서 고른다. 원본 data→NULL 재확인 등 의미는 고정 store/upsert/시험을 직접 읽어 결정하고 문서화한다.

## Review Repair Execution

- [x] R7a `src/collect_runtime.py`, `collect.py`, `manifest.json`, `tests/test_collect_runtime.py`·`test_collect_supervised.py` — time충돌/ABIimport보호, profile필수일치, transient/lock/입력오류분류, 안전한run상태·개수요약, 실제adapter인증/MFA/429/403/transient보호시험을완성한다.
- [x] R7b `src/collect_refresh.py`·`collect_runtime.py`, `tests/test_collect_supervised.py` — profile+작업tokenhash의durable승인후에만갱신게시한다. 검증전중단은기존DB/token/확인서를유지한다. owner/format확인아래stage/finished잔여정책과모든게시경계crash복구시험을완성한다.
- [x] R7c `tests/test_collect_oracle_pg.py`·oracle support/child·`test_store_contract_integration.py` — 오늘/어제재확인·data→NULL·activity목록변경freshness요청·현지일경계/시스템시간대불일치의고정SQLite비교와report_input의새현재값/원형불변을검사한다.
- [x] R7d `apps/cli/python-test/garmin-collect.test.ts`·fake child — 실제설치감독의풍부한fixture최종표/요청oracle비교·MFA/만료data0·동일연결별도writer경합/해제후진행·다른연결진행을검사한다.

- [x] R8a `src/collect_refresh.py`·credential/entry분류 및 관련시험 — 검증완료한장부를삭제전용상태로먼저전환하고부분삭제/빈잔여를멱등정리한다. 검증실패는영구거부, 재개가능I/O는retry가능으로전달한다. 실제부분unlink/빈dir·recover→ABI오류시험을작성한다.
- [x] R8b `src/collect_runtime.py`, 범용supervisor요약필터·시험, `tests/collect_oracle_support.py`, 실제감독시험 — 범용안전상태+건수JSON생산/필터/정산을일치시키고실제감독success/partial/auth/noop영속값을검사한다. core에새Garmin명칭/schema/지표/reader를추가하지않는다. 공통입력에명시최상위NULL을복원해기존비교단정을유지한다.

## Verification

**시험 실행은21.8로 이관, 미실행.** 직접·fixture/checker·합성수집/반입·산술재현·changed·전체시험을 이번에는 실행하지 않는다.

이번 명령: `pnpm build`, `pnpm typecheck`, `PYTHONPYCACHEPREFIX=<temp>/brain-21-3-pycache python3.14 -m compileall -q extensions/garmin/src extensions/garmin/tests extensions/garmin/fixtures/native`, `git diff --check`. 각 종료코드/전체로그를 로컬 증거로 남긴다.

21.8은 README의 소유 compose/test DB·role·격리home·합성자료를 준비하고 새·기존 Garmin 포함 `pnpm test` → `pnpm test:python`을 순차 실행한다. 관련 재검증은 `pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-collect.test.ts apps/cli/python-test/garmin-native.test.ts apps/cli/python-test/garmin-unit.test.ts`. 기준SHA/소유자원/명령/종료코드/로그/실패별처분/재검증 증거를 남긴다. 기대는 matrix 전체와 독립SQLite 동등성·fake 요청수/보호·raw 보존·누락만재개·fence/동시성·후손정리·기억보존이다. 이 실행이 만든 자원만 harness로 정리한다. 새·기존 시험 미실행 또는 미해결 실패면21.8 built/21.7 시작 금지다.


## Auto Run Result

- 결과: **built**(사용자 인수 전). 감독 `garmin.collect`/manual collect를 runtime self/settings/target connection/attempt와 연결했다. 계정별락·토큰증거/필수profile대조·정상갱신의영속승인/중단복구·원본호출보호/계획/재시도·raw저장→normalize/coverage/digest를재사용한다.
- forward0015는기존raw_response최초원형을보존하면서모든raw관찰을불변장부에남기고현재값/checked상태를별도로제공한다. 원본data→NULL/동일/변경재확인의미와report입력소비를유지한다. 기존migration/고정SQLiteoracle원본은변경하지않았다.
- 변경파일: `extensions/garmin/src/collect*.py`(감독입력·credential·갱신복구·ABI), `src/garmin_pipeline/store`와rawSQL소비부(현재값·문맥), `migrations/0015_raw_observations.sql`(관찰/현재표·view), manifest/README(일감·설정·인계), Python/설치supervisor시험과fake/고정fixture/독립oracle child(수락시험코드), 범용supervisor안전요약분기·그시험(상태/건수영속화), upgrade/경로분류시험(신규경로등록)이다. core에새Garmin명칭/지표/schema/reader를추가하지않았다.
- 리뷰: 최초공식thorough네렌즈 + 두렌즈후속R2·R3. 지적23행(중복포함): high10·medium12를수정/시험보강, false1기각(IA-F4: 불변원형과논리현재값의명시분리이며손실/덮어쓰기아님). deferred없음. 지휘자도R7a상태요약SQL의transaction누락을별도발견해수정했다. 마지막두독립리뷰새확정결함0/미해결0이다. followup_review_recommended=false; 마지막passpatch0으로수렴했다.
- 실제정적컴파일: `pnpm build` exit0(`.brain-automation/build-r3.log`), `pnpm typecheck` exit0(`typecheck-r3.log`), `PYTHONPYCACHEPREFIX=<temp>/brain-21-3-r3-pycache python3.14 -m compileall -q extensions/garmin/src extensions/garmin/tests extensions/garmin/fixtures/native` exit0(`python-compile-r3.log`), `git diff --check` exit0. 이후변경은계획/보고기록뿐이다.
- **시험 실행은21.8로 이관, 미실행.** 직접시험·fixture생성/checker·합성수집/반입·산술재현·test:changed·전체시험을실행하지않았다. 수치동등성·DDL/권한·동시성·crash/취소재개·실제통합회귀통과를주장하지않는다.
- 21.8인계: README의직접소유전용compose/DB/role·격리home·합성자료에서새·기존Garmin포함 `pnpm test` → `pnpm test:python` 순차실행한다. 영향시험은 `apps/cli/python-test/garmin-collect.test.ts`, `garmin-native.test.ts`, `garmin-unit.test.ts`, `garmin-upgrade.test.ts`, `packages/core/test/supervisor-abi.test.ts`, `tooling/test-db/test/test-changed.test.ts`다. 준비/정리명령·관련재검증·기대관찰은README와Verification에있다. SHA/소유자원/명령/종료코드/로그/실패별처분/재검증을남기고미실행/미해결이면21.8 built/21.7 시작금지다.
- 운영조치:21.7운영자가확인된profile+self/connection과전용tokenstore의동일계정을확인해보호된0700디렉터리에0600 `brain-account-binding.json`을준비한다(README의필드/지문). 확인서는Garmin서명이아닌로컬운영자명시증거이며동일OS사용자의보호디렉터리/session락·라이브러리token저장동작을신뢰한다. 지금운영계정/토큰에는접근하지않았다. 임의token수동교체/불명장부는보존·거부하고운영자원인을확인한다.
- 잔여위험: 실제DB DDL/권한, native값/NULL/배열/시간대동등성, 취소·프로세스그룹/동시성·시험timeout·토큰게시fsync의실행결과는21.8에서만확정된다. 원본fetched millisecond변경추적한계는그대로다. 다중사용자전체권한격리완성은주장하지않는다. 추가권고/별도기능보류는없다.
- 금지경계: 운영설치/DB/실계정/API/건강자료/모델/Telegram/예약·원본checkout변경없음. 중앙state/공용follow-ups/main병합·push/에픽전이없음. app-ref변경없음. 티켓브랜치commit/push·원격SHA확인과실제최종보고파일작성확인후중앙Run으로보고한다.
