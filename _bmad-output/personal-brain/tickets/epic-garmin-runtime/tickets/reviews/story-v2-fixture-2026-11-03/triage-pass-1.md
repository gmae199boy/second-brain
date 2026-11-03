# 16.4 후속 리뷰 triage — 수정 전 판정

모든 독립 렌즈 완료 후 현재 코드·호출자·기존 시험·기존 triage와 대조했다. 아래 번호는 원문 항목과 일대일 대응한다. 수정 결과와 검증은 완료 뒤 계획에 추가한다. 원래 baseline과 기존 증거를 보존한다.

## Blind Hunter — 10건

- B1 `[medium]` `[patch]` account 정규화 no-op: collect.py는 account target에서 set_target을 생략하고 normalize.py는 target_account 매핑만 사용한다. 시험의 관리자 INSERT가 이 공백을 가린다. 실제 account 경로 연결과 관리자 보충 없는 PG 시험을 채택한다.
- B2 `[medium]` `[patch]` collect 재진입의 pending item 누락: unpublished 호출은 rebuild뿐이고 no-op 경로는 unfinished_days만 읽는다. raw coverage가 완료면 남은 chunk를 채울 길이 없다. 수집과 독립된 미완료 발행 복구를 채택한다.
- B3 `[medium]` `[patch]` 날짜 pending 누락: publish_day는 마지막 chunk에서만 상태를 쓴다. 최초 chunk 뒤 및 raw commit 뒤 날짜 집계 전 중단을 재발견하도록 보완하고 시험한다.
- B4 `[medium]` `[patch]` 반입 전용 날짜 복제: rebuild는 수집 raw의 연속 범위를 만들고 publish_days는 계정 전체 raw를 읽는다. 중간 반입 전용 날짜가 새 수집 요약으로 바뀐다. 실제 수집 날짜·영향 활동으로 후보를 제한한다. 같은 날짜의 계정 전체 보조 입력 사용은 기존 Design Notes대로 유지한다.
- B5 `[medium]` `[patch]` 날짜 revision 충돌: day_revision은 입력별 fetched/labels를 포함하나 fetched는 max 하나뿐이다. migration 0026의 revision_count는 normalization_version 선택 전이므로 같은 max에 다른 revision이면 current에서 제외한다. 날짜 파생 발행 순서 설계 보완과 역순·동률·버전 재사용 시험을 채택한다. 원문 항목의 fetched 의미는 보존한다.
- B6 `[medium]` `[patch]` unpublished 이중 선형 탐색: raw마다 전체 revision 상태를 any로 순회하고 raw hash도 반복 계산한다. 장기 이력에서 수동 재정규화 선택 비용이 곱으로 커진다. 성공 키 집합으로 단순화한다.
- B7 `[medium]` `[patch]` 잘못된 JSON 날짜 격리 실패: normalize_all의 날짜 json.loads가 try 바깥임을 확인했다. decode를 날짜 격리 안으로 이동하고 정상 날짜와 함께 검증한다.
- B8 `[medium]` `[patch]` PG text/json/활동 키 검증 공백: 기존 storage check는 세 numeric catalog뿐이며 PG 직접 키 대조도 steps뿐이다. 실제 publisher의 text/json·활동·세트·문자열 PK를 검증한다.
- B9 `[medium]` `[patch]` chunk 중간 attempt 회수 검증 공백: 501행 완주와 완료 token 처음부터 거부는 중간 상태를 만들지 않는다. 500행 commit 뒤 회수·거부·새 attempt 수렴을 검증한다.
- B10 `[medium]` `[patch]` normalize 출력 비밀 검증 공백: 상태 행 canary 확인은 stdout/stderr를 관찰하지 않는다. 성공·파서 실패·DB 실패의 출력과 상태를 검증한다.

## Edge Case Hunter — 6건

- E1 `[medium]` `[patch]` labels 변경의 날짜 revision 동률: B5와 같은 원인. 날짜 입력 max가 같아도 파생 revision이 달라지는 실제 경로이므로 같은 수정과 시험으로 해결한다.
- E2 `[medium]` `[patch]` 날짜 chunk 중단 미재발견: B3과 같은 원인. 마지막 chunk 전 상태가 없으므로 같은 pending 보완으로 해결한다.
- E3 `[low]` `[reject]` 극단 timestamp: carried — 기존 quick의 같은 위치·같은 주장이다. datetime 범위 밖 값은 평소 입력에서 만나기 어렵고 새 예외 경로가 필요하다는 기존 판정과 조치를 유지한다.
- E4 `[medium]` `[defer]` 16.3 평문 steps 키와 새 canonical 키 중복: 원래 baseline의 _publish_steps가 이미 평문 sub_identity/day를 썼다. 16.4의 새 canonical 키는 반입과 같은 키라는 수락조건을 충족하며 옛 잘못된 관측을 변경하는 core 계약 작업은 이번 후속 리뷰 명세 밖이다. 실제 배포 전 16.3 합성/설치 시험 데이터가 남는 경우의 별도 정리 대상으로 기록한다. 건강 행 UPDATE/DELETE로 숨기지 않는다.
- E5 `[medium]` `[defer]` 빠진 샘플의 예전 current 유지: carried — 계획 frontmatter의 같은 deferred 항목과 같은 원인이다. 기존 불변 보관/키별 current 계약을 유지하며 재등록하지 않는다.
- E6 `[medium]` `[patch]` 순수 날짜 JSON decode 격리 주장 반증: B7과 같은 원인. 같은 날짜 격리 수정으로 해결한다.

## Verification Gap — 3건

- V1 `[medium]` `[patch]` 큰 항목 첫 chunk 뒤 재개 관찰 없음: 렌즈의 시험 검색 증거를 수용한다. B9와 같은 중단·새 attempt 수렴 시험으로 해결한다.
- V2 `[medium]` `[patch]` 유효 체중 원문 최신 선택·반올림 검증 없음: 렌즈의 fixture/검색 증거를 수용한다. 합성 역순 측정을 격리 legacy oracle로 고정하고 동등성 검사를 확장한다.
- V3 `[medium]` `[defer]` 옛 Orca helper 새 메시지/지역 ack 시험 없음: 렌즈의 공백 증거는 유효하지만 이번 명세는 그 helper 사용을 금지한다. baseline 이후 별도 도구 커밋이 diff에 포함된 것이며 제품 16.4의 필수 조건이 아니다. 도구 소유 작업으로 남기고 이번 수정에서 사용·변경하지 않는다.

## Intent Alignment — 관찰 A~G 7건

- I-A `[medium]` `[patch]` 계산 fixture와 PG publisher 관찰 폭 차이: B8과 같은 검증 공백. DB 변환·키·타입 검증을 추가한다.
- I-B `[false]` `[reject]` NULL raw 무조건 행 생성이라는 해석: 원래 intent는 옛 coordinator의 계산 의미를 보존하며 계획 Code Map과 Implementation Notes가 NULL raw의 기존 행 조건을 명시한다. 파서가 만든 열 NULL과 raw 자체 null은 별개다. 새 결함으로 판정하지 않는다.
- I-C `[false]` `[reject]` 계정 전체 보조 raw 사용 자체가 금지라는 해석: Design Notes는 day_values의 계정 전체 coverage snapshot을 명시한다. 반입 dataset 항목 자체를 재발행하거나 반입 dataset에 쓰지 않는 경계와 양립한다. 반입 전용 날짜가 수집 출력 후보가 되는 별도 실제 결함은 B4로 수정한다.
- I-D `[medium]` `[patch]` 완주 결과와 chunk 중단 관찰 차이: B9/V1과 같은 시험 공백. 실제 중간 commit·회수·수렴을 관찰한다.
- I-E `[low]` `[reject]` matrix COLLECT_STOPPED와 invalid attempt 코드 차이: signal은 STOPPED, DB token 회수는 INVALID_ATTEMPT이며 둘 다 fail closed다. 코드 결함이 아니라 계획의 포괄 표현이다. 계획만 고치는 finding은 워크플로 규칙상 reject하고 검증 결과에 원인별 코드를 기록한다.
- I-F `[medium]` `[defer]` 옛 샘플 표 교체와 current 집합 차이: carried — E5 및 기존 deferred와 같은 원인. 새 항목으로 다시 등록하지 않는다.
- I-G `[false]` `[reject]` 입력 diff에 자동화·타 티켓 변경이 포함됨: 공식 워크플로는 원래 baseline 이후 전체 diff를 요구한다. 이미 커밋된 별도 변경을 이번 신규 제품 변경으로 해석하지 않으며 해당 파일을 수정하지 않는다.

합계 26건: medium 21, low 2, false 3. patch 17건(공유 원인 그룹 포함), defer 4건(그중 carried 2건), reject 5건. high 및 maybe-false 0건. 이 수는 실제 수정 완료 수가 아니라 채택 판정 수다.
