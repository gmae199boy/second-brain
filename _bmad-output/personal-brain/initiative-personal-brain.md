---
type: initiative
title: "어떤 에이전트로 일해도 이어지는 나의 작업 기억"
parent: none
covers: [CAP-1, CAP-2, CAP-3, CAP-4, CAP-5, CAP-6, CAP-7, CAP-8, CAP-9, CAP-10, CAP-11, CAP-12, CAP-13, CAP-14]
after: []
assignee: ""
risk: high
---

# 어떤 에이전트로 일해도 이어지는 나의 작업 기억

## Description

Personal Brain V1 slice 1. Claude Code 세션을 자동으로 수집하고, 대화에 준 파일과 고른 Google Drive 폴더의 문서·사진을 수집해 본문과 폴더 이름으로 찾는다. 작업 로그·시작 맥락·규칙은 V1 다음이다(2026-10-26). 기능·제약·비목표는 spec이 갖고, 구현 불변식은 architecture spine(AD-1~28, Table Contract)이 갖는다.

## Outcome

어떤 대화도, 대화에 준 어떤 파일도, 고른 Drive 폴더의 어떤 문서·사진도 Brain에 남고 다시 찾아 원본을 연다. 신호는 spec의 Success signal(SM-5 = 0, 문서 찾기, LLM 호출 0)이다. 이어가기(SM-1)는 epic 3과 함께 다음에 잰다(2026-10-26).

## Done when

1. 빈 Mac에서 설치기 한 번으로 설치되고, 이후 Claude Code 세션이 손대지 않아도 빠짐없이 수집된다(SM-5 = 0). 설치하면 데몬이 로그인 때 뜨고, 죽으면 다시 뜬다(2026-10-26).
2. 고른 Drive 폴더의 문서(txt·md·텍스트 PDF·docx)와 사진이 Mac에 동기화되지 않은 채 본문 단어와 폴더·파일 이름으로 찾아지고, 결과의 원본 링크가 열린다. 대화에 붙인 파일도 같은 방식으로 찾아지고 원본이 열린다(2026-10-26. 이전의 2주 실사용 지표 SM-1·SM-2·SM-4는 V1 다음).
3. 문서 찾기 문항(사용자가 고른 실제 문서·사진 10건)의 7건 이상이 키워드 검색과 질의 바꾸기로 찾아진다. SM-3 전체 채점표는 epic 4와 함께 다음에 잰다(2026-10-26).
4. 로컬 백업에서 새 DB 파일로 되살리면 메시지·파일·문서 추출 세대 수가 같고, Brain이 보관한 원본 파일을 다시 열 수 있다. 첨부 원본을 Drive로 옮기기 전에 이 백업이 있다(2026-10-26. 전체 내보내기·`import`는 V1 다음).
5. 실사용 기간 동안 Brain의 LLM 호출은 0이고, 조용한 실패가 없다(점검에 드러나지 않은 실패 0). 데몬이 멈춘 것도 doctor에 보인다(2026-10-26).

## Boundaries

spec의 기능 단위로 에픽을 나누고, 바탕 공사는 첫 에픽이 맡는다. spec Non-goals를 따른다(팀 공유, Claude Code 외 Harness 수집 제외. 데몬은 V1의 기본 상주 런타임이고(epic 9, 가볍게), MCP는 V1 뒤다). 첫 시연 경로: 고른 Drive 폴더의 문서를 본문 단어로 찾아 원본 링크를 연다(epic 9 → 10 → 5 → 8). 작업 로그·시작 맥락(epic 3)·조회·미러(epic 4 나머지)·복제(epic 7)·임베딩(epic 6)은 V1 뒤다 (2026-10-26, `change-v1-capture-and-drive/`).

- Touch point: Claude Code 플러그인 체계(marketplace·`/plugin install`·hook 계약·`.mcp.json`) — hook·설치 진입점; owner: epic-capture(hook·bootstrap·node 런처), epic-log-and-context(skills, SessionStart 동기 `context show` hook 줄), epic-daemon(`.mcp.json`·래퍼, AD-28). `plugin/` 폴더 자체는 에픽이 만드는 코드다
- Touch point: LaunchAgent KeepAlive(데몬 실행·재시작만) — 데몬; owner: epic-daemon. UNIX 소켓은 V1 뒤(2026-10-26)
- Touch point: SQLite(Node 내장 `node:sqlite`) — 원본 DB 파일; owner: epic-foundation-and-install
- Touch point: Docker·Postgres — 복제 대상; owner: epic-replicas (V1 뒤)
- Touch point: Google Drive API — 첨부 원본 저장소·외부 문서; owner: epic-drive
- Touch point: Model Studio — 임베딩·재순위 호출(선택); owner: epic-embedding-index (V1 뒤)
- Touch point: 문서 추출 라이브러리(`pdfjs-dist`, `mammoth`, `file-type`, `exif-reader`) — 첨부·문서 텍스트 추출과 EXIF; owner: epic-attachments(`file-type`, txt·md), epic-drive(`pdfjs-dist`·`mammoth`), epic-recall-and-mirror(`exif-reader`, V1 뒤)(2026-10-26)

## References

- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, 전체(AD-1~28, Table Contract, Conventions)
- change — _bmad-output/personal-brain/change-local-sqlite-primary/change-local-sqlite-primary.md
- change — _bmad-output/personal-brain/change-surface-plugin-daemon/change-surface-plugin-daemon.md
- change — _bmad-output/personal-brain/change-users-and-review-gaps/change-users-and-review-gaps.md
- change — _bmad-output/personal-brain/change-v1-capture-and-drive/change-v1-capture-and-drive.md (V1 재절단과 데몬 먼저, 2026-10-26)
- inputs — _bmad-output/personal-brain/inputs/weknora-patterns.md (각 에픽 인셉션의 입력)
- inputs — _bmad-output/personal-brain/inputs/external-review-2026-10-16.md (외부 리뷰 검증. 각 에픽 Notes가 항목 ID로 가리킨다)
- prd — _bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md, FR별 testable consequences

## Notes

- Decision: 티켓 저장소는 repo 파일(2026-10-08).
- Decision: 임베딩 선택 색인은 맨 뒤 epic 6, SM-3이 기본 구성으로 미달일 때 착수(2026-10-08).
- Decision: 운영 epic 5는 내보내기·복구를 먼저 하고, 업그레이드·제거는 그 뒤 스토리로 둔다(2026-10-08).
- Decision: 경계·순서는 초안대로. 전부 만든 뒤 테스트한다(사용자, 2026-10-08). (순서는 2026-10-15에 바뀜: epic 10 추가, 9를 7 앞에)
- Decision: 설치 진입점은 `npx github:gmae199boy/second-brain`(공개 개인 저장소)(2026-10-08). (2026-10-15 플러그인이 Claude Code 진입점, npx는 대체 경로로 바뀜)
- Decision: doctor는 epic 1이 틀과 기본 항목을 만들고, 각 에픽이 자기 항목을 더한다(2026-10-08).
- Decision: SM-1·SM-4·SM-6의 2주 실사용 측정은 이니셔티브 Done when에서 하고, 에픽은 측정 가능하게 만드는 데까지 책임진다(2026-10-08).
- Decision: spool은 epic 2. epic 1의 스키마 불일치는 쓰기를 거부하고 `SCHEMA_MISMATCH`를 내며, spool로 보내는 경로는 epic 2가 붙인다(2026-10-08).
- Waits on: 각 에픽의 선행 조건은 `tickets.toml`의 `after`에 있다.
- Decision(2026-10-14): 원본은 로컬 SQLite 파일(Docker·서버 없음). Postgres·Drive 기록 복제는 epic 7. 첨부 원본 보관과 문서 본문 검색은 V1(FR-27·28, CAP-14). Drive 연동은 API로 epic 8. 주기 실행은 launchd(epic 5) → 2026-10-26: 데몬이 맡고 launchd는 데몬 실행만. 임베딩은 지금 하지 않고 epic 6은 맨 뒤(사용자).
- Decision(2026-10-15, `change-surface-plugin-daemon/`): Claude Code 설치·hook 진입점은 플러그인, npx는 CI·사람·개발·대체 경로. 당분간 Claude Code만(Codex 제외). Node 24 이상 유지. 데몬·MCP는 epic 9(epic 5 다음, 7 앞) → 2026-10-26: 데몬은 V1 첫 에픽(epic 2 다음), MCP는 V1 뒤. 확인 필요 종료 코드 3. WeKnora 흡수 목록(`inputs/weknora-patterns.md`)은 각 에픽 인셉션의 입력(사용자).
- Decision(2026-10-15, 트리 검증): epic 9는 epic 7 앞에 고정한다. 두 에픽이 `setup run`의 선택 단계·doctor 등록부·설정 코덱을 함께 건드리므로 순서를 바꾸면 충돌 비용이 든다. 설정 키 `[daemon] enabled`는 epic 5가 더하고(주기 Label 선택), 데몬 동작은 epic 9. Drive 동기화는 drain의 일감 종류로 돌아 launchd·데몬 어느 쪽이든 같은 경로다. 다만 epic 7·8의 Done when이 데몬 켜짐·꺼짐 둘 다를 요구하므로 둘 다 `after`에 9를 둔다(2026-10-16 정정, `change-users-and-review-gaps/` D2). → 2026-10-26: 양쪽 검증과 `[daemon] enabled`·주기 Label을 없앴고, 데몬이 기본 런타임이다(`change-v1-capture-and-drive/`).
- Decision(2026-10-15, 사용자): CAP-11은 다섯 에픽(1·2·5·7·9)이 각자 Boundaries의 경계 문장으로 나눠 맡는다. spec의 CAP 번호는 쪼개지 않는다. epic 7·8은 데몬 켜짐·꺼짐 둘 다에서 통과해야 한다(Done when에 추가). → 2026-10-26 삭제(`change-v1-capture-and-drive/`).
- Decision(2026-10-15, epic 2 인셉션): 첨부 원본과 문서 추출을 epic-capture에서 나눠 epic 10(`epic-attachments`)으로 만들고, epic 2 바로 뒤에 둔다(2026-10-26: epic 9 다음). CAP-14는 다섯 에픽이 나눠 맡는다.
  - epic 1: 스키마 자리(0001·0002)
  - epic 2: 0004 스키마(2.6. 0003은 2.2의 `users`, 2026-10-16)
  - epic 10: 첨부 저장, 문서 추출, `files redact`
  - epic 4: 문서 검색 → 2026-10-26: 촬영 일시 필터만(문서 검색은 epic 8 E8-6)
  - epic 8: Drive 저장소와 기존 Drive 문서, 그리고 문서·폴더명 검색(2026-10-26)
  - (사용자)
- Decision(2026-10-15, epic 2 인셉션): 수집 범위와 꼬리표.
  - 꼬리표는 프로젝트와 워크트리뿐이고, 근거는 첫 메시지의 transcript cwd다. → 2026-10-22 바뀜: 근거는 세션이 시작된 폴더(`startCwd`: 서브에이전트가 아닌 첫 cwd 줄, 첨부 줄 포함), 없으면 첫 메시지의 cwd다(epic-capture 25, 사용자 결정 B).
  - 워크스페이스는 slice 1에서 쓰지 않는다. 칸은 예약으로 남긴다. 회사/개인 경계는 내보내기·지우기·팀 공유를 경계 단위로 할 때 정한다.
  - 설치 때 디스크에 남은 Claude Code transcript는 한 번 가져온다. 그 밖의 과거 세션 가져오기는 그대로 범위 밖이다.
  - 서브에이전트는 최종 보고만 수집한다. → 2026-10-21 바뀜: 서브에이전트 보고는 저장하지 않는다. 부른 일은 도구 메모 한 줄로 남는다(epic-capture Notes 2026-10-21, 23).
  - spec·PRD·spine 문구는 2026-10-16에 맞췄다.
  - (사용자)
- Decision(2026-10-16, `change-users-and-review-gaps/`): 사용자 정체성은 `users` 테이블이다('나' 한 행, `setup run`이 만듦, `sessions.user_id` FK, UUIDv7 유지, 정체성은 DB와 함께 옮겨짐). 외부 리뷰(`inputs/external-review-2026-10-16.md`)의 빈틈을 D1~D8로 보강했다: 브랜치는 메시지 칸, epic 7·8은 9 뒤, 데몬 판단은 살아 있는 소켓과 `daemon start`, 데몬은 자기가 낡았을 때만 종료, 가리기는 복제 대상에도 전파, 규칙이 hook 상한을 넘으면 생략 줄과 doctor `fail`, 첫 요청 문장은 꺼내 씀, spool 레코드는 회수하고 10번 실패하면 보존(사용자).
- Decision(2026-10-19, `change-masking-b-and-review-fixes/`): 비밀은 저장할 때가 아니라 나갈 때 가린다(마스킹 B, 2026-10-18 사용자). Core 출력 코덱이 가리고, 색인은 원문 위다. 내보내기와 Drive 스냅샷도 가린다. 결정 검토 수정 넷(parser peer handback, 프로젝트 비교 키와 꼬리표 다시 채우기, `failed_stage` 강제, 도구 메모 가리기 기록)과 함께 epic 2에 스토리 17~20을 더했다(사용자).
- Decision(2026-10-20, `change-discipline-and-metrics/`): 벤더 메모리·graphify 비교 뒤 보강 넷을 인셉션 입력으로 더했다 — Stop hook 기록 점검(epic 3, 토글, 둘째 주에 켜서 SM-4a 비교), `stats show`(epic 5), 검색 회귀 러너와 `recall --count`(epic 4). graphify는 도입하지 않는다(가끔 미러 위에 돌리는 분석 층). 두 번째 하네스 수집은 slice 1 밖이고 조건은 spine Deferred에 있다(사용자).
- Decision(2026-10-26, `change-v1-capture-and-drive/`, 사용자): V1은 대화 수집 + 파일·Drive 수집이다. 순서는 1·2 → 9(가벼운 데몬) → 10(축소) → 5(로컬 백업) → 8(Drive, 문서·폴더명 검색 포함). epic 3·7·6과 4·5의 나머지는 V1 뒤(backlog, 삭제 아님). 데몬은 기본 상주 런타임이고 launchd는 데몬을 띄우고 다시 띄우는 데만 쓴다. 5분 주기 drain LaunchAgent, 두 Label 전환(`[daemon] enabled`), 데몬 켜짐·꺼짐 양쪽 검증은 없앤다. 사용자 스케줄러(배치·예약을 등록하면 그 시각에 실행)는 두 기능 다음의 첫 상주 기능이다.
- Decision(2026-10-26, 진행 방식, 사용자): 에픽 사전 조사는 새 불확실성만 한 편. validate-set은 한 번(고위험 항목만 재검증). plan은 목적·쓰기 경계·재사용 API·완료 조건·위험만. 리뷰는 원본 삭제·마이그레이션·파서·인증·기존 데이터 변경 스토리에만 하고 단순 연결·문서 작업은 생략. 플러그인 배포(app-ref·version)는 기능 묶음마다. Postgres 테스트는 Postgres 코드나 공용 Store 계약을 바꿀 때만. build·typecheck, 마이그레이션·멱등·잠금·삭제 경계 테스트, 마지막 실계정 확인은 유지한다.
- Note(2026-10-26, 트리 검증 제안): V1 에픽(9·10·5·8)은 인셉션 때 Done when에 "기능 묶음이 플러그인 배포(app-ref·version)로 이 Mac의 설치본에 들어가 동작한다"는 확인을 붙인다. V1 뒤 에픽(3·4·7·6)에는 상태 칸이 없고, 순서와 에픽 전체 대기(`after`에 epic-drive)로 미룬 것을 나타낸다.
