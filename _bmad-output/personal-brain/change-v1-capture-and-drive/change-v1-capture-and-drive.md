---
type: change
title: "V1을 대화 수집과 파일·Drive 수집으로 다시 자르고, 데몬을 먼저 만든다"
initiative: personal-brain
date: 2026-10-26
status: approved
scope: major
---

# V1을 대화 수집과 파일·Drive 수집으로 다시 자르고, 데몬을 먼저 만든다

코드는 바꾸지 않는다. 이 문서는 앞으로의 계획(이니셔티브, spec, PRD, architecture, 에픽, 티켓)만 바꾼다. 이미 만든 epic 1·2와 10.1·10.2·10.6, 운영 중인 스키마 8은 그대로다.

## 1. Issue Summary

**문제.** 사용자는 이 일을 "대화 수집"과 "파일·Drive 수집" 두 기능으로 기억한다(파일·Drive 요구는 2026-10-14 대화에서 사용자가 직접 설계했다). 그런데 계획은 V1을 "작업 기억 전체"(수집, 작업 로그, 규칙, 시작 맥락 주입, 검색, 미러, 내보내기)로 잡았고, Drive는 slice 1 밖의 epic 8로 맨 뒤에 있다. 2026-10-23 기준 epic 1·2(38스토리)가 끝났지만 Drive 착수까지는 epic 10·3·4·5·9가 남아 있다.

**발견.** 2026-10-23 중간점검(사용자 요청, 조사 다섯 건은 Codex 워커가 Orca로 수행)에서 확인했다.
- 범위가 만드는 도중 늘었다: 에픽 6→10, 스토리 24→38(+58%). 늘어난 항목 대부분은 에이전트 제안을 사용자가 승인한 것이고, 두 핵심 기능 기준으로 다시 자른 적이 없다.
- Drive를 막는 간선 `10→4→5→9→8` 가운데 9→8은 기술 의존이 아니라 "데몬 켜짐·꺼짐 양쪽 검증" 완료 조건 하나 때문이다(2026-10-16 D2). 4→8·5→8도 에픽 전체가 아니라 일부(문서 검색, 주기 실행)만 필요하다.
- Drive 최소 수집의 실제 선행은 epic 10의 추출 부분과 상주 실행 주체뿐이다.

**데몬에 대한 사용자 결정(2026-10-26).** 이 프로그램에는 사용자가 등록한 배치·예약 작업을 그 시각에 실행하는 기능과 상주가 필요한 기능이 더 올 것이므로 데몬이 기본 실행 방식이어야 한다. Drive 주기 수집과 로컬 파일 변경 감지도 데몬이 맡는다. 그래서 데몬이 Drive보다 먼저다. launchd는 데몬을 로그인 때 띄우고 죽으면 다시 띄우는 데만 쓰고, 5분마다 drain을 부르는 주기 실행은 만들지 않는다. 데몬은 CLI를 매번 부르지 않고 프로세스 안에서 Core(`createBrain`·scan·drain)를 직접 부른다.

**분류.** 전략 조정(목표 재정의) + 요구 이해의 불일치.

## 2. Impact Analysis

### 2.1 체크리스트 결과

| 항목 | 상태 | 메모 |
|---|---|---|
| 1.1 계기 | [x] | 특정 스토리가 아니라 중간점검. 직전 작업은 epic 10의 10.1·10.2·10.6과 epic 3 인셉션(2026-10-23) |
| 1.2 문제 정의 | [x] | 위 §1 |
| 1.3 근거 | [x] | 커밋 이력, tickets.toml 간선, 2026-10-14·10-15·10-16 대화 기록, 코드 import 조사 |
| 2.1 현재 에픽(10) | [!] | 계속하되 축소(§4.5) |
| 2.2 에픽 변경 | [!] | 9 축소·앞당김, 8 V1 편입·축소, 4·5 일부만 V1, 3·7·6 V1 뒤 |
| 2.3 남은 에픽 | [!] | 모든 남은 에픽의 간선 재설정(§4.6) |
| 2.4 무효·신규 에픽 | [x] | 무효 에픽 없음. 신규 에픽 없음(사용자 스케줄러는 다음 조각으로 기록만) |
| 2.5 순서 | [!] | 1·2(완료) → 9 → 10 → 5(축소) → 8 → (V1 뒤) 3·4·7·6 |
| 3.1 PRD | [!] | §6.2 범위 표, FR-27·28, §7 지표 |
| 3.2 Architecture | [!] | Design Paradigm, AD-18·25·26·27·28, AD-14·16·17 표시, Deferred |
| 3.3 UX | [N/A] | UX 문서 없음 |
| 3.4 기타 | [!] | README·코드 주석의 AD-25 언급은 epic 9 구현 때 고친다(이 변경에서는 코드 무변경) |
| 4.1 직접 조정 | 가능 | 단독으로는 부족(목표 자체가 바뀜) |
| 4.2 되돌리기 | 불가 | 운영 데이터·스키마 8이 의존. 되돌릴 이유도 없음 |
| 4.3 MVP 재검토 | 가능 | 선택 |
| 4.4 선택 | [x] | MVP 재검토 + 직접 조정(Hybrid) |

### 2.2 에픽 영향

| 에픽 | 지금 | 바뀐 뒤 |
|---|---|---|
| 1 기반·설치, 2 수집 | done | 그대로 |
| 9 데몬·MCP | V1 뒤, 선택 런타임, epic 5 뒤 | **V1 첫 번째.** 기본 상주 런타임, 가볍게. MCP·소켓·자동 업데이트는 V1 뒤 |
| 10 첨부·추출 | 3/14 built | V1. 11개 중 4개 그대로, 5개 가볍게, 1개 V1 뒤, 1개 drop |
| 5 운영 | V1, 4 뒤 | V1은 로컬 백업·복구와 스키마 가드만. 나머지 V1 뒤 |
| 8 Drive | slice 1 밖, 맨 뒤 | **V1.** 문서·폴더명 검색(epic 4에서 옮김) 포함. 스냅샷·새 Mac 복구는 V1 뒤 |
| 3 작업 로그·시작 맥락 | V1, 15스토리 인셉션 완료 | V1 뒤(backlog). 티켓은 그대로 둔다 |
| 4 조회·미러 | V1 | 문서 검색 부분은 8로 옮기고, 나머지는 V1 뒤 |
| 7 복제 | V1 뒤 | V1 뒤. 데몬 양쪽 검증 조건만 삭제 |
| 6 임베딩 | 맨 뒤 | 그대로 맨 뒤 |

### 2.3 산출물 충돌

- **PRD:** Drive 연동이 §6.2 "다음 조각", 데몬이 "slice 1 밖", 스케줄러가 "이후 조각"으로 적혀 있다. 성공 지표 SM-1·SM-4·SM-6이 작업 로그·시작 맥락을 전제한다.
- **spec:** Constraints가 "slice 1에는 상주 프로세스가 없다", Non-goals가 "데몬은 slice 1 밖", Success signal이 "이어서" 지표(SM-1)다. CAP-14는 사진을 "촬영 일시로" 찾는다고 한다.
- **architecture:** Design Paradigm과 AD-27이 "상주 프로세스 없음, 데몬은 선택"을 기준으로 한다. AD-25가 launchd 주기 실행과 두 Label 전환을, AD-18이 `[daemon] enabled`를 정한다. Deferred가 Drive(epic 8)를 미룬 항목으로 둔다.
- **이니셔티브:** Done when 2~4가 2주 기억 지표·SM-3 전체·전체 내보내기 복구를 요구한다. 첫 시연 경로가 epic 3이다.

### 2.4 기술 영향

없음(코드 무변경). 앞으로의 구현에서 생기는 영향만 적는다.
- AD-25의 5분 주기 LaunchAgent는 아직 코드가 없어(주석 두 곳: `apps/cli/src/commands/queue-drain.ts`, `packages/core/src/domain/work-item.ts`) 버려지는 구현이 없다. 주석은 epic 9 구현 때 고친다.
- Drive는 아직 내려받지 않은 원격 파일을 담을 외부 source 메타 테이블(source, remote file id, 이름, 부모 경로, 원격 버전, 연결된 content id)이 새 마이그레이션으로 필요하다. 기존 `files`(내용 해시 식별)에 억지로 넣지 않는다.
- 운영 중인 스키마 8과 마이그레이션 0001~0008은 고치지 않는다.

## 3. Recommended Approach

**MVP 재검토 + 직접 조정(Hybrid).**

- V1 목표를 "대화 수집(완료) + 파일·Drive 수집"으로 다시 정의한다.
- 순서: 1·2(완료) → **9 가벼운 데몬** → **10 축소** → **5 축소(로컬 백업)** → **8 Drive**(문서·폴더명 검색 포함). 첨부 원본을 Drive로 옮기고 로컬을 지우기 전에 로컬 백업이 있도록 5를 8 앞에 둔다.
- 미루는 것은 지우지 않는다(티켓 state `backlog`). 정말 사라지는 것만 `dropped`.

**근거.** 두 기능을 먼저 쓸 수 있게 되고, Drive를 막던 계획상 간선이 사라진다. 데몬은 사용자의 장기 방향(스케줄러·상주 기능)과 맞고, launchd 주기 실행과 데몬을 둘 다 만들고 둘 다 검증하던 중복이 없어진다.

**규모·기간(추정, 약속 아님).** 2026-10-23 속도(완료 38스토리 / 약 15일)로 환산한 값이다.

| 범위 | 남은 작업 | 환산 |
|---|---|---|
| 지금 계획, Drive 착수 전까지 | 약 46~56 | 약 18~22일 |
| 바뀐 계획, 데몬(가볍게) | 약 2~3 | 약 1일 |
| 바뀐 계획, Drive 문서·폴더명 찾기까지 | 약 14~15 | 약 6일 |
| 바뀐 계획, 첨부 Drive 이전까지 V1 완료 | 약 17~20 | 약 7~8일 |

전체 계획을 끝까지 만든다고 보면 줄어드는 양은 작다. 미룬 에픽은 언젠가 만들어야 한다. 실제로 사라지는 것은 launchd 주기 실행, 두 Label 전환 설정, 데몬 양쪽 검증, 형식적인 정리 스토리, 그리고 진행 방식 축소(§4.7)로 줄어드는 반복비다.

**위험.**
- 데몬이 멈추면 Drive 수집과 예약 작업이 멈춘다. 그래서 doctor의 heartbeat 점검과 기존 기회적 drain을 폴백으로 남긴다.
- epic 3(작업 로그)을 기대하던 "새 세션에서 이어서" 효용은 V1에서 오지 않는다.
- 진행 방식 축소로 리뷰가 줄면 결함이 늦게 보일 수 있다. 그래서 원본 삭제·마이그레이션·파서·인증 스토리는 리뷰를 유지한다.

## 4. Detailed Change Proposals

표기: OLD는 지금 문장(길면 요지), NEW는 바뀔 문장이다. 날짜 표식은 `(2026-10-26)`.

### 4.1 이니셔티브 (`initiative-personal-brain.md`)

**Description**
- OLD: "Personal Brain V1 slice 1. Claude Code 세션을 자동으로 수집하고, 일하는 에이전트가 결정·규칙·진행·선호를 그 순간에 적고, 넓은 것에서 원문으로 찾는다. …"
- NEW: "Personal Brain V1 slice 1. Claude Code 세션을 자동으로 수집하고, 대화에 준 파일과 고른 Google Drive 폴더의 문서·사진을 수집해 본문과 폴더 이름으로 찾는다. 작업 로그·시작 맥락·규칙은 V1 다음이다(2026-10-26). 기능·제약·비목표는 spec이 갖고, 구현 불변식은 architecture spine(AD-1~28, Table Contract)이 갖는다."

**Outcome**
- OLD: "새 세션에서 다시 설명하지 않고 이어간다. 신호는 spec의 Success signal(SM-1 ≥ 80%, SM-2 ≥ 90%, SM-3 통과, LLM 호출 0)이다."
- NEW: "어떤 대화도, 대화에 준 어떤 파일도, 고른 Drive 폴더의 어떤 문서·사진도 Brain에 남고 다시 찾아 원본을 연다. 신호는 spec의 Success signal(SM-5 = 0, 문서 찾기, LLM 호출 0)이다. 이어가기(SM-1)는 epic 3과 함께 다음에 잰다(2026-10-26)."

**Done when**

| # | OLD | NEW |
|---|---|---|
| 1 | 빈 Mac에서 설치기 한 번으로 설치되고, 이후 Claude Code 세션이 손대지 않아도 빠짐없이 수집된다(SM-5 = 0). | 그대로 + "설치하면 데몬이 로그인 때 뜨고, 죽으면 다시 뜬다." |
| 2 | 2주 실사용에서 SM-1 ≥ 80%, SM-2 ≥ 90%, SM-4(a)(b) ≥ 80%이다. | 고른 Drive 폴더의 문서(txt·md·텍스트 PDF·docx)와 사진이 Mac에 동기화되지 않은 채 본문 단어와 폴더·파일 이름으로 찾아지고, 결과의 원본 링크가 열린다. 대화에 붙인 파일도 같은 방식으로 찾아지고 원본이 열린다. |
| 3 | SM-3 채점표를 기본 구성으로 통과하거나, 미달이면 임베딩을 켠 구성으로 통과한다. | 문서 찾기 문항(사용자가 고른 실제 문서·사진 10건)의 7건 이상이 키워드 검색과 질의 바꾸기로 찾아진다. SM-3 전체 채점표는 epic 4와 함께 다음에 잰다. |
| 4 | 내보내기에서 되살린 Brain의 메시지·작업 로그·파일·문서 추출 세대 수가 원래와 같고, Brain이 보관한 원본 파일을 다시 열 수 있다. | 로컬 백업에서 새 DB 파일로 되살리면 메시지·파일·문서 추출 세대 수가 같고, Brain이 보관한 원본 파일을 다시 열 수 있다. 첨부 원본을 Drive로 옮기기 전에 이 백업이 있다. |
| 5 | 실사용 기간 동안 Brain의 LLM 호출은 0이고, 조용한 실패가 없다. | 그대로 + "데몬이 멈춘 것도 doctor에 보인다." |

**Boundaries**
- OLD: "… MCP·데몬은 V1 뒤 epic 9). 첫 시연 경로: 세션에서 규칙을 말하면 로그로 적히고, 다음 세션 시작에 자동으로 들어온다(epic 1 → 2 → 3). epic 10은 2와 3 사이에 있지만 시연 경로 밖이라, 시연이 한 에픽 늦게 온다."
- NEW: "… 데몬은 V1의 기본 상주 런타임이고(epic 9, 가볍게), MCP는 V1 뒤다. 첫 시연 경로: 고른 Drive 폴더의 문서를 본문 단어로 찾아 원본 링크를 연다(epic 9 → 10 → 5 → 8). (2026-10-26)"
- Touch point `UNIX 소켓·LaunchAgent KeepAlive — 데몬; owner: epic-daemon` → `LaunchAgent KeepAlive(데몬 실행·재시작만) — 데몬; owner: epic-daemon. UNIX 소켓은 V1 뒤`
- Touch point `launchd — 주기 실행 LaunchAgent; owner: epic-operations` → 삭제(launchd는 데몬을 띄우는 데만 쓴다)
- Touch point `Docker·Postgres`, `Model Studio` → 끝에 "(V1 뒤)"

**Notes에 추가**
- Decision(2026-10-26, `change-v1-capture-and-drive/`, 사용자): V1은 대화 수집 + 파일·Drive 수집이다. 순서 1·2 → 9(가볍게) → 10(축소) → 5(로컬 백업) → 8. epic 3·7·6과 4·5의 나머지는 V1 뒤(backlog, 삭제 아님). 데몬은 기본 상주 런타임이고 launchd는 데몬을 띄우는 데만 쓴다. 5분 주기 drain LaunchAgent, 두 Label 전환, 데몬 양쪽 검증은 없앤다. 사용자 스케줄러(배치·예약 등록 시 그 시각에 실행)는 두 기능 다음의 첫 상주 기능이다.
- Decision(2026-10-26, 진행 방식, 사용자): 에픽 사전 조사는 새 불확실성만 한 편. validate-set은 한 번(고위험 항목만 재검증). plan은 목적·쓰기 경계·재사용 API·완료 조건·위험만. 리뷰는 원본 삭제·마이그레이션·파서·인증·기존 데이터 변경 스토리에만 하고 단순 연결·문서 작업은 생략. 플러그인 배포(app-ref·version)는 기능 묶음마다. Postgres 테스트는 Postgres 코드나 공용 Store 계약을 바꿀 때만. build·typecheck, 마이그레이션·멱등·잠금·삭제 경계 테스트, 마지막 실계정 확인은 유지한다.
- 기존 Decision(2026-10-15, 트리 검증)의 "epic 7·8의 Done when이 데몬 켜짐·꺼짐 둘 다를 요구하므로 둘 다 after에 9를 둔다" 끝에 "→ 2026-10-26 양쪽 검증 삭제, 데몬이 기본 런타임" 표식.

### 4.2 spec (`spec-brain-v1-slice-1.md`)

**Why** 마지막 두 문장
- OLD: "slice 1은 그 최소 형태다. Claude Code 세션을 자동으로 수집하고, 일하는 에이전트가 결정·규칙·진행·선호를 그 순간에 한 줄로 적고, 넓은 것에서 좁은 것(원문)으로 찾는다. 개인용으로 먼저 검증한다."
- NEW: "slice 1은 그 최소 형태다. V1은 Claude Code 세션과 대화에 준 파일, 고른 Google Drive 폴더의 문서·사진을 빠짐없이 모으고 본문과 이름으로 찾는다. 작업 로그·시작 맥락은 그다음이다(2026-10-26). 개인용으로 먼저 검증한다."

**Capabilities**: CAP 번호·문구는 그대로 두고, 각 CAP intent 끝에 V1 여부만 붙인다.

| CAP | 표식 |
|---|---|
| 1, 2, 10, 11 | V1 |
| 14 | V1. success의 "사진은 경로와 촬영 일시로" → "사진은 폴더 이름과 파일 이름으로(촬영 일시는 V1 뒤)". 끝에 "고른 Google Drive 폴더의 문서·사진도 Mac에 동기화하지 않고 같은 방식으로 찾힌다(epic 8, 2026-10-26)" |
| 6, 7 | V1은 문서 본문·이름 검색과 출처·원본 링크만(epic 8). 대화 조각·로그·도구 메모 검색과 넓히기는 V1 뒤(epic 4) |
| 3, 4, 5, 8, 9, 12, 13 | V1 뒤 |

CAP-11 success의 "제거 후 Brain hook이 남지 않는다" 끝에 "설치하면 데몬이 로그인 때 뜨고 죽으면 다시 뜬다(epic 9)".

**Constraints**
- OLD: "구현 언어는 TypeScript, 실행 환경은 내 Mac 한 대. slice 1에는 상주 프로세스가 없고, 데몬은 epic 9에서 선택으로 더하며 데몬 없이도 전부 동작한다(AD-5, AD-6, AD-25, AD-27)."
- NEW: "구현 언어는 TypeScript, 실행 환경은 내 Mac 한 대. 상주 프로세스는 데몬 하나이고 launchd가 로그인 때 띄우고 다시 띄운다. 데몬은 같은 빌드에서 Core를 직접 부른다. 데몬이 멈춰도 hook 수집과 명령은 동작하고, 밀린 일은 명령의 기회적 drain이 처리한다(AD-6, AD-7, AD-25, AD-27, 2026-10-26)."

**Non-goals**
- OLD: "… 두 번째 기계. MCP·데몬은 slice 1 밖이지만 epic 9로 계획한다(2026-10-15)"
- NEW: "… 두 번째 기계. MCP는 slice 1 밖이다. 사용자 스케줄러·Telegram은 다음 조각이고 데몬 위에 붙는다(2026-10-26)"
- 추가: "V1에서 작업 로그·규칙·시작 맥락(CAP-3·8·9), 시간 조회(CAP-5), 대화 검색·넓히기, 내보내기(CAP-12), 미러(CAP-13). 다음 조각에서 한다(2026-10-26)"

**Success signal**
- OLD: "명훈이 2주 동안 실사용하는 기간 내내, 새 세션에서 '어제 하던 거 이어서'라고만 해도 … (SM-1 ≥ 80%) … SM-2 ≥ 90%, SM-3 통과 …"
- NEW: "명훈이 쓰는 동안 Claude Code 세션이 하나도 빠지지 않고(SM-5 = 0), 대화에 붙인 파일과 고른 Drive 폴더의 문서·사진을 '그 문서 찾아줘'로 찾아 원본을 연다(실제 문서 10건 중 7건 이상). 이 동안 Brain은 LLM을 한 번도 부르지 않는다. 이어가기(SM-1)·시간 조회(SM-2)·SM-3 전체는 다음 조각에서 잰다(2026-10-26)."

### 4.3 PRD (`prd-brain-v1-slice-1.md`)

**§1 Vision 셋째 문단** 끝에 추가: "V1은 이 가운데 수집(대화, 대화에 준 파일, 고른 Drive 폴더)과 문서 찾기를 먼저 한다. 작업 로그와 시작 맥락은 그다음이다(2026-10-26)."

**FR-27 Out of Scope**
- OLD: "Drive 연동, 기존 Drive 문서 색인, 연동 해제·새 기계 이전(이후 조각)."
- NEW: "새 기계 이전과 DB 스냅샷의 Drive 보관(이후 조각). Drive 연동·기존 Drive 문서 색인·연동 해제는 V1(epic 8, 2026-10-26)."

**FR-28 Consequences**
- OLD: "폴더 이름과 파일 이름으로도 찾힌다. 사진은 경로와 촬영 일시로 찾힌다."
- NEW: "폴더 이름과 파일 이름으로도 찾힌다. 사진은 폴더 이름과 파일 이름으로 찾힌다(촬영 일시는 이후 조각, 2026-10-26). 고른 Google Drive 폴더의 문서·사진도 Mac에 동기화하지 않고 같은 방식으로 찾힌다."

**§6.2 Out of Scope 표**

| 행 | OLD | NEW |
|---|---|---|
| 데몬·MCP | slice 1 밖. epic 9로 계획. 데몬 없이도 전부 동작하는 것이 기준이다 | 데몬은 V1의 상주 런타임(epic 9, 가볍게: launchd로 실행·재시작, Core 직접 호출, drain 반복, 파일 감시). MCP·소켓·데몬 자동 업데이트는 이후 조각(2026-10-26) |
| 스케줄러, Telegram, Google Calendar | 이후 조각 | 사용자 스케줄러(배치·예약 등록 시 실행)는 V1 다음의 첫 상주 기능으로 데몬 위에 붙는다. Telegram·Google Calendar는 이후 조각(2026-10-26) |
| Google Drive 연동(…) | 다음 조각(epic 8). Drive API로 하고 Mac에 동기화하지 않는다 | V1(epic 8, 2026-10-26): 첨부 원본 이전, 기존 문서 색인, 변경 동기화, 연동 해제. DB 스냅샷 보관과 새 기계 복구는 이후 조각. Drive API로 하고 Mac에 동기화하지 않는다 |
| 추가 | — | 작업 로그·규칙·시작 맥락(FR-7~9, FR-17~22), 시간 조회(FR-12), 대화 조각·로그 검색과 넓히기(FR-13~15의 대화 부분), 미러, 내보내기: V1 다음(2026-10-26). FR 문구는 그대로 둔다 |

**§7 Success Metrics**
- SM-1, SM-4, SM-6 끝에 "(V1 다음, epic 3과 함께 잰다, 2026-10-26)".
- SM-2 끝에 "(V1 다음, epic 4, 2026-10-26)".
- SM-3 끝에 "V1은 문서 찾기 문항(사용자가 고른 실제 문서·사진 10건 중 7건 이상)만 잰다(2026-10-26)."
- SM-7의 `[ASSUMPTION: 데몬 없이 호출마다 프로세스를 띄우는 구조에서 잡은 여유값]` 뒤에 "데몬이 있어도 hook과 명령은 V1에서 프로세스를 띄운다(소켓 경로는 이후 조각)".

### 4.4 Architecture (`architecture-brain-v1-slice-1.md`)

**Design Paradigm**
- OLD: "slice 1에 상주 프로세스는 없다. 모든 실행은 짧게 떴다 사라지는 `brain` 프로세스이고, 같은 세션에 여러 프로세스가 동시에 뜨는 것을 전제한다. 데몬(AD-27, epic 9)은 같은 빌드의 선택 런타임이고, 데몬이 없을 때의 동작이 기준이다."
- NEW: "상주 프로세스는 데몬 하나다(AD-27). 데몬은 같은 빌드에서 Core를 직접 부르며 drain 반복·파일 감시·(다음 조각의) 예약 작업을 맡는다. hook과 명령은 짧게 떴다 사라지는 `brain` 프로세스이고, 같은 세션에 여러 프로세스가 동시에 뜨는 것을 전제한다. 데몬이 멈춰도 hook·명령은 동작한다(2026-10-26)."

**AD-18** 설정 키 목록에서 "데몬 사용 여부는 `[daemon] enabled`" 삭제 → "데몬은 설치되면 늘 켠다. 임시 정지는 `daemon stop`(2026-10-26)".

**AD-25 — 제목과 본문 교체**
- OLD 제목: "주기 실행은 launchd가 단명 CLI를 부른다"
- NEW 제목: "launchd는 데몬을 띄우고 다시 띄우기만 한다"
- NEW Prevents: 상주 실행 주체가 둘이 되는 것, 로그인 뒤 데몬이 없는 것, 데몬이 죽었는데 아무도 모르는 것
- NEW Rule:
  - 설치기(`setup run`, 플러그인 bootstrap이 부르는 같은 함수)가 고정 Label(`<reverse-dns>.second-brain.daemon`)의 LaunchAgent 하나를 `RunAtLoad`·`KeepAlive`로 등록한다. 실행 대상은 shim을 거친 `brain daemon run`이다. 같은 Label이면 다시 등록하지 않는다. `setup uninstall`이 지운다.
  - 주기 실행용 LaunchAgent(`…drain`)는 두지 않는다. 주기 작업(drain, Drive 동기화, 다음 조각의 예약 작업)은 데몬 안에서 돈다.
  - 데몬이 멈춘 동안은 CLI의 기회적 drain과 SessionStart hook의 drain이 밀린 일을 처리한다(AD-7).
  - doctor는 데몬 heartbeat가 간격의 3배보다 오래되면 경고한다.
  - (2026-10-26, `change-v1-capture-and-drive/`. 이전 규칙의 두 Label·`[daemon] enabled`·`last-drain`은 없앴다.)

**AD-26 — 소켓 규약**: 본문 그대로 두고 제목 끝에 "[V1 뒤]", 첫 줄에 "V1 데몬은 소켓을 열지 않는다. hook→소켓 경로·handshake·`VERSION_MISMATCH`는 다음 조각이다(2026-10-26)."

**AD-27 — 데몬**
- OLD 제목: "데몬은 같은 빌드의 선택 런타임이다"
- NEW 제목: "데몬은 같은 빌드의 상주 런타임이다"
- NEW Prevents: 데몬 전용 코드 경로가 생겨 CLI와 갈라지는 것, 데몬이 죽었을 때 수집이 멈추는 것, 인스턴스 둘이 같은 DB를 두고 drain을 겹치는 것, 업그레이드 뒤 옛 데몬이 남는 것
- NEW Rule:
  - 데몬은 `brain daemon run`(같은 빌드·같은 shim)이고 프로세스 안에서 Core(`createBrain`, scan, drain)를 직접 부른다. CLI를 다시 띄우지 않는다. Core는 그대로다(FR-23).
  - 단일 인스턴스 잠금 `<home>/run/daemon.pid`(설치 잠금과 같은 규칙), SIGTERM 정상 종료, 로그 `<home>/log/daemon.log`(크기 회전 1MB×5), heartbeat `<home>/run/heartbeat`(mtime, 30초).
  - 데몬은 drain 반복(AD-21)과 로컬 파일 감시(transcript 폴더, 그리고 Brain이 맡은 파일 위치)를 돈다. 데몬이 살아 있으면 CLI의 기회적 drain은 짧게 끝난다(AD-7). DB에 못 쓰면 같은 spool 형식을 쓴다(AD-9).
  - 예약 작업이 붙을 자리: 데몬은 시각이 된 일감을 `work_items`에 넣는 틱 하나를 둔다. 사용자 스케줄러(등록·목록·삭제)는 다음 조각이다.
  - 업그레이드: `setup upgrade`가 데몬을 재시작한다(KeepAlive가 새 빌드로 다시 띄움). 데몬 스스로의 자동 업데이트는 다음 조각이고, 그동안은 SessionStart bootstrap이 지금 규칙(`[update] auto`)으로 갱신한다.
  - hook은 V1에서 소켓을 쓰지 않고 지금처럼 프로세스 안에서 처리한다. 데몬이 멈춰도 모든 명령·hook이 동작한다. epic 2·10·5·8의 테스트는 데몬 없이도 통과한다.
  - `daemon stop`(임시 정지, doctor `warn`), `daemon start`(Label 다시 올림).
  - doctor는 데몬 생존·마지막 heartbeat를 보이고, 죽어 있으면 `warn`이다.

**AD-28 — MCP**: 제목 끝에 "[V1 뒤]". 본문 그대로.

**AD-14·16·17**: 제목 끝에 "[V1 뒤, epic 3·4]". 본문 그대로.

**Structural Seed 도식**: `brain -. "epic 9: 소켓 (있으면)" .-> daemon["brain daemon run<br/>(선택, 같은 빌드)"]` → `launchd -. "KeepAlive" .-> daemon["brain daemon run<br/>(상주, 같은 빌드, Core 직접 호출)"]`

**Deferred 표**

| 행 | 변경 |
|---|---|
| 데몬·파일 watcher | "해소(2026-10-26): 데몬은 V1 상주 런타임(AD-25·27). 소켓·handshake·데몬 자동 업데이트는 다음 조각" |
| 소켓 프레이밍, watcher 지연 목표, 짧은 핸들 | "watcher 지연 목표는 epic 9 인셉션에서. 소켓 프레이밍과 짧은 핸들은 소켓 경로와 함께 다음 조각" |
| Drive 연동 (epic 8) | "해소(2026-10-26): V1. 외부 source 메타 테이블은 epic 8이 새 마이그레이션으로 더한다. DB 스냅샷 보관·새 기계 복구·로컬 캐시 상한은 다음 조각" |
| 추가: 사용자 스케줄러 | "V1 다음의 첫 상주 기능. 데몬의 예약 틱(AD-27) 위에 등록·목록·삭제를 얹는다. 범위는 그때 spec에 CAP으로 더한다(2026-10-26)" |
| 추가: 작업 로그·시작 맥락·규칙(AD-14·17), 미러(AD-16), MCP(AD-28) | "V1 다음(2026-10-26). epic 3·4·9 나머지" |

### 4.5 epic 10 첨부·추출 (`epic-attachments/`)

**에픽 문서**
- E10-5 OLD: "형식별 추출 — txt·md 본문 조각, 이미지 EXIF와 촬영 일시 세 칸(…), `files reindex`(새 추출 시도)." → NEW: "형식별 추출 — txt·md 본문 조각과 다시 추출 경로(`failures retry`). 이미지 EXIF와 촬영 일시는 V1 뒤(2026-10-26)."
- E10-6 OLD: "고아 블롭 정리 — … 유예(기본 24시간)가 지난 블롭을 drain이 지우고, doctor가 그 건수와 바이트를 보인다. 블롭 삭제 일감은 파일 가리기도 쓴다." → NEW: "블롭 삭제 일감 — Brain 위치의 블롭 하나를 멱등으로 지우는 일감(파일 가리기와 Drive 이전이 쓴다). 고아 블롭 자동 순회와 doctor 용량 집계는 V1 뒤(2026-10-26)."
- Done when 4 OLD: "루트 안에 있으나 위치 행이 없고 유예가 지난 블롭은 drain이 지우고, doctor가 그 건수와 바이트를 보인다." → NEW: "Brain 위치의 블롭 삭제 일감은 두 번 돌려도 같고, `external` 위치와 루트 밖 파일은 지우지 않는다."

**티켓**

| 티켓 | 변경 | NEW description 요지 |
|---|---|---|
| 10.3 FileStore 완성 | 가볍게 | 계약 테스트(fake·로컬), 루트 탈출·심볼릭 링크 거부, 0700/0600, 멱등 `put`, `url`, `external` locator 규칙. **"11이 쓸 루트 안 블롭 목록·크기 읽기" 삭제** |
| 10.4 @파일 | 그대로 | — |
| 10.5 과거 첨부 채우기 | 가볍게 | 새 코드 없이 1·2·4의 경로로 drain 재수집을 한 번 돌려 채우고, 이 기계 DB 사본에서 채운 수와 transcript가 사라진 수를 실측해 plan에 남긴다. doctor·drain 결과 항목 추가는 하지 않는다 |
| 10.7 locator 코덱 | 가볍게 | 다섯 종류 중 **text·pdf·docx 세 종류만**. time·sheet는 소비자가 생길 때 |
| 10.14 추출 세대 Store | 그대로 | — |
| 10.8 txt·md 추출 | 그대로 | — |
| 10.9 EXIF | **V1 뒤(backlog)** | — |
| 10.10 files reindex | 가볍게, 제목 변경 "다시 추출 경로" | 새 명령 `files reindex`를 만들지 않고 `failures retry`가 파일 추출 실패를 새 `attempt`로 다시 넣는다. 추출기 버전이 오르면 drain이 해당 파일을 다시 넣는다. 가린 파일·원본에 닿을 수 없는 파일은 건너뛰고 수를 알린다 |
| 10.11 고아 정리 | 가볍게, 제목 변경 "블롭 삭제 일감" | Brain 위치 블롭 하나를 지우는 멱등 일감만(지운 뒤 `deleted_at`). 24시간 고아 순회·doctor 바이트 점검 삭제. after `[3, 8, 9, 10, "2.11"]` → `[3, "2.11"]` |
| 10.12 파일 가리기 | 그대로, 참조만 정리 | "4·8·9·10이 둔 …" → "4·8·10이 둔 …", verify의 "`files reindex`가 그 파일을 건너뛰며" → "다시 추출 경로가 그 파일을 건너뛰며". after에서 9 제외 |
| 10.13 Refactor sweep | **dropped** | 확인된 결함은 해당 스토리에 흡수 |

### 4.6 나머지 에픽과 티켓 트리

**`tickets.toml`**
- 머리 주석 OLD: "V1 = 1·2·10·3·4·5, 그 뒤 9(데몬·MCP)·7·8, 임베딩 6은 맨 뒤." → NEW: "V1 = 1·2·9(가벼운 데몬)·10(축소)·5(로컬 백업)·8(Drive, 문서·폴더명 검색 포함). 그 뒤 3·4·7, 임베딩 6은 맨 뒤(2026-10-26)."
- 표 순서: `1, 2, 10, 3, 4, 5, 9, 7, 8, 6` → `1, 2, 9, 10, 5, 8, 3, 4, 7, 6`

| 에픽 | after OLD | after NEW |
|---|---|---|
| 9 | 5(LaunchAgent·upgrade·uninstall·doctor 틀), 2(명령 메타·플러그인 뼈대) | 2(명령 메타, 설치 흐름, doctor 틀, 플러그인 뼈대). LaunchAgent 등록·제거는 epic 9가 직접 만든다 |
| 10 | 2 | 그대로 |
| 5 | 4(모든 테이블), 10 | 10(파일·추출 세대가 백업 범위). 4 간선 삭제 |
| 8 | 10, 4(문서 검색), 5(스냅샷·launchd), 9(양쪽 검증) | 10(FileStore·추출 틀), 9(데몬: 주기 동기화·파일 감시), 5(첨부 이전 전 로컬 백업) |
| 3 | 2, 10(병렬 엮음 넷) | 2. epic 10과의 엮음은 착수 때 다시 본다(0009 번호는 epic 8의 source 메타 마이그레이션 뒤로) |
| 4 | 2, 3, 10 | 2, 3, 8(문서 검색 경로를 8이 먼저 만든다) |
| 7 | 5, 9(양쪽 검증) | 5, 9(데몬 런타임) |
| 6 | 4 | 그대로 |

- 에픽 state: 9·10·5·8 `planned`(V1), 3·4·7·6 `backlog`.

**epic 9 데몬 (`epic-daemon.md`)**
- title: "데몬과 MCP 표면" → "데몬(상주 런타임)". MCP는 V1 뒤 항목으로 문서 안에 남긴다.
- after: `["epic-operations", "epic-capture"]` → `["epic-capture"]`
- Description OLD 요지: mcp serve, 소켓·handshake·자동 업데이트·watcher, hook 클라이언트 소켓, 두 Label → NEW: AD-25·27(2026-10-26 판)대로. launchd LaunchAgent 하나로 실행·재시작, Core 직접 호출, drain 반복, 로컬 파일 감시, heartbeat·doctor, 예약 틱 자리, `daemon start|stop`, 설치·제거 때 Label 등록·삭제. V1 뒤: `mcp serve`, 소켓·handshake, 데몬 자동 업데이트, NDJSON 스트리밍, 짧은 핸들.
- Done when

| # | OLD | NEW |
|---|---|---|
| 1 | 데몬을 끄고도 모든 명령·hook·launchd 경로가 그대로 동작한다 | 데몬을 멈춰도 모든 명령·hook이 동작하고, 밀린 일은 기회적 drain이 처리한다 |
| 2 | 데몬을 켜면 Stop hook 없이 저장된 transcript가 N초 안에 수집된다 | 그대로(N은 인셉션에서) |
| 3 | 빌드 갱신 시 낡은 데몬만 종료, 옛 클라이언트, 자동 업데이트 | `setup upgrade` 뒤 데몬이 새 빌드로 다시 뜬다. 데몬을 죽이면 launchd가 다시 띄운다 |
| 4 | `mcp serve`가 모든 읽기 verb … | 삭제(V1 뒤) |
| 5 | `[daemon] enabled` 전환 시 두 Label 중 하나 … | 설치 뒤 데몬 Label 하나만 있고 `setup run`을 반복해도 하나다. doctor가 생존·heartbeat를 보이고 죽어 있으면 `warn`이다. `daemon stop` 뒤 기회적 drain이 돌고 `daemon start`가 다시 올린다. `setup uninstall` 뒤 Label·pid·로그가 남지 않는다 |
| 추가 6 | — | 데몬 안의 예약 틱이 시각이 된 일감 하나를 `work_items`에 넣고 drain이 처리한다(테스트용 일감으로 검증) |

**epic 8 Drive (`epic-drive.md`)**
- after: `["epic-attachments", "epic-recall-and-mirror", "epic-operations", "epic-daemon"]` → `["epic-attachments", "epic-daemon", "epic-operations"]`
- Description: "동기화는 … launchd 주기 실행이든 데몬이든 같은 경로이고" → "동기화는 drain의 일감 종류(`source_sync`)로 데몬이 주기적으로 넣고 돈다". "DB 스냅샷을 Drive에 보관해 새 기계에서 복구한다 …" 줄 끝에 "(V1 뒤)".
- Requirements: E8-4(스냅샷·새 기계 복구) → V1 뒤 표시. 로컬 캐시 상한(E8-1의 일부)도 V1 뒤.
- 추가 E8-6 (CAP-14·6·7, 문서 찾기 부분, epic 4에서 옮김): 문서 본문 단어·폴더 이름·파일 이름으로 문서와 사진을 찾고, 결과에 원본 링크(로컬 경로 또는 Drive 링크)와 위치(쪽·글자 범위)가 붙으며, 미색인 파일은 표시된다. 공백 든 질의와 `a-b`·`AND`·`"` 같은 질의가 오류나 조용한 0건 없이 처리된다. 출력은 마스킹 코덱을 거친다.
- 추가 E8-7: 외부 source 메타 테이블(새 마이그레이션): source, remote file id, 이름, 부모 경로, 원격 버전, 연결된 content id(내려받기 전 null).
- Done when

| # | OLD | NEW |
|---|---|---|
| 1 | 연동하면 첨부 원본이 Drive로 옮겨지고, 로컬 사본은 검증 뒤에만 지워진다 | 그대로 |
| 2 | 고른 Drive 폴더의 문서가 Mac에 남지 않은 채 본문으로 검색 … | 그대로 + "사진은 폴더 이름과 파일 이름으로 찾힌다" |
| 3 | 다음 drain(launchd 주기든 데몬이든)에서 반영 | 데몬의 다음 동기화 주기에서 반영된다 |
| 4 | 연동 해제 뒤에도 검색, 원본 접근 불가 표시 | 그대로 |
| 5 | 새 Mac에서 Drive 스냅샷으로 복구하면 건수가 같다 | V1 뒤 |
| 6 | 데몬 켜짐·꺼짐 둘 다 1~5 통과 | 삭제 |
| 추가 | — | 대화에 붙인 파일도 본문·이름으로 찾아지고 원본이 열린다(E8-6) |

- Notes: "Waits on epic-recall-and-mirror because: 문서 검색 경로." → 삭제(E8-6으로 옮김). "Waits on epic-operations because: 스냅샷 형식과 launchd 주기 실행." → "Waits on epic-operations because: 첨부 원본을 Drive로 옮기기 전의 로컬 백업." "Waits on epic-daemon because: Done when의 데몬 켜짐·꺼짐 두 상태 검증" → "Waits on epic-daemon because: 주기 동기화와 파일 감시를 데몬이 돈다(2026-10-26)."

**epic 5 운영 (`epic-operations.md`)**
- after: `["epic-recall-and-mirror", "epic-attachments"]` → `["epic-attachments"]`
- Description 끝에 V1 범위: "V1은 로컬 백업(DB와 Brain 소유 파일)과 새 DB 파일로의 복구 확인, 스키마 가드·`setup upgrade`만 한다. 전체 내보내기 형식·`import`, 내보내기 경과 경고, `stats show`, 완전 제거는 V1 뒤(2026-10-26)."
- Done when

| # | OLD 요지 | NEW |
|---|---|---|
| 1 | 내보낸 뒤 복구하면 메시지·작업 로그·파일·추출 세대 수가 같고 … | 로컬 백업에서 새 DB 파일로 되살리면 메시지·파일·문서 추출 세대 수가 같고 Brain이 보관한 원본 파일을 다시 열 수 있다. 백업 중에도 hook 수집은 막히지 않는다 |
| 2 | 마지막 내보내기 경과 경고 | V1 뒤 |
| 3 | `SCHEMA_MISMATCH`와 spool, `setup upgrade` 후 정상 | 그대로 |
| 4 | uninstall 뒤 hook·shim·LaunchAgent(두 Label)·run·log … | V1 뒤(데몬 Label 삭제는 epic 9 Done when 5가 맡는다) |
| 5 | `[daemon] enabled=false`면 주기 LaunchAgent … | 삭제 |
| 6 | `stats show` | V1 뒤 |

**epic 4 조회·미러 (`epic-recall-and-mirror.md`)**
- after에 epic 8 추가, state backlog.
- Done when 7 OLD: "문서 본문의 단어, 폴더 이름, 촬영 일시로 문서·사진이 찾히고 …" → NEW: "epic 8(E8-6)이 만든 문서 검색 위에 촬영 일시 필터를 더한다(EXIF, epic 10의 10.9와 함께). 나머지 문서 검색은 epic 8이 끝냈다(2026-10-26)."
- Notes에 Decision(2026-10-26): V1 뒤. 문서 검색 부분은 epic 8로.

**epic 3 작업 로그·시작 맥락 (`epic-log-and-context.md`)**
- state backlog. 15개 티켓은 그대로. 3.13 Refactor sweep만 dropped.
- Notes에 Decision(2026-10-26): V1 뒤. epic 10과의 병렬 엮음(2026-10-23) 넷은 착수 때 다시 본다. 마이그레이션 0009 번호는 epic 8의 source 메타 마이그레이션이 먼저 쓴다.

**epic 7 복제 (`epic-replicas.md`)**
- state backlog. Done when의 "데몬 켜짐·꺼짐 둘 다" 조건 삭제. Notes에 2026-10-26 표식.

**epic 6 임베딩**: 그대로(backlog).

### 4.7 진행 방식

§4.1 Notes의 두 번째 Decision이 기준이다. 스킬 설정 파일은 이번에 바꾸지 않는다. 이후 `bmad-ticket`·`bmad-build`를 부를 때 이 결정을 근거로 범위·리뷰 수준을 정한다(현재 build 리뷰 기본값은 이미 quick). 필요하면 `bmad-customize`로 따로 고정한다.

## 5. Implementation Handoff

**규모: Major**(V1 목표 재정의). 실행자는 이 세션의 코디네이터(사용자 승인 뒤)이고, 문서 편집은 직접, 티켓 트리 변경은 `bmad-ticket`으로 한다.

**순서**
1. 이 제안 승인.
2. 문서 수정: 이니셔티브 → spec → PRD → architecture → 에픽 문서(9, 8, 10, 5, 4, 3, 7) — §4.1~4.6 그대로.
3. `bmad-ticket`으로 티켓 트리 반영:
   - 표 순서 변경 `1, 2, 9, 10, 5, 8, 3, 4, 7, 6`과 §4.6의 after 표
   - 에픽 state: 9·10·5·8 planned, 3·4·7·6 backlog
   - epic 10 티켓: 10.3·10.5·10.7·10.10·10.11 description·title·after 수정, 10.12 참조 정리, 10.9 backlog, 10.13 dropped
   - epic 3 티켓: 3.13 dropped
4. 검증: 문서 간 어긋남 검사(데몬·launchd·Drive·SM 언급을 grep), 홈 절대 경로 없음 확인, `bmad-ticket` validate.
5. 하나의 docs 커밋(코드 무변경이므로 plugin app-ref·version 변경 없음).

**다음 작업**: epic 9 인셉션(가볍게: 조사 한 편, validate-set 한 번).

**성공 기준**
- 모든 계획 문서가 "V1 = 대화 수집 + 파일·Drive 수집, 데몬 먼저, launchd는 데몬 실행만"으로 같은 말을 한다.
- `tickets.toml`에서 epic 8의 선행이 10·9·5뿐이고, epic 9의 선행이 2뿐이다.
- 미룬 항목은 삭제되지 않고 backlog로 남는다.

## 6. 승인과 반영 기록

- 2026-10-26 사용자 승인("진행해"). 범위: Major.
- 반영(같은 날): 이니셔티브, spec, PRD, architecture(AD-25·27 교체, AD-18·26·28·14·16·17 표시, Deferred), epic 9·8·10·5·4·3·7·6 문서, 이니셔티브 `tickets.toml`(순서 `1, 2, 9, 10, 5, 8, 3, 4, 7, 6`과 after), epic 10 티켓.
- 제안과 달라진 점:
  - 에픽에는 `backlog` 상태가 없다(`bmad-ticket`의 container 상태는 비어 있음·in-progress·done·dropped뿐). 그래서 "V1 뒤"는 순서와 에픽 전체 대기로 나타낸다: epic 3·7의 frontmatter `after`에 `epic-drive`를 더해 Drive가 끝나야 시작하고, epic 4는 이미 epic 8을 기다린다.
  - 10.9 EXIF는 epic 10 안에 막힌 채로 두면 epic 10을 닫을 수 없어, 그것을 쓰는 epic 4로 옮겼다(`epic-recall-and-mirror` 1, E4-1). epic 10의 id 9는 다시 쓰지 않는다(`next_id = 15`).
  - epic 3은 epic 10 티켓 넷(10.1·10.2·10.4·10.6)을 기다리므로 이니셔티브 `after`에 epic 10을 다시 둔다.
  - 10.10의 선행은 `failures retry`를 만든 2.12다(옛 2.3은 명령 메타).
- 검증: `tickets.py status`에서 unpinned·undeclared·order_conflict·drift 없음(이전부터 있던 독립 plan 두 건의 경고만). 트리·epic 10 세트 검증은 Codex 워커가 Orca로 수행.

