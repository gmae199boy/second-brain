---
name: ext
description: Brain 확장의 목록·상태 확인, 설치·로그인 안내, 활성화·비활성화 또는 수동 일감 실행 요청에 사용합니다.
---

# 확장 관리

먼저 `brain guide schema ext --json`으로 요청 명령과 옵션을 확인한다. 없거나 확인이 실패하면 미구현 또는 확인 불가로 보고 중단한다. 임의 패키지 설치나 DB 수정으로 우회하지 않는다.

`brain ext list --json`으로 이름을 확인하고 `brain ext status <name> --json`으로 공개 상태를 읽는다. 이름을 추정하지 않는다. 설치 요청은 install 스킬의 `brain ext install <name> --json` 절차, 인증 요청은 login 스킬의 `brain ext login <name>` 절차를 따른다. 사용자가 직접 인증하며 비밀번호·MFA·토큰을 요청·출력·저장하거나 터미널 화면을 읽지 않는다.

활성/비활성의 예약·실행 영향을 설명하고 사용자 동의를 받은 뒤 `brain ext enable <name> --json` 또는 `brain ext disable <name> --json`을 실행한다. 명확한 해당 조치 요청은 동의로 쓴다. 비활성화를 삭제로 해석하지 않는다.

`brain ext run <name> <job> --json`은 설치된 확장의 허용 일감만 접수한다. 작업·대상은 schema와 공개 상태로 확인하고 모르면 묻는다. 외부 발신·자료 변경 가능성과 대상 범위를 설명하고 명시적 확인 후 실행한다. Garmin 수집·이관·리포트는 Garmin operations 스킬을 사용한다.

변경 후 status를 다시 읽는다. 접수·로그인 안내를 완료로 말하지 않는다. 오류는 종료 코드와 공개 코드만 보고하고 중단하며 상태 확인 실패는 미확인이다. 비밀이나 건강 원문을 보고에 복사하지 않는다.
