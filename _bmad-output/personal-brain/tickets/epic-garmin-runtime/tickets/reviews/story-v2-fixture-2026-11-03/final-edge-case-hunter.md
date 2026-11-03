# 16.4 후속 독립 경계 검사

검사 완료: 예. `/tmp/brain-16-4-final-review.diff`의 16.4 제품 변경과 현재 호출 경로를 정적으로 추적하고, 경계 재검사·삭제 검사·계획의 Intent 및 Tasks & Acceptance 대조를 마쳤다. 빌드·시험·계정 호출·운영 데이터 및 비밀 조회·추가 워커 실행은 하지 않았다. 아래 결과는 실행 재현 결과가 아니라 코드 경로에 근거한다.

발견사항은 다음 두 가지다. 추가 삭제 회귀 및 별도 claim finding은 확정하지 않았다.

```json
[
  {
    "location": "extensions/garmin/src/normalize_store.py:226-250",
    "trigger_condition": "새 원문에서 기존 샘플·세트가 사라지거나 labels 변경으로 exercise_log 키가 바뀐다",
    "guard_snippet": "removed = previous_keys - current_keys; publish_null_observations(removed, revision, watermark)",
    "potential_consequence": "사라진 논리 키의 예전 값이 current에 남아 샘플·운동 집계에 계속 포함된다"
  },
  {
    "location": "extensions/garmin/src/normalize_store.py:65",
    "trigger_condition": "heart_rates 샘플에 datetime 표현 범위를 넘는 비음수 정수 timestamp가 들어온다",
    "guard_snippet": "try: observed = checked_timestamp(ts_ms)\nexcept (ValueError, OverflowError, OSError): record_item_failure(); continue_next_item()",
    "potential_consequence": "변환 예외가 전체 실행을 중단하고 후속 정상 항목도 같은 입력 때문에 반복 차단된다"
  }
]
```

첫 번째 근거: `normalize_store.py:17-22`는 샘플·세트 위치와 `exercise_log(activity_id, exercise)`를 별도 논리 키로 만든다. `publish_item`의 130-143행과 `publish_day`의 229-250행은 이번 결과에 존재하는 행만 INSERT하고 성공을 기록하며 이전 키와의 차집합은 발행하지 않는다. 예를 들어 같은 날짜·활동·raw에서 labels의 종목 이름만 바꾸면 `digest.py:1328-1344`가 새 이름으로 exercise_log 행을 만들고, 기존 이름의 키에는 새 관측이 없다. `packages/postgres/migrations/0026_health_json_comparison.sql:113-138`은 sub_identity·날짜·시각별로 fetched_at 최대를 선택하므로 다른 키의 새 revision은 기존 키를 대체하지 않는다. 따라서 날짜 슬롯 예약과 dirty 완료가 성공해도 예전 이름과 새 이름의 sets 값이 함께 current에 남는다. 샘플 목록이 줄거나 비어도 같은 원인이다.

두 번째 근거: `normalize_daily.py:472-474`의 timestamp 검사는 비음수 int 여부만 확인한다. 정상 descriptor와 `heartRateValues: [[1000000000000000, 60]]`은 이 검사를 통과하지만, `normalize_store.py:65`는 이를 datetime 범위 밖 연도로 변환한다. 이 변환은 `normalize_tables.normalize_item`의 항목별 예외 처리 밖이고, `normalize_runtime.py:128-136`에도 항목별 catch가 없다. 재정규화에서는 예약한 pending 상태에서 전체 실행이 중단되며, 수집에서는 `collect.py:184`가 raw 저장 호출인 189행보다 먼저 실패하므로 해당 raw도 보존되지 않는다. 기존 malformed-parser 시험은 이 변환 단계 실패를 관찰하지 않는다.

실행 검증을 금지한 지시 때문에 위 두 경로를 새 시험으로 재현하지 않았다. 코드·계획·지휘자 체크포인트는 수정하지 않았고, 보고서는 이 파일에만 작성했다.
