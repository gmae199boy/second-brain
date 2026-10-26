# 에픽 10 첨부 원본과 문서 추출 — 원천 조사

조사일: 2026-10-22. 목적은 스토리 인셉션 입력 수집이며 구현·원천 문서 수정은 하지 않았다. 아래 경로는 모두 저장소 상대 경로다. 경로 약칭의 기준 디렉터리는 `_bmad-output/personal-brain/`이며, 각 약칭은 다음 문서를 뜻한다.

| 약칭 | 출처 경로 |
| --- | --- |
| 에픽 | `_bmad-output/personal-brain/epic-attachments/epic-attachments.md` |
| spec | `_bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md` |
| PRD | `_bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md` |
| spine | `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` |
| 패턴 | `_bmad-output/personal-brain/inputs/weknora-patterns.md` |
| 수집 연구 | `_bmad-output/personal-brain/epic-capture/epic-capture-research.md` |
| 수집 에픽 | `_bmad-output/personal-brain/epic-capture/epic-capture.md` |
| 미룸 | `_bmad-output/personal-brain/deferred-work.md` |
| 회고 | `_bmad-output/personal-brain/epic-capture/epic-capture-retrospective.md` |
| 초기 스키마 계획 | `_bmad-output/personal-brain/epic-foundation-and-install/story-untitled-12-plan.md` |
| 0004 계획 | `_bmad-output/personal-brain/epic-capture/story-0004-plan.md` |
| 0005 계획 | `_bmad-output/personal-brain/epic-capture/story-0005-plan.md` |

우선순위: spec 서두는 CAP을 기준으로 삼되 PRD의 검증 결과와 spine의 구현 불변식을 함께 따르며, spine과 다르면 spine을 우선한다고 명시한다. 과거 계획의 당시 상태와 이후 결정은 구분했다. 아래 ‘충돌 후보’와 ‘추정’은 새 결정을 뜻하지 않는다.

## 1. 원천 ID별 요구사항

| 원천 ID | 이 에픽이 지켜야 할 요구사항 | 출처·섹션 |
| --- | --- | --- |
| CAP-14 | 사용자 첨부 원본을 메시지와 연결하고 동일 내용은 한 번 보관한다. 원본 위치를 통해 다시 열 수 있고 사용자 기존 파일을 이동·삭제하지 않는다. 문서 내용·이름·경로, 사진 촬영 일시를 후속 검색이 사용할 수 있게 남긴다. 읽지 못한 문서를 표시한다. | spec §Capabilities CAP-14; 에픽 §Description·Outcome·Done when 1·3 |
| CAP-2 | 추출 텍스트도 원문을 저장하고 나갈 때 비밀을 가린다. 저장본 파일 가리기는 지운 내용이 파생물로 살아나지 않게 해야 한다. | spec §Capabilities CAP-2; spine AD-11·23; 에픽 §Notes 2026-10-19 |
| FR-26 | 출력 가리기는 Core 공통 함수·패턴 버전을 쓴다. 저장본 가리기 기록에는 지운 원문을 보존하지 않는다. 첨부 바이트는 출력 패턴으로 바꾸지 않고 `files.redact`로 처리한다. | PRD §4.7 FR-26; spine AD-11·23 |
| FR-27 | 로컬·연동 저장소 위치 차이를 내용 ID 뒤에 숨기고 위치 변경 때문에 메시지 기록을 다시 쓰지 않는다. 같은 파일은 Brain 사본과 사용자 원본 위치를 함께 가질 수 있다. | PRD §4.7 FR-27; spine AD-23 |
| FR-28 | txt·md·텍스트 PDF·docx의 본문 조각 및 원본 위치를 남긴다. 경로·표시 이름을 별도 색인하고 이미지 EXIF 촬영 일시를 보존한다. 미지원·실패가 조용히 누락되지 않는다. 검색 소비 기능은 후속 에픽 경계다. | PRD §4.7 FR-28; spine AD-24; 에픽 §Boundaries |
| NFR-1 | 내용과 첨부 자리·출처는 불변이다. 저장본 파일 가리기는 AD-23이 추가로 정한 예외다. | PRD §5 NFR-1; spine AD-11·23·Table Contract |
| NFR-2 | 실패 세대·실패 단계·실패 기록을 남기고 doctor에서 드러낸다. 고아 블롭 건수·바이트도 보여 준다. 파일 재시도는 기존 `failures retry`의 대상 종류 `file`로 잇는다. | PRD §5 NFR-2; spine AD-21·24; 에픽 §Done when 4·Notes 2026-10-16 |
| NFR-3 | 수집이 문서 추출 완료를 기다리지 않게 drain으로 분리하고 쓰기 잠금 시간을 제한한다. | PRD §5 NFR-3; spine AD-7·24 |
| NFR-4 | 문서 본문과 파일 이름은 한국어 부분 일치 검색이 가능한 색인으로 남겨야 한다. 검색 질의·순위는 후속 에픽이 맡는다. | PRD §5 NFR-4; spine AD-24·AD-15 기본 검색 규칙 |
| NFR-5 | LLM·OCR·필수 임베딩 없이 로컬 추출과 키워드 색인을 구성한다. | PRD §5 NFR-5 및 FR-28 Consequences·Out of Scope; spec §Constraints |
| NFR-6 | 기본 외부 전송은 없고 추출 텍스트가 나갈 때 알려진 비밀을 가린다. 파일 루트는 동기화 폴더에 두지 않는다. | PRD §5 NFR-6; spine AD-11·23 |
| NFR-9 | 원본이 DB 밖에 있으므로 문서 추출 세대와 조각은 내보내기·복구 대상이다. 접근 불가 원본은 표시하되 기존 조각은 유지한다. 내보내기 구현 자체는 에픽 밖이다. | PRD §5 NFR-9; spine AD-24·Conventions 내보내기 |
| AD-7 | 모든 DB 쓰기는 `withWrite`/`BEGIN IMMEDIATE`를 통한다. 트랜잭션 안 파일·네트워크 I/O 금지, 잠금 2초 상한. 블롭 쓰기와 추출은 밖에서 하고 DB 배치만 짧게 쓴다. drain 청구도 짧은 트랜잭션이며 모든 작업은 멱등이다. | spine §Invariants & Rules AD-7 |
| AD-9 | DB에 못 쓴 첨부 연결 메타데이터는 spool로 보존한다. 첨부 바이트는 넣지 않는다. 한 줄 64KB 이하, 원래 ID·시각 보존, 기존 재주입·실패 보관 경로를 쓴다. | spine AD-9·23 |
| AD-11 | 추출 저장본에는 원문이 있고 출력 코덱에서만 공통 마스킹을 적용한다. 파일 저장본 가리기에도 파생물·후속 출력에서 내용이 재등장하지 않는 계약이 필요하다. 기존 `messages.redact`에 첨부 미가림 경고를 붙인다. | spine AD-11·23; 에픽 §Description |
| AD-21 | 추출·고아 정리·블롭 삭제는 `work_items`와 drain에 붙인다. 미완료 `(kind,target_kind,target_id)`는 하나. 청구·재시도 상수는 Core 소유다. DB 불가에는 시도 증가 없이 spool, 영구 오류는 첫 실패에서 기록·닫기, 일시·미분류는 정해진 간격으로 최대 10회다. | spine AD-21; 에픽 §Notes 오류 분류 |
| AD-23 | 해시는 `sha256:`+소문자 hex. locator는 내용의 순수 함수, 임시 파일→rename. FileStore는 넣기·가져오기·확인·URL·지우기 port이며 `brain` 소유와 설정 루트 안 조건을 모두 만족할 때만 쓰고 지운다. 루트 0700/파일 0600, 사용자 원본은 `external`. | spine AD-23; 에픽 §Done when 3 |
| AD-23 | 블롭부터 트랜잭션 밖에서 저장하고 행을 쓴다. 위치 행이 없는 루트 내부 블롭은 기본 24시간 유예 후 drain이 지우며 doctor가 건수·바이트를 보인다. | spine AD-23; 에픽 §Done when 4 |
| AD-23 | `files.redact`는 내용 단위다. 한 트랜잭션에서 `redacted_at`, 추출 세대·조각·FTS 삭제, 이름·이름 FTS·메타데이터 삭제, `redactions`, 모든 Brain 위치의 블롭 삭제 일감을 묶는다. 재추출·이름·메타데이터 재생성은 가린 파일을 건너뛴다. 미가림 첨부가 있으면 `messages.redact`는 `ATTACHMENT_NOT_REDACTED` 경고를 낸다. | spine AD-23; 에픽 §Notes S13·Description |
| AD-24 | 확장자 대신 내용으로 형식을 판정한다. `extractor_version`에 라이브러리 버전을 포함하며 라이브러리를 올리면 상수도 바꾼다. `files reindex`는 새 추출 시도를 만든다. | spine AD-24; 에픽 §Description |
| AD-24 | `attempt`는 Store 삽입 트랜잭션의 `max+1`, 파일당 열린 세대 하나. 성공한 더 큰 attempt만 포인터를 바꾸며 실패는 이전 포인터를 유지한다. 실패 세대의 조각·FTS를 삭제한다. 만료 청구의 열린 세대는 다음 청구가 마지막 단계의 `failed`로 닫고 새 시도를 연다. | spine AD-24; 에픽 §Done when 2·Notes S9·S10 |
| AD-24 | `failed`가 되는 쓰기는 `failed_stage(read/extract/chunk/index)` 필수. locator는 Core 정규형 JSON, 텍스트 범위는 코드 포인트다. PDF만 `page`가 있고 나머지는 null. 사본 불일치는 null까지 비교해 Store가 거부한다. 조각·FTS는 예시 200개 단위처럼 2초 안의 배치로 쓴다. | spine AD-24; 에픽 §Done when 2·Notes S12·2026-10-19 |
| AD-24 | 이미지 EXIF를 신뢰하지 않는다. `captured_at_local` 원문, 시간대를 알 때만 `captured_at` 정규형, `captured_at_source`를 구분한다. 접근 불가 원본은 `source_unreachable_at`으로 표시하고 조각은 검색 가능하게 유지하며 `FILE_SOURCE_UNREACHABLE` 경고와 재추출 금지를 적용한다. | spine AD-24 |

NFR-7(조회 지연)·NFR-8(꼬리표)은 PRD §5의 공통 규칙이지만 이 조사 대상 FR-26~28의 첨부 저장·추출 수용 조건으로 별도 수치를 추가하지 않는다. 검색 소비 측의 책임과 구분한다.

추가 인셉션 입력:

- 패턴 §1.1 A1·A10은 위치와 오래된 시도 덮어쓰기 방지의 동기다. 수집 에픽 Notes 2026-10-15 및 패턴 §6 항목 8에서 A1은 locator만, A10은 attempt·failed_stage·포인터 가드로 단순화했다. quote·source_hash·하류 cancelled 단계 트리를 새 필수 조건으로 되살리지 않는다.
- 수집 연구 §4: 한 달 표본에서 사용자 붙여넣기 이미지 11건(base64 png/jpeg, 최대 약 658KB), @파일의 `attachment.file` 5건, PDF·document 블록 0건. 도구 결과 이미지 30건은 제외다. `edited_text_file`·`compact_file_reference`도 있지만 사용자 첨부와 같은 것으로 단정할 근거는 없다.
- 회고 §Findings 3 C2/I104: 크기만 비교하는 스캔 때문에 닫힌 세션이 parser 버전 변경 때 다시 읽히지 않는다. 첨부 backfill과 같은 경로로 풀고 **다음 parser 버전 업 전** 완료해야 한다. C3의 늦게 온 Agent·Task 결과 메모도 전체 다시 읽기에 의존한다.
- 회고 §Findings 3 C4·Action items 1: hook 수집 성공도 해당 세션의 이전 `session_ingest` 실패를 해소하게 한다. C2 스토리에 묶고 회귀 시험 하나를 둔다는 결정이며, 따로 할지 묻는 열린 질문이 아니다.
- 미룸 §Triage 2026-10-16 I75 및 회고 §Findings 2: Core `Redaction.fileId`와 nullable `start`/`end`가 필요하다. 파일 대상 DB 자리는 0004로 해결했으므로 다시 만드는 작업으로 잡지 않는다.
- 회고 §Findings 2·Action items 5: I67 변경 규칙, P19 줄어든 transcript 반복 enqueue, P34 가리기 뒤 파생물 연쇄를 함께 인셉션에 넣는다. P34 근거는 `_bmad-output/personal-brain/epic-capture/story-messages-redact-plan.md` §Implementation Notes·남은 위험이다. 그중 첨부 연쇄가 이 에픽 몫이다.

## 2. Table Contract 요약 — 일곱 테이블

spine §Table Contract는 모든 칼럼을 고정하지 않고 키·작성자·변경 규칙을 고정한다. 아래 칸 목록은 초기 스키마 계획 §Design Notes의 목록에 0004 계획 §Boundaries & Constraints 및 0005 계획의 추출 실패 trigger 변경을 합친 **문서 기반 요약**이다. 현재 코드의 전수 스키마 감사 결과는 아니다. `home`은 spine의 개념명이고 계획의 실제 칸 이름은 `home_location_id`다.

| 테이블 | 칸 | 키·제약·불변 규칙 | 작성자·출처 |
| --- | --- | --- | --- |
| `files` | `id`, `content_hash`, `size_bytes`, `first_seen_at`, `home_location_id`, `current_extraction_id`, `redacted_at`, `source_unreachable_at` | `content_hash` UNIQUE, sha256 소문자 hex 64자리; 크기 >=0. 내용 불변, 행 삭제 거부. 바뀌는 것은 home·현재 세대·가리기·접근 불가 시각. home은 같은 파일의 Brain 위치만, 추출 포인터는 같은 파일의 세대만. redacted_at은 가리기 표시 아래 null→값만. | 첨부 수집·소스 동기화; spine AD-23·24·Table Contract, 초기 계획 §Design Notes·Implementation Notes, 0004 계획 |
| `file_locations` | `id`, `file_id`, `store_kind`, `locator`, `ownership`, `first_seen_at`, `source_modified_at`, `uploaded_at`, `remote_checksum`, `verified_at`, `deleted_at` | UNIQUE `(file_id,store_kind,locator)`; store_kind local/drive, ownership brain/external. 소유·locator 등은 불변, DELETE 거부. verified_at·deleted_at만 null→값 한 번. Brain 이전은 넣기→검증→같은 트랜잭션의 검증 시각·home 전환→별도 옛 블롭 삭제. | 저장·이전·소스 동기화; spine AD-23·Table Contract, 초기 계획 §Design Notes·Implementation Notes |
| `message_attachments` | `id`, `message_id`, `ordinal`, `source_kind`, `source_ref`, `display_name`, `file_id`, `status` | UNIQUE `(message_id,ordinal)`; ordinal >=0. 자리·출처 불변, file_id·상태는 수집이 한 번 채움. 상태 null/stored/missing_at_ingest; stored와 file_id 존재가 동치(초기 계획의 오래된 식보다 Implementation Notes의 교정 식 우선). source_kind는 parser 소유 문자열. | sessions.ingest; spine AD-23·Table Contract, 초기 계획 §Implementation Notes |
| `document_extractions` | `id`, `file_id`, `extractor_version`, `media_type`, `status`, `started_at`, `finished_at`, `error`, `attempt`, `failed_stage`, `index_config_id` | id 및 `(file_id,attempt)` UNIQUE; attempt >=1, Store가 삽입 시 max+1. 파일당 finished_at null인 세대 하나. 종료 상태 ok/failed/unsupported/too_large/redacted, 진행 중 status null; finished_at null과 status null 동치. 실패 단계 read/extract/chunk/index. index_config_id는 nullable FK(기존 행 호환), 새 세대 채우기 규칙은 이 에픽이 정함. 상태·실패 단계 진행만 허용하며 내보내기 포함. | drain 추출; spine AD-24·Table Contract, 초기·0004·0005 계획 |
| `document_chunks` | `search_rowid`, `id`, `extraction_id`, `ordinal`, `page`, `body`, `chunk_locator` | search_rowid PK, id UNIQUE, `(extraction_id,ordinal)` UNIQUE. 새 locator null 거부, JSON 정규형; page는 PDF locator.page 사본, 비PDF null. 본문은 원문. 세대 교체·가리기로만 삭제하는 계약이며 AD-24는 실패 세대 청소도 명시한다. 본문 FTS는 행 쓰기와 같은 트랜잭션. 내보내기 포함. | drain 추출; spine AD-24·Table Contract, 초기·0004 계획 |
| `file_names` | `search_rowid`, `id`, `file_id`, `name_source`, `text` | id UNIQUE, `(file_id,name_source,text)` UNIQUE; name_source location_path/attachment_name. 위치 경로와 표시 이름을 모은 파생물, 다시 생성 가능. 이름 FTS도 가리기 때 삭제하며 가린 파일은 재생성 금지. | drain; spine AD-23·24·Table Contract, 초기 계획 §Design Notes |
| `file_metadata` | `id`, `file_id`, `key`, `value` | `(file_id,key)` UNIQUE. 파생물. EXIF와 촬영 일시 세 키를 보존; captured_at만 정규형 시각 CHECK, 시간대 모르면 지어내지 않음. 가리기 때 삭제, 가린 파일 재생성 금지. | drain 추출; spine AD-23·24·Table Contract, 초기 계획 §Design Notes |

공통 불변식:

- 연결은 messages→message_attachments→files→locations/extractions→chunks다. 같은 내용의 여러 메시지 연결은 내용 하나를 공유한다. 내용 단위 가리기의 영향도 모든 연결에 걸친다.
- `chunk_locator` 타입은 pdf(page,bbox), docx(block), text(start,end), time(start_ms,end_ms), sheet(sheet,row_start,row_end). Core 코덱이 type을 첫 키로, 고정 키 순서·null 생략·공백 없이 만든다. time/sheet 자리의 존재는 오디오·시트 추출기 구현 요구가 아니다.
- 성공 시 포인터 전환·옛 세대/FTS 삭제는 원자적이고 새 attempt만 전환 가능하다. 실패 시 현재 세대는 그대로이며 실패 시도의 조각·FTS는 청소한다. 열려 있으나 청구 만료인 세대는 회수해야 한다.
- 0004 이전 행의 locator null·실패 단계 없음은 역사 호환 예외다. 0005는 새 failed 쓰기와 실패 단계 제거를 막고, 이미 단계 없는 옛 failed 행의 다른 칸 수정은 허용한다(0005 계획 해당 trigger 규칙).
- 초기 계획의 ‘버전당 열린 세대 하나’는 0004에서 ‘파일당 하나’로 대체되었다. `document_extractions.index_config_id`·파일 가리기 `redactions.file_id`는 이미 마련됐다(미룸 §Triage 2026-10-16). 트리거 강화 여부 I67과 Core 표현 I75는 남았다.

## 3. Source conflict 후보

아래는 미해결 계약 충돌과 역사 문구를 구분한 목록이다. 인셉션에서는 판단이 필요한 항목만 결정하고, 이미 대체된 제안을 새 범위로 넣지 않는다.

| 후보 | 원천 간 차이 | 인셉션 취급 |
| --- | --- | --- |
| A1/A10 원안과 현행 단순화 | 패턴 §1.1은 quote·source_hash, 하류 cancelled를 말하지만 수집 에픽 Notes 2026-10-15·패턴 §6 항목 8·spine AD-24는 locator만 및 attempt/failed_stage/포인터 가드다. | 대체된 원안. 현재 요구는 spine으로 읽는다. |
| PDF·docx 범위 | 에픽 Description과 PRD FR-28은 PDF·docx를 포함하지만 에픽 Notes는 첫 실사용이 epic-drive일 수 있어 옮길지 열어 두었다. | 아직 제외된 것이 아니다. 옮기면 FR-28 충족 시점과 에픽 완료 조건을 함께 명시해야 한다. |
| max+1과 세대 삭제 | AD-24는 파일당 단조 증가 attempt를 max+1로 배정하면서 성공 시 옛 세대를 지운다. 실패 세대가 더 높은 번호인 상황에서 성공·정리로 어느 세대를 남기는지에 따라 최대 번호 보존이 중요하다. | 추정: 번호를 보존하지 않고 세대들을 지우는 경로가 있으면 재사용 가능성이 있다. 보존 세대·상한 저장·삭제 범위를 정해야 하며 실제 버그로 확정하지 않는다. |
| 조각 삭제 허용 문구 | Table Contract는 document_chunks를 세대 교체·가리기로만 지운다고 하지만 AD-24·에픽 S10은 실패 시도의 조각·FTS 청소도 요구한다. | 실패 세대 청소도 허용되는 규칙으로 구체화해야 향후 불변 trigger와 충돌하지 않는다. |
| 종료 시각의 변경 가능성 | Table Contract는 추출 세대의 ‘상태·failed_stage만 진행’이라 쓰지만 AD-24는 finished_at null을 닫아야 한다. | finished_at·error 및 단계 기록의 합법적 전이를 인셉션에서 열거할 필요가 있다. |
| home 개념명과 실제 칸 | spine AD-23·Table Contract는 files.home, Conventions 내보내기·초기 계획은 files.home_location_id다. | 개념명 차이로 볼 수 있으나(추정), port·스토리에서는 실제 칸과 구분해 쓴다. |
| 외부 로컬 원본 locator | AD-23은 절대 경로·URL을 저장하지 않는다고 하고, 초기 계획은 local locator를 루트 기준 상대 경로라고 설명한다. 동시에 루트 밖 사용자 원본을 external 위치로 보존해야 한다. | 외부 위치의 기준 루트·locator와 source_ref 표현이 문서에서 충분히 확정되지 않았다. FileStore 루트 검사와 사용자 원본 보존을 함께 만족할 표현을 정한다. |
| files.redact 예외와 즉시 삭제 | AD-11의 ‘유일한 예외 messages.redact’는 AD-23의 ‘두 번째 예외 files.redact’가 확장한다. 에픽 Done when의 내용 미잔존과 달리 실제 블롭은 삭제 일감으로 비동기 제거된다. | DB 가리기 완료·블롭 삭제 완료·경고 상태를 분리해 수용 조건을 정해야 한다. external 원본은 끝까지 삭제 대상이 아니다. |
| 오래된 미룸·초기 계획 | 초기 계획·미룸 원문에는 파일 가리기를 epic 2, index_config_id를 epic 4에서 추가한다고 남았다. 2026-10-16 Triage·수집 에픽 분할 결정은 자리는 0004 완료, 동작은 epic-attachments라고 정정했다. | 역사 상태. 스키마를 중복 구현하지 않는다. 0004의 실패 단계 선택 허용은 0005로 새 쓰기에 대해 강화됐다. |
| 스캔 정책의 역사 문구 | 수집 에픽 Notes는 새로 생기거나 커진 파일만 읽기로 했지만 2026-10-22 Carry·회고 C2는 버전 변경의 전체 다시 읽기를 필수로 넘겼다. | 최신 Carry 우선. I104의 ‘2.14가 자연스러운 자리’는 완료 증거가 아니다. |
| 파일 경로 색인 위치 | spine AD-15는 `files`의 경로 텍스트라고 적지만 AD-24·Table Contract는 `file_names`를 명시한다. | 실제 요구·스토리 기준은 file_names와 이름 FTS로 명시한다. |

## 4. 인셉션에서 정할 열린 질문

### 4.1 에픽 Notes에 이미 있는 질문·정책 결정

1. PDF·docx 추출기를 이 에픽에서 구현할지 epic-drive로 옮길지? 에픽 Notes의 표본은 이미지 11건·@파일 5건이며 PDF/document 0건이다. 이동은 아직 결정되지 않았다.
2. 기존 수집 세션의 첨부를 디스크에 남은 transcript에서 어떤 일감·버전·완료 표식으로 backfill할지? 기본 30일 뒤 사라질 수 있으므로 I104/C2 전체 다시 읽기와 함께 정한다. 다음 parser 버전 업 전 완료라는 기한도 티켓 description·verify에 넣는다.
3. `message_attachments`·`document_extractions` 등 0002 테이블의 변경 규칙을 DB trigger로 강제할지(I67, 초기 스키마 계획의 미룸)? 실패 세대 청소·파일 가리기 예외를 먼저 포함해야 한다.
4. Carry의 P19: cursor reset 없이 줄어든 transcript가 매 스캔 다시 큐에 들어가는 경우를 어떤 내역·재읽기 정책으로 끝낼지? 수집 연구 §4에서는 compact도 append라고 실측했지만, 회고가 이 에픽에서 정책을 정하도록 넘겼다. 근거: `_bmad-output/personal-brain/epic-capture/story-spool-plan.md` §Review Triage Log의 2026-10-19 low/reject.

Notes·Carry의 S9/S10/S12/S13, 마스킹 B, 영구/일시 오류 분류, file 대상 failures retry, C4 묶음, I75 표현 보강은 열린 선택지가 아니라 이미 지켜야 하는 인셉션 입력이다.

### 4.2 이번 원천 대조에서 새로 찾은 질문

1. **재읽기 완료와 보류 결과:** parser 버전 불일치뿐 아니라 동일 버전에서 늦게 온 Agent·Task 결과(C3)를 어떻게 전체 재읽기 대상으로 잡는가? 버전 기반 큐만으로 충분한지는 추정이며 정책 확인이 필요하다. 읽을 transcript가 이미 사라진 세션은 어떤 누락 상태로 표시할지 정한다.
2. **첨부 출처와 연결:** 별도 `attachment.file`을 어느 메시지·ordinal에 연결하며 `source_kind/source_ref/display_name`은 무엇을 보존할까? edited_text_file·compact_file_reference는 포함할까? 사용자 이미지와 도구 이미지 구분은 이미 경계가 있으나, 독립 항목의 연결·원본 바이트가 사라진 경우는 계약이 더 필요하다(수집 연구 §4, AD-23).
3. **한 번 채움과 복구:** `missing_at_ingest`·file_id null을 수집이 한 번 채운 뒤, 나중에 원본이 생기면 복구·재시도가 가능한가? file_id·상태 한 번 채움과 backfill 멱등성의 관계를 정한다.
4. **외부 원본의 정체:** 루트 밖 external 로컬 파일을 절대 경로 저장 금지 규칙과 양립하게 표현하는 locator·기준 루트는 무엇인가? 붙인 뒤 원본 내용이 바뀌면 transcript 내용과 디스크 바이트 중 어느 것을 첨부 원본으로 삼을지도 정한다. 이는 추정 가능한 구현 쟁점이며 원천의 확정 결정은 아니다.
5. **추출 세대 전이:** 삭제 뒤 attempt 상한 보존, 만료 세대의 마지막 단계 기록 위치, finished_at/error의 허용 변경, index_config_id 신규 세대 채움 규칙을 어떻게 고정할까? 0004는 index_config_id가 nullable인 자리를 제공했을 뿐이다.
6. **실패·용량:** too_large 상한·코드, 손상/암호화/미지원의 상태와 failure 코드 대응, 텍스트 없는 PDF의 상태, 문서 인코딩·빈 문서 처리를 정한다. 영구 오류 첫 실패 종료와 읽기 일시 오류 재시도라는 분류 원칙은 이미 결정됐다.
7. **로컬 FileStore 계약:** 내용 주소 locator의 확장자는 내용에서 어떻게 결정하며 동일 바이트에 다른 표시 이름을 붙여도 같은 위치를 유지할까? 루트 탈출·심볼릭 링크·임시 파일 잔존·쓰기와 고아 정리의 경합을 어떤 계약 사례로 검증할까? 이는 FileStore 루트·멱등성 요구를 구현 가능한 형태로 만드는 질문이다.
8. **파일 가리기 완료:** 포인터 비우기, 삭제 일감의 멱등성·부분 실패·doctor 표시, 같은 해시 재수집 방지, 가리기와 진행 중 추출·이름 재생성 경합을 어떻게 묶을까? 내용 단위라 같은 파일을 공유하는 다른 메시지도 영향을 받는다는 사실을 확인 게이트에 어떻게 보일까?
9. **검색 에픽과 연결:** 이 에픽에서 쓰는 문서·이름 FTS의 책임과 후속 검색의 읽기 계약을 어디서 나눌까? 포인터가 없는 failed/unsupported/too_large와 source_unreachable 파일도 검색 소비 측에서 표시 가능하도록 어떤 결과 정보를 넘길지 정한다.
10. **EXIF:** 신뢰하지 않는 입력의 크기·파싱 오류 처리와 시간대를 알았다는 근거(`captured_at_source`)의 허용 값을 정한다. 모르는 시간대를 기계 시간대로 채우는 결정은 원천에 없다.

## 5. 이 에픽 밖의 명시된 경계

| 경계 | 담당·제외 범위 | 출처 |
| --- | --- | --- |
| 선행 기반·스키마 | epic-capture가 parser·수집 경로, 큐/drain, Core 마스킹, 확인 게이트와 0004(2.6), 0005(추출 실패 단계 trigger)를 마련한다. 여기서는 그 위의 동작과 Carry를 구현한다. | 에픽 §Notes Waits on·2026-10-19; 수집 에픽 Notes |
| 문서 검색·읽기 표면 | 검색, `files show`, `files url`은 epic-recall-and-mirror. FileStore의 위치→URL port 자체와 저장/색인 준비는 이 에픽 범위다. | 에픽 §Outcome·Boundaries; spine AD-23 |
| Drive | Drive FileStore·연동·기존 Drive 문서 색인·연동 해제·기기 이전은 epic-drive/후속 조각. 검증 전 마지막 사본 삭제 금지라는 공통 계약은 유지한다. PDF/docx 이동 여부만 인셉션 질문으로 남았다. | 에픽 §Boundaries·Notes; PRD FR-27 Out of Scope; spine AD-23 |
| 내보내기·복구·운영 | 실제 export/import, 파일 본체 포함 범위와 복구 절차는 epic-operations. 문서 세대·조각을 포함해야 하는 데이터 계약은 이 에픽이 보존한다. 오래된 WAL 읽기로 남는 바이트 정리도 epic-operations Carry다. | 에픽 §Boundaries; spine AD-24·Conventions 내보내기; 미룸 §Triage 2026-10-22 |
| 복제 | Postgres 스키마 추격·복제 가리기 구현은 epic-replicas(epic 7). 과거 미룸에 적힌 Postgres 0004~0007 차이를 이 에픽 구현 범위에 넣지 않는다. | 미룸 §Triage 2026-10-16·2026-10-22; spine AD-11 |
| 첨부가 아닌 입력 | 도구 결과의 이미지·스크린샷, 일반 도구 출력은 첨부 보관 대상이 아니다. Harness 원본 transcript 영구 보관도 제외다. backfill은 현재 남은 transcript를 다시 읽는 것이며 별도 보관을 뜻하지 않는다. | 에픽 §Boundaries; PRD FR-1·26 Out of Scope; 수집 연구 §4 |
| 지원하지 않는 추출 | OCR/스캔 PDF, HWP, Google Docs 원문, 좌표→장소명 변환 제외. time/sheet locator 예약은 해당 추출기를 추가하는 근거가 아니다. | PRD FR-28 Out of Scope; 패턴 §2 조건부; spine AD-24 |
| 사용자 원본·바이트 | external 파일은 이동·삭제하지 않는다. 알려진 비밀의 출력 패턴 가리기는 텍스트에 적용되며 원본 파일 바이트를 변조하지 않는다. 파일 저장본을 지우는 별도 경로는 files.redact다. | PRD FR-27; spine AD-23 |
| 다른 수집 후속 작업 | 워커 세션 표시 결정 등 epic-log-and-context Carry, 서브에이전트 보고 보관 재도입은 범위 밖이다. 회고 C3는 도구 호출 메모 복구에 관한 항목이며 보고 본문 저장 요구가 아니다. | 수집 에픽 Notes 2026-10-21·2026-10-22; 회고 C3; 미룸 §Triage 2026-10-22 |

