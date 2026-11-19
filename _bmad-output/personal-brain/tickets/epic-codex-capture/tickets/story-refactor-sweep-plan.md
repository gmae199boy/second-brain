---
title: '23.7 Codex 수집 에픽 보류 항목 정리'
type: refactor
ticket: '7'
created: '2026-11-19'
status: built
baseline_revision: '3d7c8e4af9cba7442c214d8ea383c304c108a513'
route: full
route_source: pinned
risk: low
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**문제** Codex 수집 에픽의 계획·리뷰에서 미룬 항목의 최종 처분을 확인해야 한다.

**접근** 23.2~23.5의 반영된 계획·triage·중앙 수락 기록을 대조하고 23.1의 실측 한계와 운영 후속의 소유 범위를 근거와 함께 기록한다. 실제 보류가 없으면 이 계획 문서로 정리를 마친다.

## Boundaries & Constraints

대조 기준은 상단의 원격 main SHA다. 에픽이 실제로 미룬 계획·리뷰 항목만 다룬다. Store 계약 변경은 에픽의 별도 결정 경계에 따른다. 운영 설치·실제 기록·계정·hook/notify 설정·릴리스는 23.6 또는 별도 운영 범위다.

</intent-contract>

## Code Map

- 같은 폴더의 `story-tracer-codex-sessions-read-plan.md`, `story-codex-scan-plan.md`, `story-codex-identity-plan.md`, `story-setup-connect-codex-doctor-codex-plan.md`에서 보류 선언, triage, 후속 리뷰, 제약을 확인한다.
- `../epic-codex-capture.md`, `../epic-codex-capture-research.md`, `tickets.toml`에서 에픽의 결정과 23.1·23.6·23.7 경계를 확인한다.
- `../../../automation/follow-ups.md`의 23.1~23.5 수락 기록과 중앙의 로컬 `.brain-automation/tickets/23.5/integration-verification/`의 원시 실행 기록을 대조한다.

## Tasks & Acceptance

- [x] 이 계획의 Implementation Notes에 티켓별 보류 여부와 근거, 남은 제약·후속의 처분을 기록한다.
- [x] 이 계획의 Verification에 통합 실행 기준과 현재 제품·시험 트리의 차이, 원시 실행·표적 재검증의 종료 코드와 건수를 기록한다.

- **AC1** 주어진 23.2~23.5 반영 기록을 대조하면 에픽이 실제로 미룬 각 항목의 근거와 처분을 읽을 수 있다. 보류 0건이면 각 티켓의 판정 근거와 운영·공통 계약 경계를 확인할 수 있다.
- **AC2** 주어진 23.5 시험 기록을 23.7 후보와 대조하면 기존 결과 적용의 근거와 최초 실패, 후속 파일 재검증, Python 전체 결과, 23.7의 신규 실행 여부를 각각 확인할 수 있다.

## Implementation Notes

기준 `3d7c8e4af9cba7442c214d8ea383c304c108a513`의 각 계획, triage와 [중앙 수락 기록](../../../automation/follow-ups.md)을 대조했다. 에픽이 수락조건이나 리뷰 finding으로 실제 미룬 항목은 0건이다. 아래 제약과 다른 티켓의 책임은 미해결 finding을 완료로 바꾼 것이 아니다.

- **23.2** — [계획](story-tracer-codex-sessions-read-plan.md)의 리뷰 medium 3건은 patch, 후속 리뷰에서 모두 resolved·신규 0·defer/reject 0이다. 파일별 부모·자식은 별도 수집하되 Store에 부모 링크와 도구 output 원문 필드가 없고 동일 시각 읽기 순서는 미정이다. 전 Codex 버전 호환성은 입증하지 않았다.
- **23.3** — [계획](story-codex-scan-plan.md)의 두 리뷰 라운드 지적은 수정했고 3차 신규 0·defer/reject 0이다. 활성·보관 스캔과 재작성 복구는 구현했으나 반복된 동일 원문의 임의 삽입·삭제 뒤 역사적 물리 개체 식별은 보장하지 않는다. 격리된 실패 트리거 후 스캔 복구는 확인했지만 일반 hook/notify 설정 공존은 입증하지 못해 자동 연결하지 않았다.
- **23.4** — [계획](story-codex-identity-plan.md)의 Q1·A1은 수정 및 후속 리뷰 resolved·신규 0·defer/reject 0이다. 시작 cwd 증거가 없으면 기존 첫 메시지 cwd fallback을 유지한다. 23.2의 Store 및 순서 제약도 유지한다.
- **23.5** — [계획](story-setup-connect-codex-doctor-codex-plan.md)의 리뷰 35건은 28건 해결, 7건 근거 기각, defer 0이며 최종 후속 신규 0이다. 연결 안내는 scan-only다. 진단의 scannedAt은 기록된 성공 수집 시각이지 실제 읽기 시작·완료 시각의 보장이 아니며, 한 루트 오류나 상이한 내용의 ID 충돌은 전체 목록 오류다.

[23.1 실측](../epic-codex-capture-research.md)은 한 파일의 append와 이 기계 표본을 관측했을 뿐 형식 안정성·항상 append·실제 hook 실행을 보장하지 않는다. 부분 줄·재작성 등의 합성 검증과 실제 운영 검증의 범위를 구별한다. 실제 설치·기록 대조 및 hook/notify 공존 판단은 23.6, 계정·설정·릴리스는 해당 운영 범위다. 공통 Store 계약 변경이 필요하면 [에픽 결정](../epic-codex-capture.md)에 따라 별도 결정하며 이 sweep에서 추가하지 않는다. 23.1 통합 복구의 신원 근거 부족 장부 18건은 보존하고 별도 판단 대상으로 남긴 중앙 기록도 에픽 구현 보류와 구별한다.

## Plan Change Log

## Review Triage Log

### 2026-11-19 — Quick 1차

- 발견 1건. high 0, medium 1, low 0, false 0, maybe-false 0.
- `[medium]` `[patch]` 관련 시험·통합 회귀 수락 판단 누락. 티켓 id 7의 검증 조건과 23.5 중앙 수락 근거를 연결했다. 동일 제품·시험 트리, 관련 시험 211건, 범위 밖 실패 파일의 동일 SHA 재검증 7건, Python 전체 통과를 근거로 채택했다. 최초 전체 TypeScript와 래퍼의 종료 1 및 원인 미확인 기록을 유지했다.

### 2026-11-19 — Quick 후속

- 신규 발견 0건. 최초 지적 1건 해결. 독립 후속 리뷰에서 중앙 수락, 변화 경로, 최초 전체 실행과 파일 재검증의 원시 결과를 대조했다. 추가 리뷰 권고는 없다.

## Verification

제품·시험 변경 없이 입증하는 경우, 통합 실행 SHA와 기준 및 후보 변경 경로를 Git으로 대조하고 원시 증거의 종료 코드·집계를 대조한다. 개발 및 리뷰 반영 중에는 시험을 실행하지 않는다. 제품·시험 변경이 생길 경우에만 마지막 수정 후 직접 관련 시험 파일을 지정해 실행한다. 전체 회귀와 `test:changed`는 티켓 워크트리에서 실행하지 않는다.

### 2026-11-19 근거 대조

- 중앙 통합 실행 및 파일 재검증의 `manifest.txt`는 모두 `a077c7555ee35ce635d4818ab05897d58f2fce08`이다. `git diff --name-status a077c7555ee35ce635d4818ab05897d58f2fce08 3d7c8e4af9cba7442c214d8ea383c304c108a513`의 유일한 경로는 중앙 수락 문서 `automation/follow-ups.md`다. 기준 HEAD와 후보의 추적 파일 차이는 없고 미추적 후보는 이 계획 하나다. 따라서 제품·시험 트리는 실행 SHA와 동일하며 기존 증거가 이 후보에 적용된다. 이 비교는 새 시험 실행을 뜻하지 않는다.
- 중앙 `.brain-automation/tickets/23.5/integration-verification/`의 최초 `typescript.exit` 1, `typescript.log`는 278파일 중 277 통과·1 실패, 5,776사례 중 5,775 통과·1 실패다. 실패는 `packages/postgres/test/document-recall.test.ts`이며 원인은 미확인이다. 최초 전체 실행을 통과로 소급하지 않는다.
- 같은 SHA의 `document-recall-recheck/`에서 해당 파일만 재검증: `typescript.exit` 0, 1파일 7사례 통과·실패 0, `final.exit` 0. 이는 전체 재실행이 아니다. 최초 실행의 `python.exit` 0 및 `python.log`는 12파일·29작업·55 통과·실패/skip 0이다. 최초 `final.exit`는 TS 실패를 반영해 1이다.
- **tickets.toml id 7 검증 판단:** 제품·시험이 동일한 이 변경의 관련 시험과 통합 회귀 조건에는 중앙이 수락한 23.5 직접 관련 9파일 211사례 통과, 최초 전체 TS의 범위 밖 실패 파일에 대한 동일 SHA 전용 환경 재검증 7사례 통과, Python 전체 통과를 함께 근거로 채택한다. `git diff-tree --no-commit-id --name-only -r a077c7555ee35ce635d4818ab05897d58f2fce08`에서 실패 파일은 23.5 변경 경로에 없다. 최초 전체 TS와 래퍼 종료 1 및 원인 미확인은 위와 같으며 단일 전체 TS 완주 성공을 뜻하지 않는다.
- 23.7은 제품·시험을 변경하지 않아 시험을 신규 실행하지 않았다. 수락조건과 위 원시 집계·종료코드 및 Git 경로를 대조하고 `git diff --check`와 미추적 계획의 whitespace 검사를 수행했다.

## Auto Run Result

- 상태 `built`. 23.2~23.5의 실제 보류 및 수락조건 미해결은 0건이다. 변경은 이 계획 문서 한 파일이다.
- 독립 Quick 지적 1건을 수정했다. 독립 후속 리뷰에서 해결을 확인했고 신규 지적·보류는 0건이다.
- 제품·시험 트리가 같은 23.5의 중앙 수락 근거를 적용했다. 최초 전체 TypeScript 종료 1과 원인 미확인을 보존했다. 해당 파일 재검증 7건, 직접 관련 211건, Python 전체 55건이 통과했다. 23.7에서 새 빌드나 시험을 실행하지 않았으며 Git 경로와 공백 검사를 확인했다.
- Store와 연구의 기존 제약은 Implementation Notes에 기록했다. 운영 설치 및 실제 기록 검증은 23.6 범위다.
