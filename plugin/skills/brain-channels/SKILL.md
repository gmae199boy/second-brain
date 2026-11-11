---
name: brain-channels
description: 메신저·채널 등록, topic 경로·결과 이벤트 구독 설정, 즉시·예약 발신, 보관 요청 발신과 재전송 또는 발신 상태 확인을 요청할 때 사용합니다.
---

# 메신저·채널과 발신

먼저 `brain guide schema channels --json`으로 요청할 채널 명령과 옵션을 확인한다. 메신저 작업에는 `brain guide schema messengers --json`도 읽어 지원을 확인한다. 해당 명령·옵션이 없거나 schema 조회가 실패하면 미구현 또는 확인 불가로 보고 중단한다. 다른 API로 우회하지 않는다. 메신저는 봇/계정, 채널은 그 메신저 안의 목적지, topic 경로는 발신 목적지 매핑이다.

- 등록 목록은 `brain messengers list --json`, 요청 목록은 `brain channels list --json`으로 읽는다. 별칭이 모호하면 ID를 사용하고 임의로 목적지를 고르지 않는다.
- 사용자에게 종류·별칭·대상을 확인하고 변경 동의를 받은 뒤 메신저는 `brain messengers add <kind> --name <name> --token - --json`, 목적지는 `brain channels add --messenger <messenger> --name <name> --chat <chat-id> --json`으로 등록한다. 토큰은 사용자가 터미널에서 비밀 관리자 출력을 stdin에 연결하도록 안내한다. 에이전트는 비밀을 읽거나 인자·대화·로그에 넣지 않는다. 등록은 발신이 아니다.
- 경로는 `brain channels route list --json`으로 읽고, 목적지와 topic 변경 동의 후 `brain channels route set <topic> --messenger <messenger> --channel <channel> --json` 또는 `brain channels route remove <topic> --json`을 사용한다. 경로 등록만으로 보관 요청을 발신하지 않는다.
- 결과 이벤트 구독은 `brain channels subscribe list --json`으로 확인한다. 목적지·시각 동의 후 `brain channels subscribe set garmin.report.completed --messenger <messenger> --channel <channel> --at 08:20 --tz Asia/Seoul --json`으로 등록한다. 시간대를 생략하면 사용자 timezone을 따른다. 즉시는 `brain channels subscribe set <event> --messenger <messenger> --channel <channel> --at immediate --json`, 제거는 `brain channels subscribe remove <event> --json`이다. 분석 시각은 예약 작업, 발송 시각은 core 구독으로 따로 정한다. 기존 topic 경로는 사람·에이전트의 직접 발신용이다.
- 자동 이벤트는 대상 날짜가 기록 시점 현지 오늘인 것만 발신한다. 수동으로 요청한 재생성·report-send·기간 분석은 날짜와 무관하게 발송 대상이다. 구독이 없던 이벤트와 지난 날짜 자동 이벤트는 보관되며 구독 등록만으로 발신하지 않는다. 선택한 날짜·범위 동의 후 `brain channels send-pending --event <event> --date <date> --json`으로 접수한다. 이때 날짜는 이벤트 대상 날짜이며 `--id`는 이벤트 ID다. 기존 `--topic`의 날짜는 UTC 접수일이다.
- HH:MM 전 이벤트는 당일 해당 시각, 이후 이벤트는 즉시 접수한다. 설정 변경은 이후 이벤트부터 적용하며 이미 예약된 요청은 재계산하지 않는다. 같은 이벤트와 구독은 한 번만 접수한다.
- 발신 전 사용자에게 목적지·본문·시각을 보여 주고 명시적 확인을 받는다. 이미 그 내용을 명확히 지정해 발신을 요청했다면 그 요청을 확인으로 쓴다. `brain channels send --topic <topic> --text - --json`으로 확인한 본문을 stdin에 전달한다. 예약 발신은 schema의 `--at`을 사용하고 시간대가 포함된 ISO 시각을 확인한다. 누락된 날짜·시간대·목적지를 추정하지 않는다. 직접 목적지 옵션이나 파일 입력은 schema를 따른다.
- 보관 요청은 topic과 `--id` 또는 `--date` 범위를 확인한다. 전부 발신할 때는 전체 범위 동의를 받아 `brain channels send-pending --topic <topic> --json`을 실행한다. 접수 건수만 보고하고 모두 발신됐다고 말하지 않는다.
- 요청 ID가 없으면 목록에서 사용자가 선택하도록 한다. `brain channels status <request-id> --json`으로 상태를 읽는다. 사용자가 해당 요청 재전송을 명시적으로 요청했고 `resendEligible`이 참일 때만 `brain channels resend <request-id> --json`을 실행한다. 이미 발신, legacy, 진행 중 또는 부적격이면 재전송하지 않는다. 접수 후 같은 status를 다시 읽는다.

JSON의 `ok`, `data`/`error`와 종료 코드를 확인한다. 실패하면 오류 코드와 미완료 범위를 보고하고 반복 발신하지 않는다. 최종 상태 조회 실패는 미확인이다. 마지막으로 관찰한 delivery, workState, attempts, nextAttemptAt, unresolvedFailures, legacy, resendEligible을 보고한다. 재전송 접수만으로 발신 성공을 주장하지 않는다. 상태 조회만 요청받았다면 변경하지 않는다. 비밀번호·MFA·토큰은 요청·출력·저장하지 않으며 본문의 비밀은 보고에 복사하지 않는다.
