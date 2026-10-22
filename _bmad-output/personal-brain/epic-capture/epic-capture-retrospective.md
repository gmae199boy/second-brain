---
epic: epic-capture
date: 2026-10-22
verdict: accepted-with-open-items
criteria: declared
headless: false
---

# 회고: epic 2 세션 수집과 비밀 가리기

## Epic summary

- 에픽: `epic-capture`(epic 2 세션 수집과 비밀 가리기). `tickets.py status`: 25/25 `built`(state `review`), `pending_tickets` 없음. 25개 모두 `built`에 머물러 있다 — 아직 아무도 done으로 부르지 않았다.
- 기준: 에픽 파일의 Done when 1~8(declared).
- 사용자가 무게를 둔 곳(2026-10-22): (A) epic 1 회고에서 넘겨받은 일이 실제로 됐는지, (B) 미룬 작업의 양과 다음 에픽으로 넘길 것.
- 범위: `2c09c22..65fa3f1`, 커밋 52개, 병합 0. 저장소 코드만(`_bmad`·`_bmad-output`·`.agents`·`.claude`·lockfile 제외) 237개 파일, +53,859 / −2,049. 스토리는 처음 15개로 나눴고(2026-10-16 인셉션) 진행 중 결정으로 25개가 됐다.

| 티켓 | 플랜 | 범위(baseline → 다음 baseline) | 커밋 |
| --- | --- | --- | --- |
| 2.1 | story-untitled-plan.md | 2c09c22..c94ab66 | 2 |
| 2.2 | story-tracer-stop-hook-brain-db-plan.md | c94ab66..488b3e3 | 3 |
| 2.16 | story-untitled-16-plan.md | 488b3e3..f17e69d | 1 |
| 2.3 | story-guide-schemaexit-codesshow-plan.md | f17e69d..93dac50 | 1 |
| 2.4 | story-untitled-4-plan.md | 93dac50..10a09d2 | 2 |
| 2.5 | story-bootstrap-shim-plan.md | 10a09d2..bb01bb4 | 2 |
| 2.6 | story-0004-plan.md | bb01bb4..106a12c | 1 |
| 2.7 | story-transcript-parser-plan.md | 106a12c..64e72ce | 1 |
| 2.8 | story-untitled-8-plan.md | 64e72ce..61b4596 | 1 |
| 2.9 | story-untitled-9-plan.md | 61b4596..a14eae4 | 11 (마스킹 B correct-course 문서 커밋이 섞임) |
| 2.10 | story-spool-db-plan.md | a14eae4..46c93ff | 1 |
| 2.11 | story-drain-plan.md | 46c93ff..db54e68 | 2 |
| 2.12 | story-spool-plan.md | db54e68..b901384 | 2 |
| 2.19 | story-parser-v3-peer-handback-plan.md | b901384..eedf8f2 | 2 |
| 2.17 | story-b-plan.md | eedf8f2..a689b91 | 2 |
| 2.18 | story-0005-plan.md | a689b91..2e64c6a | 5 (2.7 follow-up 리뷰·change-drop-message-seq 문서 커밋이 섞임) |
| 2.24 | story-seq-0006-plan.md | 2e64c6a..ea4d766 | 1 |
| 2.21 | story-start-source-transcript-plan.md | ea4d766..e68f75e | 1 |
| 2.22 | story-parser-plan.md | e68f75e..8285bd1 | 2 |
| 2.23 | story-parser-v4-plan.md | 8285bd1..24d1291 | 1 |
| 2.20 | story-untitled-20-plan.md | 24d1291..1cea083 | 1 |
| 2.13 | story-messages-redact-plan.md | 1cea083..2a3d950 | 1 |
| 2.14 | story-hook-plan.md | 2a3d950..a8fb528 | 4 (app-ref 커밋·사람 확인 기록·2.25 문서 포함) |
| 2.25 | story-untitled-25-plan.md | a8fb528..d7fa300 | 1 |
| 2.15 | story-refactor-sweep-plan.md | d7fa300..65fa3f1 | 1 (마지막 범위, HEAD까지 — 추정 아님: HEAD가 2.15 커밋) |

증거 목록:
- 있음: 에픽 파일(Requirements E2-1~12, Done when 1~8, Notes), 이니셔티브·spec·architecture·PRD, `tickets.toml` 엔트리 25개(파일로 꺼낸 스토리 없음), 플랜 25개와 시도 기록 1개(`story-start-source-transcript-plan-attempt-1.md`), 2.7 follow-up 리뷰, `deferred-work.md`, 이전 회고, 커밋, 이 기계의 실제 DB(읽기만).
- 없음: 세션 로그는 이 회고에 넘겨받지 않았다. 과정 분석은 플랜의 Triage Log·Plan Change Log와 에픽 Notes의 Decision으로 좁힌다.

## Findings

분석 방법: Orca orchestration으로 codex 워커 5개를 돌렸다 — A 구조 집계, B 스펙 대조와 이전 회고 이행, C 스토리 경계 코드 리뷰(`bmad-review` adversarial·edge-case·verification-gap 렌즈), D 미룬 작업 목록, E 동작 확인. 워커는 저장소를 고치지 않았다(종료 뒤 `git status`로 확인). 아래에서 ✔ 표시는 회고 작성자가 원본 코드를 다시 열어 확인한 것이다. 처분은 **지금 고침 / 미룸(대상) / 그대로 받아들임**이다.

### 1. epic 1 회고에서 넘겨받은 일 (사용자가 무게를 둔 곳 A)

거의 모두 착지했다. 자세한 줄은 아래 Previous-retro follow-through에 있다.

- Action 1~3·5·8·9와 Open questions 1~3은 증거와 함께 착지했다. 설치기 안정화(F1~F6·F11)는 2.4(`10a09d2`), node 하한(F7)은 2.5(`bb01bb4`), `setup connect`의 `inspectShim`(F8)은 2.14(`a8fb528`), pg 분리·오류 헬퍼·임시 home 공유(G2·G4)는 2.15(`65fa3f1`)다.
- Action 4(`deferred-work.md` 정리)는 epic 2 인셉션 때 한 번 했지만 그 뒤로 유지되지 않았다(아래 2절).
- Action 6(테스트·빌드 인프라 low 지적은 거절하지 말고 sweep으로)은 채택했다는 기록을 찾지 못했다(증거 없음).
- Action 7(F10)은 구현·README·2.4 플랜은 "묻지 않고 기본값을 기록"으로 맞췄지만 epic 1의 E1-5 문구는 그대로다.
- epic 2 Notes의 Carry 3건(import 때 SQLite 파일을 열지 않음, 설치기 설정 보존 2건, SQLite `SessionStore` 계약)도 모두 착지했다. 다만 import 시험은 "열린 파일 기술자가 없음"을 lsof로 보고 양성 대조를 둔 것이고, 잠깐 열었다 닫는 것까지 잡는 시험은 아니다(`packages/second_brain/test/import-side-effects.test.ts:72-176`).

### 2. 미룬 작업의 양 (사용자가 무게를 둔 곳 B)

`deferred-work.md`의 기록 82개(append 블록 31, Triage 행 49, 끝 bullet 2)를 같은 이슈끼리 합치면 53개다. 25개 플랜에만 있고 로그에는 없는 미룬 항목이 37개 더 있다(워커 D가 항목마다 현재 코드와 대조했고, 여기에는 집계와 결정이 필요한 것만 옮긴다. I번호는 `deferred-work.md` Triage의 행 번호, P번호는 플랜에만 있는 항목이다).

| 집합 | 전체 | 해결됐는데 목록에 남음 | 결정으로 닫힘 | 살아 있고 대상 제안 있음 | 살아 있고 대상 없음 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 로그(합친 이슈) | 53 | 23 | 8 | 16 | 6 |
| 플랜에만 있음 | 37 | 3 | 14 | 18 | 2 |
| 합계 | 90 | 26 | 22 | 34 | 8 |

- epic 1 회고 때는 14건이었다(해결 4, 대상 없음 7). 그 14건은 지금 해결 9, 살아 있음 5이고 5건 모두 대상을 정할 수 있다.
- 목록이 사실과 어긋난 곳: I59(Postgres 마이그레이션 오류 구분)는 `f92c51c`부터 해결인데 epic 7로 남아 있다. I63·I69·I71은 끝난 epic 2 스토리를 아직 가리킨다. I82·I103은 "보고를 읽는다"는 옛 해결 표시인데 23의 보고 미저장 Decision으로 대체됐다. I74(Postgres 스키마 뒤처짐)는 0006까지만 적혀 0007이 빠졌다. 새로 붙은 I50·I154·I155는 Triage 행이 없다.
- **이 에픽 안에서 처리하기로 했다가 빠진 것**: I104 "버전이 올라도 크기가 같은 파일은 스캔이 다시 큐에 넣지 않는다"는 `deferred-work.md:104`에 "2.14가 자연스러운 자리"로 적혔지만 2.14가 가져가지 않았다. 아래 C2가 그 결과다.

대상이 없는 8건(사용자 결정 필요):

| # | 항목 | 출처 |
| --- | --- | --- |
| N1 | `tooling/dev/auto-build.sh` 커밋(`10a09d2`)을 이력에서 뺄지 | `deferred-work.md:79,108` |
| N2 | 저장소 밖 무인 루프의 commit 대기 — 외부 도구 상태 미확인 | `deferred-work.md:80,111` |
| N3 | **실명 경로가 남은 백업 브랜치 `backup/pre-path-rewrite-2026-10-18`** — 공개 원격에 push하면 안 된다 | `deferred-work.md:96,123`, `git branch --list 'backup/*'` |
| N4 | TTY에서 `messages redact`를 대화형으로 확인할지(지금은 `--yes` 없으면 exit 3) | `deferred-work.md:93` |
| N5 | orca 워커 세션의 코디네이터 지시가 내 발화로 저장됨(B안: 워커 세션 표시) | `deferred-work.md:105` |
| N6 | `brain --version`의 의미(앱 버전·커밋·릴리스) | `deferred-work.md:154` |
| N7 | 개발 DB의 옛 `start_source` 다시 채우기 | `story-start-source-transcript-plan.md:182,236` |
| N8 | Amex 4-6-5 카드 형식을 패턴에 넣을지 | `story-untitled-9-plan.md:267` |

다음 인셉션이 흡수해야 할 것(워커 D 제안, 대상은 아직 티켓에 배정되지 않음):
- epic-attachments(10): I67 첨부 5개 테이블의 변경 규칙, I75 Core `Redaction`의 파일 대상 표현(`packages/core/src/domain/redaction.ts:19`에 `fileId` 없음 — 없으면 파일 가리기 구현이 막힌다), I104 전체 다시 읽기 경로(첨부 backfill도 같은 길이 필요), P19 줄어든 transcript 반복 enqueue(`story-spool-plan.md:208`), P34 가리기 뒤 파생물 연쇄(`story-messages-redact-plan.md:121,186`).
- epic-log-and-context(3): I60 `log_entry_edits`·`context_injections` 불변 trigger, I50 `TRANSCRIPT_UNREADABLE`·`SESSION_NOT_FOUND`를 코드 표에 넣을지(A16과 같음), I94 도구 메모 잘림 정보, I155 harness 등록부 주입 자리, P26 "첫 메시지 cwd" 문구 정리(`story-untitled-25-plan.md:214`, B2와 같음), N5의 결정.
- 두 에픽 공통: I95 앞으로의 읽기가 `sessionForOutput`을 거치게 하는 읽기 계약, I89 지속 출력물의 패턴 버전 도장 소유.

### 3. 스토리 경계 코드 리뷰 (워커 C)

| # | 발견 | 출처 | 처분 |
| --- | --- | --- | --- |
| C1 ✔ | 꼬리표 다시 판단(identity 일감)이 저장된 `first_cwd`보다 다시 읽은 transcript의 cwd를 앞세운다. 두 값이 다르면 `first_cwd`는 A로 남고 꼬리표는 B의 프로젝트로 정해지며, 꼬리표는 바뀌지 않으므로 고칠 길이 없다. 두 값이 갈리려면 transcript 앞부분이 바뀌어야 해서(CURSOR_RESET이 대비하는 경우) 자주 생기지는 않는다. 워커는 high로 매겼고, 회고는 발생 조건을 보고 medium으로 본다 | `packages/core/src/capture/session-identity-work.ts:55-63`(`cwd = parsed.startCwd ?? firstCwd(parsed.messages) ?? cwd`), `packages/sqlite/src/sessions.ts:274-285`(`coalesce(first_cwd, …)`). 워커가 실제 SQLite로 재현. 시험 공백: `packages/core/test/session-identity-work.test.ts:119-136`은 두 값이 다른 경우를 보지 않는다 | 그대로 받아들임(2026-10-22 재판단). 지금 두 값은 같은 규칙(`startCwd`, 없으면 첫 메시지 cwd)으로 같은 파일 앞부분에서 나오므로 갈릴 수 없다. 0007 전 세션은 `first_cwd`가 비어 transcript를 쓰는 것이 맞다. 갈리는 길은 transcript 앞부분이 바뀌거나 뒤 parser 버전이 `startCwd` 규칙을 바꾸는 경우뿐이고, 후자라면 새 규칙을 따르는 지금 동작이 오히려 맞다. 꼬리표 근거 규칙을 바꾸는 스토리가 생기면 그때 `first_cwd`와의 관계를 정한다 |
| C2 ✔ | parser 버전이 올라도 이미 닫힌 세션은 다시 읽지 않는다. 스캔은 파일 크기만 비교하고, 버전이 다를 때의 전체 다시 읽기는 `ingestSession`이 불렸을 때만 돈다. 새 parser가 살리는 메시지·도구 메모가 빠진 채 transcript 보관 기간(30일)이 지날 수 있다 | `packages/core/src/capture/scan.ts:41-49`, `packages/core/src/sessions/ingest.ts:283-288`. 이미 미룬 항목 I104(`deferred-work.md:104`, "미정") | 미룸 → epic-attachments 인셉션(첨부 backfill과 같은 경로). 다음 parser 버전 업 전에는 반드시 |
| C3 | 결과가 아직 없는 `Agent`·`Task` 호출의 도구 메모는 보류되는데, 커서가 그 호출을 지나가면 증분 읽기에서는 다시 나오지 않는다. parser 주석은 "다음 전체 다시 읽기 때 들어온다"고 약속하지만 C2 때문에 그 다시 읽기가 오지 않는다. 실측상 호출과 결과 사이에 메시지가 낀 경우는 517건 중 0건이라 드물다 | `packages/claude-code/src/parser.ts:843-869` 주석과 `resolveNotes`. parser v4가 받아들인 대가 (3)(`deferred-work.md:106`) | C2와 같이 — C2가 풀리면 약속이 지켜진다 |
| C4 ✔ | hook의 정상 수집이 그 세션의 이전 `session_ingest` 실패를 해소하지 않는다. 대기열·spool 경로는 성공 뒤 `resolveFailures`를 부르지만 `brain.sessions.ingest`는 바로 `ingestSession`을 부른다. 그 세션은 스캔에서 계속 빠지고(`leaveAlone`), `failures list`·doctor에 이미 회복된 실패가 남는다 | `packages/core/src/brain.ts:246-251`(spool 성공 뒤 해소) vs `:285`(`ingest: (input) => ingestSession(...)`), `packages/core/src/capture/scan.ts:150-171`. 워커가 Core+memory store로 재현 | 미룸 → 다음에 수집 경로를 고치는 스토리(epic-attachments의 C2 전체 다시 읽기 작업)에 함께 넣는다(2026-10-22 재판단). 수정은 성공 뒤 `resolveFailures` 한 번과 회귀 시험 하나로 작다. 하지만 이 기계 DB(사본, 읽기만)에서 `failures`는 지금까지 0행이고 스캔 일감 326개가 모두 첫 시도에 끝났다. 수집 실패를 기록하는 길은 스캔 일감과 spool뿐이라(hook 실패는 기록하지 않음) 이 상황에는 스캔 실패 뒤 같은 세션의 hook 성공이 겹쳐야 한다. 생겨도 hook은 매 턴 수집을 계속하고, doctor에 남은 실패는 `failures retry` 한 번으로 풀린다 |
| C5 | 스키마 3에서 같은 시각의 서로 다른 메시지에 걸친 chunk 두 개가 있으면 0006이 그 둘을 같은 `(from_at, to_at)`으로 바꾸다 UNIQUE에 걸려 업그레이드가 스키마 5에서 멈춘다(롤백되어 데이터는 보존) | `packages/sqlite/migrations/0006_drop_message_seq.sql:106,140-151`. 워커가 임시 DB로 재현. chunk를 쓰는 코드가 아직 없다(`0006:117-121`) | 그대로 받아들임 — chunk가 있는 설치가 없다. chunk writer를 만드는 에픽(epic-recall-and-mirror)이 같은 시각 범위 규칙을 정할 때 참고 |

워커가 확인했지만 결함을 찾지 못한 곳: 저장된 글이 밖으로 나가는 모든 현재 경로(엔벨로프, hook 출력, crash 줄, `failures`·`work_items`의 오류 문장, doctor)가 출력 코덱을 거친다. 0004~0007 정상 업그레이드는 FK·FTS·불변 trigger를 보존한다. plugin·bootstrap·shim과 설치기 사이에서 새 결함은 없었다.

### 4. 스펙 대조 (워커 B)

| # | 발견 | 출처 | 처분 |
| --- | --- | --- | --- |
| B1 ✔ | 이니셔티브의 Decision이 아직 "서브에이전트는 최종 보고만 수집한다"이다. 에픽·spec·PRD·architecture·parser v4는 보고를 넣지 않는다(2026-10-21 Decision) | `initiative-personal-brain.md:79` vs `epic-capture/epic-capture.md:160`, `packages/claude-code/src/parser.ts:675` | 스펙 맞춤 제안(Action 4) |
| B2 | E2-6과 관련 티켓 설명은 꼬리표 근거를 "cwd가 있는 첫 **메시지**의 cwd"라고 하지만, 2.25(`d7fa300`, 사용자 결정 B)부터 근거는 "세션이 시작된 폴더(`startCwd`: 서브에이전트가 아닌 첫 cwd 줄, 첨부 줄 포함), 없으면 첫 메시지 cwd"다. architecture와 README는 이미 맞췄다 | `epic-capture.md:45,156`, `tickets.toml`의 22·20·25 설명 vs `packages/claude-code/src/parser.ts:886-899`, `packages/core/src/sessions/ingest.ts:409` | 스펙 맞춤 제안(Action 4) |
| B3 | epic 1 E1-5에 "`[files] path`는 묻지 않고 기본값을 기록"이 없다(이전 회고 Action 7 미완) | `epic-foundation-and-install/epic-foundation-and-install.md:28` vs `apps/cli/src/install/flow.ts:410-413` | 스펙 맞춤 제안(Action 4) |
| B4 | 2.15 플랜은 Done when 3의 근거로 "capture-scan이 자식을 죽이고 스캔으로 회복"을 들지만 그 시험이 죽이는 것은 DB 잠금을 잡은 프로세스다. 수집 프로세스를 마지막 턴 도중 죽인 뒤 회복하는 자동 시험은 없다 | `story-refactor-sweep-plan.md:122` vs `apps/cli/test/capture-scan.test.ts:689-707` | 그대로 받아들임(기록만). 동작 확인 E가 transcript를 쓴 프로세스를 SIGKILL한 뒤 스캔으로 4개 메시지를 회복함을 따로 봤다 |
| B5 | Done when 4의 "DB 어디에도 남지 않는다"는 외부 WAL 읽기가 열려 있으면 커밋은 성공해도 WAL에 옛 바이트가 잠깐 남는다. README에는 이 예외가 있다 | `epic-capture.md:58`, `README.md:315-316`, `packages/sqlite/test/redact.test.ts:122`; 미룬 항목 I91 | 미룸 → epic-operations(WAL 정리 경로). 에픽 문구는 그대로 둔다 |

요구가 통째로 빠진 곳은 없다. E2-1~12는 모두 구현 위치와 시험이 있다(워커 B 표). 방향을 바꾼 세 곳 — 마스킹(2.9 → 2.17), 서브에이전트 보고(2.7·19·22 → 23), 메시지 번호(2.24) — 은 모두 대체 Decision이 에픽 Notes에 있고 런타임 코드에 옛 방향의 흔적이 없다. 남은 것은 Decision이 허용한 `messages.is_subagent_report` 칸(늘 0)과 forward migration이 입력으로 쓰는 옛 SQL뿐이다.

### 5. 구조 집계 (워커 A)

| # | 발견 | 출처 | 처분 |
| --- | --- | --- | --- |
| A1 | 계층은 지켜졌다. 패키지 의존 선언의 추가·삭제는 0이고, 실제 새 import 간선은 허용된 `claude-code → core` 하나다. 패키지 수준 순환 없음 | 두 revision의 `package.json` 비교, production import 추출, `packages/second_brain/test/boundaries.test.ts:25-59` | 그대로 |
| A2 | `boundaries.test.ts`는 manifest 선언만 본다. 실제 소스 import나 core의 Node API 사용, 상대 경로 우회는 잡지 못한다(지금 위반은 없음) | `boundaries.test.ts:15-59` | 미룸 → epic 3 |
| A12 | 여러 스토리가 한 파일에 계속 덧붙였다: store port 17개 스토리, `packages/sqlite/src/sessions.ts`·`packages/core/src/sessions/ingest.ts`·`apps/cli/src/dispatch.ts` 각 13개. `dispatch.ts` 1,163줄(명령 생성·메타 검증·의존성 조립·hook 격리·drain·렌더링), `sqlite/src/sessions.ts` 843줄(수집·꼬리표·커서·읽기·redact), `parser.ts` 1,079줄 | `ev-all.json`·스토리별 범위, 현재 줄 수 | 미룸 → 다음에 그 파일을 고치는 에픽(epic 3·10)이 경계별로 나눔. 지금 따로 리팩터하지 않음 |
| A6·A8 | 남은 작은 중복: SQLite `instant`·`at` 래퍼 두 벌(`sessions.ts:760-774`, `work.ts:585-599`), `capture-scan.test.ts`가 2.15의 `tempHomes()`를 쓰지 않음 | 해당 줄 | 미룸 → 다음 refactor sweep |
| A16 | `TRANSCRIPT_UNREADABLE`·`SESSION_NOT_FOUND`가 중앙 코드 표에 없어 exit 1·hint 없음으로 나간다 | `packages/core/src/codes.ts`, `envelope.ts:116-136`; 미룬 항목 I50 | 미룸 → epic 3 |
| A5·A10·A11 | 의미가 다른 오류 문자열 변형, bootstrap의 독립 버전 파서, `plugin/bootstrap.mjs`와 `tooling/bootstrap/bin/second-brain.js`(같은 빌드 산출물, 바이트 동일)는 의도된 것이다 | 2.15 플랜:38-39, `tooling/bootstrap/test/plugin.test.ts` | 그대로 |

## Behavior verification

빌드된 CLI(`65fa3f1`, 스키마 7)를 임시 home(`SECOND_BRAIN_HOME`·`CLAUDE_CONFIG_DIR` 모두 격리)에서 돌렸고, 이 기계의 실제 transcript와 DB는 읽기만 했다(워커 E, 2026-10-22).

- 설치: `setup run --yes --json` exit 0, 마이그레이션 0001~0007, doctor 16개 통과.
- Done when 2: 같은 transcript를 두 번 수집하면 49개 테이블 건수가 모두 같다. Stop 두 개를 동시에 돌려도 겹침 없음.
- Done when 3: 쓰기 잠금 중 수집 → `SPOOLED`, 잠금을 풀고 drain → `replayed: 1`. 스키마 버전을 8로 바꿔도 spool되고 되돌린 뒤 drain으로 채워진다. transcript를 쓰던 프로세스를 SIGKILL한 뒤 다음 drain의 스캔이 메시지 4개를 가져왔다. 시작 줄만 있는 transcript는 세션 행을 만들지 않는다. Claude Code 자체나 수집 트랜잭션 도중을 죽이는 실험은 하지 않았다.
- Done when 4: 가짜 AWS 키가 저장 본문에 원문으로 있고, 엔벨로프·hook·텍스트 코덱 출력 어디에도 없다. 비TTY에서 `messages redact --detected`는 exit 3, `CONFIRMATION_REQUIRED`, `error.retry`(`confirm: true`)·`retry_argv`가 왔다. `--yes`로 다시 하면 DB 본문과 `brain.db`·`-wal`·`-shm` 파일 바이트에서 그 키가 사라졌다.
- Done when 5: 가짜 remote를 단 임시 저장소의 두 워크트리 세션이 한 프로젝트로, 저장소 밖 세션은 프로젝트 없이 들어갔다. remote를 대문자로 바꿔도 프로젝트 하나. 지워진 형제 워크트리 폴더의 세션은 같은 프로젝트에 `tag_source: sibling`. Bitbucket, git 일시 실패 뒤 다시 채우기, 위 폴더 추정은 돌리지 않았다(시험이 있다).
- Done when 6: 플러그인 런처가 shim으로 인자·stdin을 넘겨 수집함을 확인했다. 실제 Claude Code의 hook 발화, `claude plugin update`, 첫 세션 경쟁은 이 회고에서 돌리지 않았다 — 2.14 사람 확인(`a80d91c`)이 실제 플러그인 설치·첫 수집·doctor 15/15를 기록했다.
- Done when 7: transcript를 줄여 compact를 흉내 내면 `CURSOR_RESET`과 새 메시지 0, 기존 본문이 같다. drain 두 개를 동시에 돌려도 일감은 한 번만 처리된다. 영구 오류는 한 번에 `failures`로 닫히고 `failures retry`는 새 일감을 만든다. 10회 재시도 종료는 돌리지 않았다(시험 `packages/core/test/queue-drain.test.ts:93`).
- Done when 8: `guide schema --json`이 11개 명령을 모두 낸다. doctor 줄과 `--help`가 한국어다.
- **실제 기계(Done when 1)**: 메인 transcript 284개, DB의 Claude Code 세션 290개, 양쪽에 있는 것 281개.
  - transcript에만 있는 3개 중 2개는 대화가 없는 파일이라 세션 행이 없는 것이 맞다.
  - 나머지 1개(`d3210dcd-…`, 메시지 2개)는 SDK로 연 세션이다(`entrypoint: sdk-cli`). hook이 없어 다음 drain의 스캔을 기다리는 상태로, 2.15가 기록한 "SDK 세션은 drain 한 번 뒤 들어온다"와 같다.
  - DB에만 있는 9개는 transcript가 지워진 세션이다(보존 기간).
  - **실제 DB는 스키마 6이다.** 플러그인 `app-ref`가 `01d3341`(2.14)을 가리켜 2.25의 0007이 이 기계에 아직 깔리지 않았다. 그래서 `tag_source` 분포와 2.25가 채운다고 잰 30/33은 이 기계 DB에서 다시 확인하지 못했다(2.25는 DB 사본으로 쟀다). 꼬리표 없는 세션은 39개다.

## Previous-retro follow-through

이전 회고: `../epic-foundation-and-install/epic-foundation-and-install-retrospective.md`.

| 항목(이전 회고 원문 요약, 담당) | 착지 | 근거 |
| --- | --- | --- |
| Action 1 — epic 2에 설치기 안정화 스토리(F1~F6), 사용자 → 인셉션 | 착지 | 2.4 `10a09d2`. `apps/cli/src/install/flow.ts:473-535`(store → owner → files → config 순서), `apps/cli/test/install-flow.test.ts:541,1093,1124,1163,1257,1290`, `install-store.test.ts:157` |
| Action 2 — 진입점 node 하한을 minor까지(F7), 사용자 | 착지 | 2.5 `bb01bb4`. `tooling/bootstrap/src/bootstrap.ts:100`(`24.16.0`), `tooling/bootstrap/test/bootstrap.test.ts:747,1175` |
| Action 3 — `setup connect`가 `inspectShim`을 쓰게(F8), 인셉션 | 착지 | 2.14 `a8fb528`. `apps/cli/src/commands/setup-connect.ts:61` |
| Action 4 — `deferred-work.md` 정리, 사용자 | 부분 착지 | 2026-10-16 인셉션 Triage가 처음 14건에 처분을 달았다(`deferred-work.md:53-74`). 그 뒤로 갱신되지 않아 해결됐는데 남은 항목 26개(Findings 2절) |
| Action 5 — 흐름 결과·실패 계약을 먼저 한 스토리로, 인셉션 | 착지 | `epic-capture.md:97`이 이 Action을 근거로 4를 5 앞에 뒀다. `story-untitled-4-plan.md:24-43` |
| Action 6 — 테스트·빌드 인프라 low 지적은 거절하지 말고 sweep으로, 사용자(`bmad-customize`) | 증거 없음 | 채택·기각 기록을 찾지 못했다. 2.15가 테스트 공백을 메운 것은 결과이지 리뷰 기준 변경의 증거가 아니다 |
| Action 7 — E1-5 `[files] path` 문구 또는 질문(F10), 사용자 | 부분 착지 | 구현·README(`README.md:120`)·2.4 플랜(:41)은 "묻지 않음". E1-5 문구는 그대로(B3) |
| Action 8 — epic 1 entry 3에 Superseded, `bmad-ticket` | 착지 | `epic-foundation-and-install/tickets.toml:27-36` |
| Action 9 — G2·G4 리팩터, epic 2 sweep | 착지 | 2.15 `65fa3f1`. `packages/second_brain/src/postgres.ts:1`, `packages/core/src/error-text.ts`, `apps/cli/test/temp-home.ts`, `import-side-effects.test.ts:220`. 의미가 다른 변형은 의도적으로 남김 |
| Open Q1 — F9 shim의 `SECOND_BRAIN_HOME` 우선 | 결정·착지 | `epic-capture.md:109`, `apps/cli/src/doctor/checks.ts:247-254`, `apps/cli/test/shim.test.ts:347` |
| Open Q2 — F11 설치 동의 단계 | 결정·착지 | `epic-capture.md:111`, `install-flow.test.ts:1202,1226,1240` |
| Open Q3 — F10 파일 저장소 위치 | 결정 착지, E1-5 문구 미정합 | Action 7과 같음 |
| (F12) `--version`·`--connect`·`Cancelled` 시험 공백 | 시험 착지, `--version` 기능은 미룸 | `apps/cli/test/dispatch.test.ts:1490`, `setup-run.test.ts`, `install.test.ts:314`. 기능은 N6 |

## Action items

모두 제안이고 자동으로 적용하지 않았다.

| # | 할 일 | 종류 | 담당 |
| --- | --- | --- | --- |
| 1 | C4 — `brain.sessions.ingest`가 성공하면 그 세션의 `session_ingest` 실패를 해소한다(대기열·spool 경로와 같게), 회귀 시험 하나. 따로 티켓을 만들지 않고 C2(전체 다시 읽기) 스토리에 넣는다. C1은 고치지 않는다(Findings 3절) | 고침(묶음) | epic 10 인셉션 |
| 2 | 릴리스: 2.25(0007)와 2.15가 든 커밋으로 플러그인 `app-ref`를 옮기고 `version`을 올린다(AGENTS.md 규칙). 이 기계에서 DB가 스키마 7이 되는 것과 `tag_source` 분포, 꼬리표 없는 세션 수(지금 39)가 줄어드는 것을 확인한다 — Done when 5 마지막 절의 실제 기계 확인 | 고침(배포) | 사용자 |
| 3 | `deferred-work.md` 정리: 해결됐는데 남은 26건에 해결 표시, 결정으로 닫힌 22건 정리, 살아 있는 34건의 대상 에픽 확정, 낡은 줄(I59·I63·I69·I71·I74·I82·I103) 고침, 새 줄(I50·I154·I155)에 Triage 행. append-only 원문은 두고 Triage 표를 갱신한다 | 과정 | 사용자 → `bmad-ticket` |
| 4 | 스펙 맞춤: B1(이니셔티브 Decision에 2026-10-21 대체 사실), B2(E2-6과 22·20·25 티켓 설명을 `startCwd` 기준으로, Notes의 옛 결정에는 대체 표시), B3(E1-5에 "묻지 않고 기본값 기록") | 스펙 맞춤 | 사용자 → `bmad-ticket` |
| 5 | epic-attachments 인셉션 입력: C2/I104 전체 다시 읽기 경로(다음 parser 버전 업 전에 반드시), I67, I75, P19, P34 | 미룸(인셉션 입력) | epic 10 인셉션 |
| 6 | epic-log-and-context 인셉션 입력: I60, I50/A16, I94, I155, A2, P26(=B2), N5 결정 | 미룸(인셉션 입력) | epic 3 인셉션 |
| 7 | 대상 없는 8건(N1~N8)의 결정. 특히 N3 실명 경로 백업 브랜치는 공개 원격에 push되기 전에 지울지 정한다 | 결정 | 사용자 |
| 8 | 과정 교훈: 미룬 항목을 "스토리 X가 자연스러운 자리"로 적으면 그 스토리가 가져가지 않는다(I104 → 2.14, C2의 원인). 특정 스토리에 넘길 때는 로그만이 아니라 그 티켓 엔트리(`description`·`verify`)에 넣는다 | 과정 | 사용자, 다음 인셉션부터 |
| 9 | 과정 교훈: Decision이 요구를 바꿀 때 architecture·README는 따라갔지만 이니셔티브와 에픽 Requirements·티켓 설명은 놓쳤다(B1·B2). 대체 Decision을 적는 커밋에서 같은 낱말을 이니셔티브·Requirements·`tickets.toml`에서 찾아 함께 고친다 | 과정 | 사용자 / 코디네이터 |
| 10 | 과정 교훈: `deferred-work.md`는 인셉션 때 한 번 정리하고 끝나서 해결됐는데 남은 항목이 26개로 늘었다. 에픽을 닫을 때(이 회고 같은 시점) Triage를 갱신하는 것을 닫기 단계에 넣는다 | 과정 | 사용자 |
| 11 | 이전 회고 Action 6(인프라 low 지적 처리)을 채택할지 기각할지 명시한다 | 결정 | 사용자 |

## Acceptance verdict

**accepted-with-open-items** (기준: declared, 에픽 Done when 1~8). 사람의 결정이 이 판정을 덮는다.

- 미완 티켓 0개, 25/25 `built`.
- 2.15가 Postgres를 포함한 전체 시험 74개 파일·2,322개를 통과시켰다(`story-refactor-sweep-plan.md` Auto Run Result).
- Done when 2·4·7·8은 시험과 이번 동작 확인으로 충족된다. 4의 "DB 어디에도"는 외부 WAL 읽기가 열린 동안의 예외가 있다(B5, README에 적혀 있음).
- Done when 1은 이 기계에서 충족된다. 대화가 있는 메인 transcript 중 DB에 없는 것은 다음 drain을 기다리는 SDK 세션 하나뿐이다.
- Done when 3은 잠금·스키마 불일치 spool과 drain 회복, transcript 쓰기 프로세스 강제 종료 뒤 스캔 회복으로 충족된다. 수집 트랜잭션 도중 강제 종료의 종단 시험은 없다(B4).
- Done when 5는 시험과 임시 home 확인으로 충족된다. `tag_source`가 이 기계 DB에 남는 것은 0007이 아직 배포되지 않아 확인하지 못했다(Action 2).
- Done when 6은 시험과 2.14 사람 확인(`a80d91c`)으로 충족된다.
- 막는 지적은 없다. C1은 지금 규칙에서 생길 수 없어 받아들였고, C4는 이 기계에서 한 번도 생기지 않았으며(`failures` 0행) 생겨도 hook 수집은 계속된다. C4는 Action 1로 C2와 함께 고친다. 마감이 있는 것은 C2(다음 parser 버전 업 전)다.

## Open questions

1. 판정을 받아들이고 epic 2를 닫을지(스토리 25개와 에픽을 `done`으로). 닫기는 `bmad-ticket`의 일이다.
2. (닫힘, 2026-10-22) C1·C4를 따로 고칠지 — 재판단으로 C1은 받아들이고 C4는 C2 스토리에 묶는다.
3. Action 2(릴리스)를 epic 10 시작 전에 할지. 하지 않으면 이 기계의 꼬리표 없는 세션 39개가 그대로 남는다.
4. N3 실명 경로 백업 브랜치를 지울지.

## 닫기 (2026-10-22)

사용자가 판정을 받아들이고 닫기를 승인했다. `bmad-ticket` 닫기 검사(codex 워커, 읽기만)는 "기록이 비어 닫기 불가"를 냈다 — 받아들인 예외가 Decision으로 없고, 넘긴 일이 받는 에픽 파일에 없고, 요구 문구가 옛 결정 그대로였다. 구현이 모자란다는 지적은 아니었다. 그래서 닫기 전에 다음을 적었다.

- 받아들인 예외(Done when 1의 모집단, 3의 강제 종료 범위, 4의 WAL 예외, C1·C5): `epic-capture.md` Notes Decision(2026-10-22).
- 넘긴 일(Action 1·5·6, B5, C5, I74, I95): 받는 에픽 Notes의 Carry(2026-10-22) — epic-attachments, epic-log-and-context, epic-operations, epic-recall-and-mirror, epic-replicas.
- 스펙 맞춤(Action 4): B1·B2는 이니셔티브 Decision과 E2-6, B3는 E1-5.
- `deferred-work.md` Triage(2026-10-22)(Action 3의 일부): 바뀐 처분과 대상 없는 6건. 26건 해결 표시 전체를 다시 쓰지는 않았다.
- Action 2: 플러그인 `app-ref` → `65fa3f1`, `version` 0.1.6(`3425095`). 이 기계의 스키마 7 적용과 `tag_source` 분포는 다음 세션 시작 뒤 확인한다.
- N3: 백업 브랜치 `backup/pre-path-rewrite-2026-10-18`를 지웠다(로컬에만 있었다).
- 남은 사용자 결정: N1·N2·N4·N6·N7·N8, Action 11.
