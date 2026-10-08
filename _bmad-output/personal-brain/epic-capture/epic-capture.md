---
type: epic
title: "세션 수집과 비밀 가리기"
parent: personal-brain
covers: [CAP-1, CAP-2]
after: ["epic-foundation-and-install"]
assignee: ""
risk: high
---

# 세션 수집과 비밀 가리기

## Description

Claude Code transcript parser, `sessions.ensure`, 턴마다 증분 수집(세션 잠금), 프로젝트·워크트리 식별(git remote 정규화)과 `sessions assign-workspace`, Claude Code connector와 hook 등록(`setup connect`), drain(실패 재시도·transcript 폴더 스캔), spool(스키마 불일치 포함), `sessions failures`·`sessions retry`, 저장 전 비밀 마스킹과 `messages redact`를 만든다.

## Outcome

Claude Code 세션이 손대지 않아도 비밀이 가려진 채 빠짐없이 쌓인다.

## Requirements

인셉션 때 채운다. spec의 CAP-1, CAP-2와 그것이 인용하는 PRD FR·spine AD가 원천이다.

## Done when

1. 이 기계의 Claude Code 세션 수와 Brain 세션 수가 같다(SM-5).
2. 같은 transcript를 두 번 수집해도 모든 테이블의 건수가 같고, 같은 세션의 Stop hook이 겹쳐도 seq 충돌이 없다.
3. 세션 도중 프로세스를 죽여도 마지막 턴까지 남고, DB를 내렸다 올리면 그동안의 수집이 drain으로 채워진다.
4. 알려진 비밀 패턴이 든 세션의 저장 본문에 그 값이 없고, `brain messages redact`로 가린 부분은 DB 어디에도 남지 않는다.
5. 같은 레포의 두 워크트리 세션이 한 프로젝트(git remote 정체성)로 묶이고, 프로젝트 없는 세션을 워크스페이스에 넣을 수 있다.
6. `brain setup connect claude-code`를 여러 번 돌려도 hook이 한 번만 등록되고, doctor가 미수집 세션·실패 수집·spool 건수·마지막 hook 수신 시각을 보인다.

## Boundaries

AD-4·6·7·8·9·11·12·13, Table Contract(projects, worktrees, workspaces, sessions, messages, tool_notes, redactions, failures, transcript_files). 경고 코드 `SPOOLED`·`CURSOR_RESET`·`DB_UNAVAILABLE`의 spool 경로를 맡는다. 작업 로그는 만들지 않는다(epic-log-and-context). 미러는 epic-recall-and-mirror.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-1, CAP-2
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md
- prd — _bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md
