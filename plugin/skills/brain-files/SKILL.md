---
name: brain-files
description: Brain에 저장된 첨부·문서 출처를 읽거나 파일 원본 사본과 추출 내용을 영구 가림 처리해 달라는 요청에 사용합니다.
---

# 파일 읽기와 가림

먼저 `brain guide schema files --json`으로 요청 명령·옵션을 확인한다. 없거나 schema 확인이 실패하면 미구현 또는 확인 불가로 보고 중단한다.

검색 결과의 실제 file ID와 locator를 사용해 `brain files show <file-id> --json`에 schema가 요구하는 위치·추출 세대 옵션을 전달한다. 외부 source 파일은 schema의 source ID 옵션을 쓴다. 이어 읽기 지문과 offset도 응답 그대로 사용한다. ID를 추정하지 않는다. 원문이 없거나 접근 불가이면 그 한계를 보고하고 링크만으로 읽었다고 말하지 않는다. 비밀이 보이면 출력·보고에 복사하지 않는다.

가림은 파일을 함께 쓰는 모든 메시지에 영향을 주며 되돌릴 수 없다. 사용자에게 파일 ID/해시와 공유 영향, Brain의 사본·추출·이름이 사라진다는 점을 설명하고 명시적 확인을 받는다. 그 뒤에만 `brain files redact <file> --yes --json`을 실행한다. 단순 조회나 가림 가능 여부 질문은 동의가 아니다. 확인 전에는 `--yes`를 붙이지 않는다.

응답의 messages, already_redacted, 제거 건수와 blob_deletes_queued를 보고한다. 실제 블롭 삭제는 다음 대기열 처리이며 즉시 디스크 삭제 완료를 주장하지 않는다. 외부 source 원본 삭제를 뜻하지 않는다. 오류는 종료 코드와 공개 오류 코드만 보고하고 중단한다. 비밀·원문을 로그에 남기거나 DB·파일 직접 삭제로 우회하지 않는다.
