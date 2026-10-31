---
name: channels
description: 채널 발신 상태를 확인하고 닫힌 실패 요청의 재전송을 접수합니다.
---

# 채널 상태와 재전송

사용자가 지정한 요청 ID를 사용한다. ID가 없으면 `brain channels list --json`으로 후보를 확인하고 사용자가 선택하도록 한다. 메시지를 새로 만들거나 직접 발신하지 않는다.

1. `brain guide schema channels --json`으로 `channels list`, `channels status`, `channels resend` 지원을 확인한다. 지원하지 않으면 미구현이라고 보고 중단하며 다른 방법으로 우회하지 않는다.
2. `brain channels status <request-id> --json`으로 현재 상태를 확인한다. 실패하면 확인할 수 없다고 보고 중단한다.
3. 사용자가 재전송을 요청했고 `resendEligible`이 참이면 `brain channels resend <request-id> --json`으로 접수한다. 이미 발신, legacy, 진행 중 또는 부적격이면 재전송하지 않는다.
4. 접수 성공이나 실패 뒤 `brain channels status <request-id> --json`을 다시 조회한다. 재조회 실패 시 최종 상태를 미확인으로 보고한다.

마지막으로 관찰한 발신 결과, 일감 상태, 시도 수, 다음 시도 시각, 미해결 실패 수, legacy 여부와 재전송 적격성을 보고한다. 재전송 접수만으로 발신 성공을 주장하지 않는다. 상태 조회만 요청받았다면 변경하지 않는다. 본문이나 외부 서비스의 식별자, 비밀을 요청하거나 추정하지 않는다.
