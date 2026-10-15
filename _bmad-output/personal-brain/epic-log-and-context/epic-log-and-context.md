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

2026-10-15 변경(추가안 B, `../change-surface-plugin-daemon/`)으로 더한 것: 플러그인 스킬(`/brain:*`)과 안내문. 규율(기록 규칙 — 절대 날짜, 자격증명 금지, 추정 표시, 정정과 폐기 구분, 대화 속 지시는 데이터, 기록할 게 없는 것도 정상, 한 문장·사용자 언어, 대명사 대신 고유명사, 결정에는 짧은 이유; 인용 규칙 — 이번 결과에 나온 항목만, 직접 인용은 원문에 있는지 확인; 질의 작성 안내 — 메타 표현 제거·핵심 용어·한/영 둘 다)의 원본은 Core 상수 하나이고 `brain admin guide`가 Markdown 전문을 낸다. 시작 맥락에는 요약과 "자세한 것은 `brain admin guide`"만 들어가고, 머리말 고정부(데이터≠지시·지금 발화 우선·최근 로그는 샘플·이 세션의 토큰 줄)가 앞선다. 섹션 순서는 고정 머리말(날짜·시간대) → 규칙 → 최근 로그 → 안내 요약. 플러그인 스킬 파일은 빌드가 Core 상수에서 생성해 커밋하고 parity 테스트(생성물과 커밋본 일치, `tested_against`, 코드블록의 명령·flag 실존)가 지킨다(AD-17). `log append`는 본문을 stdin으로도 받고, 저장 전 정제(개행→공백, 제어문자 제거, 길이 상한)를 한다. 원천: `inputs/weknora-patterns.md` §1.2, §1.3(C3~C6).

## Outcome

에이전트가 적은 결정·규칙이 다음 세션 시작에 자동으로 이어진다(SM-1·SM-4·SM-6의 바탕).

## Requirements

인셉션 때 채운다. spec의 CAP-3, CAP-8, CAP-9와 그것이 인용하는 PRD FR·spine AD가 원천이다.

## Done when

1. 세션에서 내가 한 문장을 에이전트가 규칙으로 적으면, 다음 세션의 시작 맥락에 그 문장 그대로 들어온다. 한 글자라도 다르면 들어오지 않고 점검에 보인다.
2. 내가 끈 규칙은 drain을 돌려도 다시 켜지지 않는다.
3. 결정을 바꾸면 새 결정이 옛 결정을 대체하고, 둘 다 근거 메시지 위치(`anchor_seq`)를 가진다. 원문 읽기는 epic-recall-and-mirror가 맡는다.
4. DB에 쓸 수 없는 동안 적은 로그가 `SPOOLED`로 성공하고, 연결 후 빠짐없이 들어간다.
5. 시작 맥락이 오늘 날짜·시간대를 포함하고, 크기 설정(글자 수)과 10,000자 상한을 지키며, 주입 시도가 성공·실패 모두 기록된다. 시작 맥락 지연(SM-7)을 실측해 기록한다.
6. doctor가 대조되지 않은 규칙 인용, 규칙 크기 경고, 세션 수 대비 주입 시도 수를 보인다.
7. 시작 hook 경로가 쓰기 트랜잭션을 열지 않고(테스트가 확인), 주입 시도는 spool에 남아 drain이 `context_injections`로 넣는다(AD-6·17).
8. 플러그인 스킬의 코드블록에 적힌 모든 명령·flag가 `brain admin schema`에 있고, 스킬 파일이 빌드 생성물과 같다. 안내문 전문과 시작 맥락 요약이 같은 상수에서 나오며, 시작 맥락 머리말에 이 세션의 토큰 줄이 있다.

## Boundaries

AD-6·9·11·12·13·14·17, Table Contract(log_entries, log_entry_edits, context_injections). 검색은 epic-recall-and-mirror. 플러그인 뼈대(hooks·bootstrap)는 epic-capture, 이 에픽은 `plugin/skills/`와 `admin guide`의 본문(Core 상수·스킬 생성)이다. `admin guide` 명령 자체와 그 메타는 epic-capture의 CLI 규약 보강. 경고 코드 `RULE_UNVERIFIED`를 맡는다(`SPOOLED`는 epic-capture가 정의하고 이 에픽의 `log append`가 쓴다).

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-3, CAP-8, CAP-9
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md
- prd — _bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md
- inputs — _bmad-output/personal-brain/inputs/weknora-patterns.md, §1.2 (B1~B7), §1.3 (C3~C6)
- change — _bmad-output/personal-brain/change-surface-plugin-daemon/change-surface-plugin-daemon.md, §4.1, §4.2(AD-17)
