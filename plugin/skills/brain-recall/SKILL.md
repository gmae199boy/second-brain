---
name: brain-recall
description: 기억과 리포트를 검색해 출처 원문을 읽고 Garmin 건강 수치를 조회합니다.
---

# 기억 검색과 원문

텍스트 검색 요청은 먼저 `brain guide schema recall --json`으로 검색 명령·옵션을 확인한다. 세션·파일 원문을 읽을 때는 `brain guide schema sessions --json` 또는 `brain guide schema files --json`도 확인한다. 해당 명령이 없거나 확인이 실패하면 미구현 또는 확인 불가로 보고 중단한다. 건강 수치 요청은 아래 건강 절차의 지원 확인을 따른다.

질문이 대화·도구 사용·리포트의 내용을 찾는 것이면 먼저 핵심 표현을 뽑아 검색한다. 검색어는 짧고 구체적으로 정하며 적중이 없으면 같은 뜻으로 표현을 바꿔 다시 검색한다. 질의는 근거를 찾기 위한 것이며 원문 없이 답을 지어내지 않는다.

- 대화는 `brain recall chunks <query> --json`, 도구 메모는 `brain recall tools <query> --json`, 리포트는 `brain recall docs <query> --source <source> --json`을 사용한다. 특정 확장 출처를 아는 경우 `--source`에 그 이름을 지정한다. 확장 이름을 모르면 임의로 정하지 않는다.
- 각 응답의 `ok`를 먼저 확인한다. 검색 실패·DB 연결 실패는 오류 코드를 보고하고 기록 없음으로 말하지 않는다. 빈 `data`는 해당 검색어의 0건이며 표현을 바꾸어도 없으면 찾지 못했다고 말한다. `meta.extensions`의 미설치·비활성은 0건과 구별하고, 알려진 출처의 미설치면 설치를 안내한다. 비활성이라도 보존된 리포트는 검색하고 원문을 읽는다.
- 적중이 있으면 검색 결과의 출처만으로 원문을 읽고 답의 근거로 삼는다. 대화 조각의 session·from_at·to_at은 `brain recall expand <session> --from <from_at> --to <to_at> --json`에, 도구 메모의 session·tool_note_id는 `brain sessions read <session> --note <tool_note_id> --json`에 전달한다. 고아 도구 메모도 이 명령으로 읽고 메시지 원문 확장으로 대신하지 않는다. 문서의 file_id·chunk_locator·extraction_id는 `brain files show <file_id> --chunk-locator <locator> --extraction-id <extraction_id> --json`에 전달한다. 원문 조회 실패나 접근 불가는 그 상태를 보고하고 본문을 추정하지 않는다. 출처와 실제 읽은 내용을 함께 보고한다.
- 질문에 수치 계산이 포함되면 다음 건강 절차를 사용한다. 텍스트 검색의 표현 바꾸기와 건강 조회 조건을 바꿔 값을 맞추는 행위는 다르다.

# 건강 수치 조회

1. `brain ext status garmin --json`으로 상태를 확인한다. 실패하면 오류 코드를 보고하고 상태를 확인할 수 없다고 안내한다. installed가 false면 미설치이므로 second-brain-garmin 플러그인 설치를 안내하고 중단한다. enabled가 false면 비활성임을 안내하고 중단한다. 활성화는 사용자가 결정한다. 미설치·비활성 각각의 경우 상태 안내와 별도 문장으로 반드시 “Garmin 건강 수치 조회 명령이 없어 쓸 수 없습니다.”라고 보고한다. 조회 명령은 부르지 않는다.
2. `brain config get garmin.connection_id --json`과 `brain config get garmin.timezone --json`으로 연결과 시간대를 읽는다. 설정이 없으면 설정이 필요하다고 안내하고 중단한다. 조회가 실패하면 오류 코드를 보고한다.
3. 질문을 연결 시간대의 현지 날짜 기간, 지표, 운동 조건과 집계로 해석한다. 시작일과 종료일은 모두 포함한다. 어제 같은 상대 날짜는 고정 UTC 오프셋을 가정하거나 머릿속으로 계산하지 않는다. 시간대 데이터베이스를 쓰는 도구로 현재 시각의 현지 날짜를 구하고 그 날짜에서 역일 기준으로 하루를 뺀다. 예를 들어 macOS에서는 `TZ=<garmin.timezone> date -r <epoch초> +%F`를 사용하거나 같은 결과를 내는 node 또는 python 시간대 도구를 쓴다. 같은 조건을 바꿔 가며 재조회해 맞는 답을 찾지 않는다. 운동 조건이 있으면 `activity_type`, `exercise`를 사용하고 집계는 합계 `sum` 또는 평균 `mean`이다. `brain guide schema ext.garmin period-summary --json`으로 지표와 집계 이름 목록을 확인한다. 일별 조회에는 `brain guide schema ext.garmin daily-values --json`으로 해당 명령의 지표 목록을 확인한다. schema는 지표별 허용 집계를 알려주지 않으며 명령이 조합을 판정한다. 지원하지 않거나 조건을 정할 수 없으면 확인을 요청하고 값을 추정하지 않는다.
4. 읽은 `connection_id`, `timezone`과 해석한 `start_date`, `end_date`, `metric`, `aggregation` 및 필요한 운동 조건을 JSON으로 만들어 `brain ext garmin period-summary --input '<json>' --json`을 호출한다. MCP에서는 `ext_garmin_period_summary`를 쓸 수 있다. 일별 값을 요청하면 집계 없이 `brain ext garmin daily-values --input '<json>' --json`을 호출한다. 명령이 `ok:false`이면 오류 코드를 보고하고 기록 0건으로 합치지 않는다. 집계를 거부하면 다른 집계가 가능한지 사용자에게 확인한다.
5. `value` 0은 기록된 0이며 "기록 0건"이나 "비어 있음"과 다르다. 기간 요약은 응답의 `value`, `unit`, `observed_count`, `null_count`, `start_date`, `end_date`와 조회 시간대를 그대로 보고한다. 일별 조회는 반환된 날짜·값·단위를 그대로 보고한다. `value`가 null이고 `observed_count` 0, `null_count` 0이면 "기록 0건"이다. `value`가 null이고 `observed_count` 0, `null_count`가 0보다 크면 "값이 모두 비어 있음(0 아님)"으로 안내한다.

건강 수치를 손으로 다시 계산하거나 추정하지 않고 NULL을 0으로 바꾸지 않는다. DB 직접 조회 등으로 우회하지 않는다. 건강값이나 비밀을 요청하거나 추정하지 않는다.
