---
type: epic
title: "세션 수집과 비밀 가리기"
parent: personal-brain
covers: [CAP-1, CAP-2, CAP-14]
after: ["epic-foundation-and-install"]
assignee: ""
risk: high
---

# 세션 수집과 비밀 가리기

## Description

Claude Code transcript parser, `sessions.ensure`, 턴마다 증분 수집(세션 잠금), 프로젝트·워크트리 식별(git remote 정규화)과 `sessions assign-workspace`, Claude Code connector와 hook 등록(`setup connect`), drain(실패 재시도·transcript 폴더 스캔), spool(스키마 불일치 포함), `sessions failures`·`sessions retry`, 저장 전 비밀 마스킹과 `messages redact`를 만든다.

2026-10-14 변경으로 더한 것: SQLite `SessionStore`(ensure·ingest·readSession)와 계약 사례, 쓰기는 `withWrite`, `seq`는 원본 Store가 배정(AD-4·8), 시작 hook은 읽기 전용이고 세션 행은 첫 수집이 만듦(AD-6), 일감 대기열 `work_items`(미완료 `(kind, target_kind, target_id)` 하나, 짧은 쓰기 트랜잭션 청구, 종류별 청구 기간·지수 재시도 Core 상수, 10회 실패 시 `failures`, AD-21)와 모든 명령의 기회적 drain, `FileStore` port와 계약 테스트(`brain` 소유이면서 루트 안인 위치만 쓰고 지움) 및 로컬 구현, 첨부 원본 저장과 메시지 연결, 문서 텍스트 추출 일감(세대·상태, `files reindex`), 고아 블롭 정리, 가리기 연쇄와 `files redact`(AD-11·23·24).

## Outcome

Claude Code 세션이 손대지 않아도 비밀이 가려진 채 빠짐없이 쌓인다.

## Requirements

인셉션 때 채운다. spec의 CAP-1, CAP-2와 그것이 인용하는 PRD FR·spine AD가 원천이다.

## Done when

1. 이 기계의 Claude Code 세션 수와 Brain 세션 수가 같다(SM-5).
2. 같은 transcript를 두 번 수집해도 모든 테이블의 건수가 같고, 같은 세션의 Stop hook이 겹쳐도 seq 충돌이 없다.
3. 세션 도중 프로세스를 죽여도 마지막 턴까지 남고, DB에 쓸 수 없는 동안(잠금 시간 초과·스키마 불일치)의 수집이 spool에 남았다가 쓸 수 있게 되면 drain으로 채워진다. 시작 hook만 돈 세션은 세션 행을 만들지 않고 첫 수집이 만든다.
4. 알려진 비밀 패턴이 든 세션의 저장 본문에 그 값이 없고, `brain messages redact`로 가린 부분은 DB 어디에도 남지 않는다.
5. 같은 레포의 두 워크트리 세션이 한 프로젝트(git remote 정체성)로 묶이고, 프로젝트 없는 세션을 워크스페이스에 넣을 수 있다.
6. `brain setup connect claude-code`를 여러 번 돌려도 hook이 한 번만 등록되고, doctor가 미수집 세션·실패 수집·spool 건수·마지막 hook 수신 시각을 보인다.
7. 첨부가 있는 세션에서 원본이 저장소에 한 번만 남고 메시지에서 위치를 받을 수 있으며, 텍스트 문서는 추출 세대가 생기고 추출 실패는 표시된다. 가린 첨부의 내용은 조각·검색 어디에도 남지 않는다.
8. compact 뒤 다시 수집해도 기존 메시지의 `seq`와 본문이 그대로다. 겹친 drain 두 개가 같은 일감을 두 번 처리하지 않고, 10번 실패한 일감은 `failures`에 남고 멈춘다.

## Boundaries

AD-4·6·7·8·9·11·12·13·21·23·24, Table Contract(projects, worktrees, workspaces, sessions, messages, tool_notes, redactions, failures, transcript_files, work_items, files, file_locations, message_attachments, document_extractions, document_chunks). 경고 코드 `SPOOLED`·`CURSOR_RESET`·`DB_UNAVAILABLE`·`ATTACHMENT_NOT_REDACTED`를 맡는다. 문서 검색은 epic-recall-and-mirror, Drive 저장소 구현은 epic-drive. 작업 로그는 만들지 않는다(epic-log-and-context). 미러는 epic-recall-and-mirror.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-1, CAP-2
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md
- prd — _bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md

## Notes

- Decision(2026-10-14): 원본 SQLite 전환과 추가안 A(첨부·추출)로 범위가 늘었다. 인셉션 때 다시 나눈다. 꼬리표 권위 출처와 `failures.fingerprint` 정의는 인셉션에서 정한다(spine Deferred).
