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

Personal Brain V1 slice 1. Claude Code 세션을 자동으로 수집하고, 일하는 에이전트가 결정·규칙·진행·선호를 그 순간에 적고, 넓은 것에서 원문으로 찾는다. 기능·제약·비목표는 spec이 갖고, 구현 불변식은 architecture spine(AD-1~28, Table Contract)이 갖는다.

## Outcome

새 세션에서 다시 설명하지 않고 이어간다. 신호는 spec의 Success signal(SM-1 ≥ 80%, SM-2 ≥ 90%, SM-3 통과, LLM 호출 0)이다.

## Done when

1. 빈 Mac에서 설치기 한 번으로 설치되고, 이후 Claude Code 세션이 손대지 않아도 빠짐없이 수집된다(SM-5 = 0).
2. 2주 실사용에서 SM-1 ≥ 80%, SM-2 ≥ 90%, SM-4(a)(b) ≥ 80%이다.
3. SM-3 채점표를 기본 구성(키워드 + 질의 바꾸기)으로 통과하거나, 미달이면 임베딩을 켠 구성으로 통과한다.
4. 내보내기에서 되살린 Brain의 메시지 수와 작업 로그 수가 원래와 같다.
5. 실사용 기간 동안 Brain의 LLM 호출은 0이고, 조용한 실패가 없다(점검에 드러나지 않은 실패 0).

## Boundaries

spec의 기능 단위로 에픽을 나누고, 바탕 공사는 첫 에픽이 맡는다. spec Non-goals를 따른다(팀 공유, Claude Code 외 Harness 수집 제외. MCP·데몬은 V1 뒤 epic 9). 첫 시연 경로: 세션에서 규칙을 말하면 로그로 적히고, 다음 세션 시작에 자동으로 들어온다(epic 1 → 2 → 3). epic 10은 2와 3 사이에 있지만 시연 경로 밖이라, 시연이 한 에픽 늦게 온다.

- Touch point: Claude Code 플러그인 체계(marketplace·`/plugin install`·hook 계약·`.mcp.json`) — hook·설치 진입점; owner: epic-capture(hook·bootstrap·node 런처), epic-log-and-context(skills, SessionStart 동기 `context show` hook 줄), epic-daemon(`.mcp.json`·래퍼, AD-28). `plugin/` 폴더 자체는 에픽이 만드는 코드다
- Touch point: UNIX 소켓·LaunchAgent KeepAlive — 데몬; owner: epic-daemon
- Touch point: SQLite(Node 내장 `node:sqlite`) — 원본 DB 파일; owner: epic-foundation-and-install
- Touch point: Docker·Postgres — 복제 대상; owner: epic-replicas
- Touch point: Google Drive API — 첨부 원본 저장소·외부 문서; owner: epic-drive
- Touch point: launchd — 주기 실행 LaunchAgent; owner: epic-operations
- Touch point: Model Studio — 임베딩·재순위 호출(선택); owner: epic-embedding-index
- Touch point: 문서 추출 라이브러리(`pdfjs-dist`, `mammoth`, `file-type`, `exif-reader`) — 첨부·문서 텍스트 추출과 EXIF; owner: epic-attachments

## References

- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, 전체(AD-1~28, Table Contract, Conventions)
- change — _bmad-output/personal-brain/change-local-sqlite-primary/change-local-sqlite-primary.md
- change — _bmad-output/personal-brain/change-surface-plugin-daemon/change-surface-plugin-daemon.md
- inputs — _bmad-output/personal-brain/inputs/weknora-patterns.md (각 에픽 인셉션의 입력)
- prd — _bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md, FR별 testable consequences

## Notes

- Decision: 티켓 저장소는 repo 파일(2026-10-08).
- Decision: 임베딩 선택 색인은 맨 뒤 epic 6, SM-3이 기본 구성으로 미달일 때 착수(2026-10-08).
- Decision: 운영 epic 5는 내보내기·복구를 먼저 하고, 업그레이드·제거는 그 뒤 스토리로 둔다(2026-10-08).
- Decision: 경계·순서는 초안대로. 전부 만든 뒤 테스트한다(사용자, 2026-10-08).
- Decision: 설치 진입점은 `npx github:gmae199boy/second-brain`(공개 개인 저장소)(2026-10-08).
- Decision: doctor는 epic 1이 틀과 기본 항목을 만들고, 각 에픽이 자기 항목을 더한다(2026-10-08).
- Decision: SM-1·SM-4·SM-6의 2주 실사용 측정은 이니셔티브 Done when에서 하고, 에픽은 측정 가능하게 만드는 데까지 책임진다(2026-10-08).
- Decision: spool은 epic 2. epic 1의 스키마 불일치는 쓰기를 거부하고 `SCHEMA_MISMATCH`를 내며, spool로 보내는 경로는 epic 2가 붙인다(2026-10-08).
- Waits on: 각 에픽의 선행 조건은 `tickets.toml`의 `after`에 있다.
- Decision(2026-10-14): 원본은 로컬 SQLite 파일(Docker·서버 없음). Postgres·Drive 기록 복제는 epic 7. 첨부 원본 보관과 문서 본문 검색은 V1(FR-27·28, CAP-14). Drive 연동은 API로 epic 8. 주기 실행은 launchd(epic 5). 임베딩은 지금 하지 않고 epic 6은 맨 뒤(사용자).
- Decision(2026-10-15, `change-surface-plugin-daemon/`): Claude Code 설치·hook 진입점은 플러그인, npx는 CI·사람·개발·대체 경로. 당분간 Claude Code만(Codex 제외). Node 24 이상 유지. 데몬·MCP는 epic 9(epic 5 다음, 7 앞). 확인 필요 종료 코드 3. WeKnora 흡수 목록(`inputs/weknora-patterns.md`)은 각 에픽 인셉션의 입력(사용자).
- Decision(2026-10-15, 트리 검증): epic 9는 epic 7 앞에 고정한다. 두 에픽이 `setup run`의 선택 단계·doctor 등록부·설정 코덱을 함께 건드리므로 순서를 바꾸면 충돌 비용이 든다. 설정 키 `[daemon] enabled`는 epic 5가 더하고(주기 Label 선택), 데몬 동작은 epic 9. Drive 동기화는 drain의 일감 종류로 돌아 launchd·데몬 어느 쪽이든 같은 경로다(epic 8이 9를 기다리지 않게).
- Decision(2026-10-15, 사용자): CAP-11은 다섯 에픽(1·2·5·7·9)이 각자 Boundaries의 경계 문장으로 나눠 맡는다. spec의 CAP 번호는 쪼개지 않는다. epic 7·8은 데몬 켜짐·꺼짐 둘 다에서 통과해야 한다(Done when에 추가).
- Decision(2026-10-15, epic 2 인셉션): 첨부 원본과 문서 추출을 epic-capture에서 나눠 epic 10(`epic-attachments`)으로 만들고, epic 2 바로 뒤에 둔다. CAP-14는 다섯 에픽이 나눠 맡는다.
  - epic 1: 스키마 자리(0001·0002)
  - epic 2: 0003 스키마
  - epic 10: 첨부 저장, 문서 추출, `files redact`
  - epic 4: 문서 검색
  - epic 8: Drive 저장소와 기존 Drive 문서
  - (사용자)
- Decision(2026-10-15, epic 2 인셉션): 수집 범위와 꼬리표.
  - 꼬리표는 프로젝트와 워크트리뿐이고, 근거는 첫 메시지의 transcript cwd다.
  - 워크스페이스는 slice 1에서 쓰지 않는다. 칸은 예약으로 남긴다. 회사/개인 경계는 내보내기·지우기·팀 공유를 경계 단위로 할 때 정한다.
  - 설치 때 디스크에 남은 Claude Code transcript는 한 번 가져온다. 그 밖의 과거 세션 가져오기는 그대로 범위 밖이다.
  - 서브에이전트는 최종 보고만 수집한다.
  - spec·PRD·spine 문구는 2026-10-16에 맞췄다.
  - (사용자)
