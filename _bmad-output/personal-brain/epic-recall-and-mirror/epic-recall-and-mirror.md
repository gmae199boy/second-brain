---
type: epic
title: "조회와 미러"
parent: personal-brain
covers: [CAP-4, CAP-5, CAP-6, CAP-7, CAP-13]
after: ["epic-capture", "epic-log-and-context"]
assignee: ""
risk: medium
---

# 조회와 미러

## Description

조각 생성(drain), 키워드 검색(`pg_trgm`), `brain recall time/logs/chunks/tools/expand`, `brain sessions list/read`, 결과 계약(출처·근접 정렬·8,000자), 세션별 Markdown 미러와 `admin mirror-rebuild`, 조각 색인을 다시 만드는 `admin reindex`(키워드 구성), `log`·`recall` 직전 증분 수집을 만든다.

## Outcome

"지난주에 뭐 했지", "그거 왜 그렇게 했지"에 날짜와 근거 대화가 붙은 답이 나온다(SM-2, SM-3).

## Requirements

인셉션 때 채운다. spec의 CAP-4, CAP-5, CAP-6, CAP-7, CAP-13와 그것이 인용하는 PRD FR·spine AD가 원천이다.

## Done when

1. "어제·지난주·특정 날짜" 시간 조회가 프로젝트를 가리지 않고 시간순으로 나오고, 기록이 없는 기간은 빈 결과다.
2. SM-3 채점표(addendum §8)를 기본 구성으로 잴 수 있고, 결과가 기록된다.
3. 모든 결과의 출처만으로 `recall expand`·`sessions read`가 원문까지 내려간다.
4. 한 번의 결과가 8,000자를 넘으면 잘리고 `RESULT_TRUNCATED`가 붙는다.
5. 미러를 지우고 `admin mirror-rebuild`로 다시 만들면 같은 내용이고, 미러를 고쳐도 DB는 변하지 않으며, 가린 세션의 미러에는 가린 값이 없다.
6. `admin reindex`로 조각을 비우고 다시 만들어도 원문·로그·출처가 변하지 않고, 미색인 세션은 `UNINDEXED`로 표시된다. 조회 지연(SM-7)을 실측해 기록하고, doctor가 색인 설정과 실패 색인을 보인다.

## Boundaries

AD-13·15·16, Table Contract(chunks, index_configs). 임베딩은 epic-embedding-index.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-4, CAP-5, CAP-6, CAP-7, CAP-13
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md
- prd — _bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md
