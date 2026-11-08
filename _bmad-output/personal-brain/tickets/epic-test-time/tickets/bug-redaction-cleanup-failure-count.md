---
id: 14
type: bug
title: "redaction 회귀: MAINTAIN 상실 중 cleanup 실패와 복구를 결정적으로 검증한다"
parent: epic-test-time
covers: []
after: []
refined: true
hitl: false
risk: medium
severity: P2
---

# redaction 회귀: MAINTAIN 상실 중 cleanup 실패와 복구를 결정적으로 검증한다

## Description

19.5 최종 전체 회귀에서 MAINTAIN 상실 사례가 미해결 cleanup 실패 1행 대신 2행을 관찰했다. 의도된 권한 실패와 예상하지 않은 실패·중복을 작업 대상별로 구별하고, 물리 정리 확인 전 경고 유지 및 권한 복구 뒤 실패 해소를 보장해야 한다. 19.5에 최종 수락 source와 시험·fixture·제품·측정 실행 바이트 영향을 인계하고, 19.1에는 바뀐 DB 준비 비용을 인계한다.

## Reproduction

1. 관측 source 87f7b3e79e74b3da7a1de055259ed0016a989567, PostgreSQL18 전용 cluster, 관리자 암호 fixture 계약 postgres, 기본 전체 pnpm test에서 발생했다. 시각 2026-11-08 19:50:10Z~19:56:03Z, exit1.
2. 합성 message/tool note를 redact한 뒤 messages MAINTAIN을 회수하고, 세 table_cleanup 작업을 제한된 10회 재시도로 drain한다.
3. 미완료 작업0, messages attempts10 뒤 미해결 stage=table_cleanup 행수 기대1/실제2. 원시 행은 13필드가 접혀 대상·오류·attempt를 식별할 수 없다.
4. 같은 source/cluster 파일 단독 관련 재검증39/39 pass. 원인 해결이나 기존 결함 판정 근거가 아니다. 개발 중 새 시험·재현·성능 실행은 금지한다.

## Cause Hypothesis

다른 DB의 오래된 snapshot, fixture/role 격리, 작업 대상별 재시도 소진, failure 중복 기록 또는 공통 runner/test-db/부하 영향이 후보이다. 과거 동일형태 관찰과 같은 원인인지 미확정이다. 원인은 정적 근거와 결정적 회귀로 구별하며 특정 수정 방식을 강제하지 않는다.

## Acceptance Criteria

1. **권한 단독 실패의 전체 대상과 실패 수가 정확하다**
   **Given** 외부 방해 없는 독립 cluster에서 messages/tool_notes/chunks의 합성 비밀과 보존할 제어값을 redact하고 messages MAINTAIN만 회수한 상태
   **When** 기존 재시도 한도 10회 안에서 실제 작업을 drain한다
   **Then** 전체 cleanup 대상은 세 표이고 messages만 attempts10으로 소진되어 실패1행·미완료0이다. tool_notes/chunks는 실제 rewrite와 비밀 바이트 제거를 확인하고 실패0이다. messages는 rewrite되지 않고 비밀 바이트가 남으며 doctor는 messages 경고를 유지한다. 전체 작업·실패 집합을 먼저 대조하고 예상 밖 대상·코드·중복·조기 소진은 실패시킨다.
2. **권한 복구와 새 작업 보호 계약을 유지한다**
   **Given** 위 실패1행과 권한 복구, 또는 오래된 snapshot이나 새 redaction으로 아직 정리할 수 없는 작업
   **When** 명시적 retry와 실제 물리 cleanup을 수행한다
   **Then** 권한 단독 입력은 retry 추가1·skip0 뒤 messages 실제 rewrite·비밀 바이트 제거·제어값 보존과 기존 실패1해소, 미해결0·doctor ok를 확인한다. 물리 정리 미확인 입력의 경고는 남고, 처리하지 않은 대상과 새 세대 작업의 실패는 오래된 claim 성공으로 해소되지 않는다. 기존 새 세대 CAS 회귀를 보존한다.
3. **결정적 입력으로 잘못된 동작을 검출한다**
   **Given** 정적으로 확인한 원인 후보와 독립 합성 입력
   **When** 마지막 개발·리뷰 수정 뒤 회귀를 실행한다
   **Then** 수정 전 시험 전제 또는 제품 결함과 수정 후 동작을 구별하는 결정적 회귀가 실제 물리 cleanup 경로를 통과한다. 별도 방해 입력의 대상·실패 기대값은 그 입력과 계약으로 정하며 역사2행에 맞춰 역산하지 않는다. 합성 입력이 증명하는 경로와 87f7b3e 실제 두 행의 귀속 미확정을 구별한다. 전체 안전 work/failure 투영은 reporter가 접지 않는 진단으로 남긴다. 타이밍 운·통과까지 반복·timeout 증가·무한 retry·skip·기대1→2로 대체하지 않는다.
4. **격리와 검증 이력을 보존한다**
   **Given** 마지막 구현 및 독립 후속 리뷰 수정 완료
   **When** 자기 전용 PG/HOME/TMP/venv에서 VITEST_MAX_WORKERS=2 pnpm test → pnpm test:python을 각1회 순차 실행한다
   **Then** 원본 실패, 새 결과, 실패별 처분, 관련 재검증을 구별하고 미해결 필수 조건을 built로 숨기지 않는다. 다른 티켓/운영 자원은 변경하지 않는다. 19.5의 measured source87f7b3e와 실제 최종 변경의 workload/공통실행 바이트 영향을 인계하고 역사 표본을 새 실행으로 쓰지 않는다.
5. **또는 코드 무변경의 필요성을 입증한다**
   **Given** 원 관측과 현재 source 차이
   **When** 무변경 결론을 내린다
   **Then** 실제 정적·결정적 근거로 관측을 설명한다. 코드 편집만 면제하며 AC1~4의 대상별 실패·물리 정리·복구·새 세대 보호와 검증 증거는 유지한다. 단독 pass나 직접 미편집만으로 무관함을 단정하지 않는다. 과거 행 식별 유실로 설명할 수 없으면 한계를 공개하고 무변경 확정으로 닫지 않는다.

## Boundaries

원인 선택을 미리 강제하지 않는다. 우선 소유는 해당 redaction 시험과 자기 전용 helper이다. 공통 fixture·시험 DB 도구·core·PG 제품 수정은 실제 원인·최소diff·영향을 중앙에 질문한 뒤 진행한다. 다른 티켓의 runner·Drive 시험, migration0001~0043, plugin, lock, 공용 API는 편집하지 않는다.

## References

- parent — _bmad-output/personal-brain/tickets/epic-test-time/epic-test-time.md, Constraints·Boundaries·Notes
- dispatch — .brain-automation/tickets/19.14/independent-spec.md, 전체
- evidence — .brain-automation/tickets/19.14/evidence/manifest.json 및 해당 복사본, 원 관측·해시

## Notes

- Decision(2026-11-09, 중앙 명세): 과거 에픽의 redaction 조사 TODO와 달리 이번 관측은 독립 버그19.14로 조사·정제·구현한다. 부모 Notes의 이 범위 변경은 등록 인계 뒤 반영했다.
- Decision(2026-11-09, 중앙 명세): 14 예약, next_id13은 19.13 소유이다. 등록13/next14 checkpoint의 문서 범위만 통합하고 실제next14를 확인한 뒤 등록14/next15한다. 번호대체·19.13 등록 대행 금지.
- Decision(2026-11-09, 중앙 명세): after는 기능 선행만 둔다. 19.5 결과의 관측을 인계받지만 19.5 완료와 상호대기하거나 새 전역 gate를 만들지 않는다.
- Risk: medium — 잘못된 실패 처분은 물리 정리 미완료를 숨길 수 있다. severity P2는 개발 회귀 불안정 관측이며 제품 결함 확정이 아니다.
- Fact(정제 시작 당시): 원본 baseline은2f23d30/schema43, 당시 트리는next_id13이었다. 원 관측 source는 별도87f7b3e다. 등록13 수락main57331d5 통합과19.14 등록 뒤 현재next_id는15다.
- Decision(2026-11-09, 중앙 msg_827ba0da25c4): 등록13 수락main57331d5d339b05d777471e34e19935d31fc0df39를 정상 fast-forward 통합했다. 네 문서만 변경됐고 실제 next14를 확인한 뒤14등록/next15한다. 원본baseline2f23d30은 유지한다.
- 정정: 원 단독 로그 시각은2026-11-08 20:00:23Z~20:00:32Z이다. 기존 인계 보고의20:00Z전 설명은 오류이며 원문은 보존한다.
- 조사·편집 소유: packages/postgres/test/redaction.test.ts 및 필요한 자기 전용 helper. 공통 fixture/tooling/test-db/core/PG 제품 수정은 중앙 질문 대상이다. 19.5 runner/slot/hook/측정/config 및19.13 Drive 두 시험은 편집 금지다.
- Fact: 원관측 failure 두 행의13필드가 접혀 target/code/fingerprint/occurrences와 실제 work 상관 정보는 복원할 수 없다. 합성 입력이 증명하는 경로를 역사 원인으로 소급 확정하지 않는다.
- Decision: 독립 PO F1~F5를 반영하고 S1의 안전 JSON 진단과 S2의 기존 stale-claim 회귀 보존을 채택한다. A1은 중앙 인계로 해결, A2는 공통영역 편집이 실제 필요할 때만 질문한다.
