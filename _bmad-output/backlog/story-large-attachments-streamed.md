---
id: 1
type: story
title: "큰 첨부도 원본과 본문이 다 들어간다"
parent: none
covers: []
after: []
refined: false
hitl: false
risk: medium
---

# 큰 첨부도 원본과 본문이 다 들어간다

## Description

첨부 원본과 텍스트 추출이 파일을 통째로 메모리에 올리지 않고 흘려 읽게 바꾼다. 그러면 크기 때문에 원본을 못 가져오거나 본문을 못 찾는 일이 없어진다(2026-10-28 사용자: 상한을 늘리고 쪼개서 읽는 일은 나중 작업으로). 지금의 상한 두 개는 DB가 아니라 구현 방식 때문이다.
- `@파일` 원본: transcript에 내용이 없어 디스크에서 읽을 때 32MiB까지만 메모리에 모은다. 넘으면 `missing_at_ingest`로 남는다.
- 텍스트 추출(txt·md): 보관한 원본을 통째로 읽고 디코딩해서 자르므로 8MiB에서 멈추고 `too_large`로 닫는다.

바꿀 것은 다음과 같다.
- 원본은 FileStore 임시 파일로 흘려 복사하면서 해시를 계산하고, 끝나면 이름을 바꾼다.
- 텍스트는 창 단위로 읽고 이어서 디코딩하며(조각 경계에서 잘린 바이트 포함), 조각을 바로 잘라 배치로 쓴다. 메모리 사용이 파일 크기와 무관해진다.
- 이미 `too_large`로 닫힌 파일과, 이 Mac에서 상한 때문에 `missing_at_ingest`가 된 첨부를 다시 넣는 경로를 둔다(가능한 만큼).

PDF·docx는 라이브러리가 문서 전체를 열어야 하므로 이 스토리 밖이다. 형식별 상한은 epic-drive(E8-5)가 정한다.

## Requirements

Verify: 64MiB짜리 txt를 `@`로 붙인 세션을 수집하면 원본이 보관되고 해시가 원본과 같으며, 추출 뒤 파일 끝부분의 단어가 문서 조각에 있고, 추출하는 동안 프로세스 메모리가 파일 크기만큼 늘지 않으며, 예전에 `too_large`로 닫힌 파일이 다시 추출된다.

## References

- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-7(트랜잭션 2초), AD-23(파일), AD-24(추출 세대)
- epic — _bmad-output/personal-brain/tickets/epic-attachments/epic-attachments.md, Requirements E10-2·E10-4, Notes(2026-10-28 닫기)
- epic — _bmad-output/personal-brain/tickets/epic-postgres-primary/epic-postgres-primary.md (11.4가 추출 Store를 PostgreSQL로 옮긴 뒤 착수)

## Notes

- Waits on 11.4(personal-brain epic 11, backlog에서는 `after`로 걸 수 없어 여기에 적는다) because: 추출 Store가 PostgreSQL로 옮겨진 뒤에 손대야 같은 코드를 두 번 고치지 않는다.
- Note(2026-10-28): transcript도 매 턴 파일 전체를 읽는다. 지금은 보통 수백 KB라 괜찮지만, 긴 세션에서 커지면 같은 방식(저장한 커서 뒤부터 읽기)으로 줄일 수 있다. 이 스토리의 범위는 아니다.
- Note(2026-10-28): 위험 medium. 수집 경로의 원본 보관을 바꾸므로, 틀리면 원본을 잃거나 깨진 사본을 남긴다. 기준 밖의 확인으로, 복사 중 실패하면 반쯤 쓴 임시 파일이 남지 않고 행도 쓰이지 않는지 본다.
