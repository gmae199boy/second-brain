# RAG 오픈소스 검색 패턴 차용 목록 — 흡수 / 조건부 / 불필요

- 작성: 2026-11-02
- 대상: RAGFlow(`infiniflow/ragflow` main, Go 재작성판), Onyx(`onyx-dot-app/onyx` main), Open WebUI(`open-webui/open-webui` main), AnythingLLM(`Mintplex-Labs/anything-llm` master). 근거 경로는 각 저장소 기준이고 2026-11-02 main 기준이다.
- 용도: epic 17(공통 검색·원문)·epic 8(Drive 문서 찾기·동기화)·epic 6(임베딩 선택 색인) 인셉션과 refine의 입력. 저장·검색 구조 전체의 비교와 근거는 `rag-oss-core-architecture.md`다. 검색은 넷 다 보았고, Drive 동기화는 Onyx(`backend/onyx/connectors/google_drive/`)와 RAGFlow(`internal/syncer/connector/google_drive.go`, `internal/syncer/`)만 본다. Open WebUI는 브라우저 picker(사용자가 고른 파일만), AnythingLLM은 Drive 커넥터가 없다. 읽은 방법: `~/tmp/rag-oss-2026-11-02/`에 얕은 클론(sparse checkout), 코드는 실행하지 않았다. **결정이 아니라 후보 목록**이고, 채택은 인셉션에서 정한다. `weknora-patterns.md`와 같은 판단 기준(§0)을 쓴다.
- 전제(2026-11-02 결정): 네 앱은 통째로 붙이지 않는다. 가져오는 건 코드가 아니라 공식·수치·도구 모양이다. 검색·조각·추출·문서 집계는 core, Drive는 설치 없는 core 연결, 임베딩은 core의 선택 기능이다(이니셔티브 Notes 2026-11-02).

## 0. 판단 기준

`weknora-patterns.md` §0과 같다. 여기서 특히 보는 것:
- 쓰는 쪽이 UI가 아니라 에이전트다. 질의 재작성·재순위·답 생성은 에이전트가 하므로 그 층은 가져오지 않는다.
- 한국어 두 글자 검색(R14)은 Brain의 trigram LIKE(AD-15)가 네 앱의 토크나이저보다 낫다. 토크나이저는 가져오지 않는다.
- 나가는 텍스트는 출력 코덱을 거친다(마스킹 B). 색인 시 모델 호출은 그 경계를 넘으므로 보류다.

크기 표기: `문장` = 안내문 한두 줄, `소` = 함수·테스트 하나, `중` = 스키마·규약 변경.

## 1. 흡수 — 임베딩 없이 지금 (10 + Drive 동기화 12개)

### 1.1 epic 17 — 공통 검색·원문 (6)

| # | 패턴 | 크기 | 왜 필요한가 | 근거 | 넣을 곳 |
|---|---|---|---|---|---|
| R1 | 여러 질의 한 번에: `queries[]`(1~5개)를 받아 각각 검색하고 조각 해시 `(출처, chunk id)`로 중복을 지우며 최고 순위만 남긴다 | 소 | 에이전트가 표현을 바꿔 여러 번 던지는 구조(E17-6 스킬)라 왕복이 준다. 결과 계약(5건·8,000자)은 합친 뒤에 적용 | Open WebUI `backend/open_webui/retrieval/utils.py` `merge_and_sort_query_results`(SHA-256 chunk hash), Onyx `backend/onyx/context/search/retrieval/search_runner.py` `combine_retrieval_results` | 17.3 검색 명령 입력 |
| R2 | 빈 결과 때 단계 완화: 질의 전체 구 일치(지금의 LIKE) → 모든 단어 AND → 아무 단어 OR 순으로 내려가며 `meta.hint`에 어느 단계였는지 적는다. 그래도 0건이면 0건. Onyx의 가중 서열(match_phrase 1.5 > match 1.0)과 같다 | 소 | 조용한 0건을 피하면서 재질의 횟수를 줄인다. AD-15의 "0건은 `data: []`와 `meta.hint`"에 맞는다 | RAGFlow `internal/service/nlp/retrieval.go` `Retrieval`: minMatch 0.3 → 0.1(`qa` 모드) → dense-only 순 재시도 | 17.3 질의 함수 |
| R3 | 일치 주변 한 줄 `match_snippet`: 결과 조각 본문 대신(또는 함께) 첫 일치 앞뒤 N자만 돌려주고, 전체는 `recall expand`·`files show`로 읽게 한다 | 소 | 8,000자 상한 안에 더 많은 후보가 들어가고 에이전트가 고른 뒤 원문으로 내려간다. "검색은 골라내기, 원문은 따로"라는 Brain 모양과 같다 | RAGFlow `internal/agentic_rag/tool_search_chunks.go`: 결과는 `<match_snippet>` 한 줄, 전체는 `list_chunks(doc_id, anchor_chunk_ids)` | 17.3 결과 계약(`snippet` 칸 추가 여부) |
| R4 | 스킬 안내문: 질의마다 "고유명사·ID·날짜·정확한 구절은 키워드 쪽, 바꿔 말한 개념 질문은 넓게", "비거나 빗나가면 반대쪽으로 한 번 더", "넓은 질문은 대상마다 짧은 질의 하나로 쪼개기", "원문 없이 결론 내리지 않기". 더한 줄(2026-11-03): "키워드 질의는 3개 이하, 꼭 필요한 단어만", "희귀·고유 용어는 바꾸거나 풀어 쓰지 않기", "'Drive에서'·'대화에서' 같은 출처 지정 단어는 질의에서 빼고 필터로", "(임베딩이 켜진 뒤) 키워드 질의 셋이 연달아 빗나가면 그때 의미 검색 한 번, 같은 말을 바꾸지 말고 대상의 종류를 바꿔 설명" | 문장 | E17-6 `recall` 스킬의 질의 바꾸기 단계 뼈대. 임베딩이 켜지면 R9의 가중치 안내로 확장 | RAGFlow `tool_search_chunks.go`·`tool_search_semantic_chunks.go`·`tool_grep_chunks.go` 도구 설명문; Onyx `prompts/search_prompts.py` `KEYWORD_REPHRASE_USER_PROMPT`(≤3 질의, 희귀 용어 보존, 출처 지정어 제거) | 17.6 `plugin/skills/recall/SKILL.md` |
| R13 | 같은 문서(또는 세션)의 인접 조각이 결과에 함께 오르면 하나로 합쳐 한 건으로 낸다(조각 번호가 연속일 때). 상한 5건·8,000자는 합친 뒤 적용 | 소 | 결과 수를 줄이면서 문맥을 늘린다. `recall expand` 왕복이 준다 | Onyx `context/search/pipeline.py` `merge_individual_chunks` | 17.3 결과 계약 |
| R15 | 원문 읽기 응답에 "전체 중 어디까지"를 싣는다: `recall expand`·`files show`가 읽은 구간과 함께 그 세션·문서의 전체 조각 수(또는 글자 수)를 돌려주고, 앞뒤 N개 창(`neighbors`)을 받는다 | 소 | 에이전트가 "더 읽을 게 남았는지"를 추측하지 않고 판단한다. 추가 왕복을 줄인다 | RAGFlow `agentic_rag/tool_list_chunks.go`: `anchor_chunk_ids`(1~20)+`number_neighbors`(기본 0, 창 2N+1, 겹치면 합침)+응답의 `doc_chunks_total` | 17.3 E17-3 응답 모양 |

### 1.2 epic 8 — Drive 문서 찾기 (4)

| # | 패턴 | 크기 | 왜 | 근거 | 넣을 곳 |
|---|---|---|---|---|---|
| R5 | 문서 단위 집계: 조각 결과와 별도로 `meta.documents[]`(file_id, 표시 이름, 맞은 조각 수, 최고 순위)를 문서별로 묶어 돌려준다 | 소 | "드라이브에서 이런 문서 찾아줘"의 답 단위는 조각이 아니라 문서다. 조각 5건 상한과 무관하게 후보 문서 목록이 보인다 | RAGFlow `retrieval.go` `Aggs`: 유효 후보 전체를 `docnm_kwd`로 묶어 count 내림차순 | E8-6 결과 계약 |
| R6 | 제목·경로를 본문과 함께: 한 질의로 `document_chunks.body`와 `file_names.text`(파일·폴더 이름)를 같이 치고, 이름 일치는 약한 가산(동점 가르기) | 소 | 파일명만 아는 문서와 본문만 아는 문서를 한 질의로 찾는다. 제목 가중치를 낮게 두는 이유는 제목이 본문 첫 줄에도 있기 때문 | Open WebUI `get_enriched_texts`(파일명·제목·섹션 경로를 키워드 색인에 덧붙임), Onyx `backend/onyx/configs/chat_configs.py` `TITLE_CONTENT_RATIO = 0.10` | E8-6 질의(17.3 질의 함수 재사용) |
| R14 | 제목 가중은 목적에 따라 둘: 문서 집계(R5)의 문서 순위는 제목·파일명 일치를 높게(RAGFlow `title_tks^10`), 조각 순위는 낮게(Onyx 0.1). 한 질의 결과에서 둘을 따로 정렬 | 소 | "문서 찾기"와 "문단 찾기"는 반대 가중이 맞다. `rag-oss-core-architecture.md` §2-4 | RAGFlow `buildQueryStringQuery` 필드 가중; Onyx `_get_title_content_combined_keyword_search_query` | E8-6 결과 계약 |
| R16 | 제목 트리가 있는 문서(Markdown, Google Docs export, docx 제목 스타일)는 조각 본문 앞에 조상 제목 경로를 붙인다("# 2026 계획 > ## 3월 > ### 예산" 한 줄). 평문·PDF는 그대로 | 소 | 키워드 검색이 "예산" 조각을 "3월 계획"으로도 찾는다. 임베딩 없이 R11(제목 접두)의 효과를 문서 조각에 먼저 준다. 조각 규칙이라 `index_configs.chunk_params`에 기록하고 AD-15를 갱신한다 | RAGFlow `ingestion/component/chunker/hierarchy.go`(제목 레벨로 트리를 만들고 DFS로 조각을 내며 조상 제목 텍스트를 포함), Onyx `title_prefix` | E8-5 추출기·조각 또는 E17-1 chunker |

보류 후보(지금 안 넣음, 측정 뒤): 최근성 감쇠 `1 / (1 + 0.5 × 나이(년))`(Onyx `DOC_TIME_DECAY`, 2년에 반감). 개인 브레인은 "요즘 보던 문서"가 많아 동점 가르기로 쓸 만하지만, 옛 결정·옛 리포트를 찾는 질문("그때 왜")을 밀어낼 수 있다. SM-3 문항에 오래된 문서가 들어간 뒤 판단한다.

### 1.3 epic 8 — Drive 동기화 (12). 대상 스토리 2·5·6

epic 8이 이미 정한 것(changes API 증분, `text/plain` export, export 10MB 상한, `drive.readonly`+`drive.file` scope, PKCE, 7일 refresh 만료, `sources`·`source_files`, 첫 목록 전 start token, 해시 검증, resumable 업로드)은 다시 적지 않는다. 아래는 두 커넥터가 겪고 고친 것 중 epic 8 문서에 없는 것이다.

| # | 패턴 | 크기 | 왜 필요한가 | 근거 | 넣을 곳 |
|---|---|---|---|---|---|
| D1 | **403을 속도 제한으로 읽기.** Google은 429 대신 403 + reason `userRateLimitExceeded`/`rateLimitExceeded`로 속도 제한을 낸다. `Retry-After` 헤더가 없으면 오류 본문의 `Retry after <ISO 시각>`을 읽고, 둘 다 없으면 60초. 대기에 3초 버퍼. 최대 6회. 나머지 403·404는 "접근 불가" | 소 | 403을 권한 오류로만 보면 속도 제한 때 파일을 접근 불가로 잘못 표시하고(5의 "권한 상실 → 접근 불가" 규칙이 오작동), 429만 보면 재시도가 안 된다 | Onyx `google_utils/google_utils.py` `_is_rate_limit_error`, `_execute_with_retry`; RAGFlow `google_drive.go` `isGoogleRateLimited`, 4회 지수 백오프 200ms 기준 | 5 오류 행렬, 가짜 서버 case |
| D2 | **접근 확인에서 5xx를 "없음"으로 읽지 않기.** 폴더·파일 존재 확인(probe)은 403·404만 없음이고, 속도 제한·5xx는 재시도 뒤 실패로 올린다. 실패를 없음으로 읽으면 정리 단계가 문서를 지운다 | 소 | 5의 "권한 상실·삭제 → 접근 불가" 전환이 일시 오류로 발화하면 조용한 데이터 손실이다(NFR-2). `source_unreachable_at`은 확인된 없음에만 | Onyx `google_utils.py` `execute_access_probe` 주석("a prune would then delete its documents") | 5 접근 불가 전환 조건 |
| D3 | **잘못된 pageToken은 처음부터.** 목록 중 400 + `Invalid Value` + `pageToken`이면 그 목록을 토큰 없이 다시 시작한다(실패로 닫지 않음). `incompleteSearch = true` 응답은 성공으로 치지 않고 범위를 좁혀 다시 한다 | 소 | 긴 목록이 중간에 깨졌을 때 "일부만 색인하고 성공"이 가장 나쁜 결과다. changes cursor 거부(이미 5에 있음)와 같은 부류 | Onyx `google_utils.py` `_execute_single_retrieval`; RAGFlow `listFilePageWithRetry`("search is incomplete; narrow the scope") | 5 전체 재목록 조건에 두 경우 추가 |
| D4 | **바로가기(shortcut) 해석.** `application/vnd.google-apps.shortcut`은 `shortcutDetails.targetId`로 대상을 한 번 더 읽어 대상 파일로 바꾸되, 폴더 바로가기는 하위 순회 대상으로, 파일 바로가기는 대상 파일로, 그리고 **원본 id로 중복 제거**한다(같은 파일이 폴더 둘에서 보임). 대상의 `modifiedTime`이 아니라 바로가기의 것을 쓴다(목록 창 불변식) | 소 | 사용자 Drive에 바로가기가 있으면 2의 목록이 바로가기를 0바이트 파일로 보거나 같은 문서를 둘로 센다 | Onyx `file_retrieval.py` `_resolve_file_or_shortcut`(주석: 대상 시각을 쓰면 체크포인트 경계가 깨짐), `RESOLVED_FROM_SHORTCUT_KEY`; RAGFlow `googleDriveShortcutMimeType` | 2 목록 규칙, 6 중복 제거 |
| D5 | **목록 질의 고정.** `trashed = false`를 항상 붙이고, 감시 폴더 목록은 `'<id>' in parents`, 증분 창은 `(modifiedTime > start or createdTime >= start)`(생성만 되고 수정 안 된 파일도 잡힘), `orderBy = modifiedTime`, 필드는 `id,name,mimeType,modifiedTime,createdTime,webViewLink,shortcutDetails,size,md5Checksum,sha256Checksum,parents`만. 필요하면 `supportsAllDrives=true`·`includeItemsFromAllDrives=true` | 문장 | 휴지통 파일이 색인되거나, `createdTime`만 있는 파일을 놓치거나, 필드를 다 받아 느려지는 것을 막는다. changes API를 쓰는 epic 8에서도 첫 전체 목록과 cursor 거부 뒤 재목록이 이 질의다 | RAGFlow `googleDriveFileQuery`; Onyx `file_retrieval.py` `FILE_FIELDS`, `generate_time_range_filter` | 2·5 목록 질의 |
| D6 | **지문으로 내려받기 건너뛰기.** 원격 메타데이터의 지문(`id, name, mimeType, modifiedTime, size, md5Checksum`)이 `source_files`의 저장값과 같으면 export·다운로드를 하지 않는다. Google 네이티브 문서는 `size`·체크섬이 없으므로 `modifiedTime`만으로 판정 | 소 | changes는 "바뀌었을 수 있음"만 알려준다. rename·move·권한 변경에도 change가 오므로 매번 export하면 export 할당량(Docs export는 하루 한도가 낮다)을 태운다 | RAGFlow `googleDriveFile.fingerprint()`, README "fingerprint skip, lazy download"; Onyx `_claim_file` | 5 변경 적용 규칙 |
| D7 | **크기 상한은 받기 전과 받는 중 둘 다.** 메타데이터 `size`가 상한(둘 다 10MiB 기본)을 넘으면 요청하지 않고 `too_large`. 네이티브 문서는 `size`가 없으므로 export를 스트리밍하며 상한+여유를 넘는 순간 끊는다(`ExportSizeThresholdExceeded`). 추출 텍스트도 총 글자 상한(Onyx 1,000만 자) | 소 | E8-5가 PDF 50MiB·추출 500만 자를 정했지만 "받는 중 끊기"가 없다. Google Docs는 export 전에는 크기를 모른다 | Onyx `source_operations.py` `_download`(`MediaIoBaseDownload` chunk = 상한+버퍼), `GOOGLE_DRIVE_CONNECTOR_SIZE_THRESHOLD`, `CONNECTOR_MAX_EXTRACTED_TEXT_CHARS`; RAGFlow `getBytes`(`io.LimitReader(sizeThreshold+1)`) | 2·4 크기 상한 |
| D8 | **전체 목록 대조(prune) 주기.** changes 증분과 별개로, 드물게(예: 주 1회 또는 cursor 거부 때) 감시 폴더의 전체 목록을 받아 `source_files`에 있는데 목록에 없는 항목을 접근 불가로 만든다. 목록이 중간에 끊기면(D3) 대조를 하지 않는다 | 소 | changes가 놓친 삭제·권한 상실(공유 해제는 change로 안 올 수 있음)을 잡는다. 두 커넥터 다 changes API를 쓰지 않고 이 방식만 쓴다. Brain은 changes가 주, 대조가 보조 | RAGFlow `prune_runner.go`("full slim snapshot" 뒤 `DeleteStale`), Onyx `retrieve_all_slim_docs`, `slim_listing_honors_indexing_start` | 5 삭제 감지 보조 경로 |
| D9 | **Google Docs는 제목 단위 절(section)과 제목 딥링크.** Docs API(`documents.get`, `includeTabsContent=true`)로 `HEADING_*`·`TITLE` 문단을 경계로 절을 나누고, 절마다 `https://docs.google.com/document/d/<id>/edit?tab=<tabId>#heading=<headingId>` 링크를 붙인다. 표는 행을 `, `로, 링크는 `(url)`로, 사람 칩은 `<Person|name, email>`로 평문화. 응답 50MiB 넘으면 평문 export로 되돌림 | 중 | E8-6 "결과에 위치(쪽·글자 범위)"가 Google Docs에서는 글자 범위뿐이라 원본에서 그 자리를 찾기 어렵다. 제목 딥링크면 클릭 한 번에 그 절이다. `text/plain` export만으로는 제목 id를 알 수 없다 | Onyx `section_extraction.py` `get_tab_sections`, `_build_gdoc_section_link`; `doc_conversion.py` 732~790(평문 export 먼저, 구조 파싱은 보강) | 2 또는 6. locator에 `heading_id`·`tab_id` 자리. `documents.readonly` scope가 더 필요한지 확인(Onyx 주석: `drive.readonly`에 포함) |
| D10 | 임시 내려받은 바이트는 추출 attempt가 닫힐 때까지 둔다(성공·`unsupported`·`too_large`·실패 확정 뒤 삭제). 추출만 실패하면 재내려받기 없이 재추출 | 소 | Onyx·RAGFlow 모두 "가져온 것"과 "색인한 것" 사이에 디스크를 둔다. export 할당량과 속도 제한(D1)을 아낀다 | Onyx `file_store/document_batch_storage.py`; RAGFlow `ingestion/chunkcache`(7일 TTL) | 2 임시 바이트 수명 |
| D11 | 원격 버전·`content_hash`는 조각 커밋과 같은 트랜잭션에서만 적는다. 색인 전에 적으면 다음 sync가 그 문서를 영원히 건너뛴다 | 문장 | 스토리 5의 "페이지마다 변경 적용과 cursor를 한 트랜잭션"에 "버전 표식도 조각 커밋 뒤"를 명시 | Onyx `indexing_pipeline.py` 1736~1739 주석("Persist content hash only for documents confirmed written") | 5 변경 적용 규칙 |
| D12 | "이 폴더 안에서만" 필터: 검색에 `folder`(Drive 폴더 id 또는 경로) 인자를 두고, `source_files.부모 경로` 접두 일치로 거른다. 폴더가 많아져 경로 비교가 느리면 Onyx처럼 조상 폴더 id 배열을 조각 행에 두고 배열 포함으로 거른다 | 소 | "프로젝트 X 폴더에서 그 문서 찾아줘"가 흔한 질문이다. 지금 설계(부모 경로 문자열)로 바로 되고, 배열은 필요할 때 | Onyx `db/models.py` `HierarchyNode`(folder·drive 노드, `parent_id`, 문서의 `parent_hierarchy_node_id`), 조각의 `ancestor_hierarchy_node_ids` + `search.py` `terms` 필터 | E8-6 검색 인자 |

보류 후보: 링크 공유 파일의 `X-Goog-Drive-Resource-Keys` 헤더(2021년 이후 링크 공유 파일은 요청마다 resourceKey 필요. Onyx `_add_resource_key_header`). 감시 폴더가 사용자 소유면 안 생기므로 "공유받은 폴더"를 감시 대상에 넣기로 할 때만.

Drive 동기화에서 **가져오지 않는 것**: 다중 사용자 impersonation·조직 관리자·공유 드라이브 organizer 선택·권한 동기화(Onyx `drive_access.py`, `capability_checks.py` 2,180줄의 대부분), NATS 기반 작업 큐(RAGFlow syncer)는 Brain의 `work_items`·데몬(AD-21·33)이 이미 한다. 이미지 OCR·스프레드시트 평문화는 범위 밖. 두 커넥터의 "modifiedTime 창 + 체크포인트" 증분은 changes API 대신이 아니라 보조(D8)다. 1인 1계정에서는 changes API가 더 정확하고 싸다.

## 2. 조건부 — epic 6 임베딩 착수 때 (6개)

| # | 패턴 | 조건 | 근거 |
|---|---|---|---|
| R7 | 융합은 RRF(k=60), 선형 합이 아니다. Brain 키워드 검색은 LIKE라 점수가 없어 순위만으로 합친다. 기본 가중은 키워드 쪽을 무겁게(RAGFlow 기본 키워드 0.7 / 벡터 0.3). `weknora-patterns.md` §2의 "벡터 0.7 / 키워드 0.3"과 반대이니 인셉션에서 하나로 정한다. 추천은 키워드 우선(고유명사·파일명 찾기가 주 용도) | epic 6 | RAGFlow `retrieval.go` `VectorSimilarityWeight` 기본 0.3, `sim = tkWeight*tsim + vtWeight*vsim`; Onyx `HYBRID_ALPHA = 0.5`; Open WebUI `EnsembleRetriever` RRF |
| R8 | 유사도 하한 0.2(벡터 쪽), 0건이면 0.17로 한 번 완화. 하한 밑은 버린다 | epic 6 | RAGFlow `SimilarityThreshold` 0.2 → 재시도 0.17; AnythingLLM `lance/index.js` 기본 0.25 |
| R9 | 질의마다 가중치를 에이전트가 정한다(`keyword_weight` 0~1, 기본 0.7). 안내: 고유명사·ID·날짜 0.7~0.9, 개념 질문 0.2~0.4, 비면 반대편 극단까지 시도 | epic 6. R4 안내문의 확장 | RAGFlow `tool_search_chunks.go` `keywords_similarity_weight` |
| R10 | 임베딩 캐시 키 `(조각 해시, index_config_id)`. 재색인은 바뀐 조각만, 모델·차원 변경만 전체 | epic 6. `index_configs` 불변 규칙(spine Table Contract)과 맞는다 | AnythingLLM `cachedVectorInformation(fullFilePath)`; Onyx `OLD_DEFAULT_*` 모델 업그레이드 경로 |
| R11 | 임베딩 입력은 `제목\n경로\n본문`. 제목·메타데이터가 조각 한도의 25%를 넘으면 메타데이터를 뺀다. 질의·문서 비대칭 접두사(`search_query: ` / `search_document: `)는 모델별이라 `index_configs`에 기록. 겹침 0(조각 경계가 깨끗해야 이웃 확장이 된다) | epic 6 | Onyx `backend/onyx/indexing/chunker.py` `title_prefix`, `MAX_METADATA_PERCENTAGE = 0.25`, `CHUNK_OVERLAP = 0`; `model_configs.py` `ASYM_QUERY_PREFIX`·`ASYM_PASSAGE_PREFIX` |
| R12 | 미니 조각: 조각마다 150토큰 미니 조각을 추가 벡터로 두고 최대값을 쓴다. 기본 꺼짐 | epic 6 뒤, SM-3이 세부 사실 질문에서 미달일 때 | Onyx `app_configs.py` `MINI_CHUNK_SIZE = 150`, `ENABLE_MULTIPASS_INDEXING` 기본 false, `LARGE_CHUNK_RATIO = 4` |

## 3. 불필요 — 이유

### 3.1 이미 있거나 우리가 더 낫다
- 이웃 조각 확장(Onyx `CONTEXT_CHUNKS_ABOVE/BELOW = 1`, RAGFlow `list_chunks`) → `recall expand`·`files show`(E17-3)가 같은 역할.
- 조각 크기·경계(Onyx 토큰 기준, AnythingLLM 겹침 20, RAGFlow general 512토큰·`\n` 구분·겹침 %) → `index_configs`의 1,200자·메시지 경계 규칙(E17-1)이 이미 정해져 있다.
- RAGFlow 부모·자식 조각(`parent_child.use_parent_child`, `children_delimiters`로 자식을 나누고 `mom`에 부모 id. 작게 찾고 크게 보여 주기)과 표·이미지 앞뒤 문맥(`table_context_size`·`image_context_size`로 `context_above/below`) → 전자는 `recall expand`(E17-3)가 같은 역할, 후자는 표·이미지 조각이 범위 밖.
- 토크나이저·용어 가중(RAGFlow `term_weight.go`의 IDF·NER·품사 가중, Open WebUI `query.split()`, Onyx OpenSearch 언어 analyzer) → 중국어 사전 기반이거나 공백 분리다. 한국어 두 글자는 trigram LIKE(AD-15)가 낫다. 확인(2026-11-03, RAGFlow `internal/binding/cpp/rag_analyzer.cpp`): `IsKorean`은 UTF-8 `E1 84~87`(한글 자모 U+1100 블록)만 보고, 완성형 음절(U+AC00~D7A3, 선두 바이트 `EA~ED`)은 `IsChinese`(`E4~E9`)에도 걸리지 않는다. 그래서 한국어 문장은 NLTK식 정규식 토크나이저와 영어 Snowball 어간 추출 경로로 가서 띄어쓰기 단위 토큰이 된다. 조사·어미가 붙은 채 한 토큰이라 "두 글자" 부분 일치가 안 된다. 가져오지 않는 판단이 맞다.

### 3.2 LLM 호출이 전제
- Onyx contextual RAG(조각·문서 요약을 조각 앞에 붙임, `ENABLE_CONTEXTUAL_RAG`), RAGFlow 자동 키워드·자동 질문·태그 → 조각마다 모델을 부른다. 마스킹 경계(AD-11)와 비용 때문에 보류. SM-3 미달 원인이 "왜" 질문이면 그때 다시 본다.
- Onyx 질의 재작성·키워드 확장(`secondary_llm_flows/query_expansion.py`) → 에이전트가 한다(E17-6). 프롬프트의 규칙 문장만 R4로 가져왔다.
- RAGFlow "compiled knowledge" 도구군(`navigate_tree`·`navigate_structure`·`graph_explore`·`doc_outline`, `list_chunks`의 compiled statements) → 색인 때 LLM이 문서마다 요약·주제 트리·엔티티 그래프·원자 사실을 미리 만든다. 비용과 마스킹 경계 밖. `list_chunks`의 anchor·neighbors·total 모양(R15)만 가져온다.
- RAGFlow `grep_chunks`의 `intent` 한 문장 → 결과를 LLM 필터가 그 문장으로 거르기 위한 입력이다. Brain은 결과를 거르는 모델이 없으니 인자를 두지 않는다. 안내문의 "grep은 정확한 리터럴·ID·CJK 부분 문자열·같은 조각 안 동시 출현에만, 단순 키워드 재현은 BM25로" 구분은 Brain에서 LIKE 하나가 둘 다라 해당 없다.

### 3.3 에이전트 런타임이 맡는 것
- 재순위 모델 → 에이전트가 상위 후보를 읽고 고른다. 근거: AnythingLLM 기본 `rerank = false`, Open WebUI는 재순위 모델이 없으면 코사인으로 대체, Onyx는 검색 설정에서 재순위를 뺐다(`alembic/.../78ebc66946a0_remove_reranking_from_search_settings.py`). 에픽 6 Done when 2의 `RERANK_FAILED` 경로는 "재순위 없음"을 기본으로 바꿔도 된다.
- 답 생성·인용 조립 → 에이전트.

### 3.4 다중 사용자·서버
- PageRank·태그 가중(RAGFlow `RankFeature`), ACL·연합 검색(Onyx), 테넌트·워크스페이스(AnythingLLM) → 개인 1인.

### 3.5 범위 밖
- 문서 파서(RAGFlow deepdoc, Onyx 파일 처리, Docling·Tika) → E8-5의 pdfjs·mammoth로 충분하다는 2026-10-28 결정. OCR은 범위 밖.
- 데이터 소스 커넥터(RAGFlow data source, Onyx connectors) → Drive는 core가 직접 연결한다(epic 8). 커넥터로 Brain DB를 읽게 하면 마스킹을 우회한다.

## 4. 반면교사 (따라 하지 말 것)
- RAGFlow `term_weight.go`: 구두점 치환 정규식이 컴파일되지 않아 단계가 조용히 건너뛰어진다(경고 한 번만). 조용한 기능 꺼짐은 NFR-2 위반이다. 질의 전처리 단계는 실패하면 `SEARCH_FAILED`로 드러낸다.
- AnythingLLM `similarityResponse`: topN을 자른 뒤 고정 문서를 빼서 결과가 topN보다 적게 나온다. 필터는 자르기 전에 건다(AD-15의 "낮은 순위부터 통째로 빼고 1위는 남김"과 같은 방향).
- RAGFlow `search_chunks`: 코드 주석("전체 조각 반환")과 도구 설명("snippet만")이 어긋난다. 명령 메타·SDK·스킬 설명을 한 곳(CommandSpec)에서 낸다(E17-6).

- Onyx `connector.py`: 긴 재시도(약 17분, 1분 간격) 대신 체크포인트로 바꿨다는 주석(`google_utils.py` 상단). 긴 작업은 "오래 기다리기"가 아니라 "어디까지 했는지 저장"이 답이다. AD-33의 "경과 시간만으로 죽이지 않음"과 같은 결론.
- Onyx `file_retrieval.py` `get_files_in_shared_drive`: "파일 하나라도 보이면 드라이브 전체를 순회한 것으로 표시"가 폴더 제한 때문에 틀렸다는 NOTE가 코드에 남아 있다. 부분 성공을 전체 완료로 기록하지 않는다(5의 "재목록 성공 전에는 접근 불가로 바꾸지 않음"과 같은 방향).

- Open WebUI: 지식베이스마다 벡터를 복제한다(`file-<id>` collection과 knowledge collection에 같은 조각). 소속은 관계로 걸고 조각은 한 행만 둔다(스토리 6의 "같은 내용이면 결과 하나").
- Open WebUI 비네이티브 하이브리드: collection 전체 텍스트를 메모리에 올려 BM25를 계산한다. 색인 없는 검색을 "작은 데이터니까"로 넘기지 않는다. Brain은 expression GIN이 있다(AD-15).

## 5. 그대로 옮겨 적을 함수 (새로 짜지 않는다)

위 항목 대부분은 수치·순서라 Brain의 질의 함수 안에 녹인다. 아래만은 로직이 작고 엔진에 묶이지 않아, 빌더가 해당 함수를 열어 TypeScript로 **같은 구조로 옮겨 적는다**(발명 금지). 출처와 라이선스를 plan에 적는다. Open WebUI는 브랜딩 조항이 있는 자체 라이선스라 구조만 참고하고 문장을 베끼지 않는다.

| 후보 | 옮겨 적을 함수 | 라이선스 | 비고 |
|---|---|---|---|
| D1 | Onyx `backend/onyx/connectors/google_utils/google_utils.py` `_is_rate_limit_error`, `_execute_with_retry`(Retry-After 헤더 → 본문의 `Retry after <ISO>` → 60초, +3초 버퍼, 6회) | MIT | googleapis(TS) 오류 객체에 맞춰 필드 이름만 바꾼다 |
| D2 | 같은 파일 `execute_access_probe`(403·404만 없음, 5xx는 3회 뒤 raise) | MIT | 접근 불가 전환 조건 그대로 |
| D3 | 같은 파일 `_execute_single_retrieval`의 400 `Invalid Value`+`pageToken` 분기 | MIT | |
| D4 | Onyx `google_drive/file_retrieval.py` `_resolve_file_or_shortcut`, `_resolve_folder_or_shortcut`(바로가기 modifiedTime 보존 주석 포함) | MIT | `RESOLVED_FROM_SHORTCUT_KEY` 표식도 유지 |
| D7 | Onyx `google_drive/source_operations.py` `_download`(chunk = 상한+버퍼, 넘으면 중단) | MIT | TS에서는 stream 길이 누적으로 같은 조건 |
| D9(채택 시) | Onyx `google_drive/section_extraction.py` 전체(170줄: 제목 판정, 표·링크·사람 칩 평문화, 절 딥링크) | MIT | Docs API JSON 구조가 같으므로 거의 1:1 |
| R13 | Onyx `backend/onyx/context/search/pipeline.py` `merge_individual_chunks`(원래 순서 유지하며 인접 조각 묶기) | MIT | |
| R7 | RRF 합치기: 구조는 Open WebUI `retrieval/vector/utils.py` `merge_hybrid_search_results`(k=60, 가중/(k+순위), 후보 dict 합산)와 같게 하되 새로 쓴다 | 자체 라이선스 | 20줄이라 비용 없음 |
| R2·R8 | RAGFlow `internal/service/nlp/retrieval.go` `Retrieval`의 재시도 사다리(0건 → 완화 → 벡터만) 구조 | Apache 2.0 | Go라 구조만 옮긴다 |

옮겨 적지 않는 것: 검색 질의 생성(엔진별), 토크나이저, 체크포인트 모델(Brain은 `work_items`·attempt가 있음), 커넥터 프레임워크 전체.

## 6. 다음 행동
- epic 17 refine(17.3·17.6 착수 전): R1~R4·R13·R15 채택 여부. R3은 결과 계약(`snippet` 칸)이라 17.3 plan에 적는다.
- epic 8 refine(2·5·6 착수 전): R5·R6·R14·R16과 D1~D12 채택 여부. D1~D3·D6·D7은 5의 오류 행렬·가짜 서버 case에 바로 들어가는 크기다. D9는 scope·locator가 걸려 따로 판단. 최근성 감쇠와 resourceKey는 보류 그대로.
- epic 6 인셉션: R7~R12와 `weknora-patterns.md` §2의 수치 충돌(가중 방향)을 하나로 정한다. 벡터 저장은 pgvector(2026-11-02 결정).
