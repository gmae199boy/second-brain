---
name: brain-schedules
description: Brain 예약 작업의 목록, 추가, 시각 수정, 켜기·끄기, 제거 또는 한 번 실행을 요청할 때 사용합니다.
---

# 예약 작업

먼저 `brain guide schema schedules --json`으로 요청한 명령·옵션을 확인한다. 없거나 schema 확인이 실패하면 미구현 또는 확인 불가로 보고 중단한다. 별도 cron이나 LaunchAgent로 우회하지 않는다.

`brain schedules list --json`으로 대상과 현재 상태를 읽는다. ID가 없거나 모호하면 사용자가 선택한다. 쓰기 전 작업 종류·대상·시각·시간대·효과를 보여 주고 사용자 동의를 받는다. 등록 요청에 이 내용이 명확하면 그 요청을 동의로 쓴다. 확장 설치의 기본 예약은 brain-install 스킬이 처리하므로 중복 생성하지 않는다.

- `brain schedules add`에 schema가 요구하는 종류·대상 및 cron/단회/현지 시각 중 하나를 전달한다. 시간대·누락된 시각을 추정하지 않는다.
- `brain schedules update <id> --json`에 schema의 시각 옵션 또는 `--enable`/`--disable`을 넣는다. 끄기는 제거와 다르다.
- `brain schedules remove <id> --json`은 제거할 ID와 영향을 설명하고 명시적 사용자 확인 후 실행한다.
- `brain schedules run <id> --json`은 즉시 일감 접수임을 설명하고 확인받는다. 외부 발신 가능성이 있으면 목적지·본문 범위도 확인한다.

변경 후 목록을 다시 읽고 최종 enabled·next_run_at 등 실제 응답과 접수 결과를 구분한다. 실패하면 종료 코드와 오류 코드를 보고하고 중단한다. 일감 접수를 실행 완료로 말하지 않는다. 비밀·인증 정보나 원문을 로그·보고에 복사하지 않는다.
