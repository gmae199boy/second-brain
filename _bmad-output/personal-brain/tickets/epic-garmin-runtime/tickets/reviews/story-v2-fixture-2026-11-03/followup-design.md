# 16.4 후속 수정의 설계 보완과 검증 범위

원래 baseline `1b31120e62c0b8787634f7c685dc7e3b7869609a`와 기존 구현·quick 리뷰 증거를 보존한다. intent-contract는 변경하지 않았다. 후속 수정은 기존 수락조건의 불변 발행·멱등·실제 중단 복구를 완성한다.

- 계정 대상 수동 normalize는 account ID를 직접 사용한다. extension 대상은 기존 확인된 매핑을 사용한다.
- 수집 시작 시 미발행 항목을 다시 처리한다. raw 저장 트랜잭션에서 날짜 dirty generation을 기록하고, 날짜 발행 완료는 예약한 세대에만 적용한다. 첫 날짜 chunk 전에 pending을 예약해 raw commit 뒤와 날짜 chunk 사이 중단을 재발견한다.
- 날짜 후보는 수집 dataset에 실제로 있는 날짜와 활동의 영향 날짜다. 같은 날짜를 계산하는 보조 입력은 기존 설계의 계정 전체 coverage snapshot을 유지한다.
- 날짜 revision 재료의 입력 fetched와 labels SHA는 유지한다. 원문 항목 관측의 fetched는 원문 fetched 그대로다. 날짜 파생 관측은 source max 밀리초 안의 마이크로초 슬롯을 사용한다. 원래 source max는 ledger에 별도로 보존하며, 같은 source max의 다른 입력 조합은 다음 슬롯에 예약한다. 다른 source max의 자연 순서는 유지된다. 같은 revision은 버전 전체에서 같은 슬롯을 재사용한다. 1밀리초의 1,000개 슬롯이 모두 쓰이면 명시적으로 실패하며 현재를 임의로 되돌리지 않는다.
- 예약은 짧은 트랜잭션에서 현재 raw와 계산 snapshot을 검증한다. stale snapshot은 새 슬롯을 얻지 않고 다시 계산한다. 기존 0008의 동일시각 revision 충돌은 기존 관측을 보존하면서 현재 base revision의 결정적 repair alias를 다음 슬롯에 발행한다. 충돌 없는 기존 revision은 그대로 재사용한다.
- `0009_day_publication.sql`은 dirty generation과 버전 공통 revision 예약을 확장 schema에 추가한다. core·plugin·app-ref는 변경하지 않는다.
- 미발행 검색은 성공 키 집합으로 바꾸었고 순수 날짜 JSON decode는 날짜별 실패 격리 안으로 옮겼다.
- 실제 PG 시험에 500행 commit 뒤 중단/attempt 회수/새 attempt 재개, text 원문/JSONB/활동·세트·문자열 PK/단위·날짜·시각, normalize 출력 비밀 비노출, 반입 전용 중간 날짜 불변, 0008→0009 충돌 복구와 버전 재사용을 추가했다.
- 고정 oracle에 합성 역순 체중 측정을 추가했다. 최신 72,346g이 72.3kg으로 계산됨을 격리 legacy oracle로 고정했으며 archive SHA-256 `02cbaf47a5cca4a799fe42aa7d2eb988860b4395fd1ff9649439fffb87f56b25`는 유지한다. 기본 suite에서 oracle은 실행하지 않는다.

구현 워커의 대상 시험은 통과했으며 독립 재리뷰와 최종 전체 검증을 추가로 수행한다. 정상화 버전9 시험은 임시 확장 복사본과 시험 DB 지원 목록에서만 실행한다.
