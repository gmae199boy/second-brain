[
  {
    "location": "extensions/garmin/src/normalize_runtime.py:99-100",
    "trigger_condition": "라벨 파일만 바뀌어 day_revision은 달라지고 원문들의 최대 fetched_at_ms는 그대로인 경우",
    "guard_snippet": "revision, fetched = reserve_ordered_day_revision(inputs, label_hash, previous_day_publications)",
    "potential_consequence": "0026_health_json_comparison.sql의 revision_count>1 판정으로 날짜 관측들이 revision_ambiguous가 되어 health_current_v1에서 사라진다."
  },
  {
    "location": "extensions/garmin/src/normalize_store.py:172-185",
    "trigger_condition": "과거 날짜 raw가 완성된 뒤 날짜 발행의 마지막 chunk 전에 중단되는 경우",
    "guard_snippet": "reserve_pending_day(day, revision, version); publish_chunks(); mark_day_ok()",
    "potential_consequence": "완료 전 날짜 상태가 없어 unfinished_days가 놓치며, collect의 재실행도 완성된 과거 raw를 건너뛴다."
  },
  {
    "location": "extensions/garmin/src/normalize_store.py:65",
    "trigger_condition": "heart_rates의 timestamp가 10**20처럼 datetime 범위를 넘는 비음수 정수인 경우",
    "guard_snippet": "try: observed = datetime.fromtimestamp(ts_ms / 1000, timezone.utc); except (ValueError, OverflowError, OSError): record_item_error()",
    "potential_consequence": "파서는 통과하지만 collect.py:181에서 예외가 나므로 :185의 raw 저장과 해당 항목 실패 기록까지 생략된다."
  },
  {
    "location": "extensions/garmin/src/normalize_store.py:63-77",
    "trigger_condition": "16.3의 sub_identity=day 걸음 수 관측이 이미 있는 계정을 새 코드로 재수집하는 경우",
    "guard_snippet": "logical_key = canonicalize_legacy_collect_alias(original_key, sub_identity)",
    "potential_consequence": "삭제된 _publish_steps의 평문 키와 새 canonical 키가 별도 논리 그룹이 되어 같은 날짜 current가 중복된다."
  },
  {
    "location": "extensions/garmin/src/normalize_store.py:130-143",
    "trigger_condition": "동일 endpoint의 새 샘플 목록에서 이전 timestamp가 사라지거나 목록이 비는 경우",
    "guard_snippet": "for identity in previous_identities - new_identities: publish_null(identity, revision, fetched_ms)",
    "potential_consequence": "새 샘플만 INSERT하고 성공 처리하므로 빠진 과거 샘플도 health_current_v1에서 계속 현재값으로 남는다."
  },
  {
    "location": "extensions/garmin/src/normalize_tables.py:180-184",
    "trigger_condition": "항목별 ok/error_code로 실패를 격리하는 순수 표 변환이라는 계획의 주장",
    "guard_snippet": "day_raw = {i['endpoint']: json.loads(i['raw']) for i in items if i['scope'] == 'day' and i['key'] == day}  # try 밖",
    "potential_consequence": "비정상 JSON은 normalize_item에서 parse_error가 됐어도 날짜 단계에서 다시 예외를 내어 전체 결과 반환을 막는다.",
    "kind": "claim",
    "confidence": "high"
  }
]
