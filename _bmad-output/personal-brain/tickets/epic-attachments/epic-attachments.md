---
type: epic
title: "첨부 원본과 문서 추출"
parent: personal-brain
covers: [CAP-14, CAP-2, CAP-1]
after: ["epic-capture"]
assignee: ""
risk: medium
---

# 첨부 원본과 문서 추출

## Description

대화에 붙인 파일을 원본째 보관해 메시지와 잇고, 문서 텍스트를 세대가 있는 파생물로 추출해 조각으로 만든다. 2026-10-15 epic-capture 인셉션에서 나눈 에픽이다(`../epic-capture/epic-capture.md` Notes).

범위:
- `FileStore` port와 계약 테스트(`brain` 소유이면서 루트 안인 위치만 쓰고 지움), 로컬 구현(내용 주소 locator, 임시 파일 → rename, 0700/0600).
- parser의 첨부 자리·출처(붙여 넣은 이미지, @파일 `attachment` 항목)와 수집의 첨부 저장·메시지 연결(같은 내용은 한 번, 사용자 원본은 `external` 위치). epic-capture만으로 수집된 세션의 첨부 채우기(디스크에 남은 transcript 다시 읽기). `file_names` 채우기.
- Brain 위치 블롭 하나의 삭제 일감(고아 자동 정리는 V1 뒤, 2026-10-26).
- 문서 텍스트 추출 일감: 형식은 내용으로 판정, `attempt`·`failed_stage`·포인터 가드, `chunk_locator` Core 코덱과 `page` 사본, 추출 텍스트는 원문 저장·출력에서 가림(마스킹 B, 2026-10-19), 조각·FTS 배치 쓰기, `extractor_version`.
- 형식별 추출기 txt·md와 다시 추출 경로(`failures retry`, 추출기 버전 상승). PDF·docx는 epic-drive(E8-5), EXIF·촬영 일시는 epic-recall-and-mirror(1, 옛 10.9)(2026-10-26).
- `files redact` 연쇄(확인 게이트)와 `messages redact`의 `ATTACHMENT_NOT_REDACTED`.

원천: spine AD-23·24, `inputs/weknora-patterns.md` §1.1 A1·A10.

## Outcome

대화에 붙인 파일이 원본째 남고, 그 내용이 검색할 수 있는 조각이 된다(검색은 epic-drive의 E8-6, 2026-10-26).

## Requirements

- E10-1 (CAP-14): `FileStore` port와 계약 테스트, 로컬 구현 — `put`·`get`·`exists`·`url`·`delete`, 내용 주소 locator(`sha256:` + 소문자 hex), 임시 파일 → rename, 루트 0700·파일 0600, `brain` 소유이면서 설정 루트 안인 위치만 쓰고 지움, 사용자 원본은 `external` 위치로 남기고 옮기거나 지우지 않음. (FR-27, NFR-6, AD-7·23)
- E10-2 (CAP-14): 첨부 수집 — parser가 붙여 넣은 이미지와 @파일 `attachment` 줄의 자리·출처를 내고, 수집이 원본을 저장하고 메시지와 잇는다(같은 내용은 한 번, `missing_at_ingest`, `file_names`의 `attachment_name`·`location_path`). DB에 못 쓴 첨부 연결 메타데이터는 spool로 남기고 바이트는 spool에 넣지 않는다. 도구 결과 안의 이미지는 첨부가 아니다. (FR-27, NFR-1, AD-9·23; epic-capture-research §4)
- E10-3 (CAP-14, CAP-1): 닫힌 세션 다시 읽기와 첨부 채우기 — 스캔이 크기만이 아니라 저장된 `parser_version`도 비교해 크기가 같은 닫힌 세션도 다시 읽고, hook의 정상 수집이 그 세션의 이전 `session_ingest` 실패를 해소하며, 줄어든 transcript가 스캔마다 다시 들어가지 않고, 이 에픽 전에 수집된 세션 가운데 transcript가 디스크에 남은 것의 첨부가 채워진다. (FR-5·6; 회고 C2·C3·C4, deferred-work I104·P19)
- E10-4 (CAP-14): 추출 세대와 조각 — `chunk_locator` Core 코덱(정규형 JSON, 텍스트는 코드 포인트 범위)과 `page` 사본(pdf가 아니면 null, null까지 비교), `attempt`는 Store 삽입 트랜잭션의 `max+1`, 파일당 열린 세대 하나, 더 큰 `attempt`의 성공만 포인터를 바꿈, 실패 세대의 조각·FTS 정리(S10), 청구가 만료된 열린 세대 닫기(S9), `failed`에는 `failed_stage`, 2초 안의 조각·FTS 배치 쓰기, 내용으로 형식 판정, `extractor_version`, 영구·일시 오류 분류, `failures retry`의 대상 종류 `file`. 추출 텍스트는 원문으로 저장한다(마스킹 B). (FR-28, NFR-2·3·4·5, AD-7·21·24)
- E10-5 (CAP-14): 형식별 추출 — txt·md 본문 조각과 다시 추출 경로(`failures retry`가 파일 추출 실패를 새 시도로 넣고, 추출기 버전이 오르면 drain이 다시 넣는다). 이미지 EXIF와 촬영 일시 세 칸은 epic 4로 옮겼고(E4-1, 옛 10.9), 별도 `files reindex` 명령은 만들지 않는다(2026-10-26). PDF·docx 추출기는 epic-drive(2026-10-22). (FR-28, AD-24)
- E10-6 (CAP-14): 블롭 삭제 일감 — Brain 위치의 블롭 하나를 멱등으로 지우는 일감(파일 가리기와 epic 8의 Drive 이전이 쓴다). 고아 블롭 자동 순회(유예 24시간)와 doctor 건수·바이트 점검은 V1 뒤(2026-10-26). (NFR-2, AD-21·23)
- E10-7 (CAP-2): 파일 가리기 — Core `Redaction`의 `fileId`와 범위 null, `files redact`(확인 게이트)가 한 트랜잭션에서 `redacted_at`, 추출 세대·조각·FTS, `file_names`·이름 FTS·`file_metadata`, `redactions`를 지우거나 쓰고 Brain 위치의 블롭 삭제 일감을 넣으며, 다시 추출·이름·메타데이터 생성은 가린 파일을 건너뛴다. `messages redact`는 가리지 않은 첨부가 있으면 `ATTACHMENT_NOT_REDACTED`를 낸다. (FR-26, NFR-1, AD-11·23; S13, deferred-work I75)
- E10-8 (CAP-14 스키마): 마이그레이션 0008 — `message_attachments`·`document_extractions`·`document_chunks`의 변경 규칙 trigger(자리·출처 불변, `file_id`·`status`는 한 번 채움, 추출 세대의 허용 전이, 실패 세대 조각 정리와 가리기의 삭제 허용). Postgres는 epic 7. (NFR-1, Table Contract; deferred-work I67)

## Done when

1. 첨부가 있는 세션에서 원본이 저장소에 한 번만 남고 메시지에서 위치를 받을 수 있으며, 텍스트 문서는 추출 세대가 생기고 추출 실패는 표시된다. 가린 첨부의 내용은 조각·검색 어디에도 남지 않는다.
2. 문서 조각마다 `chunk_locator`가 있고(텍스트 문서는 글자 범위) pdf가 아닌 조각의 `page`는 null이며, 추출 실패는 `failed_stage`로 어디서 실패했는지 보인다. 같은 파일을 다시 추출해도 `attempt`가 하나씩 오르고 옛 시도가 포인터를 덮지 않는다.
3. FileStore는 `brain` 소유이면서 루트 안인 위치에만 쓰고 지우며, 사용자의 기존 파일은 옮기거나 지우지 않는다.
4. Brain 위치의 블롭 삭제 일감은 두 번 돌려도 같고, `external` 위치와 루트 밖 파일은 지우지 않는다(2026-10-26. 고아 자동 정리는 V1 뒤).
5. parser 버전이 오르면 크기가 같은 닫힌 세션도 drain이 다시 읽고, 이 에픽 전에 수집된 세션 가운데 transcript가 디스크에 남은 것의 첨부(이 기계에서 붙여 넣은 이미지와 @파일)가 채워진다(2026-10-22).

## Boundaries

AD-7·9·11·21·23·24, Table Contract(files, file_locations, message_attachments, document_extractions, document_chunks, file_names, file_metadata). 스키마 0004는 epic-capture(2.6)가 만든다(2026-10-16 번호 변경). 문서 검색·`files show`·`files url`과 문서 본문 출력의 가림은 epic-drive(E8-6, 2026-10-26), Drive 저장소는 epic-drive, 내보내기는 epic-operations. 경고 코드 `ATTACHMENT_NOT_REDACTED`를 맡는다. 도구 결과 안의 이미지(스크린샷)는 도구 출력이라 첨부가 아니다. PDF·docx 추출기는 epic-drive가 맡는다(2026-10-22). 추출한 문서 텍스트를 내보내는 출력 경로(검색 발췌 등)와 그 출력 가리기는 epic-recall-and-mirror다. 이 에픽은 원문 저장까지 한다(2026-10-22).

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-14, CAP-2
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-23, AD-24
- prd — _bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md, FR-26, FR-27, FR-28
- inputs — _bmad-output/personal-brain/inputs/weknora-patterns.md, §1.1 (A1, A10)
- research — _bmad-output/personal-brain/tickets/epic-capture/epic-capture-research.md, §4
- research — _bmad-output/personal-brain/tickets/epic-attachments/epic-attachments-research-sources.md (원천 조사, 2026-10-22)
- research — _bmad-output/personal-brain/tickets/epic-attachments/epic-attachments-research-code.md (현행 코드 조사, 2026-10-22)
- retrospective — _bmad-output/personal-brain/tickets/epic-capture/epic-capture-retrospective.md, Findings 2·3 (C2·C3·C4)
- split from — _bmad-output/personal-brain/tickets/epic-capture/epic-capture.md, Notes (2026-10-15)

## Notes

- Decision(2026-10-15, epic-capture 인셉션): epic-capture에서 나눴다. 순서는 epic-capture 바로 뒤. 인셉션은 차례가 올 때 한다(사용자).
- Waits on epic-capture because: 0004 스키마(2.6), parser와 수집 경로, 일감 대기열과 drain, Core 마스킹 함수, 확인 게이트.
- Open question: 한 달 실측에서 사용자가 붙인 것은 붙여 넣은 이미지 11건과 @파일 5건뿐이고 PDF·문서 블록은 0건이었다(`../epic-capture/epic-capture-research.md` §4). PDF·docx 추출기의 첫 실사용은 epic-drive(기존 Drive 문서 색인)일 수 있다. 추출기를 이 에픽에 둘지 epic-drive로 옮길지 인셉션에서 정한다. → 2026-10-22 Decision: epic-drive로 옮김.
- Open question: epic-capture만으로 수집된 세션의 첨부는 수집 때 채워지지 않았다. 이 에픽이 디스크에 남은 transcript(기본 30일)를 다시 읽어 `message_attachments`를 채우는 방법을 인셉션에서 정한다. → 2026-10-22 Decision: 닫힌 세션 다시 읽기 경로(E10-3)로 채운다.
- Open question: `message_attachments`·`document_extractions` 등 0002 테이블의 변경 거부 trigger를 둘지 정한다(`../../deferred-work.md` story-untitled-12-plan 항목). → 2026-10-22 Decision: 둔다(마이그레이션 0008, E10-8).
- Note(2026-10-16, `../../change-users-and-review-gaps/`, 인셉션 입력, 원문은 `../../inputs/external-review-2026-10-16.md`):
  - S9: 청구가 만료된 추출 일감의 열린 세대(`finished_at` null)는 다음 청구가 `failed`로 닫고 새 `attempt`를 만든다(spine AD-24).
  - S10: 실패한 세대의 조각·FTS는 그 실패를 기록하는 쓰기(또는 정리 일감)가 지운다.
  - S13: `files.redact` 연쇄에 `file_names`·이름 FTS·`file_metadata` 삭제를 넣고, 재생성은 가린 파일을 건너뛴다(spine AD-23).
  - S12: pdf가 아니면 `page`는 null이다. Store 비교는 null까지 같아야 하고, TS에서 undefined와 null을 구분한다.
- Note(2026-10-16, 인셉션 입력): 추출 오류에 분류 코드를 붙인다. 지원하지 않는 형식·손상·암호화 파일은 영구 오류(첫 실패에서 기록하고 닫음), 원본에 잠시 접근하지 못한 것은 일시 오류다(spine AD-21 재시도 분류).
- Note(2026-10-16): 추출 실패의 다시 하기는 `failures retry`에 대상 종류 `file`을 더해서 한다(2.12가 명령을 만든다, spine AD-5).
- Note(2026-10-19, `../../change-masking-b-and-review-fixes/`, 인셉션 입력): 마스킹 B. 추출한 문서 텍스트는 원문으로 저장하고 나갈 때 가린다(spine AD-23). `failed`가 되는 추출 세대는 `failed_stage`가 있어야 하고 0005(epic-capture 18)의 trigger가 강제한다.
- Carry(2026-10-22, epic 2 회고, 인셉션 입력):
  - **parser 버전이 올라도 이미 닫힌 세션은 다시 읽지 않는다**(회고 C2, `deferred-work.md` I104). 스캔은 크기만 비교하고(`packages/core/src/capture/scan.ts:41-49`), 버전이 다를 때의 전체 다시 읽기(`packages/core/src/sessions/ingest.ts:283-288`)는 수집이 불릴 때만 돈다. 첨부 backfill도 이미 수집한 세션을 다시 읽어야 하므로 같은 경로로 푼다. **다음 parser 버전 업 전에** 있어야 한다 — 없으면 새 parser가 살리는 메시지·도구 메모와 결과가 늦게 온 `Agent`·`Task` 메모(C3)가 transcript 보관 기간(30일) 뒤 영영 빠진다.
  - hook의 정상 수집이 그 세션의 이전 `session_ingest` 실패를 해소하지 않는다(회고 C4, `packages/core/src/brain.ts:285` vs `:246-251`). 위 작업과 같은 스토리에서 고친다.
  - Core `Redaction`에 파일 대상 표현(`fileId`)이 없다(I75, `packages/core/src/domain/redaction.ts`). 파일 가리기 전에 필요하다.
  - 줄어든 transcript가 스캔마다 다시 큐에 들어갈 수 있다(P19, `../epic-capture/tickets/story-spool-plan.md:208`). 다시 읽기 정책과 함께 정한다.
- Decision(2026-10-22, 인셉션, 사용자): PDF·docx 추출기는 epic-drive로 옮긴다. 한 달 실측에서 사용자가 붙인 PDF·문서는 0건이고 첫 실사용은 기존 Drive 문서 색인이다. 이 에픽은 추출 틀, txt·md, 이미지 EXIF를 맡는다. FR-28의 PDF·docx 부분은 epic-drive E8-5로 간다.
- Decision(2026-10-22, 인셉션, 사용자): 첫 스토리는 tracer가 아니라 닫힌 세션 다시 읽기(E10-3, 회고 C2·C4, P19)다. 첨부 parser가 parser 버전을 올리므로, 그보다 먼저 크기가 같은 닫힌 세션도 다시 읽혀야 새 parser가 살리는 메시지·도구 메모·첨부가 transcript 보관 기간(30일) 뒤 빠지지 않는다. tracer는 둘째다.
- Decision(2026-10-22, 인셉션, 사용자): I67 변경 규칙 trigger를 이번에 넣는다(마이그레이션 0008, E10-8). 실패 세대의 조각 정리와 파일 가리기의 삭제를 허용하는 규칙으로 쓴다.
- Decision(2026-10-22, 인셉션, 사용자): 문서 텍스트 출력과 그 출력 가리기는 epic-recall-and-mirror로 넘긴다. 이 에픽에는 문서 본문을 내보내는 출력 경로가 없다.
- Decision(2026-10-22, 인셉션, 사용자): `message_attachments.status`의 `missing_at_ingest`는 수집 시점의 확정 기록이고, 나중에 원본이 다시 생겨도 `stored`로 바꾸지 않는다. 0008(6)의 trigger가 이 규칙을 강제하고 4·5가 따른다. 붙여 넣은 이미지는 바이트가 transcript 안에 있어 해당하지 않는다.
- Decision(2026-10-22, 인셉션 집합 점검, 사용자): 추출 세대 Store를 둘로 나눈다 — 7(`chunk_locator` 코덱과 문서 조각 자료형)과 14(추출 세대 Store). 한 세션에 코덱·Store 세 곳·동시성·만료 회수가 모두 들기에는 컸다.
- Decision(2026-10-22, 인셉션 집합 점검, 사용자): 파일 가리기(12)는 나누지 않는다. 빌드 계획에서 범위가 커지면 그때 "가리기 트랜잭션·생성 막기"와 "확인·CLI·`messages redact` 경고"로 나눈다.
- Source conflict: Table Contract `document_chunks` — 세대 교체·가리기로만 지운다 vs AD-24·S10 — 실패한 세대의 조각·FTS도 지운다. 0008(E10-8)이 실패 세대 정리를 허용하는 규칙으로 맞추고 Table Contract를 고친다.
- Source conflict: Table Contract `document_extractions` — 상태와 `failed_stage`만 진행한다 vs AD-24 — 열린 세대의 `finished_at`(과 `error`)을 닫는다. 0008(E10-8)이 허용 전이를 열거하고 Table Contract를 고친다.
- Source conflict: spine AD-15 — 파일 경로 텍스트를 `files`에서 찾는다 vs AD-24·Table Contract — `file_names`와 이름 FTS. `file_names`를 따르고 AD-15를 고친다.
- Source conflict: `packages/core/src/codes.ts`의 `ATTACHMENT_NOT_REDACTED` 설명 — "첨부가 받아야 할 마스킹 없이 저장"(마스킹 B 이전) vs AD-23 — `messages redact`가 가리지 않은 첨부를 알리는 경고. E10-7이 설명을 맞춘다.
- Note(2026-10-22, 인셉션): 빌드 계획에서 정할 것(원천 조사 §4.2) — @파일 첨부의 `source_kind`·`source_ref`와 `external` 위치의 locator 표현(절대 경로를 저장하지 않는 규칙과 함께), 붙인 뒤 원본이 바뀐 경우 transcript 내용과 디스크 바이트 중 무엇을 원본으로 삼을지, `too_large` 상한, 손상·암호화·지원하지 않는 형식의 상태와 오류 코드, 삭제 뒤 `attempt` 최댓값 보존, EXIF 입력의 크기·파싱 오류 처리. 각 스토리가 자기 계획에서 정하고 사용자에게 묻는다.
- Decision(2026-10-26, `../../change-v1-capture-and-drive/`, 사용자): V1에서 이 에픽은 데몬(epic 9) 다음, 로컬 백업(epic 5)·Drive(epic 8) 앞이다. 남은 11개 가운데 10.4·10.14·10.8·10.12는 그대로, 10.3·10.5·10.7·10.10·10.11은 가볍게(티켓 description), 10.9 EXIF는 epic 4로 옮김(4.1), 10.13 Refactor sweep은 drop.
- Dropped(2026-10-26, `../../change-v1-capture-and-drive/`, 사용자): 13 Refactor sweep. 확인된 결함은 해당 스토리에 흡수하고, 마지막 통합 확인은 epic 8의 실계정 확인이 맡는다.
- Moved(2026-10-26, `../../change-v1-capture-and-drive/`, 사용자): 9 EXIF·촬영 일시는 V1 뒤라 epic 4(epic-recall-and-mirror)의 1로 옮겼다(그 에픽의 촬영 일시 필터와 함께 만든다). id 9는 다시 쓰지 않는다(`next_id = 15`).
- Note(2026-10-26, 세트 검증 제안, 빌드 입력): 10.10 verify에 원본 접근 불가 파일(`source_unreachable_at`)에 retry·버전 상승 drain을 돌려도 새 attempt가 생기지 않고 기존 조각·포인터가 남으며 `FILE_SOURCE_UNREACHABLE`과 건수가 보이는 사례, 정상 파일의 두 번째 drain에 추가 attempt가 없는 사례를 더한다(AD-24). 10.12 verify에서는 가린 뒤 4의 이름 채우기와 8의 대기 추출을 다시 돌려 이름·FTS·조각이 되살아나지 않는지 본다. 10.11은 4·14·8·10과 경로가 없으므로, 계획에서 handler·Store 능력 파일과 공통 등록부(`packages/core/src/brain.ts`의 handler 등록, `packages/core/src/ports/store.ts`의 Store 합성) 편집 소유자를 정한다.
