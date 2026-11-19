---
name: brain-recall
description: 기억과 리포트를 검색해 출처 원문을 읽고 Garmin 건강 수치를 조회합니다.
---

# 기억 검색과 원문

텍스트 검색 요청은 먼저 `brain guide schema recall --json`으로 검색 명령·옵션을 확인한다. 세션·파일 원문을 읽을 때는 `brain guide schema sessions --json` 또는 `brain guide schema files --json`도 확인한다. 해당 명령이 없거나 확인이 실패하면 미구현 또는 확인 불가로 보고 중단한다. 건강 수치 요청은 아래 건강 절차의 지원 확인을 따른다.

질문이 대화·도구 사용·리포트의 내용을 찾는 것이면 먼저 핵심 표현을 뽑아 검색한다. 검색어는 짧고 구체적으로 정한다. 도구 메모·리포트는 적중이 없으면 같은 뜻으로 표현을 바꿔 다시 검색하고, 대화는 아래 재질의 조건을 따른다. 질의는 근거를 찾기 위한 것이며 원문 없이 답을 지어내지 않는다.

- 대화는 `brain recall chunks <query> --json`, 도구 메모는 `brain recall tools <query> --json`, 리포트는 `brain recall docs <query> --source <source> --json`을 사용한다. 특정 확장 출처를 아는 경우 `--source`에 그 이름을 지정한다. 확장 이름을 모르면 임의로 정하지 않는다.
- 대화 질문은 의미 검색으로 취급하지 않는다. 질문이나 명시된 맥락에서 실제 원문에 연속해서 나타날 것으로 예상되는 구별력 있는 짧은 구절 하나를 골라 `<query>`로 쓴다. 질문 전체를 그대로 넣거나 떨어진 단어를 이어 붙이지 않는다. 예를 들어 “등대 점검 일정을 언제 정했지?”에서는 셸에서 `brain recall chunks '등대 점검' --json`처럼 따옴표로 한 인자에 담아 검색한다.
- 사용자 질문·명시 맥락 또는 독립적으로 확인한 프로젝트나 워크트리 식별자가 있을 때만 확인한 schema에 따라 `brain recall chunks <query> --project <id> --json` 또는 `brain recall chunks <query> --worktree <id> --json`을 사용한다. 불명확하면 두 옵션 없이 검색한다. 이 옵션들은 근접 결과의 순위를 높이며 범위 필터가 아니므로 다른 범위 결과도 확인한다. 기대 출처나 검색 결과를 보고 범위를 추측하지 않는다.
- 대화 검색은 사전에 정한 조회 한도와 재질의 조건을 지킨다. 별도 한도가 없다면 정상 검색 후 근거가 부족할 때만 질문에 근거한 다른 연속 구절로 최대 한 번 재질의한다. 오류는 오류로 보고하며 재질의로 0건처럼 처리하지 않는다.
- 정상 검색의 `meta.has_more`는 요청 건수 한도 밖 추가 후보를 뜻하고 `meta.omitted.count`는 응답 크기 한도로 빠진 행 수다. `RESULT_TRUNCATED`는 첫 본문만 잘려 생략 행 수가 0일 때도 나온다. `meta.next`는 첫 잘림 또는 생략 출처의 원문 읽기 안내이며 다음 검색 페이지가 아니다. 근접 범위 밖 후보, 요청 건수 밖 후보와 크기로 인한 검색 결과 잘림을 구별한다.
- 원문 확장도 부분 응답이면 허용된 조회 한도 안에서 안내된 원문을 읽는다. 그래도 근거가 부족하면 실제 읽은 범위와 원문 잘림을 밝힌다. 추가 후보, 크기 생략, 0건과 읽은 원문에 근거가 부족한 경우를 구별하고, 반환 출처의 원문을 읽기 전에는 결론을 내리지 않으며 검색 결과만으로 기록의 부재를 단정하지 않는다.
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
