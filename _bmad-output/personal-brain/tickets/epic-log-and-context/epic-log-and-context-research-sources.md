# 에픽 3 원천 조사 — 작업 로그와 시작 맥락

조사일: 2026-10-23. 스토리 인셉션 입력이며 구현 결정서는 아니다. 지정된 원천과 현재 SQLite 마이그레이션을 읽기 전용으로 대조했다. 코드·기존 문서·티켓은 바꾸지 않았다.

경로 표기: 아래 `P/`는 저장소 상대 경로 `_bmad-output/personal-brain/`의 약칭이다. `SPEC`은 `P/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md`, `PRD`는 `P/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md`, `spine`은 `P/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md`, `에픽`은 `P/tickets/epic-log-and-context/epic-log-and-context.md`다. 표의 출처는 이 경로와 해당 절을 함께 뜻한다. 원천에 없는 설계 제안은 **추정**으로 구분한다.

## 1. 요구사항 목록과 원천별 추적

SPEC 머리의 계약에 따라 CAP·PRD·spine이 구현 계약이고, 서로 다르면 spine이 우선한다. 변경 제안과 inputs는 변경 이유·안내문 문장·인셉션 질문의 근거이며, 과거 제안의 문구를 현재 계약보다 우선하지 않는다.

| 원천 ID | 이 에픽이 지킬 문장 | 출처 경로·섹션 |
| --- | --- | --- |
| CAP-3 | 에이전트가 그 순간 진행·결정·규칙·선호를 적고, 해당 시점의 대화로 내려갈 출처를 보존한다. DB 불가 중 로그도 연결 뒤 빠짐없이 들어간다. | SPEC §Capabilities CAP-3 |
| CAP-8 | 시작 시 날짜·시간대·켜진 규칙·가까운 최근 로그·안내를 자동 제공하고, 성공·실패 시도를 기록하며 장애가 세션을 막지 않는다. | SPEC §Capabilities CAP-8 |
| CAP-9 | 사용자 발화 인용으로만 규칙을 켜고, 끈 규칙을 자동 복구하지 않으며, 결정·선호의 대체와 수정 이력을 보존한다. | SPEC §Capabilities CAP-9 |
| FR-7 | 네 종류 로그에 세션·발생 시각·작성 모델·세션 꼬리표가 따라붙고 LLM을 호출하지 않는다. 수집 전 쓰기도 허용하되 세션을 확정 못 하면 spool로 받는다. | PRD §4.2 FR-7; spine AD-6·12 |
| FR-8 | 세션 로그를 시간순으로 모으고 로그 시점 앞뒤 메시지를 읽을 수 있게 한다. 로그 수정·끄기는 원문 메시지를 바꾸지 않는다. 실제 원문 읽기 명령은 에픽 4다. | PRD §4.2 FR-8; 에픽 Done when 3 |
| FR-9 | 로그 없는 세션도 없어지지 않는다. 첫 요청은 가장 이른 user 메시지에서 읽고 따로 복사하지 않는다. 첫 요청·시각·꼬리표·도구 메모의 목록/시간 조회는 에픽 4와 연결한다. | PRD §4.2 FR-9; spine AD-14 |
| FR-17 | 현재 워크트리 → 현재 프로젝트 → 없으면 나 전체의 최근 로그를 채운다. 규칙은 어디서나+현재 프로젝트, 선호는 제외한다. 크기는 최근 로그 예산과 규칙 경고선을 구분한다. | PRD §4.5 FR-17; spine AD-17 |
| FR-18 | 프롬프트마다 내용 맥락을 주입하지 않는다. Stop 점검은 후속 변경으로 정한 한 번의 규율 피드백이며 UserPromptSubmit을 추가하지 않는다. | PRD §4.5 FR-18, §8-3; spine AD-17 |
| FR-19 | 규칙은 사용자 발화 문장 그대로이고 확인 승인 절차 없이 검증 후 다음 시작부터 적용한다. 기본 적용 범위는 어디서나이며, 요청하면 현재 프로젝트로 제한한다. 출처 프로젝트와 적용 범위는 별개다. | PRD §4.6 FR-19 |
| FR-20 | 결정은 주제·내용·이유·상태를 가지며 새 행이 대체한 옛 행을 가리킨다. 현재 유효 목록과 전체 변경 이력을 구분할 수 있어야 한다. | PRD §4.6 FR-20 |
| FR-21 | 선호도 새 행으로 대체하고 옛 행은 남긴다. 종류로 조회 가능하되 시작 맥락에 넣지 않는다. | PRD §4.6 FR-21 |
| FR-22 | 조회·문장 수정·끄기·규칙 범위 변경을 제공한다. 진행·결정·선호 수정마다 이전 문장과 수정 시각을 남긴다. | PRD §4.6 FR-22 |
| FR-23·24 | CLI는 SDK의 얇은 표면이며 명령 메타에서 schema/help를 생성한다. 에이전트용 JSON과 사람용 텍스트를 제공한다. hook 전용 출력·Markdown 전문의 형식은 별도 명시된 계약을 따른다. | PRD §4.7; spine AD-5 |
| FR-25 | doctor에 미검증 규칙·규칙 크기 경고·실패 주입을 드러낸다. 주입 시도 수는 세션 수와 비교한다. | PRD §4.7 FR-25; spine AD-17 |
| FR-26 | 로그·규칙은 원문 저장하고 시작 맥락과 Stop reason을 hook 출력 코덱으로 가린다. 조회는 엔벨로프 출력 코덱을 거친다. | PRD §4.7 FR-26; spine AD-11 |
| NFR-1·2 | 메시지 원문은 수정하지 않는다. 미검증은 `RULE_UNVERIFIED`, 로그 보관은 `SPOOLED`로 드러내며 주입·로그 실패를 기록하고 doctor로 확인한다. | PRD §5; 에픽 Boundaries |
| NFR-3·7 | 시작·종료를 Brain 장애로 막지 않으며 동기 hook에는 상한을 둔다. 시작 맥락 내부 시간과 프로세스 시작 포함 시간을 따로 잰다. | PRD §5, §7 SM-7; spine AD-6·17 |
| NFR-4·5·6 | 한국어 안내·조회를 지원하고 LLM 호출·기본 외부 전송·비용은 0이다. 정제·규칙 대조·시작 맥락을 위해 검색이나 외부 호출을 하지 않는다. | PRD §5; §4.5 Description; SPEC Constraints |
| NFR-8·9 | 꼬리표가 기록을 숨기는 칸막이가 되지 않게 하고, 로그·수정 이력·출처가 이후 내보내기·복구에서 보존되도록 데이터 계약을 넘긴다. 내보내기 구현은 에픽 5다. | PRD §5; SPEC CAP-12 |
| AD-6 | `append/list/edit/set-state/set-scope`는 transcript를 찾으면 선수집한다. `context.show`·`log.remind`는 선수집·쓰기 트랜잭션 없이 읽기+spool만 한다(Stop은 표식 파일도 허용). | spine §AD-6 |
| AD-9 | 실패한 로그·주입 시도는 프로세스별 JSONL spool로 쓴다. 생성 ID·사건 시각을 재주입 때 바꾸지 않고, 반복 실패 레코드를 버리지 않는다. `append`는 `SPOOLED` 경고와 성공이다. | spine §AD-9 |
| AD-11 | 현재 로그 문장은 `log_entries.text` 하나다. edit와 이전 문장 이력 저장은 같은 트랜잭션, 대체는 새 행+`supersedes_id`다. 모든 외부 문자열은 출력 코덱을 지난다. | spine §AD-11 |
| AD-12 | 세션은 `sessions.ensure`만 만든다. 세션 시작 폴더 `startCwd`, 없으면 cwd 있는 첫 메시지로 꼬리표를 정하고 로그는 `session_id`로 따른다. | spine §AD-12; 에픽 Carry; 에픽 2 story 25 Decision |
| AD-13 | 사건 시각은 Clock으로 한 번 정하고 저장 시각과 나눈다. UTC 정규형은 24자 `YYYY-MM-DDTHH:MM:SS.sssZ`; 자연어 날짜는 에이전트가 바꾼다. 시작에 오늘 날짜·설정 시간대(기본 Asia/Seoul)를 넣는다. | spine §AD-13 |
| AD-14 | 로그를 자동 추출하지 않는다. 대화 연결은 `occurred_at`뿐이며 anchor·메시지 번호·join 일감이 없다. `pending/on/off`, pending만 자동 on, off는 사람의 set-state만 정한다. | spine §AD-14 |
| AD-14 인용 대조 | 저장 본문·인용을 양쪽 NFC 정규화 후 비교한다. 위치는 저장 본문 코드 포인트 반열린 구간이며, 위치 없으면 유일하게 한 군데 맞아야 성공한다. 실패는 pending+doctor다. | spine §AD-14 |
| AD-17 안내 | Core 상수 하나에서 guide 전문·시작 요약·스킬을 만들며 생성 스킬을 커밋한다. 생성물 일치·`tested_against`·명령/flag 실존을 parity로 지킨다. | spine §AD-17 |
| AD-17 맥락 | 고정 머리말(날짜·시간대·세션 토큰) → 규칙 → 최근 로그 → 안내 요약 순서다. 규칙 경고선 초과는 warn, 전체 10,000자 초과는 프로젝트 규칙 우선/각 최신 순+생략 수 안내+doctor fail이다. | spine §AD-17; PRD FR-17 |
| AD-17 Stop | Stop에만 반응한다. 토글 on, `stop_hook_active=false`, transcript 사용자 발화 ≥ 상수, DB·spool 모두 세션 로그 없음, 표식 없음일 때만 한 번 피드백한다. 세션 없음·판정 불명·오류이면 출력 없이 exit 0이다. | spine §AD-17; 에픽 Description·Notes |
| AD-17 기록 | start 성공·실패를 spool→drain→`context_injections`로 기록한다. 토글 on 상태로 돈 Stop 점검 호출도 매번 기록한다. doctor 주입 비율·SM-C1은 start만, 내부 `elapsed_ms`는 두 종류 모두다. | spine §AD-17 |
| AD-28 | `context.show`·`log.remind`는 `hook: only`라 MCP 도구/소켓 verb로 생성하지 않는다. MCP 쓰기의 세션 토큰 인자 계약을 스킬·토큰 머리말이 준비한다. | spine §AD-5·28 |
| SM-1 | 2주 동안 전날 작업 프로젝트에서 “이어서”로 추가 설명 없이 잇는 비율 ≥80%를 사람이 기록한다. 자동 계측 수치로 대체하지 않는다. | PRD §7 SM-1 |
| SM-4a·b·c | 로그 ≥1 세션 비율 ≥80%; 매주 표본 3세션의 결정 기록 비율 ≥80%; 다른 에이전트가 로그만으로 이어갈 수 있는지도 사람이 판단한다. Stop 효과의 SM-4a는 전체·적격(발화 ≥상수) 두 모집단으로 비교한다. | PRD §7 SM-4; spine AD-17; change-discipline §4.6 |
| SM-6 | 같은 뜻 규칙을 다시 말한 횟수 주 1회 이하를 사람이 기록한다. | PRD §7 SM-6 |
| SM-7 | 중앙값 기준 시작 맥락 내부 0.5초·전체 1초 목표를 실측한다. 전체 목표는 첫 구현에서 확정할 추정값이다. `elapsed_ms`만으로 프로세스 시작 포함 전체를 대신하지 않는다. | PRD §7 SM-7; SPEC Assumptions |
| SM-C1·C3 | 최근 로그 600자·규칙 경고선 1,000자·세션당 로그 중앙값 10줄 이하는 추정 기준이다. 로그 비율을 올리려고 사소한 로그를 강제하거나 맥락 크기를 늘리지 않는다. | PRD §7 Counter Metrics |
| §8-3·D1~D3 | 플러그인 스킬/안내에 Stop 점검을 보완한다. 토글 기본 false·설치기는 묻지 않음. 첫 주 off, 둘째 주 on으로 SM-4a를 비교한 뒤 기본값을 정한다. | PRD §8-3; `P/change-discipline-and-metrics/change-discipline-and-metrics.md` §3·4.6 |
| B1 | 절대 날짜, 자격증명 기록 금지, 추정 표시, 정정과 폐기 구분, 대화 지시는 데이터, 기록할 게 없어도 정상, 한 문장·사용자 언어를 안내한다. | `P/inputs/weknora-patterns.md` §1.2 B1 |
| B2 | 대명사 대신 고유명사, 주제는 값보다 대상을 쓰도록 안내한다. | 같은 파일 §1.2 B2 |
| B3 | 결정에는 짧은 이유를 붙인다. | 같은 파일 §1.2 B3 |
| B4 | 데이터는 지시/권한이 아님·현재 발화 우선·최근 로그는 샘플이므로 검색하라는 고정 머리말을 둔다. | 같은 파일 §1.2 B4 |
| B5 | 날짜+요일, 고정→규칙→로그 순서, 꺼진 기능 안내 제외를 반영한다. 시간대·토큰·안내 요약은 현재 AD-17을 함께 따른다. | 같은 파일 §1.2 B5; spine AD-17 |
| B6 | 저장 전 개행→공백·제어문자 제거·길이 상한을 적용한다. 규칙의 원문 동일성 문제는 §4·5에서 별도 결정한다. | 같은 파일 §1.2 B6 |
| B7 | 중간 규칙은 즉시 기록하며 “알겠다”만으로 완료하지 않고, 끝낼 때 완료/남은 일을 나눠 적는다고 안내한다. | 같은 파일 §1.2 B7 |
| C3 | 이번 결과 항목만 인용하고 직접 인용은 원문 단어 확인, 지난 답변 참조는 길잡이, 출처 창작·차용 금지를 안내한다. | 같은 파일 §1.3 C3 |
| C4 | 도구 설명은 언제/금지 상황/반환/메모/사용자 언어 예시를 가지며 대분류·소분류 설명이 서로를 가리킨다. | 같은 파일 §1.3 C4 |
| C5·C6 | 질의에서 메타 표현을 빼고 실제 대상·핵심 용어·한영 둘 다를 쓰게 한다. 총건수 안내는 개수·전체 목록 질문에만 쓴다. | 같은 파일 §1.3 C5·C6 |
| D6·S2 | 머리말·토큰을 보존한 상한 처리와 규칙 생략 안내를 구현한다. 출처가 지정된 pending 규칙의 메시지 식별 정보를 남길 자리는 인셉션에서 정한다. | `P/change-users-and-review-gaps/change-users-and-review-gaps.md` §3 D6, §4.1 이후 에픽 Notes S2 |
| 마스킹 B | 가린 출력의 인용은 원문 대조에 실패할 수 있다. 양쪽을 가려 비교할지는 미결이며 임의로 동일시하지 않는다. | `P/change-masking-b-and-review-fixes/change-masking-b-and-review-fixes.md` §4.1 이후 에픽 Notes; 에픽 Notes |
| I60 | `log_entry_edits`·`context_injections` 불변 trigger를 정한다. | `P/deferred-work.md` Triage 2026-10-16; 에픽 Carry |
| I50/A16 | `TRANSCRIPT_UNREADABLE`·`SESSION_NOT_FOUND`의 공용 코드(exit/retryable/hint) 등록 여부를 정한다. 지금 exit 1·hint 없음이라는 회고 관찰을 넘겨받는다. | `P/deferred-work.md` 해당 summary·Triage 2026-10-22; `P/tickets/epic-capture/epic-capture-retrospective.md` §4 A16 |
| I94 | 도구 메모 target 잘림을 길이로 추정하는 대신 명시 칸을 다음 마이그레이션에 둘지 정한다. 현 판정은 UTF-16 길이 ≥상한−1이라 정상 꼬리도 가릴 수 있다. | `P/deferred-work.md` “잘린 꼬리 규칙이 자름을 길이로 추정함”; 에픽 Carry |
| I155/A2 | harness 등록부를 Core 조립에 주입하는 seam과 실제 소스 import·상대경로 우회·Core Node API까지 보는 경계 검증을 넘겨받는다. | `P/deferred-work.md` “dispatch가 Core에 모듈 harness 등록부”; 회고 §4 A2·Action 6 |
| I105/N5 | 워커 지시를 사람 발화로 세는 현재 한계를 인셉션에서 판단한다. 첫 user 머리말로 워커 세션을 표시하는 B안은 미결이고 ORCA 환경변수만으로 판정할 수 없다. | `P/deferred-work.md` Triage의 워커 세션 항목; 회고 새 항목 N5·Action 6 |

에픽 Done when 대응: 1=FR-19/AD-14, 2=off 비복구, 3=대체 체인+occurred_at, 4=spool 재주입, 5=크기·시도·지연, 6=doctor, 7=쓰기 없는 hook, 8=안내/스킬 parity, 9=설치된 플러그인의 Stop 실측과 실패 계약이다. Carry의 P26/B2는 첫 메시지 cwd를 startCwd 우선으로 바꾼 최신 Decision을 따른다는 뜻이다.

## 2. Table Contract와 마이그레이션 입력

Table Contract는 전체 컬럼 목록이 아니라 키·작성자·변경 권한을 고정한다. 아래 현재 칸은 보조 근거 `packages/sqlite/migrations/0001_initial.sql`의 세 CREATE TABLE과 `0006_drop_message_seq.sql`의 로그 anchor 삭제를 함께 읽은 결과다. 설계상 요구되는 칸과 현재 저장 칸을 구분해야 한다.

| 테이블 | 현재 칸·제약 | 계약상 작성자·불변 규칙 |
| --- | --- | --- |
| `log_entries` | `search_rowid INTEGER PRIMARY KEY`(검색 내부키), `id TEXT NOT NULL UNIQUE`, `kind`, `session_id` FK→sessions, `occurred_at`, `recorded_at`, nullable `author_model`, `text`, nullable `rule_state`, nullable `apply_project_id` FK→projects, nullable `supersedes_id` 자기 FK. 필수 text 칸은 NOT NULL. kind는 progress/decision/rule/preference; rule일 때만 rule_state 필수, 값은 pending/on/off. 두 시각은 UTC 정규형 CHECK. STRICT. | UUIDv7 `id`를 작성 프로세스가 먼저 정한다. 생성은 append, 문장 수정은 edit, 상태·범위는 set-state/set-scope, pending→on은 append/drain만. `kind/session_id/occurred_at/author_model` 불변. 현재 문장은 이 행 하나. 세션 꼬리표를 복사하지 않는다. |
| `log_entry_edits` | `id TEXT PRIMARY KEY`, `log_entry_id TEXT NOT NULL` FK→log_entries, `previous_text TEXT NOT NULL`, `edited_at TEXT NOT NULL`(UTC 정규형 CHECK), STRICT. | edit가 현재 문장 변경과 같은 트랜잭션에서 이전 문장·수정 시각을 append한다. 기록은 불변. I60에서 UPDATE/DELETE 거부 trigger 결정. |
| `context_injections` | `id TEXT PRIMARY KEY`, `session_id TEXT NOT NULL` FK→sessions, `attempted_at TEXT NOT NULL`(UTC CHECK), `ok INTEGER NOT NULL` CHECK 0/1, nullable `code TEXT`, `chars INTEGER NOT NULL`, STRICT. | show/remind가 ID·시도 시각을 정해 spool에 쓰고 drain이 넣는다. 행은 불변. I60 trigger 결정. 시작 hook은 세션 행을 만들지 않는다. |

이 에픽이 반드시 더할 칸은 `context_injections.kind`(`start | stop`)와 `elapsed_ms`(Brain 내부 처리 시간)다. start의 ok는 주입 성공 여부, stop의 ok=1은 실제 차단/피드백을 낸 호출이며 code는 내지 않은 이유, chars는 출력 글자 수(없으면 0)다. doctor 주입 비율·SM-C1은 start만 센다. 기존 행을 start로 이행할 방법, 과거 elapsed_ms의 미측정 표현, CHECK·단위·null 허용은 원천에 명시되지 않아 인셉션에서 정해야 한다.

추가 후보는 pending 규칙의 인용 출처 메시지/원문 인용/코드 포인트 구간을 보존할 자리(S2), 결정 주제·이유·유효 상태 표현(FR-20), 도구 메모 잘림 정보(I94), 워커 세션 표시(I105 B안 채택 시)다. **추정:** 이들은 다음 마이그레이션 후보이며 특정 컬럼명을 확정한 원천은 없다. `apply_project_id` null=어디서나라는 표현과 supersedes 유효성·순환/분기 방지·현재 유효 상태 도출 규칙도 명문화가 필요하다.

`anchor_seq`·`joined_upto_seq`는 0006에서 삭제됐다. 메시지 FK나 anchor 캐시·재연결 일감을 되살리지 않는다. 다만 규칙 인용의 출처 저장(S2)은 로그의 대화 위치 연결과 목적이 다르므로 구분한다.

관련 공통 제약은 AD-8의 생성 ID·멱등키, AD-9의 최초 ID/발생 시각 보존, AD-13의 시각 코덱이다. 로그를 spool에서 실제 삽입하는 drain은 append의 재생이지 자동 로그 생성이 아니다(AD-14 “hook·drain은 로그를 만들지 않음”과 함께 해석).

## 3. 명령과 배포 표면의 입력·출력·규칙

정확한 새 flag·필수 인자 이름은 아직 계약이 없는 곳이 있다. 아래는 의미상 입력이며, 확정된 literal(`--kind rule`, `--json`, session 토큰 등) 외 새 flag를 발명하지 않는다. 출처는 spine AD-5·6·9·14·17·28, PRD FR-7~9·17~22, 에픽 Description·Boundaries·Notes다.

| 명령/표면 | 입력 | 출력 | 지켜야 할 규칙 |
| --- | --- | --- | --- |
| `brain log append` | 세션 토큰, 종류, 한 줄 본문(인자 외 stdin 지원), 규칙 인용·출처/범위 또는 결정 주제·이유·대체 대상의 의미 입력 | 생성 로그; DB 불가이면 성공+`SPOOLED`; 인용 미검증은 pending+`RULE_UNVERIFIED` | 가능하면 선수집, transcript 없으면 세션을 만들지 않고 spool. 정제·길이 제한. ID/occurred_at/author_model/세션 출처 보존. 규칙은 NFC 대조 후 on, off를 자동으로 되살리지 않음. |
| `brain log list` | 종류·세션/꼬리표·기간 등 필터. 규칙 조회 안내의 `--kind rule`은 확정 | 시간순 로그, 켜진 규칙·유효 결정·선호와 필요 시 이력의 목록 | 선수집 대상. 현재 유효/전체 이력을 어떻게 선택할지는 flag 설계 필요. 원문 읽기는 에픽 4에 연결. |
| `brain log edit` | 로그 식별자·새 문장 | 수정된 현재 문장과 실패/경고 엔벨로프 | 선수집. 이전 문장+수정 시각과 현재 변경을 원자적으로 저장. 규칙 편집 허용/재대조는 미결. |
| `brain log set-state` | 로그 식별자·상태 요청 | 갱신 상태 | 선수집. 사람의 off만 off를 정하며 자동 drain은 off→on 불가. 종류별 유효 상태·사용자 행위 식별 방식은 인셉션에서 정함. |
| `brain log set-scope` | 규칙 식별자·어디서나/현재 프로젝트 | 변경된 적용 범위 | 선수집. 출처 꼬리표와 적용 범위를 혼동하지 않음. 로그 전체에 범위를 추가하지 않음. |
| `brain context show` | hook stdin의 세션 식별·현재 위치 등 Harness 입력과 설정, 저장된 on 규칙·최근 로그 | hook 출력 코덱의 시작 맥락(`additionalContext`), 읽기 불가 시 대체 안내와 사용자 `systemMessage`; 주입 시도 spool | `hook: only`, 읽기 전용·선수집 없음·기회적 drain 없음·네트워크 없음. 머리말에 토큰·날짜·시간대. 10,000자와 로그 예산 준수, 선호 제외. |
| `brain log remind` | Stop stdin의 이벤트·`stop_hook_active`·`transcript_path`·세션, 설정 토글, DB·spool 로그 유무, 표식 | 조건 충족 시 top-level `{decision:'block', reason}`; 그 외 출력 없이 exit 0. 시도는 spool | `hook: only`, MCP/소켓에 없음. 기본 off면 설정·표식만 읽고 DB 미개방. 판정은 Core `isUserTurn`, DB 메시지 수가 아님. 성공 출력 뒤에만 표식. 30일 지난 표식은 drain이 청소. 어떤 오류도 종료를 막지 않음. additionalContext 대안은 실측 후 선택. |
| `brain guide show` 본문 | Core 규율 상수 하나 | Markdown 전문; 시작 맥락은 같은 상수의 요약+전문 명령 안내 | 명령/메타 뼈대는 에픽 2, 본문은 이 에픽. B1~B7·C3~C6 포함. 전문과 요약의 의미 parity 필요. |
| `plugin/skills/`의 `/brain:*` | Core 안내 상수·명령 메타/schema | 빌드 생성 후 커밋한 스킬 파일 | 개별 스킬 이름·분할은 미정. `tested_against`, 커밋본=생성물, 코드블록의 명령/flag 실존을 검사한다. 대분류/소분류 설명과 사용자 언어 예시를 포함하되 검색 구현은 에픽 4 소유다. |
| `plugin/hooks/hooks.json` SessionStart 동기 줄 | 에픽 2 node 런처를 통해 `context show` 호출 | 시작 맥락 | 이 에픽이 더한다. `|| exit 0`, 짧은 timeout, 쓰기 없음. 기존 SessionStart 비동기 bootstrap/drain 줄과 공존. |
| 같은 파일 Stop 동기 줄 | 같은 런처를 통해 `log remind` 호출 | 한 번의 규율 피드백 또는 무출력 | 이 에픽이 더한다. `timeout: 5`초, `|| exit 0`. 기존 Stop 비동기 수집(2.14)과 공존해서 Stop 줄은 둘. SubagentStop/StopFailure에는 걸지 않는다. |

일반 명령 출력은 AD-5 엔벨로프·사람용 텍스트와 출력 가리기 계약을 따른다. 세션 토큰의 외부 형식은 `harness:harness_session_id`이며 내부 UUID를 토큰으로 쓰지 않는다. 새로운 CLI 설명·예시는 명령 메타가 원본이다. 플러그인 hook 단일 출처와 guide/skill 생성 근거는 `P/change-surface-plugin-daemon/change-surface-plugin-daemon.md` §4.1·4.2이며 명령 이름은 현재 spine으로 보정한다.

doctor 확장은 이 에픽 Done when 6에 속한다: pending 인용, 규칙 경고선, 상한 초과 fail, start 주입/세션 비교, spool 실패 보존을 연결한다. `stats show` 구현은 에픽 5이지만 kind/elapsed_ms와 Stop 성공의 뜻을 지금 넘겨야 한다.

## 4. Source conflict 후보와 해석 우선순위

| 후보 | 어긋나는 문장 | 현재 처리/남은 결정 |
| --- | --- | --- |
| 옛 명령 이름 | change-surface §4.1·4.2는 `admin guide/schema`라고 하지만 에픽·spine은 `guide show/schema`다. inputs C4의 `brain schema`도 옛 표기다. | 해소된 역사 차이. change-users §6의 2026-10-16 사용자 Decision과 현재 AD-5를 따른다. |
| hook 소유 | change-surface §4.1 에픽 2 초안은 SessionStart 동기 줄까지 뼈대에 포함한다. | 에픽 2 Notes 2026-10-16 Decision과 에픽 3 Boundaries가 동기 context 줄을 에픽 3으로 명시하므로 그 소유를 따른다. |
| 꼬리표 근거 | 에픽 3 Notes 앞부분과 옛 change는 첫 메시지 cwd만 언급한다. | 에픽 3 Carry, spine AD-12, 에픽 2 story 25의 최신 Decision이 startCwd 우선/첫 cwd 메시지 fallback으로 대체했다. |
| 문자 동일성 | 에픽 Done when 1은 한 글자라도 다르면 제외, FR-19는 글자 단위 동일, AD-14는 양쪽 NFC 정규화를 허용한다. | spine 우선이면 정규화 동치가 허용된다. 테스트의 “그대로” 기준을 명시할 필요가 있다. |
| 정제 대 원문 규칙 | B6/에픽 Description은 로그 개행·제어문자 제거·길이 상한, FR-19는 규칙 원문을 그대로 요구한다. | 미해결. 다중행/긴 규칙을 자를지 거부할지, 대조 전후 어느 값을 저장할지 정해야 한다. |
| 마스킹 대 인용 | AD-11 출력은 가리고 AD-14는 저장 원문에 대조한다. 가린 출력의 `[REDACTED:…]`는 원문에 없다. | 에픽 Notes가 열린 질문으로 명시했다. 양쪽 마스킹 비교는 서로 다른 원문을 같게 볼 위험이 있어 자동 채택하지 않는다. |
| Stop 조건·상수 | change-discipline §3 D1·§4.1 초안은 조건 셋/발화 3/DB 로그만 언급한다. | 같은 문서 §4.6, 현재 AD-17, 에픽 Notes/Done when 9가 조건 넷·spool 포함·상수 미확정·모르면 무출력으로 보강한다. 3 vs 4는 실측 사항이다. |
| FR-18의 절대 문구 | FR-18 Consequences는 시작 뒤 도구 결과만 들어온다고 하나 AD-17은 Stop 피드백을 더했다. | 후속 승인된 Stop 예외로 해석하되 내용 주입/UserPromptSubmit 확장으로 일반화하지 않는다. |
| 시작 전 시도와 FK | AD-6는 SessionStart에서 세션을 만들지 않으나 context_injections 현재 session_id는 NOT NULL FK다. 성공·실패 시도를 모두 기록해야 한다. | 미해결. 세션 미생성/영구 미수집/DB 불가의 spool 기록이 끝내 어떤 FK로 저장되는지 설계 필요. |
| 결정 계약과 칸 | FR-20은 주제·이유·상태를 요구하나 현재 log_entries는 text/supersedes_id 외 전용 칸이 없다. | 미해결. 구조화 입력/칼럼 또는 문장 표현과 상태 도출을 정해야 한다. |
| stats 기준의 옛 문구 | change-discipline §3 D4·§4.1은 import 기본 제외, §4.6·현재 AD-5는 기본 포함/옵션 제외다. | 현재 spine을 따른다. 에픽 3 실험·handoff에도 전체/적격 모집단과 import 처리 조건을 남긴다. stats 구현은 에픽 5다. |
| drain의 로그 생성 표현 | AD-14는 drain이 로그를 만들지 않는다고 하고 AD-9는 spool 로그 재주입을 요구한다. | 최초 로그 저자는 append 호출자이고 drain은 같은 ID의 재생이라는 해석으로 양립한다. 테스트/문서에 구분한다. |
| 길이 단위 | 원천은 맥락 “글자 수”, 인용은 코드 포인트, I94 현 판정은 UTF-16 길이다. | 미해결. chars·로그 상한·hook JSON의 글자 수를 어느 단위/가리기 전후로 셀지 정해야 한다. |

## 5. 인셉션에서 정할 열린 질문

에픽 Notes·Carry에 이미 있는 질문:

1. **실측:** 플러그인으로 실제 설치한 상태에서 `hookSpecificOutput.additionalContext`만으로 모델이 다시 일하는가? 된다면 decision:block 대신 피드백 방식을 쓴다는 AD-17 조건을 검증한다. 되지 않으면 block+reason 경로를 검증한다.
2. **실측:** 사용자 발화 상수는 3인가 4인가? 비동기 transcript 기록으로 하나 덜 읽을 수 있으므로 Stop 시점의 parser 관찰과 실제 사용자 턴을 비교한다.
3. S2: 출처 메시지가 지정된 pending 규칙의 메시지 식별·인용·위치를 어디에 보존하고 drain이 어떻게 다시 대조하는가?
4. 마스킹 B: 가린 결과에서 인용한 규칙을 양쪽 마스킹 후 비교할 것인가? 원문 동일성·출처 유일성을 보존할 조건이 있는가?
5. I60: 두 불변 테이블의 UPDATE/DELETE 거부 trigger를 어떻게 두는가? 새 kind/elapsed_ms 이행과 충돌 없이 적용하는 순서는 무엇인가?
6. I50/A16: 두 코드의 중앙 등록 여부와 exit/retryable/hint를 정한다. guide exit-codes와 오류 출력이 같은 계약을 보도록 한다.
7. I94: 다음 마이그레이션에 target 잘림 칸을 포함할 것인가? 포함하면 옛 행의 추정과 새 parser의 명시 표시는 어떻게 구분하는가?
8. I155/A2: harness 등록부 주입 위치와 실제 import/Node API 경계 검증의 소유 스토리를 정한다.
9. I105/N5: 워커 세션 표시 B안을 채택할 것인가? 그 세션의 지시를 사람 발화에서 빼면 Stop 발화 수·규칙 발화 자격도 함께 바뀌므로 사용자 결정을 받아야 한다.
10. Stop on/off 주간 비교 후 기본값을 정하는 시점과 증거를 남긴다. 전체·적격 SM-4a, SM-4b·SM-C3를 함께 봐 억지 로그 효과를 구분한다.

이번 조사에서 새로 식별한 설계 질문(원천에서 답을 찾지 못함):

1. 규칙은 edit 가능한가? FR-22는 진행·결정·선호만 수정 이력을 명시한다. 허용한다면 기존 off·검증 상태·출처를 어떻게 유지하며 재대조할 것인가?
2. 긴/다중행/제어문자 있는 규칙의 정제·거부 정책과 NFC 동일성의 테스트 기준은 무엇인가? 일반 로그 길이 상수도 미정이다.
3. 처음 SessionStart에서 세션 UUID가 없는 주입 시도를 어떻게 영속화하는가? 세션이 영원히 생성되지 않아도 실패 시도가 점검에서 보여야 하는가?
4. 기존 context_injections 행의 kind/elapsed_ms backfill·미측정 표현, stop 무출력 이유 code 목록, elapsed_ms 경계(시작/끝 지점)를 정한다. **추정:** 미측정 과거 지연을 0으로 쓰면 SM-7 중앙값을 오염시킬 수 있다.
5. 결정의 주제/이유/상태, 선호·결정의 현재 유효 판정, supersedes 대상 종류·세션 간 허용·분기/순환/자기참조·동시 append 처리를 정한다.
6. set-state가 사람이 요청한 off임을 어떻게 나타내는가? on 전환은 반드시 재검증을 요구하는가? “끄기/켜기”의 종류별 상태 입력은 무엇인가?
7. 최근 로그 채움에서 가까운 범위가 비어 있을 때만 fallback하는가, 남은 예산을 다음 범위로 채우는가? 대체된 결정·꺼진 규칙·선호를 최근 로그에 포함할지 정한다(선호 자동 주입 금지는 확정).
8. 10,000자 계산에 hook JSON wrapping·마스킹으로 늘어난 길이·생략 줄·안내를 포함하는가? 고정 머리말+생략 줄 공간을 언제 예약하는가? “글자”의 Unicode 단위를 고정해야 한다.
9. Stop 표식 확인→출력→생성 사이 겹친 호출에 대해 한 번을 어떻게 보장하는가? spool의 open/claiming/failed 등 어느 상태에서 로그 존재를 판정하며 모름은 어떻게 반환하는가?
10. 플러그인 `/brain:*`의 구체 이름·분할, stdin/본문 인자 동시 제공 정책, 각 log 명령 필수 인자·목록 이력 필터·정렬 동률 규칙은 무엇인가? 아직 없는 에픽 4 명령을 스킬 코드블록에 언제부터 넣을 것인가(parity와 충돌 가능)?
11. SM-7 전체 시간의 측정 환경·표본 수·프로세스 기동 포함 범위를 정하고, 내부 elapsed_ms와 분리해 보고한다. SM-1/4b/4c/6의 사람 기록 양식은 운영 측정과 연결한다.

위 질문은 조사 결과이며 결정이 아니다. **추정:** 스토리 쪼개기 전에 데이터/실패 계약과 hook 실측을 먼저 확정하면 뒤 스토리가 서로 다른 상태·칼럼·출력 의미를 구현하는 위험을 줄일 수 있다.

## 6. 이 에픽 밖의 명시적 경계

- 내용 검색·시간 조회·원문 앞뒤 읽기·조각/FTS 색인·미러·검색 회귀 러너·`recall --count`는 `epic-recall-and-mirror`(에픽 4)다. 이 에픽은 로그 시각·출처·안내와 상태 계약을 제공한다.
- 플러그인 bootstrap·node 탐색 런처·세션 토큰 수집·spool/drain 기반·SPOOLED 정의·guide 명령/메타 뼈대·기존 비동기 수집 hook은 `epic-capture`(에픽 2)의 결과다. 이 에픽은 skills, guide 본문, 동기 SessionStart/Stop 줄과 로그/주입 재생 handler 연결을 맡는다.
- `stats show`, 내보내기·복구·업그레이드·WAL 정리는 `epic-operations`(에픽 5)다. 이 에픽의 kind/elapsed_ms/ok 의미와 SM-7 실측은 그 입력이다.
- Postgres 스키마 따라잡기·복제는 에픽 7, MCP·소켓·데몬은 에픽 9다. hook-only 제외 메타와 세션 토큰 안내만 현재 준비한다.
- 첨부·문서 추출과 다음 parser 버전 업 전 전체 다시 읽기 보강은 에픽 10이다. I94는 Carry로 이 에픽이 “이번 마이그레이션에 둘지” 결정하는 범위다.
- slice 1은 워크스페이스·로그 한 줄별 범위·조직/개인 구분을 두지 않는다. 규칙의 어디서나/현재 프로젝트 적용 범위만 쓴다.
- 선호 자동 주입, 프롬프트마다 맥락 주입, 규칙의 AGENTS.md/CLAUDE.md 복사, LLM 로그 자동 추출·세션 요약·통합은 범위 밖이다. 지시 파일에는 “Brain을 써서 찾고 적어라” 수준만 둔다.
- 두 번째 Harness 수집·웹 채팅 parser·과거 세션 일반 가져오기·다중 사용자·팀 공유는 slice 1 밖이다. 설치 시 기존 transcript 1회 수집은 에픽 2 범위이며, 워커 세션 표시 여부는 이 에픽 Carry의 별도 결정이다.

주요 경계 출처: 에픽 Boundaries·Notes·Carry, SPEC Non-goals·Constraints, PRD §6·§8-1/3, spine AD-5·6·17·28 및 Deferred, `P/change-discipline-and-metrics/change-discipline-and-metrics.md` §4.1·4.6, 에픽 2 회고 Action 6.
