---
title: 'Drive tracer 회귀 원인 분리와 교정'
type: 'bugfix'
ticket: '13'
created: '2026-11-09'
status: 'built'
baseline_revision: '2f23d30b7a894a9979567311544c7f28e3f25a5a'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Drive tracer 사례의 기본 회귀가 실패한다. 원시 기록의 parser 사례는 timeout이 아니라 실패 수 단언 불일치이며 개별 귀속은 미확정이다.

**Approach:** 실제 준비·동작·종료·정리 경계를 분리해 원인을 입증하고 기존 안전 계약을 유지하는 최소 교정을 한다.

## Boundaries & Constraints

**Always:** 독립 DB·role·home·venv·TMP·서버를 사용하고 사례와 단언, 제품 timeout·재시도·락·fence를 보존한다. 공통 fixture나 제품 수정 필요 시 원인·최소 diff·영향을 중앙에 먼저 질문한다. 개발 및 리뷰 수정 중 시험·진단·계측을 하지 않고 컴파일만 확인한다.

**Never:** 단순 timeout 증가, sleep, skip, 단언 약화, mock 대체, 실제 Drive·운영 DB 사용, 19.5 runner/config/측정 변경을 하지 않는다.

## I/O & Edge-Case Matrix

| 상황 | 입력 / 상태 | 기대 동작 | 오류 처리 |
|---|---|---|---|
| 정상 | 합성 Drive와 독립 DB | 원본 이전·조회·삭제와 정리가 제한 안에 완료 | 오류 없음 |
| 경합 | 지연 업로드·GET 중 가림 또는 home 변경 | 기존 보존·가림·fence 단언 유지 | 대기 해제와 자원 정리 |
| 자식 실패 | parser 강제 종료 | 이전 current와 chunks 보존 및 실패 기록 | 자식 종료 확인 |

</intent-contract>

## Code Map

- `apps/cli/test/drive-tracer.test.ts` — 독립 home/PG/서버 fixture, 실제 migrate·drain·show, barrier와 역순 cleanup. 아홉 timeout 사례의 진행 단계를 구분한다.
- `apps/cli/test/drive-source-tracer.test.ts` — 별도 fixture와 parser SIGKILL 사례. 원시 실패는 drain 결과 `failed: 4` 대 `1`이다.
- `apps/cli/test/fixtures/fake-drive.ts` — HTTP 서버·업로드/다운로드 barrier 및 `server.close`; 진행과 cleanup 대기를 구별한다.
- `apps/cli/test/pg-home.ts`, `packages/core/src/queue/drain.ts`, `apps/cli/src/runtime/document-extractors.ts` — 공유 준비, queue 시간·parser close 경계 조사만; 변경 전 소유 승인 필요.
- `apps/cli/src/assembly.ts`, `apps/cli/src/harnesses.ts`, `packages/claude-code/src/transcript-folder.ts` — fixture env의 HOME과 별개로 명시적 CLAUDE_CONFIG_DIR이 없을 때 process homedir의 transcript 폴더를 선택한다.
- `.brain-automation/tickets/19.13/evidence/` — 로컬 원시 기록. 공개 문서에 개인 경로를 옮기지 않는다.

## Tasks & Acceptance

**Execution:**
- [x] `bug-drive-tracer-timeout-plan.md` — Execution 1: 원시 기록과 source, 각 단계 및 미해결 진단/의존 질문을 기록한다.
- [x] `apps/cli/test/drive-tracer.test.ts`, `apps/cli/test/drive-source-tracer.test.ts` — Execution 2: 각 fixture가 조립하는 모든 env에 해당 fixture 소유 빈 `CLAUDE_CONFIG_DIR`을 명시해 process HOME의 transcript가 실제 drain에 유입되지 않도록 한다. fixture 격리 전후의 실제 scan 및 queue를 합성 transcript로 확인하는 결정적 회귀를 추가하고 독립 리뷰·필요 후속 리뷰를 수행한다. 기존 Drive·parser 단언, clock, budget, fence는 유지한다. 역사적 실패의 귀속은 별도 증거로 확인한다.
- [x] `bug-drive-tracer-timeout-plan.md` — Execution 3: 전체 회귀와 실패별 처분, 자원 정리, 19.5 인계 및 독립 리뷰 결과를 기록한다.

**Acceptance Criteria:**
- Given 동일 고정 합성 session·합성 process HOME과 실제 합성 서버·독립 fixture, when 기존 ambient scan/queue 유입과 전용 config 교정의 차단을 실제 조립 경로로 대조하면, then 격리 교정 인과와 기존 9 timeout/parser 대상 case 대응·제한·단언·보존 계약 및 두 파일 45case 통과를 입증하고 최초 전체 20실패의 관련 재검증 처분·미해결 유무·실제 소유 정리를 보존한다. 역사적 각 행의 정확 원인은 원시 root/kind 누락에 따른 미확정 한계이며 built 필수 조건이 아니다.
- Given 마지막 수정과 후속 리뷰, when 전체 TS와 Python을 순차 실행하면, then 원시 결과와 모든 실패의 처분 및 재검증을 보존한다.
- Given 19.5 수락 source, when 변경 파일의 hash·import·spawn 경로를 대조하면, then 시험/fixture/제품/측정 실행 바이트 영향과 필요한 재검증을 인계한다.

## Implementation Notes

- Execution 2: 두 tracer 파일의 fixture와 별도 조립 env 및 자식 조립에 fixture 소유 `CLAUDE_CONFIG_DIR`을 지정했다. 각 파일에 합성 process HOME에서 실제 drain의 미수집과 합성 경로 양성 대조를 확인하는 회귀를 작성했다. 개발 중 시험은 실행하지 않았고 build·typecheck만 통과했다. 과거 실패 귀속과 독립 리뷰·최종 검증은 남았다.

## Plan Change Log

- 2026-11-09 최종 tree 검사: plan frontmatter ticket은 epic 내부 id를 요구하므로 19.13에서 13으로 직접 교정했다. leaf/entry/after/번호 소유나 구현·시험 바이트는 변경하지 않았다.

- 2026-11-09 중앙 msg_21d84c8bcbbc 명세 보완: 원래 AC1의 역사적 9 timeout/parser failed 4 개별 귀속은 원시 root/kind 누락 때문에 필수 built 조건에서 제외하고 미확정 한계로 보존한다. 필수 근거를 고정 합성 session의 실제 기존/교정 fixture scan·queue 유입 대조, 기존 10개 case 대응·제한·단언·보존 계약 및 두 파일 45case 통과, 최초 전체 20실패 원형·환경 관련 재검증 처분·실제 소유 정리로 명시했다. 입력 격리 결함 교정만 수락하고 과거 10개 공통 원인 해결을 주장하지 않는다. 다른 AC·안전 계약과 제품/공통 fixture/runner/config 불변을 KEEP한다. leaf AC1/Notes·부모 Decision에 같은 경계를 반영하고 독립 PO 표적 확인 뒤 제출한다. 추가 진단·전체·성능 실행은 없다.

- 2026-11-09 독립 PO-T1: 보완 Change Log와 달리 현행 Acceptance Criteria가 역사적 열 개 원인 확인을 계속 요구한 문서 불일치를 직접 교정했다. 중앙의 대체 필수 근거를 현행 AC에 반영하고 다른 안전 계약은 KEEP했다. 구현·시험 바이트는 변경하지 않았다.

## Review Triage Log

### 2026-11-09 — Review pass 1

- verdicts: 9 findings — high 0, medium 9, low 0, false 0, maybe-false 0. Edge-case lens는 발견 0건이다. 의도 감사의 표면 차이 5행도 각각 기록한다.
- `[medium]` `[patch]` BH1: 양성 대조가 assembly를 우회한다. 현재 포트 직접 교체는 assembly가 빈 폴더를 반환하는 회귀를 검출하지 못한다. 같은 조립 경로에서 config env 항목만 생략하는 대조로 직접 교정한다.
- `[medium]` `[patch]` BH2: 음성 대조가 scan 실패와 빈 스캔을 구분하지 않는다. brain drain의 unwritable 조기 반환과 scanStopped가 enqueued 0과 양립한다. 양쪽 대조의 정상 종료와 scanStopped 부재 단언을 추가한다.
- `[medium]` `[patch]` BH3: parser 별도 env 설정 누락을 신규 fixture 회귀가 덮지 않는다. 기존 parser 사례에 합성 ambient HOME을 적용하고 enqueued 0·session_ingest 부재를 추가하며 기존 failed 1·세대/본문 보존 단언을 유지한다.
- `[medium]` `[patch]` VG1: parser 별도 조립 env 검증 공백. BH3와 동일 원인이지만 독립 행으로 보존하며 같은 parser 사례 보강으로 해결한다.
- `[medium]` `[reject]` IA1: 격리 회귀 코드는 최종 실행 통과 증거가 아니다. 사실이며 중간 리뷰 시점의 예정된 최종 gate로 남긴다. 코드 결함 처방으로 해석하지 않는다.
- `[medium]` `[patch]` IA2: 명시 경로 양성 대조는 fallback 조립을 직접 행사하지 않는다. BH1과 동일한 대조 교정으로 처리한다.
- `[medium]` `[reject]` IA3: 역사적 9 timeout과 추가 실패 3건의 개별 귀속은 미입증이다. 사실이며 필수 수락 미해결로 남긴다. deferred로 옮기거나 격리 교정만으로 built 처리하지 않는다.
- `[medium]` `[reject]` IA4: 기존 계약 유지의 정적 근거는 실제 종료·정리 증거와 다르다. 사실이며 마지막 수정·독립 확인 뒤 전체 회귀와 자원 정리에서 검증한다.
- `[medium]` `[reject]` IA5: 인계 문장이 실제 인계 완결을 뜻하지 않는다. 사실이며 최종 source hash/import/spawn 영향 대조와 중앙 보고가 남아 있다.

### 2026-11-09 — pass 1 수정

- BH1: 양성 대조를 같은 fixture의 `brainDependencies` 조립 함수로 변경하고 env에서 `CLAUDE_CONFIG_DIR`만 제거했다. 독립 후속 리뷰 및 실제 시험 확인은 남았다.
- BH2: 두 파일의 격리·양성 대조가 `stopped: empty`, 실패 0·spool 실패 0·`scanStopped` 부재와 enqueue/작업 행을 각각 요구한다.
- BH3: 기존 parser 실패 사례에서 합성 ambient HOME을 설치하고 실제 별도 조립 drain의 enqueue 0·session 작업 부재를 검사하며 기존 계약과 finally 복구를 유지했다.
- VG1: BH3와 같은 별도 parser 조립 경계의 검증 공백을 위 보강으로 처리했다.
- IA2: BH1의 실제 미설정 env 조립으로 fallback 표면을 직접 행사하도록 바꾸었다. 역사적 실패의 귀속은 여전히 미확정이다.

### 2026-11-09 — Independent follow-up 1

BH1·BH2·BH3·VG1·IA2의 실제 코드 수준 해결을 독립 Sol 리뷰가 확인했다. 추가 발견 0건. assembly 동일 경로·정상 scan/drain·parser 별도 env 합성 HOME 보호와 기존 SIGKILL/세대/본문 단언 보존을 추적했다. 실행 통과와 역사적 귀속은 아직 확인되지 않았고 최종 gate로 남는다. 보고: `.brain-automation/tickets/19.13/review-followup1-report.md`(로컬).

## Design Notes

현행 gate 해석: 아래 조사 당시의 “수락 조건의 남은 검증”과 pass1 IA3의 “필수 수락 미해결” 중 역사적 개별 귀속 요구는 중앙 msg_21d84c8bcbbc 보완으로 대체됐다. 원래 판단 이력은 보존하되 현행 Acceptance Criteria와 Plan Change Log의 대체 필수 근거를 따른다. 역사적 귀속 미확정 자체를 다시 built gate로 요구하지 않는다.

승인된 단일 사례별 진단은 모두 통과했으나 원시 실패를 설명하지 못한다. 합성 A/B에서 기본 process HOME의 transcript 한 건이 실제 `session_ingest` 및 `conversation_chunk` 작업으로 유입되고 fixture 전용 config에서는 제외됨을 확인했다. 네 사례 모두 통과했으며 과거 실패의 인과는 미입증이다. 고정 fake clock에서는 drain budget이 실제 경과를 제한하지 않으며 기본 재시도는 미래 nextAttemptAt으로 예약된다. fixture의 env는 CLAUDE_CONFIG_DIR을 지정하지 않아 process homedir fallback이 사용될 수 있으나 과거 실행의 실제 경로·목록·작업 귀속은 미확인이다. 과거 시간 소비 단계 및 parser 추가 실패 원인은 미확정이며 수락 조건의 남은 검증으로 보존한다. 중앙 msg_01cf5f8cc66c는 합성 A/B 뒤 시험 전용 env 최소 교정·결정적 회귀 코드·독립 확인 진행을 승인했다. 2026-11-09 지휘자는 격리 결함에 대한 Execution 2 계획이 구현 가능함을 확인해 ready-for-dev gate를 통과시키고 in-progress로 전환했다. 과거 전체 실패 귀속 미확정을 구현 완료나 built로 대체하지 않는다. 두 사례를 따로 조사하고 추가 진단이나 공통 fixture·제품 수정이 필요하면 범위·횟수·소유 영향을 지휘자에게 먼저 묻는다.

## Verification

**Commands:**
- 개발 중 `pnpm build`, `pnpm typecheck`, `git diff --check`만 허용한다.
- 최종 수정·독립 후속 뒤 커밋 전 `VITEST_MAX_WORKERS=2 pnpm test` → `pnpm test:python`을 순차 각 1회 실행한다. 실패 수정 뒤 관련 시험과 `pnpm test:changed`로 재검증한다.
- 실행 source SHA, 환경, 명령, 종료 코드, 최초 실패 원문 및 실패별 처분을 보존하고 정확히 소유한 자원만 정리하여 부재를 확인한다. 19.5 영향은 hash·import·spawn으로 확인한다.

## Auto Run Result

최종 상태는 built이며 사용자 인수 done과 구별한다. 두 시험 파일의 fixture·별도 parser/child 조립에 전용 transcript config를 지정하고, 실제 fallback assembly의 양성 대조·정상 scan/drain·parser 별도 env 격리 회귀를 작성했다. 제품·공통 fixture·runner·config·lock·migration·plugin은 변경하지 않았다.

4렌즈와 독립 후속 리뷰에서 BH1/BH2/BH3/VG1/IA2의 코드 수준 해결을 확인했다. 구현·리뷰 수정 중 시험은 실행하지 않았으며 build·typecheck·diff 확인이 통과했다. 중앙 승인 진단 2회 및 합성 A/B 4회는 별도 제한 실행으로 보존했다. 합성 transcript 유입 제거는 입증했으나 과거 10개 실패 전체 귀속은 미입증이다.

마지막 실질 수정 뒤 전체 회귀는 `VITEST_MAX_WORKERS=2 pnpm test` → `pnpm test:python`을 순차 각 1회 수행했다. TS 576.90초 exit 1, 223/226파일 통과·4928통과/12실패/1skip, Python 413.40초 exit 1, 15/16파일 통과·68통과/8실패다. 대상 tracer 18개와 source tracer 27개는 새 격리 2개·보강 parser를 포함해 모두 통과했다. 원문과 source/diff/hash 및 자원 ID는 로컬 `execution3/run/logs/`에 보존한다.

TS hook 7개/Python hook 8개의 최초 Compose unavailable·설치 산출물 부재 및 null status, TS runtime 1개/sessions 4개의 checkout 내부 TMP 문제를 각각 보존했다. 전용 Docker config에 실제 Compose plugin 한 파일 연결과 저장소 밖 TMP 교정을 독립 검토한 뒤 관련 TS 세 파일 108통과/1skip, Python hook 8통과를 순차 각 1회 exit 0로 재검증했다. 최초 null status 두 사례도 재검증에서 통과했으나 최초 signal/error는 미기록이므로 정확 원인을 단정하지 않는다. 전체 suite는 반복하지 않았다. 상세 실패별 처분은 로컬 `related-retest-report.md`와 최초 원문에 있다.

전체 회귀의 관리 PG와 생성 fixture 269개 및 관련 재검증의 관리 PG·Compose 2개·정확 volume/port의 부재를 감사했다. 다른 실행 자원은 정리하지 않았다. source/diff/lock hash는 실행 전후 동일하다. 로컬 원문 보고 `execution3-report.md`, `environment-repair-report.md`, `environment-followup-report.md`, `related-retest-report.md`를 보존했다.

중앙 msg_21d84c8bcbbc로 역사적 개별 귀속의 필수 조건 제외와 대체 필수 근거가 확정됐다(Plan Change Log). 역사적 귀속은 여전히 미확정이며 수정 불필요/공통 원인 해결로 쓰지 않는다. case 대응표, 독립 PO 표적/후속/최종 PASS, 19.5 고정 measure-v3 source/manifest 바이트 영향 감사와 독립 확인을 완료했다. 정확 최종 commit·원격 SHA를 지정 중앙 Run에 보고해 공식 19.5 인계에 사용한다. 필수 미해결을 deferred로 이동하지 않는다. 현재 `deferred`는 빈 단일 목록이다.

operator_actions: 중앙은 정확 최종 SHA와 바이트 영향 보고를 감사·수락한 뒤 19.5에 공식 인계한다. 19.5 소유자는 hook snapshot 간접 바이트 영향에 따른 성능 gate 증거의 처리·재측정 필요 여부를 판단한다. 기존 87f 측정 표본을 새 source 검증으로 쓰지 않는다. 범위 커밋/브랜치 push·정확 원격 SHA·clean 증거는 자기 로컬 최종 보고에 남긴다. 실제 사용자 home 조회나 추가 전체/성능 반복으로 누락 원시를 대체하지 않는다. 중앙 main/state 변경은 하지 않는다.

## 대상 case 및 19.5 고정 측정 바이트 인계

### 기존 실패와 현재 사례 대응

원문 `evidence/main-ab-drive.log`의 tracer 9개는 각 기본 제한 30000ms 초과다. 아래 현재 이름은 원문과 같으며 `case-bodies.json`에서 baseline과 현재 각 사례 본문 전체의 SHA 및 바이트 동일성을 확인했다. 단언·사례별 timeout을 포함한 본문은 변경되지 않았다. 다음 `통과`는 최종 전체 TS 원문이 해당 파일을 **18 tests 전체 통과, skip 없음**으로 보고한 파일 단위 증거다. 원문은 개별 9행의 별도 시간이나 pass 행을 내지 않으므로 그보다 정밀한 실행 시각·소요를 주장하지 않는다.

| 원문·현재 tracer 사례 | 그대로 보존된 핵심 안전 단언 | 최종 전체 TS |
|---|---|---|
| 0일 보관: 이전·동일 내용 재이전·실제 drain·Drive 원문 show | 중복 이전 수렴, 로컬 삭제 시점, 원문·비밀 마스킹, 원격 소실 시 본문 미노출 | 18개 전부 통과에 포함 |
| 기본 30일은 만기 직전 보존하고 도달 뒤 원격 확인 후 지운다 | 만기 직전 로컬 보존, 만기 후 GET 확인·삭제 | 동일 |
| 체크섬 불일치는 home을 보존하고 원격 소실은 보관 삭제를 막는다 | checksum 오류와 원격 소실 시 home·로컬 보존 | 동일 |
| 지연 업로드 중 가리면 미확정 원격 파일을 먼저 삭제 완료로 표시하지 않는다 | 경합 제출·가리기 fence, 미확정 위치 보존, 해제 후 원격 삭제 | 동일 |
| 두 업로더 중 제출 전 지연된 쪽은 가리기 삭제 뒤에 원격 파일을 다시 만들지 못한다 | 지연 업로더 실패와 삭제 후 원격 재생성 방지 | 동일 |
| 보관 삭제가 원격 GET 중 home 변경을 관찰하면 로컬을 보존한다 | GET 경합 중 적격성 재확인과 로컬 위치 보존 | 동일 |
| Drive home을 실제 drain으로 재추출하고 새 세대에 원격 바이트를 기록한다 | 원격 GET, 새 extraction 세대 및 원문 보존 | 동일 |
| 보관 삭제 drain의 성공과 이미 삭제된 재시도는 열린 실패 기록을 해소한다 | 성공·이미 삭제된 재시도 양쪽 실패 기록 해소 | 동일 |
| 일시적인 Drive root DB 오류는 추출 재시도 뒤 복구되며 접근 불가로 기록하지 않는다 | 일시 오류 시 기존 current·접근 가능성 보존, 재시도 뒤 새 세대 완료 | 동일 |

원문 parser `새 parser child 비정상 종료는 PG의 이전 current와 chunks를 보존한다`는 120000ms 제한 안의 34416ms에 `failed: 1` 기대 대 실제 4 단언 실패였다. 현재 같은 사례는 기존 실제 SIGKILL, parser 실패, failed 1, 이전 current·chunks 보존, 추출 실패 이력과 미해결 `EXTRACTION_FAILED`, 60000ms drain/parser budget 및 120000ms 사례 제한을 보존하고 합성 ambient HOME의 enqueue 0·정상 scan 단언을 추가했다. 최종 전체 TS 원문은 `drive-source-tracer.test.ts` **27 tests 전체 통과, skip 없음**으로 보고한다. 개별 parser 시간은 출력되지 않았다. 두 파일 합계 45개 통과다.

같은 합성 session seed SHA `7d003185bd7e0223402c7cf740f1c713b532b6a35b9f89653fa5a3e18309182e`의 제한 A/B는 fixture config 미지정 시 scan/enqueued 1, 지정 시 0을 tracer·parser 각각 관측했다. 현재 두 독립 회귀는 동일 조립 경로의 격리군과 config만 제거한 양성 대조에서 각각 enqueue 0/1 및 정상 drain·DB 행을 확인한다. 원래 10건의 실제 root/kind는 기록되지 않아 개별 과거 인과는 미확정이다. 중앙 `msg_21d84c8bcbbc`는 그 개별 귀속을 built 필수에서 제외하고 이 한계를 보존하도록 정정했다.

최초 전체 회귀는 TS 12실패와 Python 8실패이며 `execution3-report.md`의 원문·소유 269 fixture 정리 기록을 보존한다. 관련 재검증은 TS 세 파일 108통과·Python 전용 1 skip, Python hook 8통과이고, 최초 20개 실패의 사례별 대응은 `related-retest-report.md`에 있다. 최초 null status 두 건은 관련 실행에서 통과했으나 당시 signal/error 원인은 미확정이다. 이 결과는 최초 전체 suite exit 1을 소급 변경하지 않는다.

### 19.5 고정 측정 바이트

측정 source는 `87f7b3e79e74b3da7a1de055259ed0016a989567`, 원래 19.13 baseline은 `2f23d30b7a894a9979567311544c7f28e3f25a5a`다. 동결 manifest는 7파일, 21 jobs, 54 cases이며 tracer 두 파일은 직접 선택되지 않는다. 19.5 driver `measure.mjs` 실제 SHA-256 `6dabea0725597493881eaef31ce2d7ceb6e57bf6742276e59f8c96be5d89cc5a`는 frozen identity와 일치한다. driver는 `tooling/test-db/dist/python-slots.js`를 spawn하고 runner는 선택 파일을 Vitest로 실행한다. 검색·추적 원문과 비교표는 `impact-audit/dependency-search.txt`, `source-hashes.json`이다.

측정 source의 `tooling/bootstrap/test/hook.test.ts`는 `snapshot()`에서 `git ls-files -co --exclude-standard -z`로 파일을 열거하고 일반 파일마다 `copyFileSync`한다. 이어 snapshot을 Git commit하고 clone·install·build한다. 두 tracer는 추적 파일이므로 선택된 hook job의 이 경로에서 실제 읽기·복사 대상이다. 측정 source와 baseline의 두 원본 SHA는 tracer `d99cfd04f688f4f41ab07c88fe2a4db32d1a3ddde724201cd7a7a871f78707b3`, source tracer `88e0dcfa90d5e2c743780291f72039d462fb5cb83e09b5d4b4722a3b4a0be96b`; 현재는 각각 `bd958fa79cf9fa33503fd8dd584c7aecd1166e97dfc5bc0726d245fd3d0afbfa`, `ae7c9927488bcb30ace805698c5e79777f5580618c7ee923517a1e5a5d3ff0af`다. 변경된 문서와 비무시 계획 역시 snapshot에 들어갈 수 있다. `apps/cli/tsconfig.json`의 production build include는 `src`이며 두 시험을 생산 모듈로 직접 compile한다는 근거는 없다. 그래도 snapshot commit ID와 복사·Git 작업량은 달라지므로 전체 측정 workload 바이트 동일을 주장할 수 없다.

7개 직접 선택 시험 중 Garmin 6개는 measured·baseline·현재 바이트 동일이다. hook, Python config, 공통 `ext-fixture`, test-db index는 measured와 현재가 다르며, 이는 19.5 source에 이미 들어간 변경이고 현재는 원래 baseline과 같다. `python-slots.ts`, 관련 slots 모듈, Python global setup과 hook-resources는 baseline/현재에 없고 measured에 있다. 따라서 현재 checkout 전체가 measured artifact와 같다고 보지 않는다. 제품·공통 fixture·runner/config는 19.13 baseline 대비 수정되지 않았고 baseline 대비 변경은 두 tracer와 티켓 문서·계획이다. 측정 파일·runner·공통 의존의 31개 정확한 SHA는 `impact-audit/source-hashes.json`; baseline→measured 차이는 별도 19.5 기존 변화다.

정적 import/spawn 검색은 7개 시험, runner·slots 및 Python config에서 두 tracer를 명시적으로 import·spawn하는 경로를 찾지 못했지만 hook의 위 포괄 snapshot은 명백한 읽기 경로다. 실행 동적 의존을 전수 증명하거나 변경된 snapshot의 성능 영향을 측정하지 않았다. 기존 gate의 21 jobs·54 cases 및 4 slot 결과는 87f source의 과거 증거로만 인용한다. 현재 수정은 미커밋이며 최종 수락 시 이 해시들을 실제 최종 commit과 대조해야 한다.

동결 manifest, policy, identity, driver, gate와 prep 사본을 `impact-audit/`에 보존했다. 원본 gate 문서는 현재 SHA `372dd59c3a5b0c8ff9856f3e38c88a401c50922a5abbafe94de6f0df236c4bc3`이며 문서 내부의 자기 파일 SHA 항목 `01fa…`와 다르다. self-hash 항목이 현재 전체 파일을 증명하지 않으며 gate 내용의 별도 검증을 대신하지 않는다. 타 checkout·자원은 변경하지 않았다.

## 최종 독립 확인과 한계

독립 4렌즈, 실질 수정 해결 확인, 최종 실행 증거 감사, case/31경로 hash·측정 영향 감사, 독립 PO 표적/후속/최종 PASS를 완료했다. 중앙 보완 msg_21d84c8bcbbc에 따른 필수 구현·시험·리뷰 항목은 해결됐다. 역사적 개별 원인과 최초 hook null-status의 signal/error는 미확정 한계로 보존하며 과거 모두 같은 원인이었다고 주장하지 않는다.

제품·공통 fixture·runner/config·migration·plugin·lock은 원래 baseline 대비 불변이다. hook snapshot이 변경된 시험·문서를 복사하므로 간접 측정 바이트 영향은 있으며 시간 영향은 미측정이다. 공식 통합과 성능 gate 처분은 중앙/19.5 소유다. 추가 측정·전체 반복은 배정하지 않았다. deferred는 빈 단일 목록이며 워크트리·브랜치·세션·비공개 원시는 보존한다.

로컬 .brain-automation/tickets/19.13의 독립 보고는 review-followup1-report.md, final-evidence-review-report.md, final-impact-review-report.md, po-target-report.md, po-target-followup-report.md, po-target-final-report.md다. 최종 commit blob을 실행된 tracer 해시와 대조하고 정확 원격 SHA·clean 증거를 final-report.md에 남긴다.
