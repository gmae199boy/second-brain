---
type: epic
title: "공통 채널과 Telegram 발신"
parent: personal-brain
covers: [R13]
after: ["epic-postgres-primary", "epic-jobs-and-scheduler", "epic-extensions"]
refined: false
risk: medium
---

# 공통 채널과 Telegram 발신

## Description

core가 소유하는 채널 계약과 Telegram 발신 adapter를 만든다.
- 채널 계약: channel·conversation·thread identity, 발신 이력, 결과 bundle, 사건 분류, provenance.
- 채널 발신 요청·이력 표: 이 에픽이 처음 쓰므로 만든다(2026-10-28, 사용자). 확장은 요청과 legacy 이력을 INSERT만 한다(RLS, AD-30). 요청→`work_items` 인계와 crash 복구는 core가 맡고, legacy 이력은 인계하지 않는다.
- 중복 억제: 생산 결과의 안정된 식별자+채널 대화 식별자+목적/개정의 의미 키를 UNIQUE로 둔다. 원자적인 최초 시도 gate를 발신 전에 저장하고, 실제 결과와 불명 상태를 나눈다(AD-35).
- 기존 Garmin `ports`·`telegram`의 의미(최초 시도 gate, 전송 이력)를 공통 경로로 옮긴다.
- 발신은 작업 계약 위의 일감으로 재시도한다.
- 이전된 옛 Garmin 알림·전송 이력을 출처(legacy source)와 함께 받는 자리를 둔다. 받은 이력은 다시 보내지 않는다(2026-10-28, 사용자: core 채널 이력으로).
- 이후 사용자 답변·스레드·에이전트 선제 메시지를 같은 대화에 이을 수 있게 식별자를 정한다(2026-10-28, 이니셔티브 R13, 사용자: 별도 에픽).

## Outcome

Brain의 어떤 기능이든 같은 채널 계약으로 메시지를 보내고, 보낸 것과 실패한 것이 기록된다.

## Done when

1. 테스트 생산자의 메시지가 공통 계약으로 Telegram에 한 번 나가고 이력이 남는다. 실계정 확인은 사람이 한다.
2. 전송 실패는 재시도되고, 생산자 쪽 결과를 지우거나 되돌리지 않는다.
3. 같은 결과를 두 번 보내지 않고, 이전된 옛 발신 이력을 넣어도 메시지가 나가지 않는다.
4. 기능 묶음이 플러그인 배포로 이 Mac의 설치본에 들어가 동작한다.

## Boundaries

다음은 이 에픽 밖이다.
- Slack·Telegram 양방향 에이전트 대화와 수신 처리.
- Garmin 결과 bundle을 만드는 일은 epic-health-analysis다.
- Must not change: bot token은 `.env`에 두고(AD-18), 나가는 텍스트는 Core 출력 코덱으로 가린다(AD-11).

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements R13
- design — _bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md, "가져갈 코드와 교체할 경계"(ports, telegram 행)
- source — _bmad-output/personal-brain/prep-garmin-absorption/accepted-intent.md, S7
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-11, AD-30, AD-35, Table Contract(채널 발신 요청·이력)

## Notes

- Waits on epic-postgres-primary because: 채널·대화·발신 이력 테이블이 들어갈 공통 스키마와 비밀 저장 계약이 필요하다.
- Waits on epic-jobs-and-scheduler because: 발신 일감의 재시도와 중복 방지를 작업 계약 위에 만든다.
- Waits on epic-extensions because: 확장 role(`brain_ext_<name>`)과 출처 결합 규칙이 있어야 확장이 발신 요청·legacy 이력을 INSERT만 하는 RLS 정책을 둔다.
- Decision(2026-10-28, 사용자): 불명 발신(요청은 나갔는데 결과를 모름)도 지수 간격(AD-21)으로 다시 보낸다. 10번 실패하면 `failures`에 남기고 doctor에 보이며, 사람이 resend 명령으로 다시 보낸다. 같은 메시지가 두 번 갈 수 있다는 점을 받아들였다. 확실한 실패(요청이 나가지 않은 네트워크 오류, 429, 5xx)도 같은 경로다. 의미 키 UNIQUE와 최초 시도 gate는 그대로라, 새 요청이 같은 결과를 다시 보내지는 않는다. 정제 때 Telegram Bot API에 중복 방지 키와 보낸 메시지 조회가 정말 없는지 다시 확인한다. 이전의 Open question과 spine Deferred "불명 발신 재시도 정책"(owner 이 에픽)을 대신한다.
- Decision(2026-10-28, 사용자): 발신 상태 보기와 resend를 Brain 플러그인의 스킬로도 낸다. 사용자가 에이전트에게 "못 간 알림 다시 보내 줘"라고 하면 에이전트가 이 스킬로 CLI를 불러 보낸다. 임의 메시지를 보내는 명령은 이 결정에 들어 있지 않다(양방향·선제 메시지는 범위 밖, 이니셔티브 Boundaries).
- Decision(2026-10-28): Telegram은 옛 Garmin 봇과 채팅을 그대로 쓴다. 이전된 옛 이력과 새 발신이 같은 대화가 된다. bot token과 chat id를 `.env`에 넣는 것은 사람이 한다(hitl).
- Decision(2026-10-28, 사용자): 채널은 Garmin 런타임 안이 아니라 별도 에픽으로 그 앞에 둔다.
- Decision(2026-10-28, 사용자): 이전한 Garmin 알림·전송 이력은 Garmin 스키마가 아니라 core 채널 이력에 둔다. 그래서 이 에픽을 epic-garmin-import 앞으로 옮겼다.
