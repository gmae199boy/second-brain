# Addendum — Personal Brain brief

brief에 넣기엔 깊지만 PRD·architecture·spec이 읽어야 할 내용을 모았다. 출처는 2026-09-30~10-01 인터뷰다.

## 1. 아키텍처 초안

`../inputs/personal-brain-final-architecture.md` (Codex와 작성한 49개 섹션). brief와 충돌하는 부분은 없고, brief가 더 좁힌 것은 다음이다.

- 다중 사용자 배제 (초안 12장 Workspace, 45장은 개인 전제)
- 첫 조각을 memory + session + Claude Code 수집으로 한정 (초안 46장 Phase 1·2 중 일부)
- 자동 주입을 Desktop App 없이 harness hook으로 먼저 함 (초안 26·28장은 first-party App 전제, MCP는 Phase 7)
- 임베딩 provider를 외부 클라우드로 명시 (초안 42장은 "Supermemory 내부 구현 사용")

## 2. 검토했다가 접은 대안

| 대안 | 접은 이유 |
|---|---|
| Brain이 추출을 직접 하고 Supermemory는 저장만 (`POST /v4/memories`) | Supermemory의 가치가 벡터 저장으로 줄어 pgvector와 다를 바 없어짐 |
| Supermemory 빼고 pgvector + 구독으로 직접 추출 | 기억 합치기·모순 갱신·시점·검색 순위를 직접 만들어야 하고 그 부분의 품질이 오래 낮은 상태로 남을 것 |
| Supermemory 레포를 고쳐 `claude -p` 호출 | 공개 레포(MIT)에 서버 엔진 소스가 없음(바이너리 배포). 대신 shim을 쓴다 |
| 로컬 임베딩 `Xenova/bge-m3` | 가능하지만 사용자가 외부 클라우드 Qwen 선호 |
| 임베딩 2560차원 | 품질 이득 작고 pgvector 인덱스 한도(2000) 초과. 1024로 |
| 공식 plugin(Claude Code/Codex/OpenCode)만으로 운영 | 시간 기준 조회·원본 보존·provider 교체·스케줄러 불가. 실험용으로만 |
| MCP-only | 에이전트가 매번 조회 여부를 판단해야 함(초안 28장) |
| 처음부터 데몬 | 항상 켜져 있어야 하는 일이 생길 때(스케줄·승인·원격 수집) 만든다 |

## 3. Supermemory self-host 확인 사실 (2026-10-01, 공식 문서 기준)

- 실행: `npx supermemory local`. Docker·외부 DB 불필요, 내장 그래프 엔진. 포트 6767. 첫 기동 때 로컬 API 키 출력.
- 추출 LLM: API 키 필수(OpenAI, Anthropic, Gemini, Groq, Ollama·OpenAI 호환 `OPENAI_BASE_URL`). 구독 로그인 옵션 없음. 모델 자리 `OPENAI_MODEL`, `OPENAI_FAST_MODEL`, `OPENAI_TEXT_MODEL`.
- 임베딩: 기본 로컬 `Xenova/bge-base-en-v1.5`(768, 영어 전용 — 한국어 검색 약함). 원격은 `SUPERMEMORY_EMBEDDING_PROVIDER=openai` + `SUPERMEMORY_EMBEDDING_BASE_URL` + `SUPERMEMORY_EMBEDDING_MODEL` + `SUPERMEMORY_EMBEDDING_DIMENSIONS` + `OPENAI_API_KEY`. 임베딩 provider·모델·차원은 최초 주입 이후 **변경 불가**다(바꾸려면 전체 재주입 필요).
- hosted 전용: connector(Drive·Notion·Gmail), managed MCP, 튜닝된 추출 파이프라인.
- API: document ingest, conversation ingest, `POST /v4/memories`(직접 생성), 목록·이력, 수정(새 버전), forget(soft delete), 질의 기반 일괄 forget, 저신뢰 기억 review. 검색 옵션 `rerank`(~100ms), `rewriteQuery`(~400ms), `threshold`, filters, recency bias. self-host에서 rerank 동작 여부는 미확인.
- 공식 plugin: Claude Code, Codex, OpenCode. 매 프롬프트 전 recall 주입, N턴마다 자동 저장, 사용자/저장소 스코프. `baseUrl`로 self-host 지정 가능.
- 벤치마크: hosted LongMemEval 81~85% 보고. self-host 수치 미공개.

## 4. 구독 사용 경로와 정책

- shim 후보: wende/claude-max-api-proxy(포트 3456, `/v1/chat/completions`, 로그인된 Claude CLI 사용, 모델 매핑 `claude-haiku-4` 등), RichardAtCT/claude-code-openai-wrapper, router-for-me/CLIProxyAPI(Codex·Gemini CLI도 묶음).
- 정책: `claude -p`·Agent SDK는 2026-09 현재 구독 한도에서 차감. 2026-06-15 별도 Agent SDK 크레딧 전환이 예고됐다가 보류(brief의 '구독 정책' 위험과 같은 사안). Codex는 ChatGPT 로그인으로 `codex exec` 가능하나 공식 안내는 자동화에 API 키 권장.
- 위험: 한도 공유, 정책 변동, Supermemory가 JSON mode 등 새 기능을 쓰면 조용히 고장, 호출마다 CLI 기동 지연.
- 사용자별 구독 선택은 불가(Supermemory 서버 설정이 전역). 개인용이므로 설정 한 곳에서 고름.

## 5. 비용 추정

- gpt-4o-mini 기준 입력 $0.15/M, 출력 $0.60/M. 대화 텍스트만 하루 10만 토큰 → 월 약 $0.6, 50만 토큰 → 약 $3, 도구 출력까지 500만 토큰 → $25~30. Supermemory가 같은 내용을 여러 번 읽으면 2~3배.
- 임베딩 `qwen3.7-text-embedding` $0.07/M, 입력 한도 131K, RPM 2000/TPM 1M(싱가포르). OpenRouter 대안 `qwen/qwen3-embedding-4b` $0.02/M, 33K.

## 6. 사전 시험 체크리스트

0. Model Studio API 키 재발급(기존 키가 대화에 평문 노출됨)
1. shim 설치·기동, `/health`, `/v1/models`, 한국어 chat, `response_format: json_object` 지원 여부
2. `~/.supermemory/.env`의 추출 LLM 두 줄 주석 해제
3. `npx supermemory local` 기동, 로그에서 `qwen3.7-text-embedding`/1024 확인
4. 한국어 문장 직접 생성 → 검색 (임베딩 endpoint 동작)
5. transcript 4개(하나는 2MB+) 변환·주입, 추출 완료까지 폴링 (shim 호환)
6. 한국어 질문 10개: 선호·규칙 3, "왜 그랬지" 3, "어디 있지" 2, 시간 기준 2. rerank on/off
7. 측정: shim 호출 수·입력량, 임베딩 호출 수, 세션별 소요, 변환 전후 크기
8. `~/.supermemory/test/REPORT.md`

## 7. 지금까지 식별된 포트

| 포트 | 첫 구현 | 시점 |
|---|---|---|
| `MemoryProvider` | Supermemory | slice 1 |
| `SessionRepository` | Postgres | slice 1 |
| 세션 수집 adapter | Claude Code | slice 1 |
| `KnowledgeProvider` | Graphify | 다음 |
| `ResourceProvider` | Google Drive | 다음 |
| 알림 채널(양방향) | Telegram | 스케줄러와 함께 |
| `CalendarProvider` | Google Calendar | 스케줄러와 함께 |
| `Worker` | Claude Code, Codex | 추출·실행에 필요할 때 |

포트는 첫 구현을 붙일 때 하나씩 확정한다. 구현 없이 한꺼번에 설계하지 않는다.

## 8. 환경 사실

- 집 Mac mini가 운영 머신. 시험은 현재 Mac에서. `~/.supermemory/.env`에 임베딩 설정과 키(권한 600).
- 두 번째 Mac → Mac mini는 Tailscale 예정.
- 알림 채널은 Slack·카카오톡·Telegram 모두 후보, Telegram 먼저. 승인은 반드시 받되 스케줄 생성 시 auto/ask 옵션.
- 문서 추적은 BMad 문서 흐름(brief → PRD → architecture → spec)으로 남긴다.

## 9. 사전 시험 이력 (2026-10-01~02)

같은 세션 4개(도구 출력 제거 후 약 3만 3천 자)와 같은 한국어 질문 10개(선호·규칙 3, 왜 3, 어디 2, 시간 2)로 쟀다. 추출 LLM은 전부 Claude 구독 shim(Haiku).

| 회차 | 구성 | 점수 | 주입 LLM 호출 / 입력 | 비고 |
|---|---|---|---|---|
| Supermemory 1차 | 통째 주입, shim에 tool-calling 없음 | 기억 모드 0/10, 원문 조각 모드 6/10 | 6회 / 2.8만 자 | 기억 0건, 조용한 실패 |
| Supermemory 2차 | shim에 tool-calling 구현 | 5/10 | 50회 / 164만 자 | 추출 루프 미수렴, 영어 저장, 중복 |
| Supermemory 3차 | 11분할 + shim 가드 + `filterPrompt` | 6.0/10 | 26회 / 17만 자 | 문서 15~20% 고착 |
| Hindsight 1차 | 통째, reranker OFF | 3/10 (영어 reranker ON이면 ≈1/10) | 13회 / 20만 자 (+통합) | 추출 누락 |
| Hindsight 2차 | 11분할 + `retain_mission` + `qwen3-rerank` | 7/10 (7.5) | 40회 / 96만 자 | 실패 0. 73%가 통합 |
| **기준선** | 조각 검색 + `qwen3-rerank` + 세션 요약 날짜 조회 | **10/10** | **4회 / 3.3만 자** | 조각 29개짜리 작은 코퍼스 |

확정된 사실:

- **Supermemory self-host**: 벤치마크 성능은 hosted 전용. 엔진은 Bun 바이너리(역분석 `~/.supermemory/test/re/FINDINGS.md`). 추출은 `stepCountIs(40)` 에이전트 루프, tool 결과 전문 누적, 서버측 중복 검사 없음, 언어 지시 없음, reranker는 Cloudflare 전용. "Lite 10k 문서" 문자열 존재.
- **Hindsight**: MIT, 소스 공개, shim 무수정 호환(retain=json_schema, reflect=tools). 추출은 끌 수 없고 통합은 `HINDSIGHT_API_ENABLE_OBSERVATIONS=false`로 끌 수 있음. 기본 reranker(`ms-marco-MiniLM`)는 영어 전용. 국제 리전 Qwen reranker는 `cohere` provider의 `HINDSIGHT_API_RERANKER_COHERE_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-api/v1/reranks`로 연결. `temporal_window`는 필터가 아니라 가산. reflect는 영어로 번역 검색하고 환각이 있었음.
- **reranker**: `qwen3-rerank`(호스팅) 1.2초, 로컬 `bge-reranker-v2-m3` 같은 점수에 31초, 로컬 Qwen3-Reranker-0.6B seq-cls 변환본은 무의미(1/10). `qwen3.7-text-rerank`는 국제 리전에 없음.
- **기준선 세부**: 내용 8문항은 조각 크기·파이프라인과 무관하게 8/8. reranker는 1위 정확도를 5.0 → 7.5로 올림. 조각 머리말(날짜·프로젝트)은 해로움. 키워드 하이브리드는 코퍼스가 작아 미측정. 시간 질문은 `session_summary` 날짜 조회로 2/2(0.1ms 미만). 요약의 `rules`·`decisions`만으로는 6.5/8 — 요약은 괄호·대비 절·수치를 체계적으로 떨어뜨림. 주입 맥락은 조각 5개 약 8,220자. 비용은 임베딩 $0.005 + rerank $0.09(질의당 약 $0.002).
- **구독 shim**(`~/.supermemory/shim`, 브랜치 `tool-calling`): OpenAI 호환 `tools`·`response_format`을 `claude -p --json-schema`로 변환. 호출당 26~105초. Brain에서는 `Worker` 포트가 `claude -p`를 직접 부르므로 OpenAI 흉내는 필요 없음.

## 10. 2026-10-02에 바뀐 결정

- 장기기억 backend: Supermemory self-host → **원본 보존 + 조각 검색(pgvector)**. 추출·통합 엔진은 선택 사항(1순위 후보 Hindsight).
- 추출 LLM: 조각마다 호출 → **세션당 요약 1회**.
- ①층: "원본 transcript 보존" → **대화 본문 + 도구 호출 한 줄 + 추적 정보**. harness 원본 파일은 보관하지 않음.
- §3(Supermemory 확인 사실), §4(구독 정책), §6(체크리스트)은 이력으로 남긴다. §7 포트 목록의 `MemoryProvider` 첫 구현은 pgvector 조각 검색으로 바뀐다.
