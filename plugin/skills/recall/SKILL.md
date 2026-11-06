---
name: recall
description: Garmin 건강 수치를 지정한 기간과 조건으로 조회하고 응답 근거를 보고합니다.
---

# 건강 수치 조회

1. `brain ext status garmin --json`으로 상태를 확인한다. 실패하면 오류 코드를 보고하고 상태를 확인할 수 없다고 안내한다. installed가 false면 미설치이므로 second-brain-garmin 플러그인 설치를 안내하고 중단한다. enabled가 false면 비활성임을 안내하고 중단한다. 활성화는 사용자가 결정한다. 미설치·비활성 각각의 경우 상태 안내와 별도 문장으로 반드시 “Garmin 건강 수치 조회 명령이 없어 쓸 수 없습니다.”라고 보고한다. 조회 명령은 부르지 않는다.
2. `brain config get garmin.connection_id --json`과 `brain config get garmin.timezone --json`으로 연결과 시간대를 읽는다. 설정이 없으면 설정이 필요하다고 안내하고 중단한다. 조회가 실패하면 오류 코드를 보고한다.
3. 질문을 연결 시간대의 현지 날짜 기간, 지표, 운동 조건과 집계로 해석한다. 시작일과 종료일은 모두 포함한다. 어제 같은 상대 날짜는 고정 UTC 오프셋을 가정하거나 머릿속으로 계산하지 않는다. 시간대 데이터베이스를 쓰는 도구로 현재 시각의 현지 날짜를 구하고 그 날짜에서 역일 기준으로 하루를 뺀다. 예를 들어 macOS에서는 `TZ=<garmin.timezone> date -r <epoch초> +%F`를 사용하거나 같은 결과를 내는 node 또는 python 시간대 도구를 쓴다. 같은 조건을 바꿔 가며 재조회해 맞는 답을 찾지 않는다. 운동 조건이 있으면 `activity_type`, `exercise`를 사용하고 집계는 합계 `sum` 또는 평균 `mean`이다. `brain guide schema ext.garmin period-summary --json`으로 지표와 집계 이름 목록을 확인한다. 일별 조회에는 `brain guide schema ext.garmin daily-values --json`으로 해당 명령의 지표 목록을 확인한다. schema는 지표별 허용 집계를 알려주지 않으며 명령이 조합을 판정한다. 지원하지 않거나 조건을 정할 수 없으면 확인을 요청하고 값을 추정하지 않는다.
4. 읽은 `connection_id`, `timezone`과 해석한 `start_date`, `end_date`, `metric`, `aggregation` 및 필요한 운동 조건을 JSON으로 만들어 `brain ext garmin period-summary --input '<json>' --json`을 호출한다. MCP에서는 `ext_garmin_period_summary`를 쓸 수 있다. 일별 값을 요청하면 집계 없이 `brain ext garmin daily-values --input '<json>' --json`을 호출한다. 명령이 `ok:false`이면 오류 코드를 보고하고 기록 0건으로 합치지 않는다. 집계를 거부하면 다른 집계가 가능한지 사용자에게 확인한다.
5. `value` 0은 기록된 0이며 "기록 0건"이나 "비어 있음"과 다르다. 기간 요약은 응답의 `value`, `unit`, `observed_count`, `null_count`, `start_date`, `end_date`와 조회 시간대를 그대로 보고한다. 일별 조회는 반환된 날짜·값·단위를 그대로 보고한다. `value`가 null이고 `observed_count` 0, `null_count` 0이면 "기록 0건"이다. `value`가 null이고 `observed_count` 0, `null_count`가 0보다 크면 "값이 모두 비어 있음(0 아님)"으로 안내한다.

건강 수치를 손으로 다시 계산하거나 추정하지 않고 NULL을 0으로 바꾸지 않는다. DB 직접 조회 등으로 우회하지 않는다. 건강값이나 비밀을 요청하거나 추정하지 않는다.
