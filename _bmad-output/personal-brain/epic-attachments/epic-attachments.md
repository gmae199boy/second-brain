---
type: epic
title: "첨부 원본과 문서 추출"
parent: personal-brain
covers: [CAP-14, CAP-2]
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
- 고아 블롭 정리 일감.
- 문서 텍스트 추출 일감: 형식은 내용으로 판정, `attempt`·`failed_stage`·포인터 가드, `chunk_locator` Core 코덱과 `page` 사본, 추출 텍스트는 원문 저장·출력에서 가림(마스킹 B, 2026-10-19), 조각·FTS 배치 쓰기, `extractor_version`.
- 형식별 추출기(txt·md·PDF·docx, 이미지 EXIF와 촬영 일시 세 칸), `files reindex`.
- `files redact` 연쇄(확인 게이트)와 `messages redact`의 `ATTACHMENT_NOT_REDACTED`.

원천: spine AD-23·24, `inputs/weknora-patterns.md` §1.1 A1·A10.

## Outcome

대화에 붙인 파일이 원본째 남고, 그 내용이 검색할 수 있는 조각이 된다(검색은 epic-recall-and-mirror).

## Requirements

인셉션 때 채운다. spec의 CAP-14(첨부·추출 부분)와 CAP-2(파일 가리기), PRD FR-26~28, spine AD-23·24가 원천이다.

## Done when

1. 첨부가 있는 세션에서 원본이 저장소에 한 번만 남고 메시지에서 위치를 받을 수 있으며, 텍스트 문서는 추출 세대가 생기고 추출 실패는 표시된다. 가린 첨부의 내용은 조각·검색 어디에도 남지 않는다.
2. 문서 조각마다 `chunk_locator`가 있고(텍스트 문서는 글자 범위, PDF는 쪽) `page`가 그 사본과 같으며, 추출 실패는 `failed_stage`로 어디서 실패했는지 보인다. 같은 파일을 다시 추출해도 `attempt`가 하나씩 오르고 옛 시도가 포인터를 덮지 않는다.
3. FileStore는 `brain` 소유이면서 루트 안인 위치에만 쓰고 지우며, 사용자의 기존 파일은 옮기거나 지우지 않는다.
4. 루트 안에 있으나 위치 행이 없고 유예가 지난 블롭은 drain이 지우고, doctor가 그 건수와 바이트를 보인다.

## Boundaries

AD-7·9·11·21·23·24, Table Contract(files, file_locations, message_attachments, document_extractions, document_chunks, file_names, file_metadata). 스키마 0004는 epic-capture(2.6)가 만든다(2026-10-16 번호 변경). 문서 검색·`files show`·`files url`은 epic-recall-and-mirror, Drive 저장소는 epic-drive, 내보내기는 epic-operations. 경고 코드 `ATTACHMENT_NOT_REDACTED`를 맡는다. 도구 결과 안의 이미지(스크린샷)는 도구 출력이라 첨부가 아니다.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-14, CAP-2
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-23, AD-24
- prd — _bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md, FR-26, FR-27, FR-28
- inputs — _bmad-output/personal-brain/inputs/weknora-patterns.md, §1.1 (A1, A10)
- research — _bmad-output/personal-brain/epic-capture/epic-capture-research.md, §4
- split from — _bmad-output/personal-brain/epic-capture/epic-capture.md, Notes (2026-10-15)

## Notes

- Decision(2026-10-15, epic-capture 인셉션): epic-capture에서 나눴다. 순서는 epic-capture 바로 뒤. 인셉션은 차례가 올 때 한다(사용자).
- Waits on epic-capture because: 0004 스키마(2.6), parser와 수집 경로, 일감 대기열과 drain, Core 마스킹 함수, 확인 게이트.
- Open question: 한 달 실측에서 사용자가 붙인 것은 붙여 넣은 이미지 11건과 @파일 5건뿐이고 PDF·문서 블록은 0건이었다(`../epic-capture/epic-capture-research.md` §4). PDF·docx 추출기의 첫 실사용은 epic-drive(기존 Drive 문서 색인)일 수 있다. 추출기를 이 에픽에 둘지 epic-drive로 옮길지 인셉션에서 정한다.
- Open question: epic-capture만으로 수집된 세션의 첨부는 수집 때 채워지지 않았다. 이 에픽이 디스크에 남은 transcript(기본 30일)를 다시 읽어 `message_attachments`를 채우는 방법을 인셉션에서 정한다.
- Open question: `message_attachments`·`document_extractions` 등 0002 테이블의 변경 거부 trigger를 둘지 정한다(`../deferred-work.md` story-untitled-12-plan 항목).
- Note(2026-10-16, `../change-users-and-review-gaps/`, 인셉션 입력, 원문은 `../inputs/external-review-2026-10-16.md`):
  - S9: 청구가 만료된 추출 일감의 열린 세대(`finished_at` null)는 다음 청구가 `failed`로 닫고 새 `attempt`를 만든다(spine AD-24).
  - S10: 실패한 세대의 조각·FTS는 그 실패를 기록하는 쓰기(또는 정리 일감)가 지운다.
  - S13: `files.redact` 연쇄에 `file_names`·이름 FTS·`file_metadata` 삭제를 넣고, 재생성은 가린 파일을 건너뛴다(spine AD-23).
  - S12: pdf가 아니면 `page`는 null이다. Store 비교는 null까지 같아야 하고, TS에서 undefined와 null을 구분한다.
- Note(2026-10-16, 인셉션 입력): 추출 오류에 분류 코드를 붙인다. 지원하지 않는 형식·손상·암호화 파일은 영구 오류(첫 실패에서 기록하고 닫음), 원본에 잠시 접근하지 못한 것은 일시 오류다(spine AD-21 재시도 분류).
- Note(2026-10-16): 추출 실패의 다시 하기는 `failures retry`에 대상 종류 `file`을 더해서 한다(2.12가 명령을 만든다, spine AD-5).
- Note(2026-10-19, `../change-masking-b-and-review-fixes/`, 인셉션 입력): 마스킹 B. 추출한 문서 텍스트는 원문으로 저장하고 나갈 때 가린다(spine AD-23). `failed`가 되는 추출 세대는 `failed_stage`가 있어야 하고 0005(epic-capture 18)의 trigger가 강제한다.
- Carry(2026-10-22, epic 2 회고, 인셉션 입력):
  - **parser 버전이 올라도 이미 닫힌 세션은 다시 읽지 않는다**(회고 C2, `deferred-work.md` I104). 스캔은 크기만 비교하고(`packages/core/src/capture/scan.ts:41-49`), 버전이 다를 때의 전체 다시 읽기(`packages/core/src/sessions/ingest.ts:283-288`)는 수집이 불릴 때만 돈다. 첨부 backfill도 이미 수집한 세션을 다시 읽어야 하므로 같은 경로로 푼다. **다음 parser 버전 업 전에** 있어야 한다 — 없으면 새 parser가 살리는 메시지·도구 메모와 결과가 늦게 온 `Agent`·`Task` 메모(C3)가 transcript 보관 기간(30일) 뒤 영영 빠진다.
  - hook의 정상 수집이 그 세션의 이전 `session_ingest` 실패를 해소하지 않는다(회고 C4, `packages/core/src/brain.ts:285` vs `:246-251`). 위 작업과 같은 스토리에서 고친다.
  - Core `Redaction`에 파일 대상 표현(`fileId`)이 없다(I75, `packages/core/src/domain/redaction.ts`). 파일 가리기 전에 필요하다.
  - 줄어든 transcript가 스캔마다 다시 큐에 들어갈 수 있다(P19, `../epic-capture/story-spool-plan.md:208`). 다시 읽기 정책과 함께 정한다.
