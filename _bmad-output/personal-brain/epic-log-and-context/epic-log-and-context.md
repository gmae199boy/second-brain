---
type: epic
title: "작업 로그와 시작 맥락"
parent: personal-brain
covers: [CAP-3, CAP-8, CAP-9]
after: ["epic-capture"]
assignee: ""
risk: high
---

# 작업 로그와 시작 맥락

## Description

`brain log append/list/edit/set-state/set-scope`, 로그-대화 연결, 규칙 인용 대조(pending/on/off), 결정·선호 대체 체인, `brain context show`와 시작 hook 주입, 주입 시도 기록, 기록 규율 안내문을 만든다.

## Outcome

에이전트가 적은 결정·규칙이 다음 세션 시작에 자동으로 이어진다(SM-1·SM-4·SM-6의 바탕).

## Requirements

인셉션 때 채운다. spec의 CAP-3, CAP-8, CAP-9와 그것이 인용하는 PRD FR·spine AD가 원천이다.

## Done when

1. 세션에서 내가 한 문장을 에이전트가 규칙으로 적으면, 다음 세션의 시작 맥락에 그 문장 그대로 들어온다. 한 글자라도 다르면 들어오지 않고 점검에 보인다.
2. 내가 끈 규칙은 drain을 돌려도 다시 켜지지 않는다.
3. 결정을 바꾸면 새 결정이 옛 결정을 대체하고, 둘 다 근거 메시지 위치(`anchor_seq`)를 가진다. 원문 읽기는 epic-recall-and-mirror가 맡는다.
4. DB가 꺼진 동안 적은 로그가 `SPOOLED`로 성공하고, 연결 후 빠짐없이 들어간다.
5. 시작 맥락이 오늘 날짜·시간대를 포함하고, 크기 설정(글자 수)과 10,000자 상한을 지키며, 주입 시도가 성공·실패 모두 기록된다. 시작 맥락 지연(SM-7)을 실측해 기록한다.
6. doctor가 대조되지 않은 규칙 인용, 규칙 크기 경고, 세션 수 대비 주입 시도 수를 보인다.

## Boundaries

AD-6·9·11·12·13·14·17, Table Contract(log_entries, log_entry_edits, context_injections). 검색은 epic-recall-and-mirror.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-3, CAP-8, CAP-9
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md
- prd — _bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md
