---
type: epic
title: "Google Drive 연동"
parent: personal-brain
covers: [CAP-14, CAP-6, CAP-7, CAP-12]
after: ["epic-attachments", "epic-daemon", "epic-operations"]
assignee: ""
risk: high
---

# Google Drive 연동

## Description

Drive API로 Drive를 직접 다룬다. Drive는 5TB이고 Mac은 512GB라서 Mac에 동기화하지 않는다.
- 연동하면 Brain이 맡은 첨부 원본이 Drive로 옮겨 간다. 순서는 업로드 → 해시 검증 → `home` 전환 → 로컬 삭제 일감이다.
- 사용자가 고른 기존 Drive 폴더의 문서는 목록 → export 또는 임시 다운로드 → 추출 → 삭제 순서로 텍스트만 색인한다. 바뀐 것은 changes API로 반영한다. 동기화는 drain의 일감 종류(`source_sync`)이고 데몬이 주기적으로 넣고 돈다(AD-27, 2026-10-26). `brain sources sync`는 그 일감을 지금 만들어 돌리는 명령이다. 사진·큰 파일은 내려받지 않고 메타데이터와 폴더·파일 이름만 남긴다.
- 연동 해제는 Drive에 둔 채 연결만 끊는다.
- DB 스냅샷을 Drive에 보관해 새 기계에서 복구한다. 나중에 `/brain:db-migration` 스킬이 이것을 감싼다. (V1 뒤, 2026-10-26)
- 문서 찾기: 대화 첨부와 Drive 문서·사진을 본문 단어와 폴더·파일 이름으로 찾고 원본 링크를 붙인다(epic 4에서 옮겨 옴, 2026-10-26).

## Outcome

로컬 용량과 상관없이 첨부와 Drive 문서·사진이 본문과 이름으로 찾아지고 원본이 열린다. 기계를 바꿔도 되살리는 것(스냅샷)은 V1 뒤다(2026-10-26).

## Requirements

- E8-1 (CAP-14, 원본 이전 부분): OAuth(데스크톱 앱), Drive `FileStore` 구현(epic-attachments의 계약 테스트 통과), 첨부 원본 이전. 로컬 캐시 상한은 V1 뒤(2026-10-26). (AD-18·23)
- E8-2 (CAP-14, 외부 문서 색인 부분): 감시 폴더 목록, 외부 소스 테이블(새 마이그레이션: source, remote file id, 이름, 부모 경로, 원격 버전, 연결된 content id(내려받기 전 null), changes 토큰), 문서만 추출, 사진·큰 파일은 메타데이터와 이름만, 원본 삭제 시 `source_unreachable`. 기존 `files`(내용 해시 식별)에 내려받지 않은 파일을 넣지 않는다(2026-10-26). (AD-23·24·27)
- E8-3 (CAP-14): 연동 해제. 검색은 계속되고 원본은 접근 불가로 표시하며, Drive 사본은 지우지 않는다.
- E8-4 (CAP-12, Drive 스냅샷 부분): DB 스냅샷의 Drive 업로드와 새 기계 복구. **V1 뒤(2026-10-26).**
- E8-5 (CAP-14, 형식별 추출 부분): PDF(텍스트 PDF, 조각 locator의 쪽과 `page` 사본)·docx(블록) 추출기. epic-attachments의 추출 일감·형식 판정·`extractor_version` 위에 얹는다(2026-10-22, epic-attachments 인셉션에서 옮겨 옴). (FR-28, AD-24)
- E8-6 (CAP-14·6·7, 문서 찾기 부분, epic-recall-and-mirror에서 옮겨 옴, 2026-10-26): 대화 첨부와 Drive 문서·사진을 문서 본문 단어·폴더 이름·파일 이름으로 찾고, 결과에 원본 링크(로컬 경로 또는 Drive 링크)와 위치(쪽·글자 범위)가 붙으며, 미색인 파일은 표시된다. 공백 든 질의와 `a-b`·`AND`·`"` 같은 질의가 오류나 조용한 0건 없이 처리된다. 출력은 Core 출력 코덱(마스킹)을 거친다. (FR-28, AD-11·15)

## Done when

1. 연동하면 첨부 원본이 Drive로 옮겨지고, 로컬 사본은 검증 뒤에만 지워진다.
2. 고른 Drive 폴더의 문서(txt·md·텍스트 PDF·docx)가 Mac에 남지 않은 채 본문으로 검색되고, 결과에 Drive 링크가 붙으며, PDF 조각은 쪽을 가진다. 사진은 폴더 이름과 파일 이름으로 찾힌다.
3. Drive에서 바뀐 문서가 데몬의 다음 동기화 주기에서 반영된다.
4. 연동 해제 뒤에도 검색되고, 원본은 접근 불가로 표시된다.
5. 대화에 붙인 파일도 본문·이름으로 찾아지고 원본이 열린다(E8-6).
6. 첨부 원본을 Drive로 옮기기 전에 epic 5의 로컬 백업이 있다.

(2026-10-26: 이전 Done when 5 "새 Mac에서 Drive 스냅샷으로 복구하면 건수가 같다"는 V1 뒤, 6 "데몬 켜짐·꺼짐 둘 다에서 통과"는 삭제했다.)

## Boundaries

AD-11·15·23·24·27. 사용자의 외부 파일은 옮기거나 지우지 않는다. 기록의 원본(SQLite)은 Drive로 옮기지 않는다. 임베딩은 쓰지 않는다. OCR, HWP, 좌표의 장소 이름 변환은 범위 밖이다.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-12, CAP-14
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-23, AD-24, AD-25, Deferred
- change — _bmad-output/personal-brain/change-local-sqlite-primary/change-local-sqlite-primary.md, §7
- inputs — _bmad-output/personal-brain/inputs/weknora-patterns.md, §2 (조건부: lease 먼저 적기, 저장 보상과 삭제 순서, 참조 수 삭제, 배치 엔벨로프)

## Notes

- Decision(2026-10-14): Drive 데스크톱 동기화가 아니라 API를 쓴다(5TB vs 512GB). 연동 해제는 Drive에 둔 채 끊는다(b). 연동하면 첨부의 원본(SoT)이 Drive로 옮겨 간다(사용자).
- Waits on epic-attachments because: `FileStore` port와 로컬 구현, 첨부 저장, 추출 일감(2026-10-15 epic-capture에서 나뉨).
- Waits on epic-operations because: 첨부 원본을 Drive로 옮기기 전의 로컬 백업(2026-10-26).
- Waits on epic-daemon because: 주기 동기화(`source_sync`)와 파일 감시를 데몬이 돈다(2026-10-26. 이전 이유였던 데몬 켜짐·꺼짐 두 상태 검증은 삭제).
- Note(2026-10-16, `../change-users-and-review-gaps/`, 인셉션 입력): D5 가리기 이전의 DB 스냅샷은 새 스냅샷이 검증된 뒤 지운다(spine AD-11). Drive 기록 복제 파일의 다시 쓰기는 epic-replicas 몫이다.
- Note(2026-10-16, 인셉션 입력): Drive API 오류에 분류 코드를 붙인다. 429·5xx·네트워크는 일시 오류이고 `Retry-After`를 따른다. 403·404·삭제됨은 영구 오류다(spine AD-21 재시도 분류).
- Note(2026-10-16): Drive 일감 실패의 다시 하기는 `failures retry`에 대상 종류를 더해서 한다(2.12가 명령을 만든다, spine AD-5).
- Note(2026-10-19, `../change-masking-b-and-review-fixes/`, 인셉션 입력): 마스킹 B. Drive로 올리는 DB 스냅샷도 나가는 길이다. 가린 사본을 만들어 올리고, 그것으로 되살린 Brain의 비밀은 가린 채 돌아온다(D6). 첨부 원본 바이트는 가리지 않는다(`files.redact`가 그 길).
- Decision(2026-10-22, epic-attachments 인셉션, 사용자): PDF·docx 추출기가 epic-attachments에서 이 에픽으로 왔다(E8-5). 한 달 실측에서 사용자가 대화에 붙인 PDF·문서는 0건이고 첫 실사용은 기존 Drive 문서 색인이다. 추출 틀은 epic-attachments가 만든다.
- Decision(2026-10-26, `../change-v1-capture-and-drive/`, 사용자): Drive는 V1이다. 순서는 데몬(9) → 첨부·추출(10, 축소) → 로컬 백업(5) → 이 에픽. 문서·폴더명 검색(E8-6)을 epic 4에서 옮겨 왔다. 스냅샷·새 Mac 복구(E8-4)와 로컬 캐시 상한은 V1 뒤. 촬영 일시 검색은 EXIF(epic-recall-and-mirror 1, 옛 10.9)와 함께 V1 뒤.
