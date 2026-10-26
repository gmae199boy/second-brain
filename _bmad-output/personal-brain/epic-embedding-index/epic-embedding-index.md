---
type: epic
title: "임베딩 선택 색인"
parent: personal-brain
covers: [CAP-6]
after: ["epic-recall-and-mirror"]
assignee: ""
risk: low
---

# 임베딩 선택 색인

## Description

Model Studio 임베딩·재순위 adapter, 설치기의 임베딩 켜기, sqlite-vec 차원 고정 테이블(확장은 임베딩 경로 연결에서만 `allowExtension`), `index rebuild`의 임베딩 확장, `INDEX_CONFIG_MISMATCH`·`RERANK_FAILED` 경고를 만든다. SM-3이 기본 구성으로 미달일 때 착수한다.

## Outcome

키워드와 질의 바꾸기로 놓치는 "왜"·한영 교차 질문을 임베딩으로 메운다(SM-3).

## Requirements

인셉션 때 채운다. spec의 CAP-6와 그것이 인용하는 PRD FR·spine AD가 원천이다.

## Done when

1. 설정에서 임베딩을 켜면 기존 조각과 작업 로그가 색인되고, 끄면 키워드 검색만 남는다.
2. 재순위가 응답하지 않으면 벡터 순위 그대로 `RERANK_FAILED`와 함께 돌아온다.
3. 모델·차원을 바꾸고 `index rebuild`하면 재색인 중에도 옛 색인으로 검색되고, 끝나면 교체된다.
4. 임베딩을 켠 구성으로 SM-3을 재고, 기본 구성과 비교한 결과가 기록된다. doctor가 재순위 실패와 외부 전송 대상을 보인다.

## Boundaries

AD-15, Table Contract(embeddings, index_configs). 기본 구성에서는 외부 전송이 없어야 한다(NFR-6).

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-6
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md
- prd — _bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md
- inputs — _bmad-output/personal-brain/inputs/weknora-patterns.md, §2 (조건부: sqlite-vec vec0 확인·`k` 필수·트랜잭션 밖 생성, RRF k=60·벡터 0.7/키워드 0.3, 질의 임베딩 2초 초과면 키워드만)

## Notes

- Decision(2026-10-14): 임베딩은 지금 하지 않는다. 에픽 순서의 맨 뒤로 옮겼다(사용자). 벡터 저장은 pgvector가 아니라 sqlite-vec.
- Note(2026-10-19, `../change-masking-b-and-review-fixes/`, 인셉션 입력): 마스킹 B. 임베딩·재순위 요청은 출력 코덱이고 보내는 텍스트는 가린 텍스트다. 색인 행은 원문 조각을 가리킨다(spine AD-11·15).
- Decision(2026-10-26, `../change-v1-capture-and-drive/`, 사용자): V1 뒤(backlog). 순서는 그대로 맨 뒤.
