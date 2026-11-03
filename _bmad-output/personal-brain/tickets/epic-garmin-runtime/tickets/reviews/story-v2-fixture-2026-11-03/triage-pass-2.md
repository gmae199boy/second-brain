# 16.4 수정 후 thorough 재리뷰 triage

4렌즈 전부 완료 후 18개 항목을 현재 코드·호출자와 대조했다. 이전 판정과 같은 위치·주장은 carried로 보존했다. 최종 검증 워커가 소스 수정 없이 전체 시험을 마칠 때까지 다음 수정을 시작하지 않는다.

## Blind Hunter — 10건

- F-B1 `[medium]` `[defer]` 시간대 변경 재발행: item/day 상태에 zone이 없고 건강 logical key에는 zone이 있으므로 설정 전환은 단순 재발행으로 옛 그룹을 없앨 수 없다. 이는 원래 baseline의 16.3에서도 존재하던 시간대 설정 전환 계약 문제다. 이번 명세는 동일 timezone에서의 v8 이식·revision·복구이며 시간대 마이그레이션은 요구하지 않는다. 현재 실행은 고정 zone snapshot을 따른다. 별도 설정/소비 계약의 후속 작업으로 기록한다.
- F-B2 `[medium]` `[patch]` labels A→B→A: 현재 reserve_day는 A의 과거 성공을 재사용하므로 B의 높은 슬롯이 current에 남는다. B5 수정이 도입한 예약 재사용에서 드러난 실제 결함이다. 현재 입력 조합의 재등장을 별도 결정적 발행 회차로 예약하고 버전 공통 재사용·멱등을 유지한다.
- F-B3 `[low]` `[reject]` datetime 상한: carried — 기존 quick 및 E3의 같은 위치/주장/코드다. 극단 입력에 새 예외 경로를 더하지 않는 기존 판정을 유지한다.
- F-B4 `[medium]` `[patch]` collect history_start 누락: rebuild 후보만 history_start를 거르고 공통 publish_days는 거르지 않는다. collect 활동의 옛/새 시작 날짜는 시작일 이전으로 갈 수 있다. 공통 경계에 필터를 두고 실제 경계 시험을 추가한다.
- F-B5 `[medium]` `[patch]` NULL 상태 전이 검증 공백: 최초 NoData·다른 소유 endpoint의 대상 행 생성·기존 행 뒤 null·재시도의 상태 의존은 순수 fixture가 관찰하지 않는다. 원래 legacy 의미를 유지하는 제품 경로 PG 전이를 추가한다.
- F-B6 `[medium]` `[patch]` rich frozen 입력과 제품 runtime 연결 공백: publisher 직접 생성 행 시험은 저장 계약은 증명하지만 raw→prepare→publish_days 전체를 통과하지 않는다. 합성 frozen 입력 전체를 제품 경로로 발행하고 고정 expected의 catalog 투영과 대조한다.
- F-B7 `[medium]` `[patch]` 날짜의 실제 여러 chunk 중단 검증: 항목 501행 및 날짜 첫 chunk 전 중단은 날짜 마지막 chunk의 generation 완료 조건을 증명하지 않는다. 날짜 관측 500초과의 첫 commit 뒤 중단·새 attempt 복구·id/batch/watermark 보존을 추가한다.
- F-B8 `[medium]` `[patch]` dirty 세대 경합 검증 공백: 예약 N 뒤 raw commit N+1, N 완료의 generation 조건을 시험하지 않는다. 실제 두 연결을 결정적 순서로 제어해 N+1 pending 및 최종 current 수렴을 관찰한다.
- F-B9 `[medium]` `[patch]` 잠금 안 전체 raw 전송 비용: reserve_day는 날짜마다 계정 전체 본문을 SHARE 잠금 아래 전송·정렬·비교한다. 몇 년치 샘플이 있는 정상 계정에서 1.9초 제한과 전체 writer 차단을 유발할 수 있다. stale 검증 정확성을 보존하면서 본문 전송·비교 범위를 줄이고 대표 합성 이력의 짧은 transaction 경계를 검증한다.
- F-B10 `[low]` `[reject]` 같은 source millisecond의 1000슬롯 소진: 명시적 fail closed가 이미 구현돼 있어 임의 최신성 훼손은 없다. 고정 labels와 실제 endpoint timestamp가 유지된 채 1000회 서로 다른 조합이 발행되는 것은 평소 입력에서 드물다. 자동 복구 정책을 새로 추가하는 것은 단순 정정이 아니므로 reject하고 알려진 한도를 최종 보고에 보존한다.

## Edge Case Hunter — 2건

- F-E1 `[medium]` `[defer]` 사라진 샘플/세트/라벨 키 current 잔존: carried — E5와 I-F 및 원래 deferred의 같은 키별 current 계약이다. 불변 발행의 삭제 표식 계약을 이번에 새로 만들지 않고 기존 판정과 후속 항목을 유지한다.
- F-E2 `[low]` `[reject]` 극단 timestamp 변환 격리: carried — F-B3과 같은 기존 quick 판정이다. 추가 patch/defer하지 않는다.

## Verification Gap — 2건

- F-V1 `[medium]` `[patch]` 예약 뒤 새 dirty 세대 보존 시험 없음: 렌즈의 검색·시험 증거를 수용한다. F-B8과 같은 경합 시험으로 해결한다.
- F-V2 `[medium]` `[patch]` 제품 runtime의 문법상 잘못된 JSON 격리 시험 없음: 렌즈의 검색·시험 증거를 수용한다. 순수 normalize_all 검사와 실제 normalize의 날짜 ledger/result/current는 별도 표면이다. 손상 날짜와 뒤의 정상 날짜를 제품 일감으로 함께 검증한다.

## Intent Alignment — A~D 4건

- F-I-A `[false]` `[reject]` imported raw를 날짜 보조 입력으로 쓰는 것 자체가 금지라는 해석: carried — I-C와 같은 주장이다. 기존 Design Notes가 계정 전체 snapshot 보조 입력을 명시하며 대상 항목/출력 dataset 경계와 양립한다. 반입 전용 날짜의 출력 오염은 B4 수정/PG 시험으로 별도 해결했다.
- F-I-B `[medium]` `[patch]` 고정 기대값과 실제 제품 발행 경로의 연결 폭: F-B6과 같은 검증 공백이다. rich fixture 전체를 제품 runtime으로 검증한다.
- F-I-C `[false]` `[reject]` 최초 null의 무조건 열 발행 해석: carried — I-B와 같은 주장이다. 옛 coordinator의 기존 행 조건을 우선하는 원래 판정은 유지하며, F-B5의 전이 시험으로 이 의미를 명시적으로 관찰한다.
- F-I-D `[low]` `[reject]` 취소 코드 문자 차이: carried — I-E와 같은 주장이다. signal STOPPED와 DB INVALID_ATTEMPT는 원인별로 구분되고 모두 fail closed이며 실제 chunk 회수 시험이 이를 관찰한다. 계획 문구만 바꾸는 finding은 reject한다.

합계 18건: medium 12, low 4, false 2; patch 10, defer 2, reject 6. high 및 maybe-false 0. 공유 원인별 수정/검증 후 결과와 독립 확인을 추가한다.
