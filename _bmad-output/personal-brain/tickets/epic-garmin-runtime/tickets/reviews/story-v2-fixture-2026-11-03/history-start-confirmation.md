# 최초 history_start 수정 확인

검사 완료: 예. 현재 코드와 신규 시험·관련 fixture를 정적으로 대조했다. 발견사항 0건이며, 이전에 보고한 최초 history_start snapshot 누락은 해결된 것으로 판단한다. 이 작은 수정의 직접 회귀는 확인하지 못했다.

근거:

- `extensions/garmin/src/collect.py:138-139`의 수집 계획이 있는 경로와 `collect.py:211-212`의 계획이 없는 경로 모두 `set_history_start`의 DB 확정 반환값을 snapshot에 넣고 로컬 `history`도 다시 해석한다. 따라서 dirty 후보 필터와 `unfinished_days`는 확정 시작일을 사용하며, 같은 snapshot을 받는 `normalize_runtime.publish_days`의 90-91행도 최초 실행부터 그 시작일로 날짜를 제한한다.
- `extensions/garmin/src/collect_store.py:212-216`은 INSERT의 `on conflict do nothing`을 유지하고 실제 저장값을 SELECT하여 반환한다. 기존 시작일을 덮어쓰지 않으며, 호출자가 제안한 기본값과 DB 확정값이 다를 때도 후자가 메모리에 반영된다.
- `apps/cli/python-test/garmin-history-start.test.ts:44`는 최초 메타가 비어 있음을 확인한다. 25-27행의 합성 입력은 활동 목록 날짜를 범위 안인 2026-01-31로, 상세 시작 날짜를 기본 시작일 2026-01-01보다 앞선 2025-12-31로 둔다. 37-45행은 실제 감독자 일감으로 collect를 실행하며, 강제 활동 후보 패치는 사용하지 않는다.
- 시험 46-51행은 확정 시작일, 보정된 활동 상세 raw의 실제 저장, 범위 밖 날짜의 day_summary·workout·exercise_log 관측 부재를 확인한다. 53-58행은 재진입 결과가 noop인지, 전체 관측 ID 집합과 범위 밖 관측 부재 및 시작일이 유지되는지 비교한다.
- `extensions/garmin/tests/collect_fixture.py`의 Fake는 marker의 endpoint별 합성 응답을 반환하고 `collect.run(Fake(...))`을 호출한다. 활동 목록 파싱·후보 결정·raw 저장·날짜 발행은 제품 경로를 통과한다.

계획이 없는 분기는 신규 PG 시험의 직접 대상은 아니지만, 같은 setter 반환값 반영과 후속 날짜 발행 호출을 코드로 확인했다. 빌드·시험은 지시에 따라 실행하지 않았으므로 이 보고서는 실행 통과 증거를 대신하지 않는다. 구현자 보고서나 다른 리뷰 결과는 읽지 않았고, 코드·계획·체크포인트를 수정하거나 추가 워커를 실행하지 않았다.
