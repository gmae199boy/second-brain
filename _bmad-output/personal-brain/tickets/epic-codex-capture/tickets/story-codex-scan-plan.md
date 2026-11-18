---
title: 'Codex 증분 수집과 폴더 스캔'
type: feature
ticket: '3'
created: '2026-11-17'
status: built
baseline_revision: 'e2fd29956b0feadd348541fcd9275306aeb48ba3'
route: full
route_source: pinned
risk: medium
review: thorough
review_source: pinned
lenses_ran: [quick, edge-case-hunter, verification-gap]
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** Codex 기록은 명시 파일로만 수집되고 트리거 누락과 과거 기록을 스캔으로 복구하지 못한다.

**Approach:** 활성·보관 폴더를 파일별 메타 ID로 발견하고 기존 drain과 증분 수집에 연결한다. 안전한 트리거의 실제 적용과 기존 설정 공존을 격리 환경에서 검증한다.

## Boundaries & Constraints

**Always:** 합성 데이터·격리 설정·전용 시험 자원만 쓴다. 기존 Claude 결과 및 Store 계약과 23.2의 파일별 ID 검증·도구 대응을 유지한다. 스캔은 트리거 실패와 과거 기록의 복구 경로다. 중복 ID의 서로 다른 내용은 조용히 선택하지 않고 충돌로 보고한다.

**Never:** 실제 계정·설정·기록·운영 hook·DB 54320/54329에 접근하지 않는다. 23.4 소유 startCwd/cwd 정책, session-identity-work/repository를 수정하지 않는다. 23.5 connect/doctor 및 23.6 운영 설치를 구현하지 않는다. 공통 계약 또는 같은 블록의 변경이 필요하면 지휘자 결정 후 진행한다.

## I/O & Edge-Case Matrix

| 상황 | 입력 / 상태 | 기대 동작 | 오류 처리 |
|---|---|---|---|
| 발견 | 합성 활성 날짜별 경로와 보관 경로의 JSONL | 메타 payload.id로 구분하여 수집 | 없는 루트는 빈 목록; 읽기 오류는 드러냄 |
| 이동/중복 | 보관 이동 또는 같은 ID의 동일 복사본 | 같은 세션으로 중복 없이 수집, 이동 경로 이력 갱신 | 동일 ID의 다른 내용은 충돌 보고, 임의 선택 금지 |
| 증분 | append, 개행 전 부분 줄과 완성, 지연 도구 출력 | 완결된 내용만 반영, 반복 수집 멱등 | 부분 줄은 보류; 완결 깨진 줄은 계수와 경고 |
| 재작성 | 앞부분 변경 또는 축소, 같은 크기 변경 포함 | 변경 발견 후 cursor reset과 중복 없는 재수집 | listing fingerprint와 저장 fingerprint 비교 |
| 트리거 | 합성 설정의 기존 notify와 hook/notify 실패 | 안전한 공존이 입증되면 연결, 누락은 스캔으로 복구 | 실제 실행 또는 공존을 입증할 수 없으면 증거와 미충족을 명시 |

</intent-contract>

## Code Map

- `packages/codex/src/parser.ts` — 완결 개행만 읽고 메타 ID를 검사한다. 메시지 ordinal+줄 해시, 마지막 메시지까지 prefix hash cursor를 쓴다. 유효 cursor에서도 마지막 메시지를 재포함하고 전체 도구 호출/출력을 다시 대응한다. 기존 `packages/codex/test/parser.test.ts`에 부분 줄·깨진 줄·reset·지연 출력 사례가 있다. startCwd/cwd 블록은 23.4 소유다.
- `packages/claude-code/src/transcript-folder.ts` — 누락 폴더는 빈 목록, 열거 오류는 실패로 돌리는 폴더 port 패턴. Codex는 파일명보다 `codexSessionId`의 완결 메타를 신뢰하고 활성 날짜 트리와 보관을 함께 다룬다. 링크·순환·삭제 경합과 잘못된 ID도 명시적으로 다룬다.
- `packages/core/src/capture/scan.ts` — history는 harness+path와 크기만 비교하고 open/failure는 session token으로 중복 억제한다. `session-ingest-work.ts`는 토큰만 전달하고 실패 재시도를 관리한다. `sessions/ingest.ts`의 `locateTranscript`는 한 harness 폴더의 첫 일치 경로를 선택하므로 중복·이동 경합을 해결해야 한다. Store와 정체성 구현은 바꾸지 않는다.
- `packages/core/src/ports/transcript.ts`, `domain/transcript-file.ts` — listing은 size/mtime만 있고 history에는 fingerprint가 있다. 사용자 승인으로 선택적 listing fingerprint를 추가하고 제공 시 저장 fingerprint와 비교한다. 미제공 시 기존 크기 비교를 유지한다. 스캔 listing과 실제 읽기의 경합 및 fingerprint 계산 비용을 검증한다.
- `apps/cli/src/harnesses.ts`, `assembly.ts` — 현재 registry는 connector/hook/folder/watch를 묶고 Codex는 explicit parser만 등록한다. 가짜 connector 없이 스캔 폴더를 조립하고 parser 중복 등록을 피한다. daemon watch 경로도 확인하되 안전한 트리거 확인 전 가짜 연결을 만들지 않는다.
- `apps/cli/test/capture-scan.test.ts`, `codex-registration.test.ts`, `codex-tracer.test.ts` — CLI drain/실제 파일/전용 PG, 등록과 명시 수집의 선례다. 새 `codex-scan` 시험으로 범위를 분리하고 Claude 기존 검증을 보존한다.
- `epic-codex-capture-research.md` — 23.1 표본은 활성 날짜 계층과 보관의 존재만 관측했고 파일명 ID 일치나 append 전용을 보장하지 않는다. hook 실행·설정 공존은 검증하지 못했다.

## Tasks & Acceptance

**Execution:**
- [x] 1 `packages/codex/src/transcript-folder.ts`, `packages/codex/src/index.ts`, `packages/codex/test/` — 두 루트 발견·메타 ID·동일 복사/충돌·이동 및 파일 경합을 구현하고 합성 시험을 쓴다. `CODEX_HOME` 해석은 CLI 환경 경계에서 처리한다.
- [x] 2 `packages/core/src/ports/transcript.ts`, `packages/core/src/capture/scan.ts`, `packages/core/src/sessions/ingest.ts`, `apps/cli/src/harnesses.ts`, `apps/cli/src/assembly.ts` — 선택적 fingerprint 비교와 올바른 경로 선택을 잇는다. Claude의 크기 비교를 보존한다. 명시 parser와 자동 폴더 조립을 중복 없이 유지한다.
- [x] 3 `packages/codex/src/parser.ts`, `packages/codex/test/parser.test.ts`, `apps/cli/test/codex-scan.test.ts` — 필요할 때만 cursor/도구 정합을 수정하고 실제 drain→수집→sessions read의 모든 매트릭스 행과 Claude 보존을 합성 fixture로 검증한다. 격리된 hook/notify 실제 실행·기존 설정 공존을 조사하고 안전한 경우에만 연결한다. 성공 입증이 불가능하면 실패 근거를 기록하고 수락조건을 완료로 숨기지 않는다.


- [x] 4 `packages/codex/src/transcript-folder.ts`, `packages/codex/test/transcript-folder.test.ts`, `packages/core/src/sessions/ingest.ts` 및 직접 관련 시험 — 빈 파일·개행 전 메타는 다음 스캔으로 보류하면서 정상 파일은 발견한다. 목록에서 찾은 경로가 첫 읽기 전에 보관 이동하면 제한된 재탐색으로 새 경로를 읽어 영구실패 억제를 피한다. 명시 파일 경로와 Claude의 기존 오류 의미를 보존한다.
- [x] 5 `packages/core/src/capture/session-ingest-work.ts`, `packages/core/src/queue/drain.ts`, `packages/core/src/brain.ts`, `apps/cli/src/commands/queue-drain.ts` 및 직접 관련 시험 — 기존 scanStopped와 성공 수집 경고를 최소 선택 필드로 CLI JSON·텍스트까지 전달한다. 이미 정의된 경고 코드를 재사용하고 정상 종료·기존 카운트·기존 핸들러 동작을 보존한다. 새 공개 명령이나 Store/스키마 변경은 하지 않는다.
- [x] 6 `packages/core/test/sessions-ingest.test.ts`, `packages/codex/test/transcript-folder.test.ts`, `apps/cli/test/codex-scan.test.ts` — 구 parser 경로로 실제 legacy ID를 저장한 뒤 신규 정합의 기존 ID·cursor·가림 보존을 검증하고, 합성 외부 파일/폴더 심볼릭 링크 제외, 부분 메타 혼재, 보관 이동 경합 및 충돌/손상 경고의 CLI 관측을 시험한다. 개발 중 실행은 금지하며 최종 관련 파일 목록을 갱신한다.

**Acceptance Criteria:**
- Given 활성 및 보관 합성 기록과 보관 이동·동일 복사본, when CLI drain을 반복하고 sessions read를 호출하면, then 파일별 ID당 한 세션과 중복 없는 대화가 보인다.
- Given 수집 후 append·부분 줄 완성·앞부분 재작성·축소 및 완결 손상 줄, when CLI drain을 반복하면, then 완결 대화가 중복 없이 보이고 손상은 경고된다.
- Given 서로 다른 내용의 동일 ID 또는 트리거 실패, when 스캔하면, then 충돌이 드러나고 실패한 트리거의 정상 기록은 복구된다.
- Given 합성 기존 notify 설정, when 격리된 실제 Codex로 트리거 적용과 공존을 확인하면, then 기존 설정의 실행을 보존하고 안전한 연결만 사용한다.

## Implementation Notes

- 사용자 승인(2026-11-17): TranscriptListing의 선택적 fingerprint와 제공 시 scan 비교를 허용한다. Claude 기존 동작, Store/스키마 및 23.4 경계는 유지한다.

- 중간 구현: 활성·보관 discovery, 선택적 fingerprint scan, CLI 조립과 관련 합성 시험 코드를 작성했다. 재작성 ID 대응은 지휘자의 티켓 범위 판단에 따라 선택적 Parser 조정과 기존 readSession으로 구현했다. 격리 실측의 반복에서 notify와 hook이 함께 관측됐으나 신뢰 우회 및 앞선 notify 미관측으로 안전한 운영 연결을 주장하지 않는다.

- 지휘자 범위 판단(2026-11-17): 선택적 `Parser.reconcile`은 저장된 ID snapshot을 이용해 legacy를 보존하고 신규 발화에 원문 줄 hash와 occurrence 기반 canonical ID를 부여한다. 저장 cursor는 저장 ID를 가리키고 현재 prefix fingerprint와 일치할 때만 파일 내 ID로 역변환한다. 동일 원문 반복의 물리적 개체를 임의 재작성에서 구별할 수 없으며 발화 수는 보존한다. Store·스키마·Claude 및 23.4 소유 블록은 변경하지 않았다.

- 리뷰 수정: 빈/미완성 메타를 보류하고 자동 발견 경로의 읽기 실패에 한 번 재탐색한다. 성공한 작업의 기존 경고와 scanStopped를 drain 표면까지 전달하며 legacy 실제 저장·가림, 링크 제외, 이동 경합 및 CLI 경고 시험을 추가했다. 기존 코드 전용 복원 patch와 원본 tar는 `/tmp/brain-23-3-rebuild-worker/`에 보존했다.

## Plan Change Log

### 2026-11-17 — Review pass 1 repair
리뷰에서 부분 메타/이동 경합/바깥 표면 경고 및 시험 연결부의 계획 누락이 확인돼 intent-contract는 유지하고 Execution 4~6으로 구체화했다. 이전 코드의 보존 patch는 `/tmp/brain-23-3-review-1.diff`이며 수정 전 구현자가 코드 전용 patch를 따로 저장한 뒤 baseline으로 되돌려 보존분과 보완 계획으로 재구성한다.
KEEP: 활성·보관의 메타 ID 발견, 동일 복사본 중복제거/상이내용 충돌 거절, optional fingerprint와 Claude 기존 크기 비교, legacy/canonical·저장cursor·원문가림 정합, Codex scan-only 조립과 CODEX_HOME 시험격리, 기존 실측 원시 증거를 유지한다. Store/스키마·23.4 cwd/identity 블록·운영 hook은 변경하지 않는다.

## Review Triage Log

### 2026-11-17 — Review pass 3
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- Quick와 verification-gap 집중 후속리뷰에서 legacy 숫자 정규식·실제 가림 준비 및 두 queue 구간의 carry 경고병합 assertion을 모두 코드상 해결로 확인했다. 제품코드는 review2 이후 변경되지 않았다. 시험 실행 통과는 아직 주장하지 않는다.

### 2026-11-17 — Review pass 2
- verdicts: 5 findings — high 0, medium 5, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` verification-gap: legacy 시험 정규식 및 가림 준비 오류 — 실제 legacy ID와 맞지 않는 정규식 및 redactMessage 미호출을 확인했다. 숫자 정규식과 실제 가림 성공/본문 사전확인 후 기존 업그레이드 assertion을 유지하도록 수정한다.
  - `[medium]` `[patch]` verification-gap: 두 queue 구간 경고병합 시험 공백 — 단일 작업 시험은 carry 재진입을 만들지 않는다. 기존 carry fixture로 두 구간 실행 및 경고·합계 카운트 assertion 하나를 추가한다.
  - `[medium]` `[patch]` edge-case: legacy 정규식 오류 — 실제 숫자 ID가 assertion에서 막히므로 같은 시험 정규식을 수정한다.
  - `[medium]` `[patch]` edge-case: 가림 호출 누락 — 본문 원문을 저장한 뒤 가림 없이 원문 부재를 요구하므로 실제 가림 성공을 준비한다.
  - `[medium]` `[patch]` quick: legacy 시험 준비/단언 오류 — 위와 동일한 정규식·가림 준비의 root cause이며 같은 수정으로 해결한다. 제품 가림 결함으로 오인하지 않는다.

원 1차 지적의 부분 메타·이동 재탐색·CLI 충돌 및 손상 경고 전달·하위 링크 시험은 세 후속리뷰에서 코드상 해결로 확인했다. legacy 회귀와 추가 경고병합 시험은 이번 patch 및 후속 검토가 필요하며 아직 실행하지 않았다.

### 2026-11-17 — Review pass 1
- verdicts: 7 findings — high 2, medium 5, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[bad_plan]` verification-gap: legacy snapshot 전달 검증 공백 — helper에 ID를 직접 주는 시험만 있고 실제 구 parse 저장→새 ingest의 ID 전달을 검증하지 않는다. Execution 6에 업그레이드 회귀를 추가한다.
  - `[medium]` `[bad_plan]` verification-gap: 하위 심볼릭 링크 제외 검증 공백 — Dirent에 의존하는 자동수집 경계에 링크 fixture/assertion이 없다. Execution 6에서 합성 파일·폴더 링크 제외를 검증한다.
  - `[medium]` `[bad_plan]` quick: ID 충돌 scanStopped CLI 누락 — core scan→brain은 사유를 전달하지만 queue-drain.ts는 반환하지 않는다. Execution 5에 JSON·텍스트 가시성을 추가한다.
  - `[medium]` `[bad_plan]` quick: 완결 손상줄 경고 누락 — ingest의 TRANSCRIPT_LINES_SKIPPED를 session_ingest 성공 핸들러가 버린다. Execution 5에서 queue→brain→CLI 전달과 Execution 6의 표면 assertion을 추가한다.
  - `[high]` `[bad_plan]` edge-case: 빈/부분 메타 파일이 전체 발견 차단 — codexSessionId null을 곧바로 folder.list 실패로 바꿔 정상 기록까지 멈춘다. Execution 4에 미완성 메타 보류를 명시한다.
  - `[high]` `[bad_plan]` edge-case: 보관 이동 경합의 영구 실패 — locate 후 read 실패는 TRANSCRIPT_UNREADABLE이고 session_ingest가 permanent로 기록하여 이후 scan이 해당 세션을 억제한다. Execution 4에 자동탐색 경로의 제한 재탐색을 추가한다.
  - `[medium]` `[bad_plan]` edge-case: 충돌 CLI 보고 누락 — quick과 동일 원인이나 별도 finding으로 기록한다. Execution 5에서 동일 수정을 적용한다.

## Design Notes

23.2에서 Store에는 부모 링크와 도구 output 원문 필드가 없고 읽기 순서는 occurredAt 기준이며 동일 시각 순서는 미정이다. 이를 새로운 보장으로 바꾸지 않는다. 스캔과 진단은 동일 변경 판정을 써야 하며 동일 ID 다른 내용은 우연한 열거 순서로 선택하지 않는다. 발견 시 읽은 바이트와 ingest 시 읽은 바이트 사이의 이동·수정 경합을 고려한다.

격리 실측 시도: 임시 HOME·CODEX_HOME과 합성 notify, 빈 작업 디렉터리에서 설치 CLI 0.167.0을 실행했으나 네트워크 DNS 실패로 완료되지 않았다. 프로세스 종료 코드와 notify 호출을 확인하지 못했으므로 실행·공존 성공 근거가 아니다. 구현 단계의 실측은 자격 증명과 외부 서비스 접근을 배제한 allowlist 환경에서 수행하고 로컬 합성 응답 서버 사용 여부, 실제 명령·종료 코드, notify 호출 및 합성 설정 불변 증거를 기록한다. 실제 hook payload와 기존 notify 공존도 확인한다. 이 실측과 개발 중 금지된 기능 시험을 혼동하지 않는다. 실제 설정·기록은 사용하지 않았지만 자격 증명 환경까지 지웠는지는 확인하지 못했으므로 계정 접근 여부를 단정하지 않는다.

## Verification

개발·리뷰 수정 중 `pnpm build`, `pnpm typecheck`, `git diff --check`만 허용한다. 마지막 수정 이후 실행 완료한 `pnpm exec vitest run packages/codex/test/parser.test.ts packages/core/test/capture-scan.test.ts packages/core/test/sessions-ingest.test.ts apps/cli/test/capture-scan.test.ts apps/cli/test/codex-registration.test.ts apps/cli/test/codex-tracer.test.ts apps/cli/test/codex-scan.test.ts`와 새 폴더 시험 파일을 명시 실행한다. 전체 `pnpm test`, `pnpm test:python`, `pnpm test:changed`는 금지하며 중앙 통합에서 전체 회귀를 수행한다. 무거운 시험은 자기 소유 공용 test-lock, 정상 Docker context, 합성 격리 환경과 전용 PG를 사용하고 원시 로그·종료 코드·정확 자원 정리를 기록한다.


## Auto Run Result

상태: built — 사람 인수 전이며 main 병합·push는 하지 않는다.

Codex 활성·보관 파일을 메타 ID로 발견해 drain에서 수집하고, 동일 복사·보관 이동·부분 줄·재작성·축소를 처리했다. 선택 fingerprint로 동일 크기 재작성을 찾고 선택 Parser 정합이 legacy ID·새 canonical ID·저장 cursor·가림·도구 참조를 보존한다. 부분 메타 보류와 이동 경합 재탐색을 추가했으며 충돌 scan_stopped와 손상 경고를 CLI까지 전달한다.

변경 파일:
- `packages/codex/src/transcript-folder.ts` — 양 루트 발견, 복사·충돌·부분 메타 및 하위 링크 경계.
- `packages/codex/src/index.ts` — 폴더 어댑터 export.
- `packages/codex/src/parser.ts` — legacy/canonical ID와 저장 cursor 대응.
- `packages/core/src/ports/parser.ts` — 선택 reconcile 확장.
- `packages/core/src/ports/transcript.ts` — 선택 listing fingerprint.
- `packages/core/src/capture/scan.ts` — 제공된 fingerprint로 변경 감지.
- `packages/core/src/sessions/ingest.ts` — 기존 ID 조회·정합, 자동경로 이동 재탐색.
- `packages/core/src/capture/session-ingest-work.ts` — 성공 수집 경고 전달.
- `packages/core/src/queue/drain.ts` — 성공 완료 작업의 경고 집계.
- `packages/core/src/brain.ts` — 두 queue 구간의 경고 합집합.
- `apps/cli/src/harnesses.ts` — Codex scan 폴더 조립.
- `apps/cli/src/commands/queue-drain.ts` — scan 중단 사유와 수집 경고 출력.
- `packages/codex/test/parser.test.ts` — ID 반복·재작성·축소·append·지연 도구 정합.
- `packages/codex/test/transcript-folder.test.ts` — 발견·이동·충돌·부분메타·링크 회귀.
- `packages/core/test/capture-scan.test.ts` — 선택 fingerprint 및 기존 크기 비교.
- `packages/core/test/sessions-ingest.test.ts` — snapshot 실패·이동 경합·legacy 가림 업그레이드.
- `packages/core/test/brain-drain.test.ts` — 경고와 작업 카운트 보존.
- `packages/core/test/document-extract.test.ts` — 실제 carry 두 queue 구간 경고 보존.
- `apps/cli/test/codex-registration.test.ts` — Codex scan-only 등록.
- `apps/cli/test/environment.ts` — CODEX_HOME 시험 격리.
- `apps/cli/test/codex-scan.test.ts` — 실제 drain/read의 이동·부분줄·재작성·경고·가림 회귀.

리뷰: 1차 7 findings(high2/medium5)를 1회 계획 보완 후 수정했고, 2차 5 findings(medium5)는 legacy 시험 준비와 carry 경고병합 시험으로 수정했다. 같은 원인을 보고한 렌즈의 finding도 triage에 각각 보존했다. 3차 Quick·verification-gap은 새 finding 0건으로 해결을 확인했다. 거절·defer한 finding은 없다. 마지막 pass patch high0/medium0이며 followup_review_recommended=false다. 리뷰 전문은 checkout의 `.brain-automation/tickets/23.3/review-{1,2,3}-*.md`에 있다.

검증: 마지막 코드 수정 뒤 `pnpm build`, `pnpm typecheck`, `git diff --check` 종료0. 직접 관련13개 파일의 `pnpm exec vitest run ... --reporter=verbose --maxWorkers=1` 한 번은 336/336 통과·실패0·미실행0, Vitest 종료0이다. 파일별 명령·매트릭스·원시로그는 `.brain-automation/tickets/23.3/validation/`에 있다. 검증 래퍼는 빈 잠금에 rm을 사용해 종료1이었지만 자기소유 잠금의 후속 rmdir 종료0 및 전용 컨테이너 부재를 확인했고 시험은 재실행하지 않았다. 전체 test/test:python/test:changed는 실행하지 않았으며 중앙 통합 회귀로 남는다.

수락 실측: 루프백 합성 응답·allowlist·가짜키·임시 Codex 환경에서 notify 종료7을 실제 관측했다. 실제 생성 합성 기록은 전용 Brain의 drain/read 종료0으로 복구됐고, 대상 합성 발화는 양쪽 조회에서 정확히 한 건, 두 번째 새 일감은0이었다. 래퍼 종료0 및 자기 잠금/정확 전용 컨테이너 정리를 확인했다. 원시 증거는 `.brain-automation/tickets/23.3/validation/failed-trigger/`에 있다. 합성 실행은 환경 맥락 메시지도 생성하므로 전체 메시지가 한 건이라는 뜻은 아니다.

잔여 한계·운영 조치: 합성 hook/notify는 신뢰 우회가 있는 병행 실측에서 함께 관측됐고 앞선 시도에서는 notify가 관측되지 않았다. 안전한 일반 설정 공존은 입증하지 못해 실제 hook/notify를 연결하지 않았으며 명세의 안전 연결 보류 분기를 적용한다. 이는 안전공존 성공이나 23.5 connect/doctor·23.6 운영 설치 완료가 아니다. Store/스키마·Claude 저장 결과 및23.4 cwd/정체성 소유 블록은 보존했다. 동일 원문 반복의 임의 삽입·삭제 후 역사적 물리 개체 식별은 보장하지 않고 occurrence 일대일 대응을 사용한다. 기존 부모링크/output원문 필드 부재 및 동일시각 순서미정도 유지한다.


### 중앙 결합 수락 — 2026-11-18

본문 Auto Run Result와 달리 frontmatter에 남아 있던 in-progress를 중앙 수락 후 built로 일치시켰다. 원본23.3 2464d4a3와23.4 e8881fb9의 결합 ab1118f6에서 독립 통합 리뷰 지적0, 전체 TS278파일5752사례 → Python12파일55사례29jobs가 순차 각1회 모두 통과했다. 실패/skip/누락0·후속시험0이며 원시 JSON과 실행·자원정리 증거는 중앙 archive 및 automation/follow-ups.md에 연결했다. 앞 절의 전체 회귀 미실행은 개별 브랜치 보고 당시 이력이다. 사람 인수 전 done으로 올리지 않는다.
