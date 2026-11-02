---
type: epic
title: "임베딩 선택 색인"
parent: personal-brain
covers: [CAP-6]
sources: [_bmad-output/personal-brain/initiative-personal-brain.md, _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md]
companions: [_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, _bmad-output/personal-brain/inputs/rag-oss-patterns.md, _bmad-output/personal-brain/inputs/rag-oss-core-architecture.md]
after: ["epic-recall-and-mirror"]
assignee: ""
refined: false
risk: low
---

# 임베딩 선택 색인

## Description

Model Studio 임베딩·재순위 adapter, 설치기의 임베딩 켜기, sqlite-vec 차원 고정 테이블(확장은 임베딩 경로 연결에서만 `allowExtension`), `index rebuild`의 임베딩 확장, `INDEX_CONFIG_MISMATCH`·`RERANK_FAILED` 경고를 만든다. SM-3이 기본 구성으로 미달일 때 착수한다. (2026-11-02: 벡터 저장은 sqlite-vec가 아니라 pgvector, adapter는 OpenAI 호환 endpoint 하나(Model Studio는 그중 하나), 재순위는 기본 없음, 확장이 아니라 core 선택 기능. Notes 2026-11-02 참조. 인셉션 때 이 문단을 다시 쓴다.)

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
- inputs — _bmad-output/personal-brain/inputs/rag-oss-patterns.md, §2 R7~R12·§3.3 (2026-11-02 채택 companion: RRF·하한·에이전트 가중치·임베딩 캐시 키·제목 접두·미니 조각, 재순위 제외)
- inputs — _bmad-output/personal-brain/inputs/rag-oss-core-architecture.md (2026-11-02 채택 companion: 네 RAG 앱의 저장·검색 구조 비교, §2 결론 1·2·4)

## Notes

- Decision(2026-10-14): 임베딩은 지금 하지 않는다. 에픽 순서의 맨 뒤로 옮겼다(사용자). 벡터 저장은 pgvector가 아니라 sqlite-vec.
- Note(2026-10-19, `../../change-masking-b-and-review-fixes/`, 인셉션 입력): 마스킹 B. 임베딩·재순위 요청은 출력 코덱이고 보내는 텍스트는 가린 텍스트다. 색인 행은 원문 조각을 가리킨다(spine AD-11·15).
- Decision(2026-10-26, `../../change-v1-capture-and-drive/`, 사용자): V1 뒤(backlog). 순서는 그대로 맨 뒤.
- Note(2026-10-28, `../../prep-garmin-absorption/`, 인셉션 입력): 저장소가 PostgreSQL 하나로 바뀌어 2026-10-14의 "pgvector가 아니라 sqlite-vec" 결정의 근거(원본이 SQLite)가 없어졌다. 벡터 저장은 인셉션 때 다시 정한다. pgvector는 Garmin 흡수의 선행 조건이 아니다(이니셔티브 C2).
- Decision(2026-10-28, 사용자): 임베딩 선택 색인은 나중에 확장(extension)으로 만든다. 지금은 구현하지 않고, 남은 에픽을 이어 만드는 무인 파이프라인(V1과 V1 뒤 5·3·4)에서 뺀다. 착수할 때 확장 계약(AD-29·30·33, epic 13) 위에서 다시 정의한다. 이 에픽 파일과 `tickets.toml`의 자리는 그때의 입력으로 남긴다.
- Decision(2026-11-02, 추천으로 정함 → 같은 날 사용자 승인): 2026-10-28의 "확장으로 만든다"를 바꾼다. 임베딩은 확장이 아니라 **core의 선택 기능**이다. 이유: 임베딩은 새 출처가 아니라 core 조각 위의 파생 색인이고 그것을 읽는 건 core 검색이라, 확장으로 두면 core가 확장 표를 질의해야 해 AD-29("core는 확장을 부르지 않는다")를 깬다. 확장을 둔 이유였던 "미설치 Brain에 런타임 요구 금지"는 임베딩을 HTTP 엔드포인트 호출로 두면 저절로 지켜진다. 모양: pgvector 열, 설정 `embedding.endpoint`·`embedding.model`(기본 비어 있음 = 꺼짐), 모델이 어디서 도는지는 Brain 밖. 벡터 저장은 pgvector. 외부 앱(RAGFlow·Onyx·Open WebUI·AnythingLLM)은 붙이지 않고 공식·수치만 가져온다. 재순위는 기본 없음(에이전트가 고른다). 착수 조건은 그대로 SM-3 미달.
- Note(2026-11-02, 인셉션 입력): `../../inputs/rag-oss-patterns.md` §2 R7~R12(RRF·하한·에이전트 가중치·임베딩 캐시 키·제목 접두·미니 조각)와 §3.3(재순위 제외). `weknora-patterns.md` §2의 가중 방향(벡터 0.7)과 R7(키워드 0.7)이 충돌하므로 인셉션에서 하나로 정한다. 추천은 키워드 우선.
- Note(2026-11-02, 인셉션 입력, 설정·비밀·모델 결정 방식): AD-18 세 층과 epic 18(E18-4)의 선례를 그대로 쓴다. 사용자 설정 `embedding.endpoint`(OpenAI 호환 `/v1/embeddings` URL, 비어 있으면 꺼짐. 별도 on/off 키 없음), `embedding.model`, `embedding.dimensions`, `embedding.api_key_env`(환경 변수 이름, 기본 `BRAIN_EMBEDDING_API_KEY`), `embedding.timeout_seconds`. 키 값은 `.env`에만. 켜는 순간 `index_configs`에 `(embedding, model, dimensions, chunk_params)` 불변 행을 만들고 모델·차원 변경은 새 행 + `index rebuild`(AD-15, Done when 3). adapter는 OpenAI 호환 하나(Model Studio 호환 모드·Ollama·LM Studio·vLLM·OpenAI 공통), 공급자 개념 없음. Brain은 기본 모델을 고르지 않는다(NFR-6 기본 꺼짐). 호출은 일감 안에서만(AD-33), 입력은 출력 코덱을 거친 가린 텍스트(마스킹 B). doctor: 키 존재, endpoint 1회 호출로 차원 일치 확인, localhost 아닌 endpoint는 외부 전송 대상으로 표시, 미색인 조각 수. endpoint 불통은 E18-4와 같이 다시 하지 않는 오류로 `failures`에.
