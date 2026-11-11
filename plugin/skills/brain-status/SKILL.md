---
name: brain-status
description: Brain 설치 진단, 데몬 시작·중지·상태, 대기열 조회·취소·처리, 실패 조회·재시도를 요청할 때 사용합니다.
---

# 진단과 운영

먼저 요청에 해당하는 `brain guide schema doctor --json`, `brain guide schema daemon --json`, `brain guide schema queue --json`, `brain guide schema failures --json`을 읽는다. 필요한 명령·옵션이 없거나 확인에 실패하면 미구현 또는 확인 불가로 보고 중단한다.

조회는 `brain doctor run --json`, `brain daemon status --json`, `brain queue list --json`, `brain failures list --json` 중 요청 범위만 실행한다. 진단 실패를 빈 목록이나 정상으로 바꾸지 않는다. 대상 ID는 실제 목록에서 고르며 모호하면 묻는다.

수정·실행은 영향과 대상을 설명하고 사용자 동의를 받은 뒤 한다. 이미 구체적으로 요청한 조치는 동의로 쓴다. `brain daemon start --json`과 `brain daemon stop --json`은 감독 프로세스 운영만 제어한다. `brain queue cancel <id> --json`은 취소 요청과 실제 취소를 구별한다. `brain failures retry --json`의 범위 옵션은 schema로 확인하고 무범위 전체 재시도에는 전체 동의를 받는다. `brain queue drain --json`은 남은 일감을 실제 처리하므로 외부 발신 가능성과 처리 범위에 대한 명시적 확인 없이 실행하지 않는다. 진단만 요청받고 수리를 시작하지 않는다.

변경 뒤 해당 상태·목록을 다시 읽는다. `requested`, 재시도 접수, 시간 예산 종료는 완료가 아니다. 종료 코드와 오류 코드, 관찰한 건수·상태 및 남은 일을 보고한다. 실패한 변경을 무한 반복하지 않는다. 비밀·인증 정보나 원문을 보고에 복사하지 않는다.
