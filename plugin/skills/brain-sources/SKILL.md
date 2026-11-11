---
name: brain-sources
description: Drive 같은 외부 source의 연결·해제, 감시 폴더 추가·제거, 목록 또는 동기화를 요청할 때 사용합니다.
---

# 외부 source

먼저 `brain guide schema sources --json`으로 요청 명령·옵션을 확인한다. 없거나 확인에 실패하면 미구현 또는 확인 불가로 보고 중단한다. 별도 Drive API나 DB로 우회하지 않는다.

`brain sources list --json`으로 연결과 감시 폴더를 읽는다. 사용자에게 계정 종류·폴더 또는 source ID를 확인하고 변경 영향을 설명한다. 명확한 변경 요청을 동의로 쓰되 대상이 모호하면 묻는다.

- 연결은 `brain sources connect <kind> --json`을 사용한다. 인증은 사용자가 직접 완료한다. OAuth 코드·비밀번호·토큰을 대화에 받거나 화면에서 읽지 않는다.
- 감시 추가는 `brain sources add <folder-id> --json`, 제거는 `brain sources remove <folder-id> --json`이다. 감시 제거를 원격 파일 삭제로 해석하지 않는다.
- `brain sources sync <source-id> --json`은 실제 파일 동기화 작업을 접수한다. 동기화 방향·대상과 로컬 변경 영향을 확인하고 명시적 사용자 동의 후 실행한다.
- `brain sources disconnect <kind> --json`은 연결 해제할 계정과 영향을 설명하고 명시적 확인 후 실행한다.

변경 후 목록을 다시 확인한다. 동기화 접수를 완료로 말하지 않는다. 실패는 종료 코드·오류 코드와 미완료 범위를 보고하고 중단한다. 비밀·인증 URL의 민감 인자·문서 원문은 보고나 로그에 복사하지 않는다.
