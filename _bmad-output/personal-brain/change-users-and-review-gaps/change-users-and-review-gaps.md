---
title: '사용자 테이블과 외부 리뷰 빈틈 보강'
type: sprint-change-proposal
created: '2026-10-16'
status: approved
approved: '2026-10-16'
scope: moderate
mode: batch
trigger: 'story 2.2 계획 중 사용자 결정(users 테이블), Gemini 외부 리뷰의 저장소 대조 결과(2026-10-16)'
inputs:
  - ../inputs/external-review-2026-10-16.md
  - ../tickets/epic-capture/tickets/story-tracer-stop-hook-brain-db-plan.md
---

# Sprint Change Proposal — 사용자 테이블과 외부 리뷰 빈틈

## 0. 체크리스트 상태

| 항목 | 상태 | 메모 |
| --- | --- | --- |
| 1.1 트리거 스토리 | [x] | story 2.2(tracer) 계획 중. `sessions.user_id`의 출처를 묻다가 users 테이블 결정이 나왔고, 같은 날 Gemini 리뷰 41건을 저장소와 대조했다 |
| 1.2 문제 정의 | [x] | 유형: 원래 요구의 오해(사용자 칸이 가리킬 대상 없이 생김) + 설계 보강(리뷰가 찾은 빈틈). 기술 한계나 실패한 접근은 아니다 |
| 1.3 근거 | [x] | `inputs/external-review-2026-10-16.md`(판정·근거 줄 번호) |
| 2.1 현재 에픽 | [x] | epic 2는 그대로 완료할 수 있다. 2.2·2.5·2.6·2.7·2.10·2.11·2.12 티켓의 문구가 바뀐다 |
| 2.2 에픽 변경 | [x] | §4.1 |
| 2.3 이후 에픽 | [x] | epic 3·4·5·7·8·9·10의 Notes에 항목을 건다(인셉션 입력). epic 7·8의 `after` |
| 2.4 새 에픽 | [N/A] | 없다 |
| 2.5 순서 | [x] | 순서는 그대로 1→2→10→3→4→5→9→7→8→6. epic 7·8의 `after`에 9를 더해 표 순서를 의존으로도 고정한다(D2) |
| 3.1 PRD | [x] | §4.3. FR은 바뀌지 않는다. FR-17·FR-24·NFR-9·§6.2 문구 |
| 3.2 Architecture | [x] | §4.2 |
| 3.3 UX | [N/A] | UX 문서 없음 |
| 3.4 기타 산출물 | [x] | addendum, change 문서 두 개, weknora-patterns, deferred-work, 2.2 계획(§2.3) |
| 4.1 직접 조정 | [x] Viable | 노력 낮음~중, 위험 낮음. 문서와 티켓 문구만 바뀐다. 코드는 2.2가 처음 쓴다 |
| 4.2 되돌리기 | [x] Not viable | 되돌릴 구현이 없다. 2.1은 영향 없음 |
| 4.3 MVP 축소 | [x] Not viable | MVP 범위는 그대로다 |
| 4.4 선택 | [x] | Option 1 직접 조정 |
| 5.x 제안 구성 | [x] | §1~§5 |
| 6.3 승인 | [x] | §6 |
| 6.4 핸드오프 | [x] | §5 |

## 1. Issue Summary

**users.** `sessions.user_id`는 2026-10-08 팀 공유 대비로 넣은 칸이다(spine `.memlog.md` 49·52행). 요구사항은 없다. FR-3의 확인 조건에 사용자가 없다. 마이그레이션 0001은 `text not null` 칸만 만들었고, 가리킬 테이블도 값의 출처도 없다. story 2.2가 첫 세션 행을 쓰게 되면서 문제가 드러났다. 사용자 결정(2026-10-16)은 이렇다.
- `users` 테이블을 둔다. `sessions.user_id`가 FK로 그 테이블을 가리킨다.
- "나" 행은 `setup run`이 만든다.
- 정체성은 DB와 함께 옮겨진다.
- ID는 UUIDv7을 유지한다.

**리뷰 빈틈.** Gemini가 `bmad-review`로 기획 문서와 마이그레이션을 검토했다. 그 주장 41건을 저장소와 대조했고, 결과는 `inputs/external-review-2026-10-16.md`에 있다.
- 맡은 곳 없이 실제로 비어 있는 것이 10건이다:
  - 브랜치 저장 칸
  - epic 7·8의 `after`
  - `.claiming` 회수
  - 추출 도중 죽은 세대
  - 실패한 세대의 조각
  - `files.redact`의 이름·EXIF
  - Drive 복제본의 가린 비밀
  - 문서 조각 넓히기
  - 데몬 버전 불일치
  - ER 다이어그램
- 정의 보강이 필요한 것이 약 10건이다.
- 나머지는 이미 다른 곳에서 다루거나, 틀렸거나, 문체 문제다.

## 2. Impact Analysis

### 2.1 에픽

| 에픽 | 상태 | 영향 |
| --- | --- | --- |
| 1 기반 | 완료 | 없음 |
| 2 수집 | 2.1 built, 2.2 계획 draft | 2.2에 `users`(마이그레이션 0003)가 들어간다. 2.6은 0004·버전 4가 되고 `messages.git_branch`가 더해진다. 2.5·2.7·2.10·2.11·2.12의 문구가 보강된다. Description의 "CLI 규약 보강(스토리 하나)"를 "스토리 1·3"으로 고친다 |
| 10 첨부 | envelope | Notes: S9(죽은 세대 정리), S10(실패 세대 조각 정리), S13(가리기에 이름·EXIF), S12(`page` 사본 비교) |
| 3 로그·맥락 | envelope | Notes: D6(규칙이 hook 상한을 넘을 때), S2(대조 대기 규칙의 출처 메시지) |
| 4 조회·미러 | envelope | Notes: T4(문서 조각 넓히기), D7(첫 요청 문장은 꺼내 쓴다), T9(파일명 정제·충돌 접미사) |
| 5 운영 | envelope | Notes: S5(순환 FK 복구 순서), T10(복구 확인 기준에 파일), DB 합치기(들어오는 "나"를 받는 쪽 "나"로) |
| 9 데몬 | envelope | Notes: D3(판단 기준과 `daemon start`), D4(버전 불일치) |
| 7 복제 | envelope | `after`에 9(D2). Notes: D5(복제본 가리기) |
| 8 Drive | envelope | `after`에 9(D2). Notes: D5(Drive 파일·스냅샷 가리기) |
| 6 임베딩 | envelope | 없음 |

### 2.2 문서

- **Architecture spine:** AD-5·6·7·9·10·11·12·14·16·17·19·21·23·24·25·26·27, Table Contract(`users` 행), ER 다이어그램, Conventions(`USER_MISSING`, 복구 순서), Deferred 두 행
- **PRD:** FR-17, FR-24, NFR-9, §6.2 팀 공유 행
- **spec:** CAP-12 success
- **addendum §2:** 옛 Postgres 스케치에 역사 기록 표시
- **change 문서 두 개:** "반영 완료 기록" 안내
- **inputs/weknora-patterns.md §1.1:** 제목에 분할 사실

### 2.3 기술·기타 산출물

- **2.2 계획(draft):**
  - 고정 영역의 결정 두 개는 그대로다.
  - 이 change가 문서를 고치므로, "deferred에 문서 갱신을 적는" 작업 중 문서 항목은 빠진다. 남는 것은 epic 5·7 항목뿐이고, 그것도 이 change의 Notes로 간다.
  - Code Map의 마이그레이션 번호와 `USER_MISSING` 출처(Conventions)는 다시 이어받을 때 맞춘다.
- **deferred-work.md:** 2.1이 남긴 `DB_UNAVAILABLE` exit 1/2 항목에 Triage 행이 없다(R7). 처분은 2.10, 쓰기 가드를 spool로 바꿀 때다.
- **코드:** 이 change로는 바뀌지 않는다. 2.2가 처음 구현한다.

## 3. Recommended Approach

**Option 1 직접 조정.** 요구는 그대로이고 문서와 티켓만 바뀐다. 노력은 낮음~중이다(spine 문단 약 20곳, 티켓 7개, 에픽 Notes 7개). 위험은 낮다. 아직 코드가 없는 영역이고, 2.2보다 먼저 반영하면 2.2는 승인된 문서를 근거로 짓는다. 일정에 주는 영향은 문서 작업 한 세션이다.

### 정할 것 (D1~D8). 권고는 굵게.

| # | 질문 | 선택지 | 권고와 이유 |
| --- | --- | --- | --- |
| D0 | 사용자 정체성 | (확정, 사용자 2026-10-16) | `users` 테이블(`id` UUIDv7, `name`=OS 사용자 이름, `is_self` 1인 행 하나, `created_at`), `sessions.user_id` FK. "나" 행은 `setup run`이 마이그레이션 직후 찾거나 만든다. 없으면 수집은 `USER_MISSING`(exit 2). DB 합치기는 epic 5 |
| D1 | 브랜치를 어디에 둘까 (S1) | (a) `messages.git_branch` (b) `sessions.git_branch` (c) `worktrees.branch` | **(a)**. FR-3은 "임의의 메시지에 대해" 브랜치를 묻는다. transcript는 줄마다 `gitBranch`를 갖고, 한 세션 안에서 브랜치가 바뀔 수 있다. (b)는 첫 브랜치만 남고, (c)는 같은 폴더에서 브랜치를 바꾸면 틀린다. 2.6의 0004가 칸을 더하고(불변 trigger 포함), 2.7 parser가 채운다. 브랜치는 꼬리표가 아니라 추적 정보다 |
| D2 | epic 7·8의 `after` (T1) | (a) 둘 다 `after`에 9를 더함 (b) epic 8의 Done when에서 "데몬 켜짐·꺼짐 둘 다"를 뺌 | **(a)**. 표 순서상 8은 이미 9 뒤라 늦어지지 않는다. 두 Done when을 검증하려면 데몬이 있어야 한다. initiative Notes의 "epic 8이 9를 기다리지 않게"는 "Drive 동기화 경로는 데몬과 무관하다"로 고친다 |
| D3 | "데몬이 켜져 있으면"의 기준, 다시 켜는 법 (T7) | (a) 기준은 살아 있는 소켓(handshake 응답)이고 `daemon start`를 더함 (b) 기준은 설정 `[daemon] enabled`이고 다시 켜기는 `setup run` | **(a)**. 설정 기준이면 `daemon stop` 동안 기회적 drain까지 꺼진다. 소켓 기준이면 정지 중에는 CLI가 drain을 돈다. `daemon start`는 KeepAlive Label을 다시 올린다 |
| D4 | handshake 버전 불일치 (T11) | (a) 데몬은 자기 빌드가 `installed.json`의 `commit`과 다를 때만 종료하고, 옛 클라이언트에는 `VERSION_MISMATCH`만 답한다 (b) 지금처럼 늘 종료 | **(a)**. (b)는 오래 떠 있는 옛 클라이언트(업그레이드 전의 `mcp serve` 등) 하나가 데몬을 재시작 루프에 넣는다 |
| D5 | 가리기가 복제 대상에도 미치는가 (T14) | (a) 가리기 연쇄에 복제 대상 전파 일감을 더한다(Postgres는 같은 가리기 함수, Drive 파일은 그 메시지가 든 파일을 다시 쓰고 옛 파일 삭제, 가리기 이전 DB 스냅샷은 새 스냅샷이 검증된 뒤 삭제). 끝날 때까지 doctor `warn` (b) 복제 대상은 가리기 범위 밖이라고 문서에 적는다 | **(a)**. FR-26·CAP-2는 "어디에도 남지 않는다"이고 slice 1 밖의 복제도 그 약속 아래에 둔다. 세부(파일 단위, 스냅샷 보관 수)는 epic 7·8 인셉션 몫이고, 이 change는 원칙과 계약 테스트 문장만 넣는다. Drive 파일은 "평소 append-only, 가리기만 다시 쓰기"가 된다 |
| D6 | 규칙만으로 hook 상한(10,000자)을 넘으면 (T5) | (a) 머리말과 세션 토큰 줄은 항상 넣고, 규칙은 현재 프로젝트 규칙 → 어디서나 규칙, 각각 최신 순으로 상한까지 넣는다. 못 넣은 규칙은 "규칙 N개 생략 — `brain log list --kind rule`" 한 줄로 알리고 doctor `fail`. 최근 로그는 남는 자리만 (b) 상한을 넘으면 규칙 부분을 통째로 파일 경로로 바꾼다 | **(a)**. 넘으면 Claude Code가 출력 전체를 파일 경로와 2,000자 미리보기로 바꿔서, 세션 토큰까지 사라진다. FR-17의 "규칙은 전부 들어간다"는 hook 상한 안에서만 지킬 수 있다. 경고선(1,000자) 경고는 그대로 둔다 |
| D7 | 로그 없는 세션의 첫 요청 문장 (S3) | (a) seq가 가장 낮은 user 메시지에서 꺼낸다 (b) `sessions.first_prompt`에 저장 | **(a)**. 메시지는 불변이고 parser가 메타 항목을 거른다. 저장하면 `messages.redact`가 가려야 할 곳이 하나 더 생긴다 |
| D8 | spool 레코드가 계속 실패하거나 drain이 도중에 죽으면 (T12·T13) | (a) `.claiming` 이름에 청구한 pid를 넣는다. pid가 죽었거나 청구 뒤 10분이 지나면 다음 drain이 `.jsonl`로 되돌린다. 한 레코드가 10번 실패하면 `failures`에 남기고, 그 줄은 `spool/failed/`의 파일로 옮겨 지우지 않는다. doctor가 건수를 보인다 (b) 10번 실패하면 버린다 | **(a)**. 작업 로그·주입 기록은 transcript처럼 다시 읽을 원본이 디스크에 없다. 잠금 회수와 같은 규칙(pid 생존 + 상한 시간)을 쓴다 |

## 4. Detailed Change Proposals

### 4.1 에픽·스토리 (적용: `bmad-ticket`)

#### initiative `tickets.toml` (D2)

```
OLD: id = 7 … after = [{ epic = 5, needs = "내보내기 형식과 운영 명령(복제·이전의 검증 기준)" }]
NEW: after = [{ epic = 5, needs = "…(그대로)" }, { epic = 9, needs = "데몬 런타임(Done when의 데몬 켜짐·꺼짐 두 상태 검증), setup run·doctor·설정 코덱의 선택 단계" }]

OLD: id = 8 … after = [{ epic = 10, … }, { epic = 4, … }, { epic = 5, … }]
NEW: 같은 목록 + { epic = 9, needs = "데몬 런타임(Done when의 데몬 켜짐·꺼짐 두 상태 검증)" }
```

에픽 파일 frontmatter `after`(`epic-replicas.md:6`, `epic-drive.md:6`)에도 `epic-daemon`을 더한다.

#### initiative-personal-brain.md

- **Done when 4** (T10)
  - OLD: 내보내기에서 되살린 Brain의 메시지 수와 작업 로그 수가 원래와 같다.
  - NEW: 내보내기에서 되살린 Brain의 메시지·작업 로그·파일·문서 추출 세대 수가 원래와 같고, Brain이 보관한 원본 파일을 다시 열 수 있다.
- **Notes** (R6)
  - 2026-10-08 "설치 진입점은 `npx github:…`"에 표시를 단다: "(2026-10-15 플러그인이 Claude Code 진입점, npx는 대체 경로로 바뀜)"
  - 2026-10-08 "경계·순서는 초안대로"에 표시를 단다: "(순서는 2026-10-15에 바뀜: epic 10 추가, 9를 7 앞에)"
- **Notes** (D2)
  - OLD: "…(epic 8이 9를 기다리지 않게)."
  - NEW: "…Drive 동기화는 데몬과 무관하게 같은 경로다. 다만 epic 7·8의 Done when이 데몬 켜짐·꺼짐 둘 다를 요구하므로 둘 다 `after`에 9를 둔다(2026-10-16, change-users-and-review-gaps D2)."
- **Notes 추가:** "Decision(2026-10-16, `change-users-and-review-gaps/`): `users` 테이블과 리뷰 빈틈 보강. D0~D8(사용자)."

#### epic-capture (epic 2)

- **epic-capture.md**
  - Description 21행 (R1)
    - OLD: "CLI 규약 보강(스토리 하나, 앞쪽)"
    - NEW: "CLI 규약 보강(스토리 1·3으로 나눔, 2026-10-16 인셉션)"
  - Requirements E2-5에 "`users`(D0)"를 더한다.
  - E2-9 OLD: "마이그레이션 0003" → NEW: "마이그레이션 0004(0003은 2.2의 `users`)", 그리고 "`messages.git_branch`"를 더한다.
  - Notes에 이 change의 결정 한 줄을 더한다.
- **2.2** (D0)
  - description 끝에 더한다: "; 사용자 정체성: 마이그레이션 0003이 `users`(`id` UUIDv7, `name`, `is_self` 1인 행 하나, `created_at`)와 `sessions.user_id` FK(`sessions` 재생성)를 더하고 `SQLITE_SCHEMA_VERSION`을 3으로 올린다. `setup run`은 마이그레이션 직후 '나' 행을 찾거나 만들고, 수집은 그 id를 쓰며, '나'가 없으면 `USER_MISSING`이다"
  - verify에 더한다: "`setup run`을 두 번 돌려도 `users`에 '나' 한 행이고 세션의 `user_id`가 그 id다"
- **2.5** (T2·T3)
  - description에 더한다: "런처가 하한 이상의 node를 찾지 못하면 아무것도 하지 않고 stdout에 `systemMessage` 한 줄(node를 찾은 위치와 하한)을 낸다; 설치 잠금의 stale 판정은 pid 프로세스 생존(`kill -0`) 또는 30분 경과다"
  - verify에 더한다: "node가 없는 PATH로 첫 세션을 열면 `systemMessage` 한 줄이 남는다"
- **2.6** (D1, S7)
  - title OLD: "마이그레이션 0003: …" → NEW: "마이그레이션 0004: …"
  - description: "SQLite 세 번째 마이그레이션" → "네 번째 마이그레이션(0003은 2.2의 `users`)", "`SQLITE_SCHEMA_VERSION`을 3으로" → "4로"
  - description에 더한다: "`messages.git_branch`(nullable, 불변 trigger가 막음)"
  - description에 더한다: "`redactions`의 nullable 전환은 0002 `index_configs`와 같은 재생성으로"
  - verify: "버전 2 DB가 … 3이 되고" → "버전 3 DB가 … 4가 되고"
- **2.7** (D1, T15)
  - description의 추적 정보에 "메시지마다 `gitBranch`(줄의 값 그대로)"를 더한다.
  - description에 더한다: "서브에이전트 최종 보고를 서브에이전트 파일에서 읽는다면 그 경로 규칙을 2.12의 스캔 범위와 맞춘다"
- **2.10** (D8)
  - description에 더한다: "`.claiming` 이름에 청구한 pid를 넣고, pid가 죽었거나 청구 뒤 10분이 지난 파일은 다음 drain이 `.jsonl`로 되돌린다; 한 레코드가 10번 실패하면 `failures`에 남기고 그 줄을 `spool/failed/`로 옮겨 지우지 않으며 doctor가 건수를 보인다"
  - verify에 더한다: "청구한 프로세스를 죽이면 다음 drain이 그 파일을 다시 집는다"
- **2.11** (S11, S8, S4 주의)
  - description에 더한다: "10번 실패한 일감은 `failures` 기록과 같은 트랜잭션에서 `completed_at`을 채워 닫고(같은 대상의 다음 일감은 새 행), 성공과 구분하는 칸이 필요하면 이 스토리가 정한다; 청구 질의(due 조건 + `attempts ASC, id ASC`)를 덮는 인덱스로 `work_items_due_idx`를 바꾼다"
  - Notes에 더한다: "세션 없는 실패의 키를 nullable로 고르면 `failures` 재생성이 또 필요하다. 고정 키(예: `harness`=대상 종류, `harness_session_id`=대상 id)는 스키마 변경이 없다"
- **2.12** (T15)
  - description에 더한다: "스캔 대상은 각 프로젝트 폴더 바로 아래의 `<session-id>.jsonl`뿐이고 `subagents/`·`tool-results/`는 세션으로 보지 않는다"
  - verify에 더한다: "fixture의 `subagents/` 파일이 세션 수에 들어가지 않는다"

#### 이후 에픽 Notes (인셉션 입력, 원문은 `inputs/external-review-2026-10-16.md`)

| 에픽 파일 | 더할 Note |
| --- | --- |
| `epic-attachments.md` | S9: 청구 만료된 추출 일감의 열린 세대(`finished_at` null)는 다음 청구가 `failed`로 닫고 새 `attempt`를 만든다. S10: 실패한 세대의 조각·FTS는 그 실패를 기록하는 트랜잭션(또는 정리 일감)이 지운다. S13: `files.redact` 연쇄에 `file_names`·이름 FTS·`file_metadata` 삭제를 넣고, 재생성은 가린 파일을 건너뛴다. S12: pdf가 아니면 `page`는 null이다. 비교는 null까지 같아야 한다(TS에서 undefined와 null 구분) |
| `epic-log-and-context.md` | D6: 시작 맥락 예산 순서(머리말·토큰 > 규칙 > 최근 로그), 규칙 생략 한 줄과 doctor `fail`. S2: 대조 대기(`pending`) 규칙의 출처 메시지를 기록할 자리(지정된 경우) |
| `epic-recall-and-mirror.md` | T4: 문서 조각의 앞뒤를 읽는 길(`recall expand`가 `document_chunk`도 받거나 `files` 동사). D7: 첫 요청 문장은 꺼내 쓴다. T9: 파일명 정제(C9)와 " (2)" 충돌 접미사가 AD-16의 "순수 함수"와 어울리게 |
| `epic-operations.md` | S5: 복구 순서(`files` 포인터를 비우고 넣은 뒤 위치, 그다음 포인터). T10: 복구 확인에 파일·위치·메타데이터·Brain 원본. D0: 내보내기에 `users`. 가져오기가 기존 DB에 합치기도 지원하면 들어오는 "나" id를 받는 쪽 "나"로 바꾸고, 파생물을 다시 만들고, 먼저 스키마 버전을 맞추고, `users.name` 갱신 여부를 정한다 |
| `epic-daemon.md` | D3: 판단 기준은 살아 있는 소켓, `daemon start`. D4: 자기 빌드가 낡았을 때만 종료 |
| `epic-replicas.md` | D5: Postgres 가리기 전파(Postgres `tool_notes` trigger deferred와 함께). D2: `after` 9 |
| `epic-drive.md` | D5: Drive 파일은 가리기 때만 다시 쓰기, 가리기 이전 스냅샷 삭제. D2: `after` 9 |

#### deferred-work.md Triage (R7)

| 항목 | 처분 |
| --- | --- |
| 쓰기 가드의 `DB_UNAVAILABLE` exit 1 vs 표 2 (2.1) | epic 2 story 10(쓰기 가드를 spool로 바꿀 때 함께 정한다) |

### 4.2 Architecture spine (적용: 승인 뒤 이 세션에서 직접. 문구가 정해져 있다)

**AD-5 표**
- OLD: `| \`daemon\` | \`run\`, \`status\`, \`stop\` | 상주 런타임 (AD-27, epic 9) |`
- NEW: `| \`daemon\` | \`run\`, \`start\`, \`status\`, \`stop\` | 상주 런타임 (AD-27, epic 9) |` (D3)

**AD-6 시퀀스** (R4)
- `participant PG as brain.db (SQLite)` → `participant DB as brain.db (SQLite)`
- `B->>PG` → `B->>DB`

**AD-7** (D3)
- OLD: "데몬이 켜져 있으면 어떤 명령도 돌지 않으며(AD-27)"
- NEW: "데몬이 살아 있으면(소켓 handshake가 응답하면. 설정 `[daemon] enabled`가 기준이 아니다) 어떤 명령도 돌지 않으며(AD-27)"

**AD-9** (D8): "drain은 파일을 `*.claiming`으로 rename한 뒤 재주입하고, 성공하면 지운다." 뒤에 더한다.

> `*.claiming` 이름에는 청구한 프로세스의 pid를 넣는다. 그 프로세스가 살아 있지 않거나 청구 뒤 10분이 지난 파일은 다음 drain이 `*.jsonl`로 되돌린다. 한 레코드의 재주입이 10번 실패하면 `failures`에 남기고, 그 줄을 `spool/failed/`의 파일로 옮겨 지우지 않는다(작업 로그·주입 기록은 다시 읽을 원본이 없다). doctor가 그 건수를 보인다.

**AD-10** (D5)
- OLD: "**복제 대상**(Postgres, Drive의 기계별 append-only 파일)은 원본을 커서로 따라온다(epic 7, slice 1 범위 밖)."
- NEW: "**복제 대상**(Postgres, Drive의 기계별 append-only 파일. 가리기만 예외로 그 파일을 다시 쓴다, AD-11)은 원본을 커서로 따라온다(epic 7, slice 1 범위 밖)."

**AD-11** (D5, S14)
- 연쇄 문장 OLD: "…+ 조각 재생성·미러 재생성 일감(AD-21)."
- 연쇄 문장 NEW: "…+ 조각 재생성·미러 재생성 일감 + 복제 대상이 있으면 복제 가리기 일감(AD-21·22: Postgres는 같은 가리기 함수, Drive는 그 메시지가 든 파일을 가린 본문으로 다시 쓰고 옛 파일을 지움, 가리기 이전의 DB 스냅샷은 새 스냅샷이 검증된 뒤 지움). 복제 가리기가 끝날 때까지 doctor는 `warn`이다."
- 계약 테스트 문장의 "조각·도구 메모·검색·미러·내보내기"에 "·복제 대상"을 더한다.
- 문장 하나를 더한다: "`redactions`의 위치 `[start, end)`는 그 가리기 직전 본문 위의 구간이다(저장 전 마스킹이면 마스킹 전 원문, story 1.3)."

**AD-12** (D0, D1)
- OLD: "세션에는 사용자 식별자(설정값)와 기계 이름이 있다. slice 1에서 사용자는 항상 나다."
- NEW:
  > 세션은 사용자(`users` 행)와 기계 이름을 가진다. slice 1의 사용자는 "나"(`is_self = 1`) 한 행이다. 그 행은 `setup run`이 마이그레이션 직후 찾거나 만든다(`id`는 UUIDv7, `name`은 OS 사용자 이름이고 표시용이다). 수집은 그 id를 `sessions.user_id`(FK)에 넣고, "나" 행이 없으면 쓰지 않고 `USER_MISSING`(exit 2)으로 답한다. 정체성은 DB와 함께 옮겨진다. 두 DB를 합치는 가져오기는 들어오는 "나"를 받는 쪽 "나"로 바꾼다(epic 5). 2026-10-16 사용자 결정.
- 더한다: "브랜치는 꼬리표가 아니라 메시지의 추적 정보다(`messages.git_branch`, transcript 줄의 값 그대로, 불변)."

**AD-14** (D7): 둘째 항목 뒤에 더한다.

> 로그가 없는 세션의 첫 요청 문장은 seq가 가장 낮은 user 메시지에서 꺼낸다. 따로 저장하지 않는다(가리기가 한 곳에서 끝나게).

**AD-16** (T9): 파일 이름 문장 뒤에 더한다.

> `<project>`는 프로젝트 정체성에서 제어문자와 `<>:"/\|?*`를 `_`로 바꾼 것이다(WeKnora C9). 충돌 처리는 epic 4가 정한다.

**AD-17** (D6)
- OLD: "크기는 **글자 수**로 잰다(토크나이저 없음). 최근 로그 부분과 규칙 경고선은 설정값이고, 전체는 hook 상한 10,000자 안이다. 최근 로그는 오래된 줄부터 빼고, 규칙은 전부 넣되 경고선을 넘으면 점검에 경고한다."
- NEW:
  > 크기는 **글자 수**로 잰다(토크나이저 없음). 최근 로그 부분과 규칙 경고선은 설정값이고, 전체는 hook 상한 10,000자 안이다. 넘으면 Claude Code가 출력을 파일 경로와 미리보기로 바꿔 세션 토큰까지 잃기 때문이다. 자리는 고정 머리말(세션 토큰 줄 포함) → 규칙 → 최근 로그 → 안내 요약 순서로 채운다. 규칙은 경고선을 넘어도 전부 넣고 점검에 경고한다. 규칙만으로 상한을 넘으면 현재 프로젝트 규칙 → 어디서나 규칙, 각각 최신 순으로 상한까지 넣는다. 넣지 못한 수는 "규칙 N개 생략 — `brain log list --kind rule`" 한 줄로 알리고 doctor는 `fail`이다. 최근 로그는 남은 자리에서 오래된 줄부터 뺀다.

**AD-19** (T3, T2)
- OLD: "pid가 없거나 시작 시각이 30분을 넘으면 stale로 보고 회수"
- NEW: "그 pid의 프로세스가 살아 있지 않거나(`kill -0`) 시작 시각이 30분을 넘으면 stale로 보고 회수"
- "…`|| exit 0`으로 감싼다." 뒤에 더한다: "런처가 하한 이상의 node를 찾지 못하면 아무것도 하지 않고 stdout에 `systemMessage` 한 줄(찾아본 위치와 하한)을 낸다. 설치 전이라 doctor가 없는 유일한 경로이기 때문이다."

**AD-21** (S11)
- OLD: "10번 실패하면 `failures`에 기록하고 멈춘다."
- NEW: "10번 실패하면 같은 트랜잭션에서 `failures`에 기록하고 그 행을 닫는다(`completed_at`). 같은 대상의 다음 일감은 새 행이다(`sessions retry` 등). 청구 질의를 덮는 인덱스를 둔다."

**AD-23** (S13)
- OLD: "한 트랜잭션에서 `redacted_at`, 그 내용의 추출 세대·조각·FTS 삭제, `redactions` 기록, 모든 `brain` 위치에 블롭 삭제 일감을 남긴다."
- NEW: "한 트랜잭션에서 `redacted_at`, 그 내용의 추출 세대·조각·FTS 삭제, 그 내용의 `file_names`(와 이름 FTS)·`file_metadata` 삭제, `redactions` 기록, 모든 `brain` 위치에 블롭 삭제 일감을 남긴다. 이름·메타데이터 재생성은 가린 파일을 건너뛴다."

**AD-24** (S9, S10, S12)
- OLD: "두 값이 다르면 Store가 쓰기를 거부한다."
- NEW: "pdf가 아니면 `page`는 null이다. 두 값이 다르면(null 포함 비교) Store가 쓰기를 거부한다."
- OLD: "실패하면 포인터는 그대로다."
- NEW:
  > 실패하면 포인터는 그대로이고, 그 세대가 남긴 조각·FTS는 실패를 기록하는 쓰기(또는 뒤따르는 정리 일감)가 지운다. 청구가 만료된 추출 일감의 열린 세대(`finished_at` null)는 다음 청구가 `failed`(`failed_stage`는 마지막 단계)로 닫은 뒤 새 `attempt`를 만든다. 열린 세대를 건너뛰는 것은 그 세대의 일감 청구가 살아 있을 때뿐이다(AD-21).

**AD-25** (D3)
- OLD: "`daemon stop`은 임시 정지이고 주기 Label을 되살리지 않으며 doctor가 `warn`이다."
- NEW: "`daemon stop`은 임시 정지이고 주기 Label을 되살리지 않으며 doctor가 `warn`이다. `daemon start`가 데몬 Label을 다시 올린다. 정지된 동안은 데몬이 살아 있지 않으므로 CLI의 기회적 drain과 SessionStart hook의 drain이 돈다(AD-7)."

**AD-26** (D4)
- OLD: "다르면 데몬은 `VERSION_MISMATCH`로 답한 뒤 정상 종료하고(KeepAlive가 새 빌드로 다시 띄운다, AD-27), 클라이언트는 …"
- NEW:
  > 다르면 데몬은 `VERSION_MISMATCH`로 답한다. 자기 빌드가 `installed.json`의 `commit`과 다를 때(데몬이 낡았을 때)만 정상 종료하고 KeepAlive가 새 빌드로 다시 띄운다(AD-27). 클라이언트가 낡았으면 데몬은 살아 있다. 클라이언트는 …

**AD-27** (D3, D4)
- OLD: "데몬은 `VERSION_MISMATCH`를 만나거나 `setup upgrade`·`daemon stop`의 요청을 받으면 정상 종료하고"
- NEW: "데몬은 자기 빌드가 낡았음을 알거나(AD-26) `setup upgrade`·`daemon stop`의 요청을 받으면 정상 종료하고"
- OLD: "데몬이 켜져 있으면 CLI의 기회적 drain은 꺼진다(AD-7)."
- NEW: "데몬이 살아 있으면 CLI의 기회적 drain은 꺼진다(AD-7)."

**Table Contract** (D0)
- `projects` 행 앞에 새 행을 더한다: `| \`users\` | \`id\`. \`is_self = 1\`인 행은 하나 | \`setup run\`(마이그레이션 직후 찾거나 만듦). 가져오기 합치기(epic 5) | \`id\`·\`is_self\`·\`created_at\` 불변. \`name\`은 표시용(갱신 규칙은 epic 5) |`
- `sessions` 행 OLD: "불변: 키, `user_id`, …" → NEW: "불변: 키, `user_id`(→ `users.id`), …"

**ER 다이어그램** (R4, D0): 다음 관계와 독립 엔티티를 더한다.

```
  users ||--o{ sessions : owns
  files ||--o{ file_locations : "놓인 곳"
  messages ||--o{ message_attachments : has
  files ||--o{ message_attachments : "내용"
  files ||--o{ document_extractions : "추출 세대"
  document_extractions ||--o{ document_chunks : has
  files ||--o{ file_names : "이름 색인"
  files ||--o{ file_metadata : has
  transcript_files { text path }
  work_items { text kind }
  schema_version { integer version }
```

**Conventions**
- CLI `--json` 응답 행의 오류 코드 OLD: "`CONFIG_MISSING`·`DB_UNAVAILABLE`(exit 2)" → NEW: "`CONFIG_MISSING`·`DB_UNAVAILABLE`·`USER_MISSING`(exit 2)" (D0)
- 내보내기 행의 "복구는 의존 순서대로 insert하고" 뒤에 더한다: "(`files.home_location_id`↔`file_locations.file_id` 순환은 포인터를 비운 채 `files`를 넣고, 위치를 넣은 뒤 포인터를 채운다. BEFORE INSERT 포인터 trigger 때문에 `defer_foreign_keys`만으로는 안 된다. `users`도 내보낸다)" (S5, D0)

**Deferred**
- "기계 교체·원본 이전" 행 OLD: "지금은 `admin.export`→`import`(빈 DB에만)."
  - NEW: "지금은 `admin.export`→`import`(빈 DB에만). 기존 DB에 합치는 가져오기(들어오는 '나'를 받는 쪽 '나'로, 2026-10-16)는 epic 5에서 정한다."
- "팀 공유" 행 OLD: "AD-12의 remote 정체성·사용자 칸과 AD-11의 마스킹이 그 준비다"
  - NEW: "AD-12의 remote 정체성·`users` 테이블과 AD-11의 마스킹이 그 준비다"

### 4.3 PRD

- **FR-17** (D6)
  - OLD: "규칙은 전부 들어간다. 규칙 부분이 정해진 크기를 넘으면 그대로 넣되 점검에서 경고하고, 내가 규칙을 끄거나 적용 범위를 좁혀 줄인다."
  - NEW: "규칙은 전부 들어간다. 규칙 부분이 정해진 크기를 넘으면 그대로 넣되 점검에서 경고하고, 내가 규칙을 끄거나 적용 범위를 좁혀 줄인다. 다만 시작 맥락 전체에는 Harness가 받는 상한이 있다. 규칙만으로 그 상한을 넘으면 넣지 못한 규칙의 수와 그것을 보는 방법이 시작 맥락에 한 줄로 들어가고, 점검은 실패로 표시한다(2026-10-16)."
- **FR-24** (R9): 도구 목록의 "…넓히기," 뒤에 "문서 검색, 파일 정보와 원본 위치,"를, "비밀 가리기," 뒤에 "첨부 가리기, 재색인·재추출,"을 더한다.
- **NFR-9** (T10)
  - OLD: "되살린 뒤 메시지 수와 작업 로그 수가 내보내기 전과 같다."
  - NEW: "되살린 뒤 메시지·작업 로그·파일·문서 추출 세대의 수가 내보내기 전과 같고, Brain이 보관한 원본 파일을 다시 열 수 있다."
- **§6.2 팀 공유 행** (D0)
  - OLD: "slice 1은 프로젝트를 git remote로 식별하고 세션에 사용자 칸을 두어 대비한다"
  - NEW: "slice 1은 프로젝트를 git remote로 식별하고, 세션이 `users` 테이블의 사용자를 가리키게 해 대비한다(slice 1은 '나' 한 행, 2026-10-16)"
- frontmatter `updated`를 2026-10-16으로 둔다(이미 그 날짜다).

### 4.4 Spec

- **CAP-12 success** (T10)
  - OLD: "되살린 뒤 메시지 수와 작업 로그 수가 내보내기 전과 같다."
  - NEW: "되살린 뒤 메시지·작업 로그·파일·문서 추출 세대의 수가 내보내기 전과 같고, Brain이 보관한 원본 파일을 다시 열 수 있다."

### 4.5 기타 문서

- **`prd-brain-v1-slice-1/addendum.md` §2** (R3): 제목 바로 아래에 더한다.

  > 2026-10-16: 이 스케치는 Postgres 시절(2026-10-08)의 출발점이고 역사 기록으로만 남긴다. 테이블·키·이름은 spine의 Table Contract가 정한다(예: `only_project_id` → `apply_project_id`, `ingest_failures` → `failures`, 벡터는 선택 색인).

- **`change-local-sqlite-primary.md`, `change-surface-plugin-daemon.md`** (R11): 제목 바로 아래에 더한다.

  > 반영 완료 기록이다. 이후의 기준은 spine·PRD·spec·에픽 파일이고, 이 문서와 다르면 그쪽이 우선한다.

- **`inputs/weknora-patterns.md` §1.1 제목** (R10): 끝에 "(2026-10-15 분할 뒤: 스키마 몫은 epic 2, 추출 동작은 epic 10)"을 더한다.

## 5. Implementation Handoff

**범위 분류: Moderate.** spine 문단 보강과 티켓 재정리다. 새 에픽이나 요구 변경이 없고, 코드도 아직 없다.

| 순서 | 할 일 | 누가 |
| --- | --- | --- |
| 1 | 이 제안과 D1~D8 승인 | 사용자 |
| 2 | §4.2~4.5 문서 편집. 문구가 정해져 있으므로 이 세션에서 직접 한다 | Dev(이 세션) |
| 3 | §4.1 티켓: initiative `tickets.toml`·initiative 파일, epic 2 티켓 7개와 epic-capture.md, 이후 에픽 Notes 7개, deferred Triage 행. `bmad-ticket` | PO(`bmad-ticket`) |
| 4 | `/bmad-build 2.2`: draft 계획을 이어받아 Code Map·deferred 작업을 이 change에 맞춘다 | Dev |

**성공 기준.**
1. spine에 `users` Table Contract 행, AD-12 새 문장, D1~D8 문장이 있다. ER 다이어그램이 Table Contract의 테이블을 모두 그린다.
2. `tickets.py next`에서 epic 7·8이 epic 9 뒤에 막혀 있다.
3. epic 2 티켓에서 2.2는 0003(`users`), 2.6은 0004·버전 4를 말한다.
4. 이후 에픽 Notes에 리뷰 ID가 걸려 있다.
5. `tickets.py status`에 충돌(`order_conflict`) 0.

## 6. Approval & Handoff Log

- 2026-10-16 초안 작성(batch). 사용자 결정 대기: D1~D8(§3). D0는 확정.
- 2026-10-16 사용자 질문: 새 세션에서 2.2를 해도 되나 → 이 change를 먼저 마무리하고 새 세션에서 `/bmad-build 2.2`를 권함(2.2는 D0만 쓰고 이미 계획에 있음. 먼저 하면 deferred 중복과 티켓 어긋남, 같은 작업 트리의 동시 세션은 충돌).
- 2026-10-16 **승인**(사용자, "마무리해"). D1~D8 권고대로 확정. 범위 Moderate. §4.2~4.5 문서 편집 적용(spine 29곳 + frontmatter `sources`, PRD 4곳, spec 1곳, addendum §2 안내, change 문서 두 개 안내, weknora §1.1 제목). §4.1은 `bmad-ticket`으로 넘긴다.
- 2026-10-16 `bmad-ticket` 반영(§4.1)과 검증(Set·Tree·Dependencies 서브에이전트 두 개). 검증으로 §4.1과 달라진 점:
  - D8의 10번 실패 규칙은 2.10이 아니라 2.12에 둔다(실패 기록 함수는 2.11, 재주입은 2.12). 레코드별 시도 횟수와 일부 줄 실패 시 다시 쓰기를 2.12가 맡고, AD-9에 그 문장을 더했다.
  - S8 청구 인덱스는 2.11이 아니라 2.6의 0004가 바꾸고(스키마 변경은 마이그레이션 스토리 몫), 2.11의 `after`에 6을 더했다. 2.6의 `after`에는 2를 더했다(0003 뒤 0004).
  - D5의 Drive 기록 복제 파일 다시 쓰기는 epic 8이 아니라 epic 7 몫이다(epic-replicas Boundaries). epic 8에는 가리기 이전 스냅샷 삭제만 남겼다.
  - spine AD-12의 DB 합치기는 "만들면 이렇게, 만들지는 epic 5 인셉션"으로 맞췄다(Deferred와 일치).
  - 그 밖의 정합성 수정: epic-daemon Description(D3·D4), epic-replicas 첫 대상 번호, deferred Triage의 0003→0004 세 곳, epic-operations Done when 1(복구 기준), initiative References, 에픽 Boundaries의 AD 목록(7·8에 AD-11, 5에 AD-12, 4에 AD-14), 2.4↔2.2·2.12↔2.7 인계, 2.10 references.
  - 사용자 결정 대기: 세션 없는 실패의 키(2.11 전에, 0004와 엮임), Done when 보강 제안 세 개(epic 9 Done when 3·5, epic 3 Done when 6, epic 2 Done when 7 문구).
- 2026-10-16 사용자 추가 결정: 재시도 분류(DB에 쓸 수 없음은 spool, 영구 오류는 첫 실패에서 기록·닫기, 외부 일시 오류는 `Retry-After`·긴 간격, 모르는 오류만 기본 간격 10번). 반영: spine AD-21, epic 2(2.11, Done when 7, Notes), epic 7·8·10 Notes. 사용자 질문 중(미반영): `failures` 네임스페이스(`failures list`·`failures retry`), `failures` 키 (c) 대상 키, D4를 외부 재시작 + 데몬은 어긋나면 일을 멈춤으로.
- 2026-10-16 사용자 결정: 명령 이름공간 통일. 이름공간은 명령이 다루는 대상이고 `admin`을 없앤다: `queue drain`, `doctor run`, `backup export·import`, `index rebuild`, `mirror rebuild`, `guide show·schema·exit-codes`, `failures list·retry`(`sessions failures·retry` 대신). 반영: spine AD-5 표와 규칙 문장, 그리고 spine·spec·initiative `tickets.toml`·에픽 8개·epic 2 티켓의 명령 이름. 기록 문서(옛 change, 리뷰, epic 1 계획·회고, inputs, deferred 위쪽 항목)는 옛 이름을 그대로 둔다. 이미 만든 `admin doctor`(코드·README·테스트)는 2.3이 옮긴다. `failures` 키 (c)는 사용자가 되물어("이미 실패 테이블이 있다") 보류.
- 2026-10-16 사용자 결정: (1) `failures` 키는 (c) 대상 키 `(target_kind, target_id, stage, fingerprint)`, 2.6의 0004가 재생성(Table Contract, 2.6, 2.11, epic 2 Notes). (2) 자동 업데이트 옵션 `[update] auto`(기본 true): 켜면 `app-ref`를 따라 bootstrap·데몬이 갱신하고 데몬은 스스로 재시작, 끄면 doctor `UPDATE_AVAILABLE`과 CLI 직접 갱신(spine AD-18·19·27·Conventions, 2.5, epic 2·5·9 Notes). D4는 보조 장치로 그대로.
- 2026-10-16 Done when 보강(사용자 승인): epic 9 Done when 3(낡은 데몬만 종료, 옛 클라이언트가 데몬을 멈추지 않음, `[update] auto`에 따른 자동 업그레이드)·5(`daemon stop` 뒤 기회적 drain, `daemon start`), epic 3 Done when 6(규칙이 hook 상한을 넘으면 생략 줄과 doctor `fail`). epic 2 Done when 7은 재시도 분류와 함께 이미 고쳤다.
