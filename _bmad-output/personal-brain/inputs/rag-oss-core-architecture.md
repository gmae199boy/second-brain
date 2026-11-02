# RAG 오픈소스 넷의 핵심 구조 비교 — 동기화·저장·검색

- 작성: 2026-11-02. 대상과 읽은 방법은 `rag-oss-patterns.md` 머리와 같다(얕은 클론, 실행 없음). 근거 경로는 각 저장소 기준이다.
- 용도: "어디에 어떻게 저장하고 어떻게 찾는가"를 Brain의 결정(AD-15·23·24·30, epic 8·17·6)과 나란히 놓는다. 채택 후보는 `rag-oss-patterns.md`에 번호로 적었고, 이 문서는 그 근거다.
- 한 줄 결론: 넷 다 **원본 바이트 + 문서 행 + 별도 검색 엔진의 조각** 세 겹이고, 조각은 언제든 다시 만드는 파생물이다. Brain이 PostgreSQL 하나에 셋을 다 두는 것은 Open WebUI의 pgvector 구성과 같은 모양이라 특이한 선택이 아니다. 차이는 "검색 엔진을 따로 두느냐"뿐이다.

## 1. 프로젝트별

### 1.1 Onyx (Python, Postgres + OpenSearch + S3/Postgres large object)

**동기화·수집.** connector(소스별) → `IndexAttempt`(connector·credential 쌍마다) → 두 단계. (1) docfetching: connector가 체크포인트(JSON, 파일 저장소에 보관, 크기 상한)를 받아 문서 배치를 내고, 배치를 **파일 저장소에 직렬화**해 둔다(`file_store/document_batch_storage.py`, 접두 `iab/`). (2) docprocessing: 배치를 읽어 조각·임베딩·색인. 증분 창은 "마지막 성공 attempt의 창 끝 − 30분"(`POLL_CONNECTOR_OFFSET`, `run_docfetching.py` `_get_incremental_window_start`). 갱신 판정은 두 관문(`indexing_pipeline.py` `get_docs_to_update`): `doc_updated_at`이 안 늘었고 → `content_hash`가 같으면 건너뜀. **해시는 색인 쓰기가 확인된 뒤에만 저장**(그 전에 저장하면 다음 sync가 영원히 건너뜀). 삭제 감지는 slim 목록(id만) 전체 대조. 문서별 실패는 `IndexAttemptError` 행. 색인 중 문서 행 잠금.

**저장.** Postgres `document`(id, semantic_id, link, file_id, doc_updated_at, chunk_count, content_hash, last_modified, last_synced, boost, hidden, owners, doc_metadata, parent_hierarchy_node), `document_by_connector_credential_pair`, `file_record`(bucket, object_key, file_origin, metadata) + `file_content`(lobj_oid: **Postgres large object**가 기본 파일 저장소, S3·GCS·Azure 선택). 조각은 Postgres에 없고 OpenSearch에만 있다. 색인 스키마(`document_index/opensearch/schema.py`): `title`(text, 언어 analyzer), `content`(text), `content_vector`(knn_vector, lucene hnsw, cosine, M=32, ef_construction=256, ef_search=500), 필터용 keyword(source_type, metadata_list, acl, document_sets, document_id, chunk_index, hierarchy), 날짜, `blurb`, `doc_summary`, `chunk_context`, `metadata_suffix`, `image_file_id`, `source_links`, `max_chunk_size`. 문서 재색인 = `delete_by_query(document_id)` 뒤 bulk insert(`opensearch_document_index.py` `index`). 임베딩 모델 교체 = primary/secondary 두 색인에 동시 쓰기 뒤 전환(`OpenSearchIndexPair`, `port_reembed.py`).

**검색.** `context/search/pipeline.py` `search_pipeline`: 필터 조립(ACL·기간·소스·문서집합) → 불용어 제거한 keywords → `search_chunks` → OpenSearch `hybrid` 질의 하위 둘: [knn `content_vector` k=500] + [bool should: match title ×0.1, match_phrase title slop1 ×0.2, match content ×1.0, match_phrase content slop1 ×1.5, minimum_should_match 1] → search pipeline의 min_max(또는 z_score) 정규화와 가중 합(alpha 0.5) → 하이라이트(unified, 조각당 100자 × 4개, `<hi>` 태그) → **같은 문서의 인접 조각을 한 섹션으로 합침**(`merge_individual_chunks`: chunk_id가 1 차이면) → 사용자별 가리기. 기각한 것(코드 주석): minimum_should_match 높이기(의미 질의는 키워드 비율이 낮다), fuzziness AUTO(recall이 오히려 나빠짐). 재순위는 검색 설정에서 뺐다.

### 1.2 RAGFlow (Go 재작성판, MySQL/Postgres + Elasticsearch·Infinity·OpenSearch 등 + MinIO/S3)

**동기화·수집.** syncer(NATS JetStream 큐, DB가 진실): connector가 `SourceDocument{SourceID(webViewLink 정규형), Fingerprint(메타데이터 해시), FetchRef(지연 내려받기), UpdatedAt}`를 배치로 내고 → fingerprint가 같으면 건너뜀 → upsert → `document` 행 + 원본 바이트를 MinIO(bucket=kb_id, key=location) → ingestion task(`ingestion_task`: document_id, schema=DSL, status, component_total) → **파이프라인 DSL**(canvas) 템플릿(`ingestion/pipeline/template/*.json`: general·book·paper·qa·table·one…): File → Parser → Chunker → Tokenizer → (Extractor: LLM 키워드·질문·요약·태그) → 엔진 insert. 단계 출력은 kvrocks `chunkcache`(7일 TTL)에 두어 재개한다. 삭제 감지는 slim 전체 목록 뒤 `DeleteStale`. 오류는 transient/non_transient 두 급으로 재시도 예산이 다르다(`syncer/transient_error.go`: 4회/3회).

**저장.** `document`(kb_id, parser_id, parser_config, pipeline_id, location, size, token_num, chunk_num, progress, progress_msg, content_hash, status), `file`·`file2document`(파일 트리와 문서의 N:M), `knowledgebase`(embd_id, similarity_threshold, vector_similarity_weight, pagerank, 각종 파생 작업 id). 조각은 엔진에만, tenant마다 색인 하나(`ragflow_<tenant>`)에 `kb_id`로 구분. 매핑(`conf/mapping.json`)은 **접미사 동적 템플릿**: `*_tks`(text, whitespace analyzer, 스크립트 유사도 = IDF × min(freq,1): 빈도 무시), `*_ltks`(text, whitespace), `*_kwd`·`*_id`(keyword), `*_int`·`*_flt`·`*_dt`, `q_*_vec`(dense_vector cosine), `*_fea`(rank_feature). **토큰화를 앱이 하고 공백 결합 문자열로 넣어** 엔진이 바뀌어도 같다. 조각 한 건(`schema/chunk_types.go` `ChunkDoc`): text, doc_type, title_tks/sm, content_ltks/sm, page_number, positions, top_int, questions, keywords, summary, context_above/below, img_id, table, mom(부모 조각).

**검색.** `service/nlp/retrieval.go`: 질의 → 자체 토크나이저·용어 가중(`term_weight.go`) → `query_string` best_fields on `title_tks^10 title_sm_tks^5 important_kwd^30 important_tks^20 question_tks^20 content_ltks^2 content_sm_ltks`, minimum_should_match 30% → knn `q_<dim>_vec`(k 1024, num_candidates 2048, similarity ≥ 0.2) → 엔진 융합은 0.001/1(벡터 recall용) → **앱에서 재채점** sim = 0.7·tsim + 0.3·vsim(+pagerank) → 하한 0.2 → 페이지 → 문서별 집계(`Aggs`) → 하이라이트(정규식). 0건이면 30%→10%→벡터만. 에이전트용 도구(`agentic_rag/`): grep_chunks·search_bm25_chunks·search_semantic_chunks·search_chunks(hybrid, 질의당 가중)·list_chunks(원문).

### 1.3 Open WebUI (Python, SQL + 선택 벡터 DB + 로컬/S3)

**수집.** 업로드 → `file` 행(filename, path, `data.content`=추출 전문, `hash`=전문 sha256, meta) → loader(Tika·Docling 등) → `routers/retrieval.py` `save_docs_to_vector_db`: 같은 collection에 같은 hash가 있고 file_id가 다르면 중복으로 거부 → 분할(RecursiveCharacter `rag.chunk_size`/`chunk_overlap`, 선택 markdown 헤더 분할) → 임베딩 → collection `file-<id>`에 넣고, 지식베이스에 더하면 **그 지식베이스 collection에 벡터를 한 번 더** 넣는다(벡터가 collection마다 복제). 소스 동기화는 없다(Drive picker는 1회 가져오기). 재색인 = collection 삭제 뒤 재추가.

**저장.** `file`, `knowledge`, `knowledge_file`(knowledge_id, file_id, directory_id). 원본은 로컬 uploads 또는 S3·GCS·Azure. 벡터는 교체 가능한 VectorDB(기본 chroma). **pgvector 구현**(`retrieval/vector/dbs/pgvector.py`)은 표 하나 `document_chunk(id, vector, collection_name, text, vmetadata JSONB)` + hnsw(또는 ivfflat) + `GIN (to_tsvector('simple', text))`. Brain이 pgvector를 더하면 정확히 이 모양이다(text·locator는 이미 `document_chunks`에 있음).

**검색.** `retrieval/utils.py` `query_collection(_with_hybrid_search)`: collection마다 벡터 top-k + BM25(네이티브면 pgvector `plainto_tsquery('simple')`, 아니면 **collection 전체 텍스트를 메모리에 올려 rank_bm25**) → `merge_hybrid_search_results`: RRF k=60, 점수 = 가중/(60+순위), bm25 가중 기본 0.5 → 재순위(모델 또는 코사인) → relevance threshold → collection 간 조각 해시(sha256) 중복 제거 → k.

### 1.4 AnythingLLM (Node, SQLite(Prisma) + LanceDB + 로컬 JSON)

**수집.** collector가 파일을 **JSON 문서**로 바꿔 `storage/documents/<folder>/<name>.json`에 둔다(`collector/utils/files/index.js` `writeToServerDocuments`; 내용: id, url, title, docAuthor, description, docSource, chunkSource, published, wordCount, pageContent, token_count_estimate). 워크스페이스에 더하면 `workspace_documents`(docId, docpath, metadata, pinned, watched) 행 → **벡터 캐시** `storage/vector-cache/<md5(docpath)>.json`이 있으면 재임베딩 없이 재사용(워크스페이스 간 공유) → 없으면 TextSplitter(recursive, 1,000자/겹침 20, 헤더 메타를 조각 앞에) → 임베딩 → LanceDB 표(워크스페이스 slug마다) → `document_vectors(docId, vectorId)`로 삭제 추적. `watched` 문서는 7일마다 재동기(`document_sync_queues`). 소스 커넥터는 가져오기형(GitHub·Confluence 등)이고 Drive는 없다.

**저장.** 원본 바이트는 보관하지 않고 추출 JSON만. 벡터는 LanceDB(로컬 파일). SQLite는 매핑만.

**검색.** LanceDB cosine topN 4, 하한 0.25, `pinned` 문서는 검색 없이 전문을 토큰 예산까지 주입(`DocumentManager`), 이전 대화의 출처로 빈자리를 채움(`fillSourceWindow`), 재순위 선택(후보 max(10, min(50, 전체의 10%))).

## 2. 가로지르기 — Brain과 나란히

| 축 | Onyx | RAGFlow | Open WebUI | AnythingLLM | Brain(결정됨) |
|---|---|---|---|---|---|
| 원본 바이트 | Postgres large object 또는 S3 | MinIO/S3 | 로컬/S3 | 보관 안 함(JSON만) | PG `files`·FileStore(로컬→Drive home 이전) AD-23 |
| 문서 행 | `document` + 소스 연결 표 | `document`·`file`·`file2document` | `file`·`knowledge_file` | `workspace_documents` | `files`·`source_files`·`file_names` |
| 조각 | OpenSearch만 | ES/Infinity만 | 벡터 DB만(pgvector면 PG 표) | LanceDB만 | PG `document_chunks`·`chunks` AD-15 |
| 키워드 색인 | text analyzer(언어별) | 앱 토큰화 + whitespace | tsvector('simple') / rank_bm25 | 없음 | trigram LIKE GIN(한국어 두 글자) |
| 벡터 | knn_vector hnsw | dense_vector | pgvector hnsw | LanceDB | (epic 6) pgvector |
| 갱신 판정 | updated_at → content_hash | fingerprint(메타) + content_hash | 전문 sha256 | md5(경로) 캐시 | `files.content_hash`, `source_files` 원격 버전 |
| 재색인 단위 | 문서: 조각 전부 삭제 후 재삽입 | 문서 | collection 삭제 | docId의 vectorId 삭제 | 세션·파일 단위 재생성(E17-1, AD-24 세대) |
| 중간 산출물 | 배치를 파일 저장소에 직렬화 | 단계 출력 kvrocks 7일 | 없음 | 벡터 캐시 JSON | 추출 세대(`extractions`) |
| 삭제 감지 | slim 전체 대조 | slim 전체 대조 + stale 삭제 | 수동 | watched 7일 | changes API + (후보 D8) 전체 대조 |
| 모델 교체 | 두 색인 동시 쓰기 뒤 전환 | kb마다 embd_id | collection 재생성 | 캐시 무효화 | `index_configs` 교체(AD-15, epic 6 Done 3) |
| 결과 모양 | 조각 → 인접 조각 합친 섹션 + 하이라이트 | 조각 + 문서 집계 + snippet | 조각 | 조각 + pinned 전문 | 조각 5건·8,000자 + 출처 → 원문 조회 |

읽어낸 것:
1. **Brain의 "PG 하나" 선택은 Open WebUI pgvector 구성과 같다.** 거기에 trigram GIN이 tsvector 자리에 있을 뿐이다. 넷 중 셋이 검색 엔진을 따로 두는 이유는 다중 테넌트·ACL·수백만 조각이고, 1인 브레인에는 해당 없다.
2. **조각은 어디서나 파생물이고 "문서 단위 전부 삭제 후 재삽입"이 보편 갱신**이다. E17-1의 재생성과 AD-24 세대 모델이 같은 방향이다.
3. **해시는 색인이 끝난 뒤 같은 트랜잭션에서 저장**(Onyx). Brain은 `source_files` 원격 버전·`files.content_hash`를 조각 커밋과 같은 트랜잭션에 적는 것으로 같은 효과를 낸다(epic 8 스토리 5 "원격 버전이 바뀌면 새 content"와 맞춤). 명시해 둘 가치가 있다.
4. **제목 가중의 철학이 정반대다.** Onyx는 제목 0.1~0.2 대 본문 1.0~1.5, RAGFlow는 제목 ^10 대 본문 ^2. Onyx는 "문단 찾기", RAGFlow는 "문서 찾기"에 맞춘 것이다. Brain은 둘 다 필요하다: 문서 집계(R5) 순위는 제목 가중 높게, 조각 순위는 낮게.
5. **구 일치(match_phrase slop 1) 가산이 Onyx 키워드 질의의 최고 가중(1.5)**이다. Brain의 LIKE는 질의 전체가 곧 구 일치라 이미 가장 좋은 신호를 먼저 본다. R2의 완화 순서를 "구 → 모든 단어 AND → 아무 단어 OR"로 적으면 Onyx와 같은 서열이 된다.
6. **인접 조각 합치기**(Onyx)는 결과 수를 줄이면서 문맥을 늘린다. Brain의 5건·8,000자 상한 안에서 같은 문서의 이웃 조각이 둘 나오면 하나로 합치는 편이 낫다.
7. **중간 산출물 보존.** Onyx·RAGFlow 둘 다 "가져온 것"과 "색인한 것" 사이에 디스크를 둔다. Brain은 추출 세대가 그 자리지만, epic 8의 "임시 내려받기 → 추출 → 삭제"에서 추출 실패 시 재내려받기가 export 할당량을 쓴다. 추출 attempt가 닫힐 때까지 임시 바이트를 두는 게 싸다.
8. **Open WebUI의 collection마다 벡터 복제**는 반면교사다. Brain은 조각 한 행에 소속을 관계로 건다(첨부와 Drive에 같은 내용이면 결과 하나, 스토리 6).
9. **AnythingLLM의 pinned·history backfill**은 채팅 UI 기능이라 Brain에는 시작 맥락 주입(AD-17)이 대응물이고 더 가져올 게 없다.
10. **RAGFlow의 접미사 동적 매핑**은 확장이 매핑 변경 없이 필드를 더하는 장치다. Brain은 확장 데이터를 `raw_records` 고정 view로만 읽기로 했으니(AD-30) 필요 없다. 다만 "토큰화를 앱이 하고 엔진은 whitespace"라는 결정은 Brain의 "질의 함수 하나, adapter는 LIKE만"(AD-15)과 같은 종류의 엔진 독립 선택이다.
