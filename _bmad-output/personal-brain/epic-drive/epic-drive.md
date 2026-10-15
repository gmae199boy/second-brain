---
type: epic
title: "Google Drive 연동"
parent: personal-brain
covers: [CAP-14, CAP-12]
after: ["epic-capture", "epic-recall-and-mirror", "epic-operations"]
assignee: ""
risk: high
---

# Google Drive 연동

## Description

Drive API로 Drive를 직접 다룬다. Drive는 5TB이고 Mac은 512GB라서 Mac에 동기화하지 않는다.
- 연동하면 Brain이 맡은 첨부 원본이 Drive로 옮겨 간다. 순서는 업로드 → 해시 검증 → `home` 전환 → 로컬 삭제 일감이다.
- 사용자가 고른 기존 Drive 폴더의 문서는 목록 → export 또는 임시 다운로드 → 추출 → 삭제 순서로 텍스트만 색인한다. 바뀐 것은 changes API로 반영한다. 동기화는 drain의 일감 종류(`source_sync`)로 돌아 launchd 주기 실행이든 데몬이든 같은 경로이고, `brain sources sync`는 그 일감을 지금 만들어 돌리는 명령이다(AD-25).
- 연동 해제는 Drive에 둔 채 연결만 끊는다.
- DB 스냅샷을 Drive에 보관해 새 기계에서 복구한다. 나중에 `/brain:db-migration` 스킬이 이것을 감싼다.

## Outcome

로컬 용량과 상관없이 첨부와 Drive 문서가 본문으로 검색되고, 기계를 바꿔도 기억을 되살린다.

## Requirements

- E8-1 (CAP-14, 원본 이전 부분): OAuth(데스크톱 앱), Drive `FileStore` 구현(epic 2의 계약 테스트 통과), 첨부 원본 이전과 로컬 캐시 상한. (AD-18·23)
- E8-2 (CAP-14, 외부 문서 색인 부분): 감시 폴더 목록, 외부 소스 테이블(파일별 마지막 버전, changes 토큰), 문서만 추출, 큰 파일은 메타데이터만, 원본 삭제 시 `source_unreachable`. (AD-23·24·25)
- E8-3 (CAP-14): 연동 해제. 검색은 계속되고 원본은 접근 불가로 표시하며, Drive 사본은 지우지 않는다.
- E8-4 (CAP-12, Drive 스냅샷 부분): DB 스냅샷의 Drive 업로드와 새 기계 복구.

## Done when

1. 연동하면 첨부 원본이 Drive로 옮겨지고, 로컬 사본은 검증 뒤에만 지워진다.
2. 고른 Drive 폴더의 문서가 Mac에 남지 않은 채 본문으로 검색되고, 결과에 Drive 링크가 붙는다.
3. Drive에서 바뀐 문서가 다음 drain(launchd 주기든 데몬이든)에서 반영된다.
4. 연동 해제 뒤에도 검색되고, 원본은 접근 불가로 표시된다.
5. 새 Mac에서 Drive 스냅샷으로 복구하면 건수가 같다.
6. 데몬이 켜진 상태와 꺼진 상태 둘 다에서 1~5가 통과한다(AD-27).

## Boundaries

AD-23·24·25. 사용자의 외부 파일은 옮기거나 지우지 않는다. 기록의 원본(SQLite)은 Drive로 옮기지 않는다. 임베딩은 쓰지 않는다. OCR, HWP, 좌표의 장소 이름 변환은 범위 밖이다.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, Capabilities CAP-12, CAP-14
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-23, AD-24, AD-25, Deferred
- change — _bmad-output/personal-brain/change-local-sqlite-primary/change-local-sqlite-primary.md, §7
- inputs — _bmad-output/personal-brain/inputs/weknora-patterns.md, §2 (조건부: lease 먼저 적기, 저장 보상과 삭제 순서, 참조 수 삭제, 배치 엔벨로프)

## Notes

- Decision(2026-10-14): Drive 데스크톱 동기화가 아니라 API를 쓴다(5TB vs 512GB). 연동 해제는 Drive에 둔 채 끊는다(b). 연동하면 첨부의 원본(SoT)이 Drive로 옮겨 간다(사용자).
- Waits on epic-capture because: `FileStore` port와 로컬 구현, 첨부 저장, 추출 일감.
- Waits on epic-recall-and-mirror because: 문서 검색 경로.
- Waits on epic-operations because: 스냅샷 형식과 launchd 주기 실행.
