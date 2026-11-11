---
name: brain-messages
description: Brain에 수집된 메시지·도구 메모의 비밀을 영구 가림 처리해 달라는 요청에 사용합니다.
---

# 메시지 가림

먼저 `brain guide schema messages --json`으로 `messages redact`와 옵션을 확인한다. 없거나 schema 확인이 실패하면 미구현 또는 확인 불가로 보고 중단한다. 읽기는 brain-sessions 스킬을 사용한다.

사용자가 지정하거나 검색에서 확인한 메시지 ID만 사용한다. 가림은 본문과 도구 메모에서 되돌릴 수 없는 변경이다. ID와 자동 탐지 범위를 설명하고 사용자에게 명시적 확인을 받은 뒤 `brain messages redact <message-id> --detected --yes --json`을 실행한다. 확인 전 `--yes`를 붙이지 않는다. 비밀 문자열을 사용자에게 요청하거나 명령 인자·대화·로그에 넣지 않는다. 특정 문자열 가림이 필요해도 비밀을 `--text`로 전달하지 말고 사용자가 직접 처리하도록 안내한다.

반환된 가림 구간·도구 메모·제거 조각 수와 unredacted_attachments를 보고한다. 첨부는 자동 가림이 아니므로 남아 있으면 brain-files 스킬로 별도 동의 후 처리한다. 메시지 가림 성공을 첨부 삭제 성공으로 말하지 않는다. 종료 코드와 공개 오류 코드를 보고하고 실패 시 중단한다. 원문·비밀을 보고에 복사하거나 DB 직접 수정으로 우회하지 않는다.
