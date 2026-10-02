# Addendum — PRD: Personal Brain V1 slice 1

PRD에는 "무엇"만 있다. 이 문서는 인터뷰와 사전 시험에서 나온 "어떻게"를 모은 것으로, architecture 단계의 입력이다. 여기 적힌 것은 대부분 **출발점과 후보**이고 architecture가 확정한다. 사용자 확인이 끝난 항목은 그 자리에 "(사용자 확인)" 또는 "결정"이라고 적었다. 시험 근거는 `../brief-personal-brain/addendum.md` §9와 `~/.brain-baseline-test/REPORT.md`.

## 1. 출발점 구성 (기준선 측정. 미측정 항목은 각 행과 표 아래에 표시)

| 요소 | 값 | 근거 |
|---|---|---|
| 저장소 | PostgreSQL + pgvector | 원문·작업 로그·색인을 한 DB에. **기준선은 SQLite+인메모리 코사인으로 쟀다.** 정확 검색이라 순위는 같을 것으로 보지만, pgvector의 근사 인덱스에서 같은 점수가 나오는지는 재지 않았다 |
| 임베딩 | Alibaba Model Studio `qwen3.7-text-embedding`, 1024차원. `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | 다국어. $0.07/M. 1024는 pgvector 인덱스 한도(2000) 안 |
| 재순위 | 같은 키의 `qwen3-rerank`. `https://dashscope-intl.aliyuncs.com/compatible-api/v1/reranks`(Cohere 와이어 포맷) | 1.2~1.5초. 영어 reranker는 한국어를 망가뜨림(≈1/10), 로컬 bge-reranker-v2-m3는 31초. `qwen3.7-text-rerank`는 국제 리전에 없음 |
| 조각 크기 | 약 1,200자, 메시지 경계, 인접 겹침 1메시지 | 4,000자와 점수 같고 주입 맥락 절반(8,220자 vs 16,062자) |
| 조각 머리말 | 붙이지 않음 | 날짜·프로젝트를 본문에 넣으면 같거나 나빠짐. 꼬리표는 컬럼으로 |
| 조각 검색 | 벡터 top-30 → 재순위 → top-5 | 내용 8문항 8/8. 재순위가 1위 정확도를 5.0 → 7.5로 |
| 시간 조회 | 날짜 표현 → 범위(코드) → `BETWEEN` | 기준선에서 LLM 요약 대상으로 2/2, 0.1ms 미만. 작업 로그 대상으로는 미측정 |

미검증: 키워드(BM25) 하이브리드(코퍼스가 작아 측정 불가), 대분류 → 소분류 2단계 검색, **에이전트가 적은 작업 로그의 검색 품질**(기준선은 Haiku 요약을 썼다).

## 2. 저장 구조 스케치

architecture에서 확정한다. PRD의 FR이 요구하는 것을 담을 수 있는지 보이는 용도.

```
workspaces     id, name, parent_id? (slice 1 미사용)
projects       id, workspace_id?, repo_identity (git 공통 디렉터리), path, name
worktrees      id, project_id, path, branch, removed_at? (폴더가 지워져도 행은 남는다)
sessions       id, workspace_id? (프로젝트 없는 세션을 직접 넣을 때), project_id?, worktree_id?,
               -- 실행 속성 (나중에 Execution으로 떼어 낼 묶음)
               harness, harness_session_id (unique per harness), machine, git_branch,
               started_at, ended_at, first_prompt,
               continued_from_session_id?, continuation_kind? (resume | handoff),
               work_context_id? (예약: 여러 세션이 한 작업을 이을 때),
               ingest_source (live | import), ingested_at, ingest_status, metadata jsonb
messages       id, session_id, seq, role, model?, occurred_at, body (원문 그대로)
tool_notes     id, session_id, message_id?, seq, tool, target, ok, occurred_at
log_entries    id, kind (progress | decision | rule | preference), text, reason?,
               session_id, occurred_at, message_seq? (수집 후 채우는 파생값), author_model,
               -- decision / preference
               subject?, status? (active | superseded), supersedes_id?,
               -- rule: text는 출처 메시지의 인용
               quote_message_id?, quote_start?, quote_end?,
               rule_state? (on | off), only_project_id? (적용 범위 제한이 있을 때만)
log_entry_edits id, log_entry_id, previous_text, edited_at
chunks         id, session_id, message_seq_from, message_seq_to, body
embeddings     id, target_kind (chunk | log_entry), target_id, index_config_id, vector
index_configs  id, embedding_provider, embedding_model, dimensions, chunk_target_chars
ingest_failures id, harness, harness_session_id, stage, error, occurred_at
```

- **수준**: 나 ⊃ 워크스페이스 ⊃ 프로젝트 ⊃ 워크트리 ⊃ 세션. 나와 세션 사이는 전부 선택이다. 프로젝트는 git 공통 디렉터리(저장소 정체성)로, 워크트리는 작업 폴더 경로로 식별한다. 저장소가 아닌 폴더의 세션은 프로젝트가 없다.
- **꼬리표는 세션에만 둔다**: 작업 로그와 조각은 `session_id`로 세션의 꼬리표를 따른다. 로그나 조각에 `project_id`를 복사해 두면 세션의 꼬리표를 바꿀 때 두 번째 진실이 생긴다(검토 지적). 조회 성능이 필요하면 뷰나 파생 컬럼으로 풀고 원본은 세션 하나로 한다.
- **프로젝트 없는 세션의 워크스페이스**: `sessions.workspace_id`로 직접 넣는다(UJ-6의 Keyboard). 프로젝트가 있으면 워크스페이스는 프로젝트를 따라간다.
- **"나"는 테이블이 아니라 전체 그 자체다.** 규칙의 `only_project_id`는 꼬리표와 별개인 적용 범위이고 기본은 비어 있다(어디서나).
- **규칙은 인용이다**(FR-19): `text`는 `quote_message_id`의 `quote_start..quote_end` 구간과 글자 단위로 같아야 한다. 에이전트는 구간만 고른다. 수집 전에 적히면 구간 대신 문장을 받아 두고, 수집 후 원문과 대조해 인용 위치를 확정한다. 대조에 실패하면 규칙을 켜지 않고 점검에 올린다.
- **join**: 작업 로그는 시각을 기록하고 "그 시각 직전의 메시지"로 대화에 이어진다. `message_seq`는 수집 후 채우는 파생값이다(§5).
- **세션과 실행의 분리**: 초안 14·38절은 Session(작업 맥락)과 Execution(에이전트 실행 한 번)을 구분한다. slice 1은 Harness 세션 하나를 세션 한 행으로 두지만, 실행 속성을 한 묶음으로 표시해 두고 `continuation_kind`·`work_context_id`를 예약해, 한 작업에 Harness 둘이 올 때 재설계가 되지 않게 한다.
- **벡터를 따로 둔다**: 조각과 로그 행에 `vector(1024)`를 박으면 색인 설정을 바꿀 때(FR-11) 스키마가 걸린다. `embeddings`를 분리해 설정별로 공존하게 한다. pgvector 인덱스는 차원이 고정이라 설정별 부분 인덱스나 테이블이 필요할 수 있다 — architecture에서 정한다.
- **수정 이력**: 여러 번 고쳐도 남아야 하므로(FR-22) `log_entry_edits`로 둔다.
- **가져오기 수용**: `ingest_source`, 메시지의 `occurred_at`과 세션의 `ingested_at` 분리, `harness_session_id` 멱등 키. 옛 세션에는 작업 로그가 없으므로 가져오기 때는 `first_prompt`·도구 메모로 보이거나 요약을 돌려야 한다(PRD §8-1).
- **이후 조각을 위한 자리**: Execution, Resource/Artifact 연결, 외부 자료 링크는 세션·메시지를 가리키는 별도 테이블로 붙일 수 있다. 지금 구조가 막지 않는다. 두 번째 기계는 `machine` 칸과 `harness_session_id` 멱등 키로 받는다.
- 작업 로그는 짧아서 임베딩·재순위 비용이 조각보다 훨씬 작다. 대분류 검색의 대상.
- `messages.body`와 `tool_notes.target`에 Postgres 전문 검색을 걸면 임베딩이 놓친 것을 키워드로 잡는 보조 경로가 되고, 도구 메모 검색(FR-2)이 된다.
- **BMad memlog와의 대응**: `event → progress`, `decision → decision`, `change·override → decision`(대체 관계로), `assumption → progress`(표시 추가) 정도로 맞출 수 있다. 연계 여부는 PRD §8-2.

## 3. 포트 (Core가 아는 것)

| 포트 | slice 1 구현 | 비고 |
|---|---|---|
| 세션·메시지·작업 로그 저장소 | Postgres | |
| 색인·검색(`MemoryProvider` 자리) | pgvector | 나중에 Hindsight 등을 같은 포트 뒤에 붙일 수 있음 |
| 임베딩 | Model Studio (OpenAI 호환) | |
| 재순위 | Model Studio (Cohere 호환) | 응답이 없으면 벡터 순위 그대로 돌려주되 결과에 표시한다(FR-25, NFR-2). 영어 전용 모델로 대체하지 않는다(NFR-4) |
| 내보내기 | 표준 형식 파일(예: JSON Lines) | NFR-9. `pg_dump`와 별개로 Brain 없이 읽을 수 있는 형식 |
| Harness adapter | Claude Code | |

slice 1에는 LLM `Worker` 포트가 없다. 요약을 다시 넣게 되면 그때 추가한다(`claude -p --json-schema`가 검증된 경로. 호출당 약 70초, 세션 4개에 4회·33,438자).

## 4. 에이전트가 적게 만드는 수단 (후보)

어느 수단을 쓰든 **규칙 자체를 Harness의 지시 파일에 복사하지 않는다.** 지시 파일에는 "Brain을 써서 적고 찾아라"만 넣고, 규칙의 원본은 Brain 하나로 둔다(PRD §6.1).

FR-7은 "에이전트가 시키지 않아도 적는다"를 요구한다. 수단은 강도 순으로 넷이 있고, 겹쳐 쓸 수 있다.

| 수단 | 방식 | 장점 | 약점 |
|---|---|---|---|
| 시작 맥락의 안내 | Brain이 세션 시작 때 "진행·결정·규칙·선호가 생기면 로그를 적어라"를 주입 | Brain이 한 곳에서 관리, Harness 공통 | 지시일 뿐. 긴 세션에서 잊힐 수 있음 |
| AGENTS.md / CLAUDE.md | 전역 지시 파일에 같은 내용 | 가장 단순, 모든 Harness | 파일 관리가 Brain 밖 |
| Claude Code plugin (hook + skill) | 설치 한 번으로 hook(수집·주입)과 skill(기록 절차)을 묶음 | Claude Code에서 가장 강함. `Stop`·`PreCompact` hook으로 "아직 안 적은 결정이 있나" 점검 가능 | Harness마다 따로 만들어야 함 |
| BMad 연계 | BMad 스킬이 memlog를 쓸 때 Brain에도 쓰거나, Brain이 `.memlog.md`를 읽음 | BMad 작업 중에는 이미 규율이 있음 | BMad를 쓰는 세션에만 해당 |

도구의 형태도 둘이다.

- **CLI**(`brain log …`, `brain recall …`): 셸을 쓸 수 있는 모든 Harness에서 동작. 사람이 직접 쓰기 좋다.
- **MCP**: 도구 스키마가 에이전트에게 명시적으로 보인다. Harness 공통. SDK 위의 얇은 adapter.

둘 다 SDK 위에 얇게 얹히므로(FR-23, FR-24) 하나를 먼저 내고 다른 것을 나중에 더해도 된다.

## 5. Claude Code 연결

- `SessionStart` hook → 시작 맥락을 추가 컨텍스트로 주입(FR-17).
- `Stop`/`SessionEnd` hook → 수집과 색인을 뒤에서 실행(FR-1~6, FR-10~11). hook은 바로 돌아온다.
- 수집 원천은 hook이 넘겨주는 transcript 경로의 jsonl. 메시지별 모델명, 세션 ID, cwd, git 브랜치, 버전, 타임스탬프가 들어 있다.
- 변환 규칙(시험의 `convert.py`): user/assistant의 text 블록만 본문으로, tool_use는 도구 메모 한 줄로, tool_result·system·meta는 버림. 7.72MB → 50.7KB(1/150).
- **쓰기 API는 둘로 나눈다**(사용자 확인): 대화 쌓기(`sessions.ingest` — hook이 호출, 여러 건, 멱등)와 로그 쌓기(`log.append` — 에이전트가 호출, 한 줄). 로그는 hook이 쓸 수 없다. 문장을 쓰는 것은 에이전트다. 조회(`context`, `recall`, `expand`)는 별개의 읽기 API.
- **작업 로그와 수집 시점**: 로그는 세션 중에 적히는데 메시지는 세션 끝에 수집되면, 로그가 먼저 도착한다. 권장: 두 API 모두 `(harness, harness_session_id)`를 열쇠로 쓰고, `log.append`는 처음 보는 세션이면 빈 세션을 먼저 만든다. 로그는 메시지 순번 대신 **시각**을 기록하고, join은 "로그 시각 직전의 메시지"로 맞춘다(스케치의 `message_seq`는 수집 후 채우는 파생값). 대안은 턴마다 증분 수집(`Stop` hook은 턴마다 발화). PRD §8-7.
- **재시도의 주체**: 데몬이 없으므로 밀린 수집·색인·인용 대조는 다음 `SessionStart` hook이나 점검 도구가 실행될 때 처리한다. 수집이 Claude Code hook에만 얹히면 다른 Harness를 붙일 때 다시 만들어야 하므로, hook은 "밀린 일을 처리하라"는 SDK 호출 하나만 부르게 한다(PRD §8-7).
- **세션 ID 전달**: Claude Code는 hook에 세션 ID를 넘긴다. `SessionStart` hook이 그 값을 세션 환경에 심어 두면 에이전트가 부르는 `brain log`가 자동으로 그 세션에 붙는다.
- 참고: Hindsight의 Claude Code hook 패키지도 `SessionStart`·`UserPromptSubmit`·`Stop`을 쓰고, 대화 턴 + 도구명 한 줄만 보낸다.

## 6. 비용 추정

기준선 실측에서 환산. 하루 세션 10개 가정.

| 항목 | 단가 | 하루 | 월 |
|---|---|---|---|
| 임베딩 (조각 + 작업 로그) | 세션 텍스트 1M자당 약 $0.035 | 약 13만 자 → $0.005 | $0.15 |
| 재순위 (조각 조회) | 질의당 약 $0.002 (후보 30개) | 조회 30회 → $0.06 | $1.8 |
| LLM | Brain은 부르지 않음 | 0 | 0 |

작업 로그를 적는 문장은 일하는 에이전트의 출력 토큰 몇십 개다. 대분류(작업 로그) 검색은 대상 텍스트가 짧아 조각 재순위보다 훨씬 싸다.

## 7. 접은 대안 (이 PRD 범위)

| 대안 | 접은 이유 |
|---|---|
| 에이전트가 규칙을 자기 말로 적기 | 조건·수치가 빠질 수 있고 확인 없이 매 세션 주입됨. 규칙은 내 발화의 인용으로 |
| 에이전트가 적은 규칙을 확인받고 켜기 | 손이 감. 인용이면 확인이 필요 없음 |
| 선호를 규칙에 넣기 | 항상 주입되어 시작 맥락을 잡아먹음. 선호는 찾을 때만 나오는 별도 종류로 |
| 세션 끝에 LLM 요약 1회 | 처음에 넣었다가 뺌. 요약은 공수가 두 번이고(대화 + 요약) 대비·수치를 빠뜨림. 일하는 에이전트가 그 순간에 적는 쪽이 정확하고 호출이 없음. 안전망으로 되살릴 여지는 둠(PRD §8-1) |
| 요약에서 결정·규칙 후보를 뽑아 확인받기 | 위와 같은 이유. 결정은 나는 순간에 적는다 |
| 프롬프트마다 조각 검색·주입 | 턴당 2~4천 토큰, 1.5초, $0.002. 품질이 오른다는 증거 없음 |
| 전부 요청 시에만(자동 주입 0) | "매번 말해야 한다"는 원래 고통이 남음 |
| 기록마다 귀속(나/프로젝트)을 골라 넣기 | 항상 나에 속하고 프로젝트 꼬리표가 자동으로 붙는 쪽이 단순. 제한이 필요한 건 규칙뿐 |
| 결정을 프로젝트에 귀속 | 틀린 모델. 프로젝트에서 내린 결정이 나 자체의 결정일 수 있음 |
| LLM 주제 분류 | 비용과 오분류. 꼬리표와 작업 로그 → 조각의 계층으로 대신 |
| Hindsight (추출+통합) | 7/10이나 세션 4개에 LLM 40회·96만 자. 원문을 다시 쓰는 방식 |
| Supermemory self-host | 성능은 hosted 전용, 엔진 블랙박스, 6.0/10 |
| Harness 원본 파일 보관 | 사용자 결정으로 제외 |
| 과거 세션 가져오기 | 보류. 저장 구조만 수용 |

## 8. 확장 채점표 (SM-3)

기존 10문항(`~/.supermemory/test/REPORT.md` 5절. 기준선 재채점은 `~/.brain-baseline-test/REPORT.md`)에 아래 유형을 각 2문항 추가한다. 문항은 실사용 2주 뒤 실제 데이터로 만든다.

| 유형 | 예 | 왜 재는가 |
|---|---|---|
| 집계 | "reranker 얘기를 몇 번이나 했지" | 조각 top-5로는 셀 수 없다 |
| 세션 간 변화 | "임베딩 차원 결정이 어떻게 바뀌었지" | 결정의 대체 체인이 덮는지 |
| 모순 해소 | "지금 Supermemory를 쓰기로 한 거야 아니야" | 옛 발언과 새 발언이 함께 나올 때 |
| 시점 추론 | "shim을 고친 건 Hindsight 시험 전이야 후야" | 날짜가 붙은 출처로 답이 되는지 |
