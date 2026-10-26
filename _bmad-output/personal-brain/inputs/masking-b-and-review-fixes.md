# 입력: 마스킹 B와 결정 검토 수정 (correct-course용)

2026-10-18 사용자 결정을 모은 것이다. `bmad-correct-course`의 입력으로 쓴다. 한 제안으로 묶어 다룬다. 2.13·2.14를 시작하기 전에 끝내야 한다(두 티켓의 `unknown`이 이 문서를 가리킨다).

## 1. 마스킹 B — 저장은 원문, 나갈 때 가린다

- **결정:** 비밀은 저장할 때 가리지 않고 원문 그대로 둔다. 밖으로 나갈 때 가린다. 나가는 길은 시작 맥락 주입, 검색·조회 결과, Markdown 미러, 내보내기, Drive·복제 대상이다.
- **지금과 다른 점:** FR-26과 AD-11은 저장 전 마스킹(원문 불변의 유일한 예외)을 정했고, 2.9가 그것을 만들었다(use case가 batch를 만들 때 `maskSecrets`를 부르고 `IngestMessage.redactions`에 기록).
- **영향 범위(정리해야 할 곳):**
  - PRD FR-26(`prd-brain-v1-slice-1/`), spine AD-11(`architecture-brain-v1-slice-1/`).
  - epic 2(`tickets/epic-capture/epic-capture.md`) E2-8과 Done when 4.
  - built 2.9(`tickets/epic-capture/tickets/story-untitled-9-plan.md`): 저장 경로의 `maskSecrets` 호출과 redactions 기록을 어떻게 할지.
  - 2.13 `messages redact`: 사람이 고른 것을 저장본에서 지우는 수동 가리기로 남길지, 범위가 바뀌는지.
  - epic 3·4·5의 출력 경로: 시작 맥락, recall·조회, 미러, 내보내기가 같은 Core 패턴으로 가리게.
- **2.9 패턴 문제(실측 근거가 있음):** 영어 키워드 값이 평범한 코드·문장까지 가리는 과잉 가림, 한국어 표현("비밀번호 X", "비밀번호가 X") 놓침, 값이 `!` 같은 구두점에서 끊김. 근거와 재현은 `tickets/epic-capture/tickets/story-untitled-9-plan.md`의 Review Triage Log와 frontmatter `deferred`. 저장 시점에 가리지 않으면 과잉 가림이 저장본을 망가뜨리지 않으므로, 패턴을 고칠 여유가 생긴다.

## 2. 결정 검토 수정 (사용자: "우려대로 고친다")

- **2.7 parser — peer handback 누락.** parser가 peer handback(`origin.kind === 'peer'`, `origin.handback === true`, `origin.handbackReportText`)을 서브에이전트 보고로 받지 못해, 실측에서 보고의 약 58%가 빠진다. parser 버전 3으로 고치고 2.14 전에 끝낸다. 근거 plan: `tickets/epic-capture/tickets/story-transcript-parser-plan.md`(ticket 7).
- **2.8 정체성 — 대소문자와 영구 null.** GitHub·Bitbucket의 owner/repo는 대소문자를 구분하지 않으므로 비교용 case-fold 키를 둔다. git이 잠깐 실패해도 세션 꼬리표가 영구히 null이 되므로, null일 때 한 번 다시 채우거나 doctor가 경고한다. 근거 plan: `tickets/epic-capture/tickets/story-untitled-8-plan.md`(ticket 8).
- **2.6 `failed_stage` 강제.** 새로 failed가 되는 행에 `failed_stage`가 반드시 있도록 trigger로 강제한다. 근거 plan: `tickets/epic-capture/tickets/story-0004-plan.md`(ticket 6).
- **0005의 도구 메모 가리기 자리.** 마스킹 B에서는 도구 메모 대상 가리기가 2.13 수동 가리기에만 필요한지 정리한다.

## 3. 순서

- 이 제안이 승인되기 전에는 2.13·2.14를 시작하지 않는다. 2.10~2.12는 영향이 없어 먼저 진행해도 된다.
- 2.7 parser v3는 2.14 전에 끝나야 한다.
