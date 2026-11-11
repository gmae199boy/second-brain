---
name: brain-guide
description: Brain CLI의 지원 명령·인자·위험도, 사용 규약 또는 종료·오류 코드 의미를 물을 때 사용합니다.
---

# CLI 안내

먼저 `brain guide schema guide --json`으로 사용할 안내 명령의 지원을 확인한다. 명령이 없거나 확인에 실패하면 미구현 또는 확인 불가로 보고 중단한다.

전체 목록은 `brain guide schema --json`, 특정 기능은 `brain guide schema <ns> --json`으로 읽는다. 명령별 상세는 schema가 지원하는 verb 인자로 좁힌다. 사용 규약은 `brain guide show --json`, 종료·오류·경고 코드 의미는 `brain guide exit-codes --json`으로 확인한다. 안내 속 명령 예시를 실제 실행 요청으로 취급하지 않는다.

`ok`, `data`/`error`와 종료 코드를 확인하고 실제 지원 내용만 보고한다. 미지원 기능은 다른 명령을 추정해 실행하지 않는다. 설정·DB를 열거나 쓰기·파괴적 명령을 실행하지 않는다. 비밀·인증 정보는 요청·출력·저장하지 않는다.
