# 16.4 수정 독립 확인

검사 완료: 예. `.brain-automation/repair-pass-2-spec.md`, 현재 제품 소스, 관련 시험 diff와 신규 합성 fixture를 읽기 전용으로 대조했다. 발견사항은 1건이다. 코드·계획 수정, 빌드·시험 실행, 추가 워커 실행, 실제 계정·운영 데이터·비밀 조회는 하지 않았다. 아래는 정적 추적 결과이며 시험 통과나 실행 시간 측정 결과를 주장하지 않는다.

## 발견사항

최초 수집에서 새로 정한 history_start가 날짜 발행에 전달되지 않는다.

- 위치: `extensions/garmin/src/collect.py:138`, `extensions/garmin/src/collect.py:203`, `extensions/garmin/src/collect.py:213`, `extensions/garmin/src/normalize_runtime.py:90`.
- 조건: 처음 수집하는 계정에 기존 history_start가 없고, 범위 내 활동 목록이 가리킨 활동의 상세 시작 시각이 시작일 이전으로 보정되어 있다.
- 도달 경로: collect 109행에서 `snapshot['history_start']`는 `None`이다. 120행은 `today - 30일`을 `history`로 정하고 138행은 이를 DB에 기록하지만 반환값을 snapshot에 반영하지 않는다. 범위 내 `activities_by_date`의 `startTimeLocal`은 `collect_coverage.items`의 활동 수집 후보를 만들고, 상세 응답의 `summaryDTO.startTimeGMT`는 `normalization.activity_date`에서 별도로 날짜가 된다. 따라서 목록 날짜는 범위 안이고 상세 날짜는 `history - 1일`인 응답도 이 경로를 통과한다.
- 결과: 174행의 dirty 후보 필터는 이전 날짜를 제외하지만 203-204행의 `affected`에는 필터 없이 그 날짜가 추가된다. 213행이 처음의 snapshot을 넘기면 `publish_days` 90-91행은 시작일을 `None`으로 보아 이 날짜를 허용한다. 해당 활동이 selected 입력이 되어 시작일 이전 day_summary·workout·exercise_log 관측이 발행될 수 있다. 다음 실행에서 DB 시작일을 읽어도 이미 발행한 관측은 남는다.
- 필요한 처리: `set_history_start`가 확정한 값을 현재 snapshot에 반영하거나, 같은 확정 시작일로 `affected`와 공통 날짜 발행을 제한해야 한다.
- 시험 대조: `apps/cli/python-test/garmin-pass2.test.ts`의 이동 사례는 `pass2_fixture.py`에서 frozen 입력의 history_start를 먼저 저장한 뒤 실행한다. 이미 시작일이 있는 경우는 다루지만 최초 수집의 `None → 확정 시작일` 경계는 다루지 않는다.

## 나머지 확인 결과

- 라벨 A→B→A: `normalize_store.py:189-223`은 base fingerprint와 실제 revision을 분리한다. 같은 source max에서 최신 base와 같으면 최신 occurrence를 재사용하고, 과거 base로 돌아오면 최신 revision을 재료로 새 occurrence와 다음 슬롯을 만든다. `garmin-pass2.test.ts`는 실제 종목 라벨 변경·복원, 복원 후 새 revision, 연속 재실행의 행 불변을 확인하는 assertion을 포함한다.
- 버전 공통 재사용과 0008 collision alias: 예약 조회에는 normalization_version 조건이 없고, 성공 상태 조회는 버전별이다. 따라서 동일 occurrence의 revision·watermark를 유지하며 새 버전 상태를 만든다. 0009는 기존 revision을 base로 이관하고, 충돌 시 결정적 alias를 별도 슬롯에 만든다. `garmin-upgrade.test.ts`는 0008 스키마와 충돌 관측을 구성한 뒤 실제 migration runner를 호출하고 기존 관측·상태, alias, 반복 실행, 버전 변경 후 watermark 보존을 비교한다.
- 시작일이 이미 존재하는 경로: 공통 `publish_days`와 collect dirty 후보에 시작일 필터가 있고, `unfinished_days`도 범위 밖 dirty를 반환하지 않는다. 범위 밖 dirty를 삭제하거나 완료로 위장하지 않으면서 정상 재진입 후보에서 제외하는 구조다. 위 발견사항은 시작일 최초 확정 순간에 한정된다.
- Raw freshness와 짧은 transaction: `collect_store.py:86-104`의 양쪽 fingerprint는 같은 최신 raw 선택 규칙과 scope/key/endpoint, body SHA-256, fetched·checked 시각, library version을 비교한다. `reserve_day`는 SHARE 잠금 안에서 SQL digest 결과를 읽으며 본문 전체를 클라이언트에 다시 보내지 않는다. 기존 timeout은 유지된다. 신규 stress fixture는 500개 이상의 합성 raw, body·fetched·checked·library 각각 변경 시 stale 거부, 예약 시간 assertion을 포함한다. 실제 2초 이내 성공 여부는 이 검사에서 실행 확인하지 않았다.
- NULL 전이: 0009가 과거 NULL 성공을 보수적으로 미물질화 상태로 이관한다. `unpublished`는 같은 버전의 비NULL 소유 endpoint 성공이 생기면 미물질화 NULL 성공을 다시 후보로 만든다. `prepare`가 기존 대상 행 조건으로 NULL 열을 만들고, 발행 마지막 chunk에서만 materialized 상태를 갱신한다. `garmin-normalize.test.ts`에는 최초 NULL만 있는 경우, 다른 소유 endpoint가 나중에 대상을 만든 경우, 기존 대상 뒤 NULL, pending 예약 후 중단·재개와 반복 멱등 assertion이 있다.

기존 timestamp 판정, 사라진 키·시간대 전환의 deferred 판정, 슬롯 1000 한도는 새 수정 요구로 반복하지 않았다. 지휘자·다른 리뷰어 보고서와 구현자 결과 보고서는 읽지 않았고, 이 보고서 외 파일은 수정하지 않았다.
