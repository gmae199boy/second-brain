---
title: 'Codex 최초 cwd의 프로젝트·워크트리 꼬리표'
type: feature
ticket: '4'
created: '2026-11-17'
status: built
baseline_revision: 'e2fd29956b0feadd348541fcd9275306aeb48ba3'
route: full
route_source: pinned
risk: medium
review: thorough
review_source: pinned
lenses_ran: [quick, edge-case-hunter, verification-gap]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Codex 시작 폴더와 턴 cwd는 다른 증거다. 기존 공통 정체성 연결은 있지만 교차 하네스 저장 결과와 메타 경계를 증명하는 fixture가 부족하다.

**Approach:** 최초 session_meta의 cwd를 시작 증거로 고정하고 기존 Claude 정체성 규칙을 재사용한다. 명시 CLI 수집·기존 정체성 일감으로 합성 검증하며 불필요한 제품 변경은 하지 않는다.

## Boundaries & Constraints

**Always:** 첫 완결 session_meta의 cwd만 startCwd로 사용한다. 그 증거가 없으면 기존 Core의 첫 메시지 cwd fallback을 보존하고 그 한계를 명시한다. 정상 시작 cwd는 턴 cwd와 선택적 git.branch로 대체하지 않는다. remote 정규화·common-dir·worktree·비교 키·삭제 폴더 추정은 Claude 공통 경로를 사용한다. Store 계약과 Claude 결과를 보존한다.

**Never:** 23.3 소유 harnesses.ts, assembly/index exports, 폴더 어댑터, scan, trigger를 수정하지 않는다. parser의 cursor·부분 줄·도구 대응 블록과 기존 공유 시험 파일을 수정하지 않는다. 공통 계약/스키마 변경은 중앙 결정 없이 하지 않는다. 실제 기록·설정·운영 DB·hook 설치를 사용하지 않는다. main 병합/push·강제 push·hook 우회 금지.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 시작 증거 | 첫 메타 cwd A, 이후 메타/턴 cwd B, git 메타 생략 또는 다른 branch | startCwd A 유지, 메시지 턴 cwd 별도 | 메타 최초 cwd 누락/빈 값이면 startCwd null, 기존 Core fallback만 유지 |
| 교차 하네스 | Claude·Codex의 같은 remote, SSH/HTTPS·GitHub 대소문자 변형, linked worktree | 동일 project와 checkout별 worktree, Claude 기존 결과 보존 | 타 host 경로 대소문자는 별도 identity |
| 비레포·로컬 | 시작 비레포 후 턴 레포, 또는 remote 없는 레포 | 비레포는 무태그 수집, remote 없음은 common-dir identity | 비레포는 identity 일감 없음 |
| 삭제·불명 | 삭제 시작 폴더, 조상/동일 identity 형제 또는 애매한 형제, 일시 unknown | 공통 ancestor/sibling 추정·모호성 보존, unknown 일감 재시도로 시작 기준 태그 | 미확정 상태를 성공 태그로 꾸미지 않음 |
| 재수집 | 최초 수집 뒤 턴 cwd 변경 및 두 번 수집 | 저장된 시작 증거·태그·전체 건수 유지 | 기존 세션을 재태깅하지 않음 |

</intent-contract>

## Code Map

- `packages/codex/src/parser.ts` — 현재 첫 비어 있지 않은 메타 cwd를 사용한다. 메타/startCwd 블록만 교정한다. 별도 신규 `packages/codex/test/identity.test.ts`로 경계를 증명한다.
- `packages/core/src/sessions/ingest.ts` — `parsed.startCwd ?? firstCwd(messages)`와 `checkoutFor`를 최초 생성 때 적용한다. `packages/core/src/capture/session-identity-work.ts`는 재파싱·저장 firstCwd로 지연 처리한다. 결함이 입증될 때만 최소 수정한다.
- `packages/core/src/domain/project-identity.ts` — remote 정규화와 GitHub/Bitbucket ASCII 비교 키의 단일 공통 규칙. `packages/core/test/session-identity-work.test.ts`는 기존 fakes 패턴이다.
- `apps/cli/src/runtime/git.ts`, `apps/cli/test/codex-tracer.test.ts` — 실제 Git inspector 및 명시 CLI/전용 PG 패턴을 읽고 새 `apps/cli/test/codex-identity-tracer.test.ts`에서 독립 검증한다. 기존 tracer는 수정하지 않는다.
- `tooling/test-db/src/index.ts` — run/file 라벨·tmpfs·랜덤 loopback 전용 PG 소유권/정리 패턴. 실제 정상 Docker context와 HOME을 유지하면서 Brain/Claude/Codex/XDG/fake launchctl을 격리한다.

## Tasks & Acceptance

**Execution:**
- [x] Execution 1 `packages/codex/src/parser.ts`, `packages/codex/test/identity.test.ts` — 첫 메타 cwd 권위와 반복 메타·누락/빈 값·턴 이동·선택적 branch 경계를 구현/검증한다.
- [x] Execution 2 `packages/core/test/codex-session-identity.test.ts` — Codex parser와 기존 ingest/identity handler를 합성 연결해 삭제 폴더 추정·unknown 재시도·저장 증거와 기존 태그 보존·비레포를 검증한다. 위 Code Map의 Core 구현은 입증된 결함만 최소 교정한다.
- [x] Execution 3 `apps/cli/test/codex-identity-tracer.test.ts` — 명시 CLI ingest와 실제 임시 Git/전용 PG로 교차 하네스·remote 변형·linked worktree·타 host case·비레포·remote 없음·턴 이동·재수집 멱등을 검증한다. 실행은 최종 리뷰 수정 뒤로 유예한다.

**Acceptance Criteria:**
- Given 같은 레포의 합성 Claude·Codex 파일과 linked worktree, when 명시 CLI로 각각 두 번 수집하면, then 같은 project와 올바른 worktree가 저장되고 Claude 본문·건수·태그와 전체 저장 건수가 보존된다.
- Given 시작 cwd와 다른 턴 cwd 및 없는/다른 git branch, when Codex 파일을 명시 수집하면, then 시작 cwd의 project/worktree와 first_cwd가 저장된다. 시작이 비레포이면 프로젝트 없이 정상 수집된다.
- Given 삭제되었거나 Git 응답이 불명인 시작 폴더, when 공통 수집/정체성 일감을 처리하면, then Claude와 동일한 추정·재시도 규칙으로 시작 증거를 보존한다.

## Implementation Notes

계획 gate: 실제 parser·공통 ingest/identity 코드를 조사 보고와 대조했다. 기존 연결을 재사용하는 full/pinned 경로이며 위험은 오태깅에 따른 프로젝트 혼합을 고려해 medium으로 올린다. 23.2의 파일별 id 검증·Store 불변·동일시각 정렬 한계를 그대로 유지한다. 첫 메타에 시작 증거가 없을 때 첫 메시지 fallback은 기존 공통 계약이며 이번에 강화하거나 제거하지 않는다.

## Plan Change Log

## Review Triage Log

### 2026-11-17 — Review pass 1
- verdicts: 리뷰어 1건·지휘자 matrix audit 1건 — high 0, medium 2, low 0, false 0, maybe-false 0
- `[medium]` `[patch]` Q1 Git fixture 환경 오염 — 새 helper는 process.env를 복사하여 GIT_DIR/GIT_WORK_TREE가 -C보다 우선한다. 외부 저장소 쓰기 가능성이 실제 호출에서 확인되므로 모든 상속 GIT_*를 제거한 뒤 합성 값만 설정한다. Docker 부모 환경은 유지한다.
- `[medium]` `[patch]` A1 전체 저장 건수 멱등 단언 공백 — tracer snapshot은 다섯 테이블의 일부 열만 비교하여 계획의 전체 저장 건수 유지를 직접 확인하지 않는다. 기존 tracer의 전체 brain 테이블 count 패턴을 새 파일 내부에 적용해 재수집 전후 비교한다.
- Quick Q1을 수용했고 edge-case·verification-gap은 지적0이다. 전문은 `.brain-automation/tickets/23.4/review-{quick,edge,verification}.md`. 수정 후 독립 후속 리뷰로 격리와 멱등 단언을 확인한다. 시험은 계속 미실행이다.

### 2026-11-17 — Follow-up review pass 2
- verdicts: 신규0 — high 0, medium 0, low 0, false 0, maybe-false 0
- Q1·A1 모두 resolved. 수정 diff와 실제 Git helper 및 PG counts 호출을 지휘자와 독립 Sol/medium 리뷰어가 확인했다. 전문 `.brain-automation/tickets/23.4/review-followup.md`. 미해결0, defer0, reject0. 추가 후속 리뷰 권고 false. 개발 종료 후 관련 시험으로 진행한다.

## Verification

- 개발/리뷰 수정 중 `pnpm build`, `pnpm typecheck`, `git diff --check`만 실행한다. 의존성 다운로드가 필요한 명령은 require_escalated로 실행한다.
- 마지막 구현·리뷰 수정 후 새 세 파일과 직접 관련 기존 `packages/codex/test/parser.test.ts`, `packages/core/test/session-identity-work.test.ts`, `packages/core/test/sessions-ingest.test.ts`, `packages/claude-code/test/parser.test.ts`를 `pnpm exec vitest run <파일들> --reporter=verbose --maxWorkers=1`로 지정 실행한다. Core 제품 변경이 추가되면 그 모듈 직접 관련 파일도 지정한다.
- 무거운 시험은 `~/.brain-operations/test-lock`을 mkdir로 자기 소유 획득 후 실행하고 종료 시 자기 잠금만 해제한다. 점유 중이면 폴링/삭제 없이 중앙 보고한다. 전체 시험·test:changed 금지, 전체 회귀는 중앙 통합 단계에 남긴다.
- preflight·명령·SHA·파일목록·종료코드·PG 정확 ID/PID/출생시각 manifest·원시로그·정리 종료 증거를 `.brain-automation/tickets/23.4/`에 당시 저장한다. Matrix 각 행과 AC의 실제 통과 시험을 최종 매핑한다.


## Auto Run Result

- 결과: built. 최초 완결 session_meta의 cwd를 시작 증거로 고정했다. 첫 메타 cwd가 누락·빈 값일 때 null을 반환하고 기존 Core의 첫 메시지 fallback을 유지한다. 반복 메타와 턴 cwd·선택적 git branch가 정상 시작 증거를 덮지 않는다.
- 변경 파일: `packages/codex/src/parser.ts`의 메타/startCwd만 최소 교정, `packages/codex/test/identity.test.ts`의 메타 경계7건, `packages/core/test/codex-session-identity.test.ts`의 공통 정체성 연결5건, `apps/cli/test/codex-identity-tracer.test.ts`의 실제 임시 Git/전용 PG 연결 및 격리2건. Core 제품·Store·스키마·23.3 소유 파일은 변경하지 않았다.
- 실측: 명시 CLI ingest에서 Claude/Codex가 동일 project에 묶이고 linked worktree·별도 clone은 올바른 worktree를 얻는다. GitHub SSH/HTTPS·대소문자 변형, 타 host 경로 대소문자 분리, remote 없는 common-dir identity, 비레포 무태그, 턴 이동·전체 brain 테이블 건수 멱등과 Claude 결과 보존을 검증했다. 삭제 폴더 추정·불명 재시도는 합성 Core 연결로 검증했다.
- 리뷰: Sol/medium Quick1건과 지휘자 matrix audit1건을 medium patch로 처리했다. edge-case·verification-gap0건, 독립 후속 리뷰 Q1·A1 resolved·신규0·미해결0. defer0/reject0. 후속 통과 이후 추가 수정이 없어 추가 후속 리뷰 권고 false다.
- 검증: 마지막 수정 후 build/typecheck/diff --check 각각 종료0. 최종 직접 관련7파일257건 통과·실패0·skip0·종료0. 실제 명령과 개별 시험/Matrix/AC 대응은 `.brain-automation/tickets/23.4/terra-verify-report.md`, `terra-verify-command.sh`, `terra-verify-execution.log`에 있다. 소유 잠금 획득·해제 당시 출력은 보존된 Orca transcript에서 추출한 `verify-lock-evidence.json`에 출처 메시지 ID·시각과 함께 기록했다. 시험 재실행이나 사후 실행 주장으로 대체하지 않았다.
- 자원: 정상 OrbStack/context와 실제 HOME을 유지했다. 전용 admin PG loopback59573, tracer PG59574를 사용하고 정확 ID 제거 후 inspect 종료1·worker 종료를 확인했다. run/file·tmpfs·PID/출생시각·정리 로그는 `terra-verify-{execution,resources}.log`. 타/불명 ledger와 운영54320/공유54329는 변경하지 않았다.
- 한계: 시작 cwd가 없는 파일의 기존 첫 메시지 fallback은 보존한다. 실제 사용자 데이터·운영 설치는 범위 밖이다. 전체 pnpm test → test:python은 미실행이며 중앙 통합 단계에서 수행한다. Store의 부모 링크/도구 output 원문·동일시각 순서 한계를 강화하지 않았다. 수락조건 미충족을 defer한 항목은 없다.
- 전달: 티켓 관련5파일만 커밋·자기 브랜치 일반 push하며 원격 SHA를 확인한다. main 병합/push는 중앙 전용이다. 시작 영수증 `start-receipt.json`, `.brain-automation/worker.json`, 리뷰 `review-{quick,edge,verification,followup}.md`, 최종 `ticket-result.md`를 중앙 복사용 증거로 보존한다.
